import redis.asyncio as redis
from src.config.settings import get_settings

_redis_client = None

def get_redis() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        settings = get_settings()
        _redis_client = redis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


def reset_redis():
    """Synchronously reset the global Redis client.

    Same rationale as reset_engine() — each asyncio.run() creates a new
    event loop, and the old client's connection may be tied to the old loop.
    """
    global _redis_client
    _redis_client = None


async def close_redis():
    global _redis_client
    if _redis_client is not None:
        await _redis_client.close()
        _redis_client = None
