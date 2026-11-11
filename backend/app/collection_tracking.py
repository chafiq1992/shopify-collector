"""Collection follow-up state derived from the existing order audit log."""

import asyncio
import hashlib
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.orm import aliased

from .models import OrderEvent, User


WRONG_ITEM_ACTIONS = ("wrong_item", "wrong_item_unassigned")
COLLECTION_ACTIONS = ("collected", "out", "fulfilled", "wrong_item", "out_found")
_local_locks = tuple(asyncio.Lock() for _ in range(64))


@asynccontextmanager
async def collection_write(session, store, order_gid):
    """Serialize collection transitions for one store/order until commit."""
    key = f"collection:{store}:{order_gid}".encode()
    lock_id = int.from_bytes(hashlib.sha256(key).digest()[:8], "big", signed=True)
    async with _local_locks[lock_id % len(_local_locks)]:
        try:
            if session.bind.dialect.name == "postgresql":
                await session.execute(select(func.pg_advisory_xact_lock(lock_id)))
            yield
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


def wrong_items():
    return select(OrderEvent).where(OrderEvent.action.in_(WRONG_ITEM_ACTIONS))


def pending_wrong_items():
    return wrong_items().where(OrderEvent.event_metadata["resolved_at"].as_string().is_(None))


def user_wrong_items(user):
    assigned = (OrderEvent.action == "wrong_item") & (OrderEvent.user_id == user.id)
    if user.role == "admin":
        # The admin can resolve legacy reports without a recorded collector.
        return pending_wrong_items().where(or_(assigned, OrderEvent.action == "wrong_item_unassigned"))
    return pending_wrong_items().where(assigned)


def active_out_events():
    later = aliased(OrderEvent)
    superseded = select(later.id).where(
        later.store_key == OrderEvent.store_key,
        later.order_gid == OrderEvent.order_gid,
        later.id > OrderEvent.id,
        later.action.in_(("out", "found")),
    ).exists()
    return select(OrderEvent).where(OrderEvent.action == "out", OrderEvent.order_gid.is_not(None), ~superseded)


def for_order(statement, store, order_gid):
    return statement.where(OrderEvent.store_key == store, OrderEvent.order_gid == order_gid)


def utc_iso(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def resolve_wrong_item(event, status, user):
    event.event_metadata = {
        **(event.event_metadata or {}),
        "status": status,
        "resolved_at": datetime.now(timezone.utc).isoformat(),
        "resolved_by_id": user.id,
    }


def with_event_user(statement):
    return statement.add_columns(User.id, User.name, User.email).join(User, User.id == OrderEvent.user_id)
