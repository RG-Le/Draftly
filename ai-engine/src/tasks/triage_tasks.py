"""Celery tasks for triage pipeline."""

import asyncio
import structlog
from src.celery_app import celery_app
from src.pipelines.base import PipelineContext
from src.pipelines.triage_pipeline import create_triage_pipeline
from src.infrastructure.redis.event_publisher import publish_event
from src.celery_app import celery_app as app # Used to dispatch draft tasks
from src.config.database import reset_engine
from src.infrastructure.redis.connection import reset_redis

logger = structlog.get_logger()

async def async_classify_thread(thread_id: str, correlation_id: str, user_id: str):
    ctx = PipelineContext(
        correlation_id=correlation_id,
        user_id=user_id,
        thread_id=thread_id
    )
    
    # Fire event back to Node.js Gateway
    await publish_event("triage:started", {
        "userId": user_id,
        "threadId": thread_id,
        "correlationId": correlation_id
    })
    
    try:
        pipeline = create_triage_pipeline()
        result_ctx = await pipeline.execute(ctx)
        
        if result_ctx.errors:
            raise Exception(f"Triage Pipeline Failed: {result_ctx.errors}")
            
        triage_res = result_ctx.data.get('triage_result', {})
        classification = triage_res.get('classification')
        
        # Fire event back to Node.js Gateway
        await publish_event("triage:completed", {
            "userId": user_id,
            "threadId": thread_id,
            "correlationId": correlation_id,
            "classification": classification,
            "confidence": triage_res.get('confidence'),
            "reasoning": triage_res.get('reasoning')
        })
        
        # If it is a reply_needed, queue up drafting automatically
        if classification == 'reply_needed':
            app.send_task(
                "ai.draft.generate",
                args=[thread_id, correlation_id, user_id],
                queue="draft-queue"
            )
            
        return triage_res
    except Exception as e:
        logger.error("triage.pipeline_failed", thread_id=thread_id, error=str(e))
        await publish_event("triage:failed", {
            "userId": user_id,
            "threadId": thread_id,
            "correlationId": correlation_id,
            "error": str(e)
        })
        raise
    finally:
        from src.config.database import dispose_engine
        await dispose_engine()

@celery_app.task(
    name="ai.triage.classify",
    queue="triage-queue",
    max_retries=2,
    default_retry_delay=2,
    time_limit=30,
    soft_time_limit=25,
)
def classify_thread(thread_id: str, correlation_id: str, user_id: str) -> dict:
    """Classify a thread running the async pipeline synchronously in Celery."""
    logger.info(
        "triage.task.started",
        thread_id=thread_id,
        correlation_id=correlation_id,
        user_id=user_id,
    )

    try:
        # Run async in celery sync context
        reset_engine()  # Fresh engine for this event loop (asyncio.run creates a new one)
        reset_redis()   # Fresh Redis client for this event loop
        result = asyncio.run(async_classify_thread(thread_id, correlation_id, user_id))
        return result
    except Exception as e:
        logger.error("triage.task.failed", thread_id=thread_id, error=str(e))
        raise
