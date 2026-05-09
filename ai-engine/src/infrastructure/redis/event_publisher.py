import json
import structlog
from typing import Any
from src.infrastructure.redis.connection import get_redis

logger = structlog.get_logger()

class EventPublisher:
    def __init__(self):
        self.redis = get_redis()
        
    async def publish(self, event_type: str, payload: dict[str, Any]):
        channel = "draftly:events"
        message = {
            "type": event_type,
            "data": payload
        }
        
        try:
            await self.redis.publish(channel, json.dumps(message))
            logger.debug("event.published", event_type=event_type)
        except Exception as e:
            logger.error("event.publish_failed", event_type=event_type, error=str(e))

async def publish_event(event_type: str, payload: dict[str, Any]):
    """Helper function to publish event from pipelines and tasks."""
    publisher = EventPublisher()
    await publisher.publish(event_type, payload)
