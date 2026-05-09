"""Draftly AI Engine — Celery application configuration."""

from celery import Celery
from src.config.settings import get_settings

settings = get_settings()

celery_app = Celery(
    "draftly_ai",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "src.tasks.triage_tasks",
        "src.tasks.draft_tasks",
        "src.tasks.profile_tasks",
    ],
)

celery_app.conf.update(
    # Serialization
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",

    # Timezone
    timezone="UTC",
    enable_utc=True,

    # Task execution
    task_acks_late=True,                   # Don't ack until task completes
    worker_prefetch_multiplier=1,          # Fetch one task at a time (fair scheduling)
    task_reject_on_worker_lost=True,       # Re-queue if worker crashes

    # Result backend
    result_expires=3600,                   # Expire results after 1 hour

    # Worker
    worker_max_tasks_per_child=100,        # Restart worker after 100 tasks (memory leak protection)
    worker_max_memory_per_child=512_000,   # 512MB per worker process

    # Task routes — each task type goes to its own queue
    task_routes={
        "ai.triage.*": {"queue": "triage-queue"},
        "ai.draft.*": {"queue": "draft-queue"},
        "ai.profile.*": {"queue": "profile-queue"},
    },

    # Default queue for unrouted tasks
    task_default_queue="default-queue",
)
