"""SQLAlchemy async engine and session factory."""

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from src.config.settings import get_settings

from sqlalchemy.pool import NullPool

_engine = None
_session_factory = None


async def dispose_engine():
    """Asynchronously dispose of the engine.
    
    MUST be called at the end of each async task to ensure connections 
    are closed within the same event loop that created them.
    """
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _session_factory = None


def reset_engine():
    """Reset the global engine and session factory variables.
    
    This is called at the start of each task to ensure a fresh engine
    is created for the new event loop.
    """
    global _engine, _session_factory
    _engine = None
    _session_factory = None


def get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        # Using NullPool is recommended when using asyncio.run() repeatedly (like in Celery)
        # to avoid connection leakage and 'MissingGreenlet' errors during teardown.
        _engine = create_async_engine(
            settings.database_url,
            poolclass=NullPool,
            echo=False,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
    return _session_factory


async def get_session() -> AsyncSession:
    """Dependency for FastAPI routes."""
    factory = get_session_factory()
    async with factory() as session:
        yield session
