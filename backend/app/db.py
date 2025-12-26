import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import declarative_base

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///./local.db").strip()

# Async SQLAlchemy setup
_engine_kwargs = {"echo": False, "future": True}
# Cloud SQL / Postgres connections can be dropped when idle; pre-ping avoids "connection is closed" errors.
try:
    db_url_l = (DATABASE_URL or "").lower()
    is_sqlite = db_url_l.startswith("sqlite")
    if not is_sqlite:
        _engine_kwargs.update({
            "pool_pre_ping": True,
            # Recycle pooled connections periodically to avoid server-side idle timeouts.
            "pool_recycle": int(os.environ.get("DB_POOL_RECYCLE_SECONDS", "300").strip() or 300),
        })
        # Optional tuning knobs (only apply to non-sqlite)
        if os.environ.get("DB_POOL_SIZE"):
            _engine_kwargs["pool_size"] = int(os.environ.get("DB_POOL_SIZE", "").strip() or 5)
        if os.environ.get("DB_MAX_OVERFLOW"):
            _engine_kwargs["max_overflow"] = int(os.environ.get("DB_MAX_OVERFLOW", "").strip() or 10)
        if os.environ.get("DB_POOL_TIMEOUT"):
            _engine_kwargs["pool_timeout"] = int(os.environ.get("DB_POOL_TIMEOUT", "").strip() or 30)
except Exception:
    # Never fail import due to tuning parsing
    pass

engine = create_async_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
Base = declarative_base()


async def get_session() -> AsyncSession:
    """FastAPI dependency that yields an async session."""
    async with SessionLocal() as session:
        yield session


async def init_db():
    """Create tables at startup (lightweight, safe to run repeatedly)."""
    from . import models  # ensure models are imported

    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)

