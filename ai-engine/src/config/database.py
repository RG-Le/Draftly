"""SQLAlchemy async engine and session factory."""

import ssl as ssl_lib
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

        connect_args = {}
        if settings.db_ssl:
            if settings.db_ssl_reject_unauthorized and settings.db_ssl_ca:
                ctx = ssl_lib.create_default_context(cadata=settings.db_ssl_ca)
            elif settings.db_ssl_reject_unauthorized:
                ctx = ssl_lib.create_default_context()
            else:
                ctx = ssl_lib.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl_lib.CERT_NONE
            connect_args["ssl"] = ctx

        # Using NullPool is recommended when using asyncio.run() repeatedly (like in Celery)
        # to avoid connection leakage and 'MissingGreenlet' errors during teardown.
        _engine = create_async_engine(
            settings.database_url,
            poolclass=NullPool,
            echo=False,
            connect_args=connect_args,
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
