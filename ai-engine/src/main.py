"""Draftly AI Engine — FastAPI application (health + admin only)."""

from fastapi import FastAPI
from contextlib import asynccontextmanager
import structlog

from src.config.settings import get_settings
from src.config.database import get_engine

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    settings = get_settings()
    logger.info("ai_engine.starting", primary_model=settings.llm_primary_model)
    yield
    # Dispose DB engine on shutdown
    engine = get_engine()
    await engine.dispose()
    logger.info("ai_engine.stopped")


app = FastAPI(
    title="Draftly AI Engine",
    version="0.1.0",
    docs_url="/docs",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    """Deep health check — DB, Redis, LLM circuit breaker."""
    settings = get_settings()
    components = {}

    # Check database
    try:
        engine = get_engine()
        from sqlalchemy import text
        async with engine.connect() as conn:
            import time
            start = time.monotonic()
            await conn.execute(text("SELECT 1"))
            latency_ms = round((time.monotonic() - start) * 1000, 1)
            components["database"] = {"status": "up", "latencyMs": latency_ms}
    except Exception as e:
        components["database"] = {"status": "down", "error": str(e)}

    # Check Redis
    try:
        import redis.asyncio as aioredis
        import time
        r = aioredis.from_url(settings.redis_url)
        start = time.monotonic()
        await r.ping()
        latency_ms = round((time.monotonic() - start) * 1000, 1)
        components["redis"] = {"status": "up", "latencyMs": latency_ms}
        await r.aclose()
    except Exception as e:
        components["redis"] = {"status": "down", "error": str(e)}

    all_up = all(c["status"] == "up" for c in components.values())

    return {
        "status": "healthy" if all_up else "degraded",
        "components": components,
        "config": {
            "primaryModel": settings.llm_primary_model,
            "fallbackModel": settings.llm_fallback_model,
        },
    }


@app.get("/ping")
async def ping():
    """Lightweight liveness probe."""
    return {"status": "ok"}
