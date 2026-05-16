"""Celery tasks for triage pipeline."""

import asyncio
import random
import structlog
from src.celery_app import celery_app
from src.pipelines.base import PipelineContext
from src.pipelines.triage_pipeline import create_triage_pipeline, create_batch_triage_pipeline
from src.infrastructure.redis.event_publisher import publish_event
from src.celery_app import celery_app as app
from src.config.database import reset_engine, dispose_engine
from src.infrastructure.redis.connection import reset_redis

logger = structlog.get_logger()


def _backoff_countdown(retries: int, base: int, cap: int) -> float:
    """Exponential backoff with ±20% jitter: base * 2^retries, capped at cap seconds."""
    delay = min(base * (2 ** retries), cap)
    return delay * (1 + random.uniform(-0.2, 0.2))


# ── Single-thread task ─────────────────────────────────────────────────────────

async def _async_classify_thread(thread_id: str, correlation_id: str, user_id: str):
    ctx = PipelineContext(correlation_id=correlation_id, user_id=user_id, thread_id=thread_id)

    await publish_event("triage:started", {
        "userId": user_id,
        "threadId": thread_id,
        "correlationId": correlation_id,
    })

    try:
        pipeline = create_triage_pipeline()
        result_ctx = await pipeline.execute(ctx)

        if result_ctx.errors:
            raise Exception(f"Triage Pipeline Failed: {result_ctx.errors}")

        triage_res = result_ctx.data.get('triage_result', {})
        classification = triage_res.get('classification')

        await publish_event("triage:completed", {
            "userId": user_id,
            "threadId": thread_id,
            "correlationId": correlation_id,
            "classification": classification,
            "confidence": triage_res.get('confidence'),
            "reasoning": triage_res.get('reasoning'),
        })

        if classification == 'reply_needed':
            app.send_task(
                "ai.draft.generate",
                args=[thread_id, correlation_id, user_id],
                queue="draft-queue",
            )

        return triage_res
    finally:
        await dispose_engine()


@celery_app.task(
    name="ai.triage.classify",
    bind=True,
    queue="triage-queue",
    max_retries=3,
    time_limit=30,
    soft_time_limit=25,
)
def classify_thread(self, thread_id: str, correlation_id: str, user_id: str) -> dict:
    attempt = self.request.retries + 1
    logger.info("triage.task.started", thread_id=thread_id, user_id=user_id, attempt=attempt)
    try:
        reset_engine()
        reset_redis()
        return asyncio.run(_async_classify_thread(thread_id, correlation_id, user_id))
    except Exception as e:
        logger.error("triage.task.failed", thread_id=thread_id, error=str(e), attempt=attempt)
        if self.request.retries < self.max_retries:
            countdown = _backoff_countdown(self.request.retries, base=5, cap=120)
            reset_redis()
            asyncio.run(publish_event("triage:retrying", {
                "userId": user_id,
                "threadId": thread_id,
                "correlationId": correlation_id,
                "attempt": attempt,
                "maxAttempts": self.max_retries + 1,
                "retryInSeconds": int(countdown),
            }))
            raise self.retry(exc=e, countdown=countdown)
        # Final failure — notify user
        reset_redis()
        asyncio.run(publish_event("triage:failed", {
            "userId": user_id,
            "threadId": thread_id,
            "correlationId": correlation_id,
            "error": str(e),
            "attempt": attempt,
        }))
        raise


# ── Batch task ─────────────────────────────────────────────────────────────────

async def _async_classify_thread_batch(thread_ids: list[str], correlation_id: str, user_id: str):
    ctx = PipelineContext(
        correlation_id=correlation_id,
        user_id=user_id,
        thread_id=thread_ids[0] if thread_ids else "",
    )
    ctx.data["thread_ids"] = thread_ids

    await publish_event("triage:batch_started", {
        "userId": user_id,
        "threadCount": len(thread_ids),
        "correlationId": correlation_id,
    })

    try:
        pipeline = create_batch_triage_pipeline()
        result_ctx = await pipeline.execute(ctx)

        if result_ctx.errors:
            raise Exception(f"Batch Triage Pipeline Failed: {result_ctx.errors}")

        results = result_ctx.data.get("batch_triage_results", [])

        for res in results:
            if res.get("classification") == "reply_needed":
                app.send_task(
                    "ai.draft.generate",
                    args=[res["thread_id"], correlation_id, user_id],
                    queue="draft-queue",
                )

        await publish_event("triage:batch_completed", {
            "userId": user_id,
            "threadCount": len(thread_ids),
            "correlationId": correlation_id,
            "results": [
                {"threadId": r["thread_id"], "classification": r["classification"]}
                for r in results
            ],
        })

        return {"classified": len(results), "results": results}
    finally:
        await dispose_engine()


@celery_app.task(
    name="ai.triage.classify_batch",
    bind=True,
    queue="triage-queue",
    max_retries=4,
    time_limit=120,
    soft_time_limit=110,
)
def classify_thread_batch(self, thread_ids: list[str], correlation_id: str, user_id: str) -> dict:
    attempt = self.request.retries + 1
    logger.info("triage.batch.task.started", thread_count=len(thread_ids), user_id=user_id, attempt=attempt)
    try:
        reset_engine()
        reset_redis()
        return asyncio.run(_async_classify_thread_batch(thread_ids, correlation_id, user_id))
    except Exception as e:
        logger.error("triage.batch.task.failed", error=str(e), attempt=attempt)
        if self.request.retries < self.max_retries:
            countdown = _backoff_countdown(self.request.retries, base=10, cap=300)
            # Exponential schedule: ~10s, ~20s, ~40s, ~80s (with ±20% jitter)
            reset_redis()
            asyncio.run(publish_event("triage:batch_retrying", {
                "userId": user_id,
                "correlationId": correlation_id,
                "threadCount": len(thread_ids),
                "attempt": attempt,
                "maxAttempts": self.max_retries + 1,
                "retryInSeconds": int(countdown),
            }))
            raise self.retry(exc=e, countdown=countdown)
        # Final failure — notify user with full context for main-UI banner
        reset_redis()
        asyncio.run(publish_event("triage:batch_failed", {
            "userId": user_id,
            "correlationId": correlation_id,
            "threadCount": len(thread_ids),
            "error": str(e),
            "attempt": attempt,
            "permanent": True,
        }))
        raise
