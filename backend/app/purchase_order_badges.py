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
_CACHE_SECONDS = 300
_MEMBERSHIP_QUERY = """
query PendingPurchaseOrderMembership($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on InventoryTransfer {
      id
      lineItems(first: 100) {
        nodes { totalQuantity inventoryItem { id variant { id } } }
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
      nodes { totalQuantity inventoryItem { id variant { id } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""


def invalidate_purchase_order_membership(store: str, transfer_id: str | None = None) -> None:
    for key in list(_membership_cache):
        if key[0] == store and (transfer_id is None or key[1] == transfer_id):
            _membership_cache.pop(key, None)


def _members_from_connection(connection: dict) -> list[dict[str, Any]]:
    members = []
    for item in connection.get("nodes") or []:
        inventory = item.get("inventoryItem") or {}
        members.append({
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
                        connection = (page.get("inventoryTransfer") or {}).get("lineItems") or {}
                        members.extend(_members_from_connection(connection))
                        page_info = connection.get("pageInfo") or {}
                    result[row.id] = members
                    _membership_cache[(store, row.shopify_order_gid)] = (
                        time.monotonic() + _CACHE_SECONDS, str(row.updated_at), members,
                    )
            except Exception:
                logger.warning("Could not load pending purchase-order membership for %s", store, exc_info=True)
                # Keep known preview membership and retry shortly; a receiving
                # API permission/network problem must not hide customer orders.
                for row in batch:
                    if row.id not in result:
                        members = list(row.line_items or [])
                        result[row.id] = members
                        _membership_cache[(store, row.shopify_order_gid)] = (
                            time.monotonic() + 10, str(row.updated_at), members,
                        )
        if len(_membership_cache) > 2000:
            for key, entry in list(_membership_cache.items()):
                if entry[0] <= time.monotonic():
                    _membership_cache.pop(key, None)
            while len(_membership_cache) > 2000:
                _membership_cache.pop(next(iter(_membership_cache)))
        return result


async def enrich_orders_with_purchase_orders(items: list, *, store: str, db, graphql, api_version: str) -> None:
    variants = [variant for order in items for variant in order.variants]
    if not variants:
        return
    # Query active records each time so completion is respected across instances,
    # even when another worker still has transfer membership cached.
    rows = (await db.execute(
        select(
            InventoryReceipt.id, InventoryReceipt.shopify_order_gid,
            InventoryReceipt.po_number, InventoryReceipt.order_number,
            InventoryReceipt.status, InventoryReceipt.shopify_details_loaded,
            InventoryReceipt.line_items, InventoryReceipt.updated_at,
        ).where(
            InventoryReceipt.store_key == store,
            InventoryReceipt.shopify_order_gid.like("gid://shopify/InventoryTransfer/%"),
            InventoryReceipt.status.notin_(("complete", "incomplete")),
        )
    )).all()
    unloaded = [row for row in rows if not row.shopify_details_loaded]
    # Apply known membership before networking. If the caller's short deadline
    # cancels hydration, badges still use store-scoped cached/preview data.
    known = {}
    for row in unloaded:
        cached = _membership_cache.get((store, row.shopify_order_gid))
        if cached and cached[1] == str(row.updated_at):
            known[row.id] = cached[2]
    _apply_memberships(variants, rows, known)
    if unloaded:
        memberships = await _load_memberships(store, unloaded, graphql, api_version)
        _apply_memberships(variants, rows, memberships)


def _apply_memberships(variants: list, rows: list, memberships: dict) -> None:
    by_inventory: dict[str, list] = {}
    by_variant: dict[str, list] = {}
    for row in rows:
        ref = {"id": row.id, "number": row.po_number or row.order_number, "status": row.status}
        members = row.line_items if row.shopify_details_loaded else memberships.get(row.id, row.line_items)
        for member in members or []:
            if int(member.get("ordered_quantity") or 0) <= 0:
                continue
            for index, key in ((by_inventory, member.get("inventory_item_id")), (by_variant, member.get("variant_id"))):
                if key and ref not in index.setdefault(str(key), []):
                    index[str(key)].append(ref)
    for variant in variants:
        refs = by_inventory.get(str(variant.inventory_item_id)) or by_variant.get(str(variant.id)) or []
        variant.pending_purchase_orders = list(refs)
