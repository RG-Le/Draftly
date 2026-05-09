"""Celery tasks for draft generation pipeline."""

import asyncio
import structlog
from src.celery_app import celery_app
from src.pipelines.base import PipelineContext
from src.pipelines.draft_pipeline import create_draft_pipeline
from src.infrastructure.redis.event_publisher import publish_event
from src.config.database import reset_engine
from src.infrastructure.redis.connection import reset_redis

logger = structlog.get_logger()

async def async_generate_draft(thread_id: str, correlation_id: str, user_id: str):
    ctx = PipelineContext(
        correlation_id=correlation_id,
        user_id=user_id,
        thread_id=thread_id
    )
    
    await publish_event("draft:started", {
        "userId": user_id,
        "threadId": thread_id,
        "correlationId": correlation_id
    })
    
    try:
        pipeline = create_draft_pipeline()
        result_ctx = await pipeline.execute(ctx)
        
        if result_ctx.errors:
            raise Exception(f"Draft Pipeline Failed: {result_ctx.errors}")
            
        draft_id = result_ctx.data.get('draft_id')
        
        # Fire event back to Node.js Gateway
        await publish_event("draft_generated", {
            "userId": user_id,
            "threadId": thread_id,
            "correlationId": correlation_id,
            "draftId": draft_id,
            "status": "generated"
        })
        
        return {"draft_id": draft_id, "thread_id": thread_id}
    except Exception as e:
        logger.error("draft.pipeline_failed", thread_id=thread_id, error=str(e))
        await publish_event("draft:failed", {
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
    name="ai.draft.generate",
    queue="draft-queue",
    max_retries=3,
    default_retry_delay=10,
    time_limit=60,
    soft_time_limit=50,
    rate_limit="30/m",
)
def generate_draft(thread_id: str, correlation_id: str, user_id: str) -> dict:
    """Generate a reply draft using the async pipeline synchronously in Celery."""
    logger.info(
        "draft.task.started",
        thread_id=thread_id,
        correlation_id=correlation_id,
        user_id=user_id,
    )

    try:
        reset_engine()  # Fresh engine for this event loop (asyncio.run creates a new one)
        reset_redis()   # Fresh Redis client for this event loop
        result = asyncio.run(async_generate_draft(thread_id, correlation_id, user_id))
        return result
    except Exception as e:
        logger.error("draft.task.failed", thread_id=thread_id, error=str(e))
        raise
