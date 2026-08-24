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
    from sqlalchemy import text

    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)
        # Additive migrations for columns added to existing tables.
        # SQLite "ADD COLUMN" doesn't accept JSON default values in all versions, so we add a TEXT-typed column
        # with default '[]' (compatible across SQLite/Postgres since the type emitted by JSON() is TEXT/JSON).
        is_sqlite_engine = (DATABASE_URL or "").lower().startswith("sqlite")
        try:
            if is_sqlite_engine:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN agent_tags TEXT NOT NULL DEFAULT '[]'"
                )
            else:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_tags JSONB NOT NULL DEFAULT '[]'::jsonb"
                )
        except Exception:
            # Column already exists or DB rejected addition (safe to ignore on repeat starts).
            pass

        # Durable idempotency key for Confirmation action writes. Shopify tag
        # mutations are idempotent, and this key makes their audit row idempotent
        # too, so browser retries cannot either lose or double-count an action.
        try:
            if is_sqlite_engine:
                await conn.exec_driver_sql(
                    "ALTER TABLE order_events ADD COLUMN client_action_id VARCHAR(128)"
                )
            else:
                await conn.exec_driver_sql(
                    "ALTER TABLE order_events ADD COLUMN IF NOT EXISTS client_action_id VARCHAR(128)"
                )
        except Exception:
            # Column already exists.
            pass
        try:
            await conn.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_order_events_client_action_id "
                "ON order_events (client_action_id)"
            )
        except Exception:
            # A legacy database may need manual cleanup if duplicate non-null keys
            # were introduced outside this application. Startup must remain usable.
            pass

        # Additive columns for the Return Scanner PDF export (order detail).
        return_scan_cols = ("total_price", "currency", "city", "phone", "fulfilled_at")
        for col in return_scan_cols:
            try:
                if is_sqlite_engine:
                    await conn.exec_driver_sql(
                        f"ALTER TABLE return_scans ADD COLUMN {col} TEXT DEFAULT ''"
                    )
                else:
                    await conn.exec_driver_sql(
                        f"ALTER TABLE return_scans ADD COLUMN IF NOT EXISTS {col} TEXT DEFAULT ''"
                    )
            except Exception:
                # Column already exists (safe to ignore on repeat starts).
                pass

        # Inventory Helper lifecycle: a count remains pending until the agent
        # explicitly marks it complete. The reported total is intentionally
        # separate from the sum of variant quantities so discrepancies remain
        # visible instead of being silently overwritten.
        try:
            if is_sqlite_engine:
                await conn.exec_driver_sql(
                    "ALTER TABLE inventory_receipts ADD COLUMN reported_items_received INTEGER"
                )
            else:
                await conn.exec_driver_sql(
                    "ALTER TABLE inventory_receipts ADD COLUMN IF NOT EXISTS reported_items_received INTEGER"
                )
        except Exception:
            # Column already exists.
            pass
        try:
            await conn.exec_driver_sql(
                "UPDATE inventory_receipts "
                "SET status = CASE WHEN actual_items IS NULL THEN 'new' ELSE 'pending' END "
                "WHERE status IN ('waiting', 'matched', 'mismatch')"
            )
        except Exception:
            # The Inventory Helper table may not exist in partial test schemas.
            pass

        # Inventory Helper automatic Shopify sync and received-history fields.
        # Tags are retained as the source for the ordered-crate number, while
        # finalized_at groups completed/incomplete receipts by receiving day.
        try:
            if is_sqlite_engine:
                await conn.exec_driver_sql(
                    "ALTER TABLE inventory_receipts ADD COLUMN shopify_tags TEXT NOT NULL DEFAULT '[]'"
                )
            else:
                await conn.exec_driver_sql(
                    "ALTER TABLE inventory_receipts ADD COLUMN IF NOT EXISTS shopify_tags JSONB NOT NULL DEFAULT '[]'::jsonb"
                )
        except Exception:
            pass
        try:
            if is_sqlite_engine:
                await conn.exec_driver_sql(
                    "ALTER TABLE inventory_receipts ADD COLUMN finalized_at DATETIME"
                )
            else:
                await conn.exec_driver_sql(
                    "ALTER TABLE inventory_receipts ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ"
                )
        except Exception:
            pass
        try:
            await conn.exec_driver_sql(
                "UPDATE inventory_receipts "
                "SET finalized_at = COALESCE(finalized_at, counted_at, updated_at, created_at) "
                "WHERE status IN ('complete', 'incomplete') AND finalized_at IS NULL"
            )
        except Exception:
            pass

