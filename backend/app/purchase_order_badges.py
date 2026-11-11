"""Read-only, store-scoped purchase-order indicators for Collector variants.

Inventory Helper queue cards initially contain just their first product. Fetch
only the missing transfer membership, in bounded batches, without hydrating the
expensive image/counting details or changing the receiving record.
"""

import asyncio
import logging
import time
from typing import Any

from sqlalchemy import select

from .models import InventoryReceipt


logger = logging.getLogger(__name__)
_membership_cache: dict[tuple[str, str], tuple[float, str, list[dict[str, Any]]]] = {}
_store_locks: dict[str, asyncio.Lock] = {}
_membership_tasks: dict[str, asyncio.Task] = {}
_membership_failures: dict[tuple[str, str], float] = {}
_store_retry_after: dict[str, float] = {}
_CACHE_SECONDS = 300
_BACKGROUND_TIMEOUT_SECONDS = 90
_RETRY_SECONDS = 10
_MEMBERSHIP_QUERY = """
query PendingPurchaseOrderMembership($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on InventoryTransfer {
      id
      lineItems(first: 100) {
        nodes { id totalQuantity inventoryItem { id variant { id } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""
_MEMBERSHIP_PAGE_QUERY = """
query PendingPurchaseOrderMembershipPage($id: ID!, $after: String!) {
  inventoryTransfer(id: $id) {
    lineItems(first: 100, after: $after) {
      nodes { id totalQuantity inventoryItem { id variant { id } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""


def invalidate_purchase_order_membership(store: str, transfer_id: str | None = None) -> None:
    for key in list(_membership_cache):
        if key[0] == store and (transfer_id is None or key[1] == transfer_id):
            _membership_cache.pop(key, None)
            _membership_failures.pop(key, None)
    _store_retry_after.pop(store, None)


def _members_from_connection(connection: dict) -> list[dict[str, Any]]:
    members = []
    for item in connection.get("nodes") or []:
        inventory = item.get("inventoryItem") or {}
        members.append({
            "id": item.get("id"),
            "inventory_item_id": inventory.get("id"),
            "variant_id": (inventory.get("variant") or {}).get("id"),
            "ordered_quantity": item.get("totalQuantity") or 0,
        })
    return members


async def _load_memberships(store: str, rows: list, graphql, api_version: str) -> dict:
    """Single-flight membership fetch, with full pagination and bounded cost."""
    async with _store_locks.setdefault(store, asyncio.Lock()):
        now = time.monotonic()
        result = {}
        missing = []
        for row in rows:
            key = (store, row.shopify_order_gid)
            cached = _membership_cache.get(key)
            fingerprint = str(row.updated_at)
            if cached and cached[0] > now and cached[1] == fingerprint:
                result[row.id] = cached[2]
            else:
                missing.append(row)
        # Three transfers of 100 lines stay below Shopify's query cost limit.
        for start in range(0, len(missing), 3):
            batch = missing[start:start + 3]
            try:
                data = await graphql(
                    _MEMBERSHIP_QUERY,
                    {"ids": [row.shopify_order_gid for row in batch]},
                    store=store,
                    api_version=api_version,
                )
                by_id = {node["id"]: node for node in data.get("nodes") or [] if node}
                for row in batch:
                    if row.shopify_order_gid not in by_id:
                        raise ValueError("Shopify did not return the requested transfer membership")
                    connection = (by_id.get(row.shopify_order_gid) or {}).get("lineItems") or {}
                    members = _members_from_connection(connection)
                    page_info = connection.get("pageInfo") or {}
                    seen_cursors = set()
                    while page_info.get("hasNextPage"):
                        cursor = page_info.get("endCursor")
                        if not cursor or cursor in seen_cursors:
                            raise ValueError("Shopify transfer membership pagination was incomplete")
                        seen_cursors.add(cursor)
                        page = await graphql(
                            _MEMBERSHIP_PAGE_QUERY,
                            {"id": row.shopify_order_gid, "after": cursor},
                            store=store,
                            api_version=api_version,
                        )
                        if not page.get("inventoryTransfer"):
                            raise ValueError("Shopify transfer membership pagination was incomplete")
                        connection = (page.get("inventoryTransfer") or {}).get("lineItems") or {}
                        members.extend(_members_from_connection(connection))
                        page_info = connection.get("pageInfo") or {}
                    result[row.id] = members
                    _membership_failures.pop((store, row.shopify_order_gid), None)
                    _membership_cache[(store, row.shopify_order_gid)] = (
                        time.monotonic() + _CACHE_SECONDS, str(row.updated_at), members,
                    )
            except Exception:
                logger.warning("Could not load pending purchase-order membership for %s", store, exc_info=True)
                # Keep known preview membership and retry shortly; a receiving
                # API permission/network problem must not hide customer orders.
                for row in batch:
                    if row.id not in result:
                        cached = _membership_cache.get((store, row.shopify_order_gid))
                        members = list(cached[2] if cached and cached[1] == str(row.updated_at) else row.line_items or [])
                        result[row.id] = members
                        _membership_cache[(store, row.shopify_order_gid)] = (
                            time.monotonic() + 10, str(row.updated_at), members,
                        )
                        _membership_failures[(store, row.shopify_order_gid)] = time.monotonic() + _RETRY_SECONDS
        if len(_membership_cache) > 2000:
            for key, entry in list(_membership_cache.items()):
                if entry[0] <= time.monotonic():
                    _membership_cache.pop(key, None)
            while len(_membership_cache) > 2000:
                _membership_cache.pop(next(iter(_membership_cache)))
        return result


async def load_pending_receipts(db, store: str) -> list:
    """Read scalar snapshots, safe to use after the request session closes."""
    return (await db.execute(
        select(
            InventoryReceipt.id, InventoryReceipt.shopify_order_gid,
            InventoryReceipt.po_number, InventoryReceipt.order_number,
            InventoryReceipt.status, InventoryReceipt.shopify_details_loaded,
            InventoryReceipt.line_items, InventoryReceipt.updated_at, InventoryReceipt.expected_items,
        ).where(
            InventoryReceipt.store_key == store,
            InventoryReceipt.shopify_order_gid.like("gid://shopify/InventoryTransfer/%"),
            InventoryReceipt.status.notin_(("complete", "incomplete")),
        )
    )).all()


async def enrich_orders_with_purchase_orders(items: list, *, store: str, db, graphql, api_version: str) -> None:
    variants = [variant for order in items for variant in order.variants]
    if not variants:
        return
    # Query active records each time so completion is respected across instances.
    rows = await load_pending_receipts(db, store)
    unloaded = [row for row in rows if _needs_membership(row)]
    # Apply known membership before networking. If the caller's short deadline
    # cancels hydration, badges still use store-scoped cached/preview data.
    known = {}
    for row in unloaded:
        cached = _membership_cache.get((store, row.shopify_order_gid))
        if cached and cached[1] == str(row.updated_at):
            known[row.id] = cached[2]
    _apply_memberships(variants, rows, known, complete=_membership_complete(store, unloaded))
    if unloaded:
        memberships = await _load_memberships(store, unloaded, graphql, api_version)
        _apply_memberships(variants, rows, memberships, complete=_membership_complete(store, unloaded))


def purchase_order_snapshot(variants: list, rows: list, *, store: str, graphql, api_version: str) -> dict:
    """Return badges immediately; hydrate cold membership once per store.

    The caller must close its DB session before calling this function. Only
    scalar receipt rows are retained by the shared task, never request sessions.
    Expired known data remains visible while it refreshes, matching legacy
    deadline behavior. `loading`/`unavailable` prevent claiming absence as final.
    """
    now = time.monotonic()
    known = {}
    unloaded = [row for row in rows if _needs_membership(row)]
    needs_refresh = []
    unavailable = False
    for row in unloaded:
        key = (store, row.shopify_order_gid)
        cached = _membership_cache.get(key)
        same_version = cached and cached[1] == str(row.updated_at)
        if same_version:
            known[row.id] = cached[2]
        failed = _membership_failures.get(key, 0) > now
        if failed:
            unavailable = True
        if not same_version or cached[0] <= now or key in _membership_failures:
            needs_refresh.append(row)
    _apply_memberships(variants, rows, known, complete=_membership_complete(store, unloaded))
    task = _membership_tasks.get(store)
    if needs_refresh and (task is None or task.done()):
        if _store_retry_after.get(store, 0) > now:
            unavailable = True
        elif not unavailable:
            task = asyncio.create_task(_refresh_memberships(store, unloaded, graphql, api_version))
            _membership_tasks[store] = task
    loading = bool(needs_refresh and task is not None and not task.done())
    return {
        "badges": {variant.id: list(variant.pending_purchase_orders) for variant in variants},
        "stock": {
            variant.id: {"pending_purchase_order_quantity": variant.pending_purchase_order_quantity}
            for variant in variants
        },
        "loading": loading,
        "unavailable": unavailable,
    }


async def _refresh_memberships(store: str, rows: list, graphql, api_version: str) -> None:
    try:
        await asyncio.wait_for(_load_memberships(store, rows, graphql, api_version), _BACKGROUND_TIMEOUT_SECONDS)
    except asyncio.CancelledError:
        raise
    except Exception:
        _store_retry_after[store] = time.monotonic() + _RETRY_SECONDS
        logger.warning("Background purchase-order membership refresh failed for %s", store, exc_info=True)


async def close_membership_tasks() -> None:
    tasks = list(_membership_tasks.values())
    _membership_tasks.clear()
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def _needs_membership(row) -> bool:
    if row.shopify_details_loaded:
        return False
    # A preview that accounts for the transfer's entire Shopify quantity already
    # identifies every line with a positive quantity.
    preview_total = sum(int(item.get("shopify_quantity") or 0) for item in row.line_items or [])
    expected = getattr(row, "expected_items", 0)
    return not (expected > 0 and preview_total == expected)


def _membership_complete(store: str, unloaded: list) -> bool:
    now = time.monotonic()
    for row in unloaded:
        cached = _membership_cache.get((store, row.shopify_order_gid))
        if not cached or cached[0] <= now or cached[1] != str(row.updated_at) or (store, row.shopify_order_gid) in _membership_failures:
            return False
    return True


def _apply_memberships(variants: list, rows: list, memberships: dict, *, complete: bool) -> None:
    by_inventory: dict[str, dict] = {}
    by_variant: dict[str, dict] = {}
    for row in rows:
        ref = {"id": row.id, "number": row.po_number or row.order_number, "status": row.status}
        members = memberships.get(row.id, row.line_items)
        for member in members or []:
            ordered = int(member.get("ordered_quantity") or 0)
            applied = member.get("inventory_applied_quantity")
            if applied is None:
                applied = member.get("shopify_received_quantity")
            remaining = max(0, ordered - max(0, int(applied or 0)))
            if remaining == 0:
                continue
            inventory_id = member.get("inventory_item_id")
            variant_id = member.get("variant_id")
            # Duplicate snapshots of the same Shopify line must not inflate the
            # amount. Separate lines for one variant still count together.
            line_key = (row.id, member.get("id") or (inventory_id, variant_id))
            for index, key in ((by_inventory, inventory_id), (by_variant, variant_id)):
                if key:
                    index.setdefault(str(key), {})[line_key] = (ref, remaining)
    for variant in variants:
        lines = {
            **by_variant.get(str(variant.id), {}),
            **by_inventory.get(str(variant.inventory_item_id), {}),
        }
        refs = {}
        for ref, remaining in lines.values():
            current = refs.setdefault(ref["id"], {**ref, "quantity": 0})
            current["quantity"] += remaining
        variant.pending_purchase_orders = list(refs.values())
        variant.pending_purchase_order_quantity = (
            sum(ref["quantity"] for ref in refs.values()) if complete and (variant.id or variant.inventory_item_id) else None
        )
