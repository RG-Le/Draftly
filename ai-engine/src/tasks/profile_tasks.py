"""Celery tasks for profile building pipeline."""

import asyncio
import structlog
from datetime import datetime

from src.celery_app import celery_app
from src.pipelines.base import PipelineContext
from src.pipelines.profile_pipeline import create_profile_pipeline
from src.infrastructure.redis.event_publisher import publish_event
from src.config.database import reset_engine
from src.infrastructure.redis.connection import reset_redis

logger = structlog.get_logger()


async def async_build_profile(user_id: str):
    """Run the profile pipeline asynchronously."""
    ctx = PipelineContext(
        correlation_id=f"profile-build-{user_id}",
        thread_id="profile_build",
        user_id=user_id
    )

    try:
        pipeline = create_profile_pipeline()
        result_ctx = await pipeline.execute(ctx)

        if result_ctx.errors:
            raise Exception(f"Profile Pipeline Failed: {result_ctx.errors}")

        # Publish event back to Node.js Gateway
        await publish_event("profile_generated", {
            "userId": user_id,
            "metrics": result_ctx.usage.to_dict(),
            "timestamp": datetime.utcnow().isoformat()
        })

        return {
            "status": "success",
            "usage": result_ctx.usage.to_dict()
        }
    except Exception as e:
        logger.error("profile.task_failed", user_id=user_id, error=str(e))
        raise
    finally:
        from src.config.database import dispose_engine
        await dispose_engine()


@celery_app.task(
    name="ai.profile.build",
    queue="profile-queue",
    bind=True,
    max_retries=2,
    default_retry_delay=60,
    time_limit=300,
    soft_time_limit=270,
)
def build_profile_task(self, user_id: str) -> dict:
    """Build or update a user's communication profile based on their sent emails."""
    logger.info(
        "profile.task.started",
        user_id=user_id,
        task_id=self.request.id,
    )

    try:
        reset_engine()  # Fresh engine for this event loop (asyncio.run creates a new one)
        reset_redis()   # Fresh Redis client for this event loop
        result = asyncio.run(async_build_profile(user_id))
        logger.info("profile.task.completed", user_id=user_id, result=result)
        return result
    except Exception as exc:
        logger.error("profile.task.failed", user_id=user_id, error=str(exc))
        raise self.retry(exc=exc)
