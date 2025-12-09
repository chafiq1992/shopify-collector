import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import declarative_base

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///./local.db").strip()

# Async SQLAlchemy setup
engine = create_async_engine(DATABASE_URL, echo=False, future=True)
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

