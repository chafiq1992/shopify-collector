"""Fail-closed schema step, run before a release replaces the running container.

This app has no Alembic. Its schema is `create_all` plus a list of additive
`ALTER TABLE ... IF NOT EXISTS` statements in `backend.app.db.init_db`, applied
by a FastAPI startup handler that catches every exception and prints it:

    except Exception as e:
        print(f"[DB] Failed to init tables: {e}")

On Cloud Run that was survivable — a revision that fails to boot never receives
traffic. On plain Docker, `compose up -d` has already replaced the running
container by the time the same failure scrolls past in the log, and because the
handler swallows it the container then reports itself healthy and serves 500s.

So the release runs this first, in a throwaway container:

    docker compose run --rm --no-deps web python -m backend.migrate

It does the identical schema work, but a failure exits non-zero and the running
container is never touched.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys


def _safe_url(url: str) -> str:
    """The DSN with its password removed — this output goes into deploy logs."""
    return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:***@", url)


async def _migrate_collection_indexes(engine) -> None:
    """Keep collection unique while allowing a new OUT after an order is found."""
    from sqlalchemy import text

    indexes = {
        "uq_order_events_collected": (
            "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_order_events_collected "
            "ON order_events (order_gid, store_key) "
            "WHERE order_gid IS NOT NULL AND action = 'collected'"
        ),
        "ix_order_events_collection_lookup": (
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_order_events_collection_lookup "
            "ON order_events (store_key, order_gid, action, id)"
        ),
    }
    index_status = text("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)")
    async with engine.connect() as connection:
        conn = await connection.execution_options(isolation_level="AUTOCOMMIT")
        await conn.exec_driver_sql("SET statement_timeout = '90s'")
        for name, create in indexes.items():
            valid = await conn.scalar(index_status, {"name": name})
            if valid is False:
                # Postgres can leave an invalid index after an interrupted build.
                await conn.exec_driver_sql(f"DROP INDEX CONCURRENTLY {name}")
            if not valid:
                await conn.exec_driver_sql(create)
            if not await conn.scalar(index_status, {"name": name}):
                raise RuntimeError(f"Collection index {name} is invalid")

        # This legacy rule prevented every later OUT for the same order. Drop it
        # only after the replacement has preserved uniqueness for Collected.
        await conn.exec_driver_sql("DROP INDEX CONCURRENTLY IF EXISTS uq_order_events_collect_out")


async def _main() -> int:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        print("✗ DATABASE_URL is not set", file=sys.stderr)
        return 2

    # A SQLite URL here means app.env did not reach the container: the schema
    # would be written to a file inside a throwaway container and thrown away,
    # and the release would then come up against an empty database.
    if url.lower().startswith("sqlite"):
        print(
            f"✗ refusing to migrate a SQLite database ({_safe_url(url)}).\n"
            "  On this box DATABASE_URL must point at Postgres; check "
            "/opt/collector/app.env reached the container.",
            file=sys.stderr,
        )
        return 2

    print(f"→ database: {_safe_url(url)}")

    from sqlalchemy import text

    from backend.app.db import engine, init_db

    # Connectivity first, so an unreachable host is reported as exactly that
    # rather than as a confusing failure part-way through create_all. This is
    # also where a missing `enable_ipv6: true` surfaces: the direct Supabase
    # host is AAAA-only and a plain Compose bridge cannot route to it, which
    # arrives here as OSError: [Errno 101] Network is unreachable.
    try:
        async with engine.connect() as conn:
            version = await conn.scalar(text("SELECT version()"))
    except Exception as e:
        print(f"✗ cannot reach the database: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(f"→ connected: {str(version).split(' on ')[0]}")

    try:
        await init_db()
        await _migrate_collection_indexes(engine)
    except Exception as e:
        print(f"✗ schema step failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    finally:
        await engine.dispose()

    print("✓ schema up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
