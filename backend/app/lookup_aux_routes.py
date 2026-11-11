"""Authenticated, lightweight data for the order lookup's background UI."""
import asyncio
import time
from types import SimpleNamespace
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .auth_routes import get_current_user
from .models import User
from .purchase_order_badges import (
    close_membership_tasks, load_pending_receipts, purchase_order_snapshot,
)

router = APIRouter()
_tags_cache: dict[str, tuple[float, list[str]]] = {}
_tags_tasks: dict[str, asyncio.Task] = {}
_TAGS_TTL_SECONDS = 60
_TAGS_TIMEOUT_SECONDS = 12
_TAGS_QUERY = """
query LookupRecentTags {
  orders(first: 50, query: "status:any", sortKey: UPDATED_AT, reverse: true) {
    nodes { tags }
  }
}
"""


class BadgeVariantInput(BaseModel):
    id: str = Field(pattern=r"^gid://shopify/ProductVariant/[0-9]+$", max_length=100)
    inventory_item_id: Optional[str] = Field(default=None, pattern=r"^gid://shopify/InventoryItem/[0-9]+$", max_length=100)


class PurchaseOrderBadgeInput(BaseModel):
    variants: list[BadgeVariantInput] = Field(max_length=250)


@router.post("/api/order-purchase-orders")
async def order_purchase_orders(
    body: PurchaseOrderBadgeInput,
    store: Optional[str] = Query(None),
    _user: User = Depends(get_current_user),
):
    from . import main as m
    from .inventory_helper_routes import _TRANSFER_API_VERSION

    if not body.variants:
        return {"badges": {}, "stock": {}, "loading": False, "unavailable": False}
    if not m.HAVE_AUTH_DB or m.SessionLocal is None:
        raise HTTPException(status_code=503, detail="Purchase-order badges are temporarily unavailable")
    store_key = m.normalize_store_label(store)
    # End the read transaction before any background Shopify task is created.
    async with m.SessionLocal() as db:
        rows = await load_pending_receipts(db, store_key)
    variants = [
        m.OrderVariant(id=variant.id, inventory_item_id=variant.inventory_item_id, qty=1, status="unfulfilled")
        for variant in body.variants
    ]
    snapshot = purchase_order_snapshot(
        variants, rows, store=store_key, graphql=m.shopify_graphql,
        api_version=_TRANSFER_API_VERSION,
    )
    inventory_ids = sorted({variant.inventory_item_id for variant in variants if variant.inventory_item_id})
    if inventory_ids:
        key = m._orders_cache_key({"path": "/api/order-purchase-orders/stock", "store": store_key, "ids": inventory_ids})
        inventory = m._orders_cache_get(key)
        if inventory is None:
            try:
                await asyncio.wait_for(m._enrich_orders_with_on_hand([SimpleNamespace(variants=variants)], store=store_key), timeout=2.5)
            except asyncio.TimeoutError:
                pass
            inventory = {
                variant.inventory_item_id: {
                    name: value for name, value in (
                        ("on_hand_quantity", variant.on_hand_quantity),
                        ("committed_quantity", variant.committed_quantity),
                    ) if value is not None
                }
                for variant in variants if variant.inventory_item_id
            }
            m._orders_cache_set(key, inventory)
        for variant in variants:
            snapshot["stock"][variant.id].update(inventory.get(variant.inventory_item_id, {}))
    return snapshot


async def _fetch_tags(store_key: str) -> list[str]:
    from . import main as m
    data = await asyncio.wait_for(m.shopify_graphql(_TAGS_QUERY, {}, store=store_key), _TAGS_TIMEOUT_SECONDS)
    tags = sorted({str(tag) for node in (data.get("orders") or {}).get("nodes") or [] for tag in node.get("tags") or []})
    if len(_tags_cache) >= 200:
        expired = [key for key, (expires, _) in _tags_cache.items() if expires <= time.monotonic()]
        for key in expired:
            _tags_cache.pop(key, None)
        if len(_tags_cache) >= 200:
            _tags_cache.pop(next(iter(_tags_cache)))
    _tags_cache[store_key] = (time.monotonic() + _TAGS_TTL_SECONDS, tags)
    return tags


def _observe_tag_task(task: asyncio.Task) -> None:
    # A disconnected caller does not cancel shared work; consume failures even
    # when no caller remains to await the shared result.
    if not task.cancelled():
        task.exception()


@router.get("/api/order-tags")
async def order_tags(store: Optional[str] = Query(None), _user: User = Depends(get_current_user)):
    from . import main as m
    store_key = m.normalize_store_label(store)
    cached = _tags_cache.get(store_key)
    if cached and cached[0] > time.monotonic():
        return {"tags": list(cached[1])}
    task = _tags_tasks.get(store_key)
    if task is None or task.done():
        task = asyncio.create_task(_fetch_tags(store_key))
        task.add_done_callback(_observe_tag_task)
        _tags_tasks[store_key] = task
    try:
        return {"tags": list(await asyncio.shield(task))}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Tag suggestions are temporarily unavailable")


async def close_lookup_tasks() -> None:
    tasks = list(_tags_tasks.values())
    _tags_tasks.clear()
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    await close_membership_tasks()


router.add_event_handler("shutdown", close_lookup_tasks)
