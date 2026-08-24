"""Inventory Helper API: browse Shopify transfers and reconcile received stock."""

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
import json
import os
import re
from typing import Any, Literal, Optional
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .auth_routes import get_current_user, require_admin
from .db import get_session
from .models import InventoryReceipt, InventoryReceiptPhoto, User


router = APIRouter(prefix="/api/inventory-helper", tags=["inventory-helper"])

_MAX_PHOTOS = 4
_MAX_PHOTO_BYTES = 6 * 1024 * 1024
_ALLOWED_PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}

_TRANSFER_API_VERSION = os.environ.get("SHOPIFY_INVENTORY_API_VERSION", "2026-07").strip()

_TRANSFER_LINE_ITEM_FIELDS = """
  id
  title
  totalQuantity
  inventoryItem {
    id
    sku
    variant {
      id
      title
      selectedOptions { name value }
      image { url altText }
      product {
        title
        featuredMedia { preview { image { url altText } } }
      }
    }
  }
"""

_TRANSFER_CORE_FIELDS = """
  id
  name
  referenceName
  dateCreated
  status
  note
  tags
  totalQuantity
  destination {
    name
    location { id name }
  }
  lineItems(first: 100) {
    nodes {
""" + _TRANSFER_LINE_ITEM_FIELDS + """
    }
    pageInfo { hasNextPage endCursor }
  }
"""

_TRANSFER_CARD_FIELDS = """
  id
  name
  referenceName
  dateCreated
  status
  note
  tags
  totalQuantity
  destination {
    name
    location { id name }
  }
  lineItems(first: 1) {
    nodes {
""" + _TRANSFER_LINE_ITEM_FIELDS + """
    }
  }
"""

_TRANSFER_DETAIL_FIELDS = _TRANSFER_CORE_FIELDS + """
  shipments(first: 2) {
    nodes {
      id
      name
      status
      lineItems(first: 100) {
        nodes {
          id
          quantity
          acceptedQuantity
          rejectedQuantity
          unreceivedQuantity
          inventoryItem { id }
        }
      }
    }
  }
"""

_INVENTORY_LEVELS_QUERY = """
query InventoryHelperLevels($ids: [ID!]!, $locationId: ID!) {
  nodes(ids: $ids) {
    ... on InventoryItem {
      id
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) { name quantity }
      }
    }
  }
}
"""

_INVENTORY_ADJUST_MUTATION = """
mutation InventoryHelperAdjust(
  $input: InventoryAdjustQuantitiesInput!
  $idempotencyKey: String!
) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    userErrors { field message }
    inventoryAdjustmentGroup {
      createdAt
      reason
      changes { name delta }
    }
  }
}
"""

_SHIPMENT_MARK_IN_TRANSIT_MUTATION = """
mutation InventoryHelperMarkShipmentInTransit($id: ID!, $dateShipped: DateTime) {
  inventoryShipmentMarkInTransit(id: $id, dateShipped: $dateShipped) {
    userErrors { field message }
    inventoryShipment { id status }
  }
}
"""

_SHIPMENT_RECEIVE_MUTATION = """
mutation InventoryHelperReceiveShipment(
  $id: ID!
  $lineItems: [InventoryShipmentReceiveItemInput!]
  $idempotencyKey: String!
) {
  inventoryShipmentReceive(id: $id, lineItems: $lineItems) @idempotent(key: $idempotencyKey) {
    userErrors { field message }
    inventoryShipment { id status }
  }
}
"""


class InventoryLineItemInput(BaseModel):
    id: str
    variant_id: Optional[str] = None
    title: str
    variant_title: Optional[str] = None
    variant_color: Optional[str] = None
    variant_size: Optional[str] = None
    selected_options: list[dict[str, str]] = Field(default_factory=list)
    sku: Optional[str] = None
    image_url: Optional[str] = None
    inventory_item_id: Optional[str] = None
    destination_location_id: Optional[str] = None
    destination_name: Optional[str] = None
    shopify_quantity: int = Field(ge=0)
    ordered_quantity: int = Field(ge=0)
    actual_quantity: Optional[int] = Field(default=None, ge=0)
    shopify_received_quantity: int = Field(default=0, ge=0)
    inventory_applied_quantity: int = Field(default=0, ge=0)
    inventory_synced_at: Optional[str] = None


class InventoryReceiptCreate(BaseModel):
    store: str
    shopify_order_gid: str
    order_number: str
    po_number: Optional[str] = None
    shopify_created_at: Optional[str] = None
    shopify_tags: list[str] = Field(default_factory=list)
    ordered_crates: int = Field(ge=0)
    line_items: list[InventoryLineItemInput]


class InventoryAdminUpdate(BaseModel):
    ordered_crates: int = Field(ge=0)
    line_items: list[InventoryLineItemInput]


class InventoryCountLineItemInput(BaseModel):
    id: str
    actual_quantity: int = Field(ge=0)


class InventoryCountUpdate(BaseModel):
    actual_crates: int = Field(ge=0)
    total_items_received: int = Field(ge=0)
    line_items: list[InventoryCountLineItemInput] = Field(default_factory=list)
    sync_inventory: bool = True
    agent_note: Optional[str] = Field(default=None, max_length=2000)


class InventoryFinalizeUpdate(BaseModel):
    outcome: Literal["complete", "incomplete"]


def _clean_store(value: str) -> str:
    store = (value or "").strip().lower()
    if not store or len(store) > 63 or not all(c.isalnum() or c in "_-" for c in store):
        raise HTTPException(status_code=400, detail="invalid store")
    return store


def _status(
    expected_crates: int,
    expected_items: int,
    actual_crates: Optional[int],
    actual_items: Optional[int],
    line_items: Optional[list[dict[str, Any]]] = None,
    reported_items_received: Optional[int] = None,
) -> str:
    if actual_crates is None or actual_items is None:
        return "waiting"
    crates_match = actual_crates == expected_crates
    counted_variants = [item for item in (line_items or []) if item.get("actual_quantity") is not None]
    variants_match = not counted_variants or (
        len(counted_variants) == len(line_items or [])
        and all(
            int(item.get("actual_quantity") or 0) == int(item.get("ordered_quantity") or 0)
            for item in counted_variants
        )
    )
    reported_match = (
        reported_items_received is None
        or reported_items_received == actual_items
    )
    if crates_match and actual_items == expected_items and variants_match and reported_match:
        return "matched"
    return "mismatch"


def _person(user: Optional[User]) -> Optional[dict[str, Any]]:
    if not user:
        return None
    return {"id": user.id, "name": user.name, "email": user.email}


def _serialize(row: InventoryReceipt) -> dict[str, Any]:
    return {
        "id": row.id,
        "store": row.store_key,
        "shopify_order_gid": row.shopify_order_gid,
        "order_number": row.order_number,
        "po_number": row.po_number,
        "shopify_created_at": row.shopify_created_at,
        "shopify_tags": row.shopify_tags or [],
        "shopify_details_loaded": bool(row.shopify_details_loaded),
        "line_items": row.line_items or [],
        "ordered_crates": row.ordered_crates,
        "expected_items": row.expected_items,
        "actual_crates": row.actual_crates,
        "actual_items": row.actual_items,
        "reported_items_received": row.reported_items_received,
        "agent_note": row.agent_note or "",
        "status": row.status,
        "count_result": _status(
            row.ordered_crates,
            row.expected_items,
            row.actual_crates,
            row.actual_items,
            list(row.line_items or []),
            row.reported_items_received,
        ),
        "created_by": _person(row.created_by),
        "counted_by": _person(row.counted_by),
        "counted_at": row.counted_at.isoformat() if row.counted_at else None,
        "finalized_at": row.finalized_at.isoformat() if row.finalized_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "photos": [
            {
                "id": photo.id,
                "filename": photo.filename,
                "content_type": photo.content_type,
                "uploaded_by_id": photo.uploaded_by_id,
                "created_at": photo.created_at.isoformat() if photo.created_at else None,
                "url": f"/api/inventory-helper/photos/{photo.id}",
            }
            for photo in sorted(row.photos or [], key=lambda item: item.id)
        ],
    }


def _shipment_state(transfer: dict[str, Any]) -> dict[str, dict[str, Any]]:
    state: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"accepted_quantity": 0, "lines": []}
    )
    for shipment in (((transfer.get("shipments") or {}).get("nodes")) or []):
        for line in (((shipment.get("lineItems") or {}).get("nodes")) or []):
            inventory_item_id = str(((line.get("inventoryItem") or {}).get("id")) or "")
            if not inventory_item_id:
                continue
            state[inventory_item_id]["accepted_quantity"] += max(
                0, int(line.get("acceptedQuantity") or 0)
            )
            state[inventory_item_id]["lines"].append(
                {
                    "shipment_id": shipment.get("id"),
                    "shipment_status": shipment.get("status"),
                    "shipment_line_item_id": line.get("id"),
                    "unreceived_quantity": max(0, int(line.get("unreceivedQuantity") or 0)),
                }
            )
    return dict(state)


def _variant_dimensions(variant: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    color: Optional[str] = None
    size: Optional[str] = None
    color_names = {"color", "colour", "couleur", "colore", "farbe", "لون"}
    size_names = {
        "size",
        "taille",
        "pointure",
        "shoe size",
        "eu size",
        "uk size",
        "us size",
        "größe",
        "tamanho",
        "مقاس",
    }
    for option in variant.get("selectedOptions") or []:
        name = str(option.get("name") or "").strip().casefold()
        value = str(option.get("value") or "").strip() or None
        if name in color_names and value:
            color = value
        elif name in size_names and value:
            size = value

    # Legacy cards saved before selectedOptions were retained normally use
    # Shopify's "Color / Size" variant-title format.
    if color is None and size is None:
        parts = [part.strip() for part in str(variant.get("title") or "").split("/") if part.strip()]
        if len(parts) >= 2:
            color, size = parts[0], parts[-1]
    return color, size


def _line_items_from_shopify(transfer: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    destination = transfer.get("destination") or {}
    destination_location = destination.get("location") or {}
    shipment_state = _shipment_state(transfer)
    for item in (((transfer.get("lineItems") or {}).get("nodes")) or []):
        inventory_item = item.get("inventoryItem") or {}
        variant = inventory_item.get("variant") or {}
        product = variant.get("product") or {}
        product_preview = (((product.get("featuredMedia") or {}).get("preview")) or {})
        image = variant.get("image") or product_preview.get("image") or {}
        variant_color, variant_size = _variant_dimensions(variant)
        quantity = max(0, int(item.get("totalQuantity") or 0))
        inventory_item_id = inventory_item.get("id")
        received_quantity = int(
            ((shipment_state.get(str(inventory_item_id)) or {}).get("accepted_quantity")) or 0
        )
        result.append(
            {
                "id": str(item.get("id") or inventory_item.get("id") or len(result)),
                "variant_id": variant.get("id"),
                "title": product.get("title") or item.get("title") or "Untitled item",
                "variant_title": variant.get("title"),
                "variant_color": variant_color,
                "variant_size": variant_size,
                "selected_options": [
                    {
                        "name": str(option.get("name") or ""),
                        "value": str(option.get("value") or ""),
                    }
                    for option in (variant.get("selectedOptions") or [])
                ],
                "sku": inventory_item.get("sku"),
                "image_url": image.get("url"),
                "image_alt": image.get("altText"),
                "inventory_item_id": inventory_item_id,
                "destination_location_id": destination_location.get("id"),
                "destination_name": destination_location.get("name") or destination.get("name"),
                "shopify_quantity": quantity,
                "ordered_quantity": quantity,
                "actual_quantity": None,
                "shopify_received_quantity": received_quantity,
                "inventory_applied_quantity": received_quantity,
                "inventory_synced_at": None,
            }
        )
    return result


def _shopify_transfer_payload(transfer: dict[str, Any], store_key: str) -> dict[str, Any]:
    items = _line_items_from_shopify(transfer)
    display_name = transfer.get("referenceName") or transfer.get("name") or "Shopify transfer"
    transfer_name = transfer.get("name")
    destination = transfer.get("destination") or {}
    location = destination.get("location") or {}
    tags = [str(tag).strip() for tag in (transfer.get("tags") or []) if str(tag).strip()]
    return {
        "store": store_key,
        "shopify_order_gid": transfer.get("id"),
        "order_number": display_name,
        "po_number": transfer_name if transfer_name != display_name else None,
        "shopify_created_at": transfer.get("dateCreated"),
        "shopify_tags": tags,
        "ordered_crates": _ordered_crates_from_tags(tags),
        "transfer_status": transfer.get("status"),
        "destination_name": location.get("name") or destination.get("name"),
        "line_items": items,
        "expected_items": max(
            0,
            int(
                transfer.get("totalQuantity")
                if transfer.get("totalQuantity") is not None
                else sum(item["ordered_quantity"] for item in items)
            ),
        ),
    }


def _date_search_query(selected_date: date) -> str:
    return _date_range_search_query(selected_date, selected_date)


def _date_range_search_query(start_date: date, end_date: date) -> str:
    if end_date < start_date:
        raise ValueError("The end date must be on or after the start date")
    local_tz = ZoneInfo("Africa/Casablanca")
    start_local = datetime.combine(start_date, time.min, tzinfo=local_tz)
    end_local = datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=local_tz)
    start_utc = start_local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    end_utc = end_local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"created_at:>={start_utc} created_at:<{end_utc}"


def _ordered_crates_from_tags(tags: list[str]) -> int:
    """Extract the PO crate plan from Shopify transfer tags.

    A pure numeric tag is the primary convention (for example ``2`` means two
    crates). Labeled forms are accepted as a forgiving fallback.
    """
    cleaned = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    labeled = re.compile(
        r"(?i)(?:crates?|boxes?)\s*[:#x-]?\s*(\d+)|(\d+)\s*(?:crates?|boxes?)"
    )
    for tag in cleaned:
        match = labeled.fullmatch(tag)
        if match:
            return max(0, int(match.group(1) or match.group(2)))
    for tag in cleaned:
        if re.fullmatch(r"\d+", tag):
            return max(0, int(tag))
    return 0


def _final_receipt_status(ordered_crates: int, actual_crates: int) -> str:
    return "complete" if int(actual_crates) == int(ordered_crates) else "incomplete"


def _stored_receipt_date_prefixes(selected_date: date) -> tuple[str, str]:
    """Return both date encodings found in existing transfer cards."""
    return selected_date.isoformat(), selected_date.strftime("%m/%d/%Y")


def _stored_receipt_range_prefixes(start_date: date, end_date: date) -> list[str]:
    if end_date < start_date:
        raise ValueError("The end date must be on or after the start date")
    if (end_date - start_date).days > 366:
        raise ValueError("Choose a period of 367 days or less")
    prefixes: list[str] = []
    current = start_date
    while current <= end_date:
        prefixes.extend(_stored_receipt_date_prefixes(current))
        current += timedelta(days=1)
    return prefixes


def _stable_key(*parts: Any) -> str:
    canonical = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
    return str(uuid5(NAMESPACE_URL, canonical))


def _user_error_message(payload: dict[str, Any], operation: str) -> Optional[str]:
    errors = (payload or {}).get("userErrors") or []
    if not errors:
        return None
    messages = "; ".join(str(error.get("message") or "Unknown Shopify error") for error in errors)
    return f"Shopify could not {operation}: {messages}"


async def _loaded_receipt(db: AsyncSession, receipt_id: int) -> InventoryReceipt:
    row = await db.scalar(
        select(InventoryReceipt)
        .options(
            selectinload(InventoryReceipt.created_by),
            selectinload(InventoryReceipt.counted_by),
            selectinload(InventoryReceipt.photos),
        )
        .where(InventoryReceipt.id == receipt_id)
    )
    if not row:
        raise HTTPException(status_code=404, detail="inventory record not found")
    return row


def _ensure_receipt_open(row: InventoryReceipt) -> None:
    if row.status in {"complete", "incomplete"}:
        raise HTTPException(
            status_code=409,
            detail="This purchase order is already in received history and can no longer be edited",
        )


async def _shopify_transfer_by_id(store_key: str, transfer_id: str, *, detailed: bool) -> dict[str, Any]:
    from .main import shopify_graphql

    fields = _TRANSFER_DETAIL_FIELDS if detailed else _TRANSFER_CORE_FIELDS
    query = f"query InventoryHelperTransferById($id: ID!) {{ inventoryTransfer(id: $id) {{ {fields} }} }}"
    data = await shopify_graphql(
        query,
        {"id": transfer_id},
        store=store_key,
        api_version=_TRANSFER_API_VERSION,
    )
    transfer = data.get("inventoryTransfer")
    if not transfer:
        raise HTTPException(status_code=404, detail="The linked Shopify inventory transfer no longer exists")
    connection = transfer.get("lineItems") or {}
    nodes = list(connection.get("nodes") or [])
    page_info = connection.get("pageInfo") or {}
    after = page_info.get("endCursor")
    page_query = f"query InventoryHelperTransferLines($id: ID!, $after: String!) {{ inventoryTransfer(id: $id) {{ lineItems(first: 100, after: $after) {{ nodes {{ {_TRANSFER_LINE_ITEM_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }} }} }}"
    while page_info.get("hasNextPage") and after:
        page_data = await shopify_graphql(
            page_query,
            {"id": transfer_id, "after": after},
            store=store_key,
            api_version=_TRANSFER_API_VERSION,
        )
        next_connection = ((page_data.get("inventoryTransfer") or {}).get("lineItems") or {})
        nodes.extend(next_connection.get("nodes") or [])
        page_info = next_connection.get("pageInfo") or {}
        after = page_info.get("endCursor")
    transfer["lineItems"] = {"nodes": nodes, "pageInfo": page_info}
    return transfer


def _translate_shopify_access_error(exc: HTTPException) -> None:
    detail = str(exc.detail)
    upper = detail.upper()
    if exc.status_code == 502 and any(
        marker in upper
        for marker in (
            "ACCESS_DENIED",
            "ACCESS DENIED",
            "INVENTORYTRANSFERS",
            "INVENTORYSHIPMENT",
        )
    ):
        raise HTTPException(
            status_code=403,
            detail="Reconnect this Shopify store to grant Inventory Helper transfer, shipment, and inventory permissions.",
        ) from exc
    raise exc


def _merge_admin_items(
    stored_items: list[dict[str, Any]], submitted_items: list[InventoryLineItemInput]
) -> list[dict[str, Any]]:
    submitted = {item.id: item for item in submitted_items}
    if set(submitted) != {str(item.get("id")) for item in stored_items}:
        raise HTTPException(status_code=400, detail="The purchase-order variants changed; refresh and try again")
    merged: list[dict[str, Any]] = []
    for stored in stored_items:
        item = dict(stored)
        item["ordered_quantity"] = submitted[str(stored.get("id"))].ordered_quantity
        merged.append(item)
    return merged


def _build_inventory_sync_plan(
    stored_items: list[dict[str, Any]],
    submitted_items: list[InventoryCountLineItemInput],
    transfer: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], list[dict[str, Any]]]:
    desired_by_id = {item.id: item.actual_quantity for item in submitted_items}
    stored_by_id = {str(item.get("id")): item for item in stored_items}
    if not desired_by_id or set(desired_by_id) != set(stored_by_id):
        raise HTTPException(status_code=400, detail="Enter a received quantity for every variant")

    authoritative_items = {
        str(item.get("id")): item for item in _line_items_from_shopify(transfer)
    }
    if not set(stored_by_id).issubset(authoritative_items):
        raise HTTPException(
            status_code=409,
            detail="The Shopify transfer variants changed. Re-add this transfer before changing inventory.",
        )

    shipment_state = _shipment_state(transfer)
    receive_groups: dict[str, dict[str, Any]] = {}
    adjustments: list[dict[str, Any]] = []
    merged: list[dict[str, Any]] = []

    for line_id, stored in stored_by_id.items():
        authoritative = authoritative_items[line_id]
        inventory_item_id = str(authoritative.get("inventory_item_id") or "")
        location_id = str(authoritative.get("destination_location_id") or "")
        if not inventory_item_id or not location_id:
            raise HTTPException(
                status_code=409,
                detail=f"{authoritative.get('title') or 'A variant'} is not stocked at a Shopify destination location.",
            )

        desired = int(desired_by_id[line_id])
        received_now = int(
            ((shipment_state.get(inventory_item_id) or {}).get("accepted_quantity")) or 0
        )
        stored_applied = int(stored.get("inventory_applied_quantity") or 0)
        received_before = int(
            stored.get("shopify_received_quantity")
            if stored.get("shopify_received_quantity") is not None
            else received_now
        )
        # A retry after Shopify succeeded but before our database commit sees
        # the newly accepted shipment quantity here and won't apply it twice.
        applied_before = stored_applied + max(0, received_now - received_before)
        remaining_delta = desired - applied_before

        if remaining_delta > 0:
            for shipment_line in (shipment_state.get(inventory_item_id) or {}).get("lines", []):
                available_to_receive = int(shipment_line.get("unreceived_quantity") or 0)
                if available_to_receive <= 0 or remaining_delta <= 0:
                    continue
                shipment_id = str(shipment_line.get("shipment_id") or "")
                shipment_line_id = str(shipment_line.get("shipment_line_item_id") or "")
                if not shipment_id or not shipment_line_id:
                    continue
                quantity = min(remaining_delta, available_to_receive)
                group = receive_groups.setdefault(
                    shipment_id,
                    {
                        "status": shipment_line.get("shipment_status"),
                        "line_items": [],
                    },
                )
                group["line_items"].append(
                    {
                        "shipmentLineItemId": shipment_line_id,
                        "quantity": quantity,
                        "reason": "ACCEPTED",
                    }
                )
                remaining_delta -= quantity

        if remaining_delta:
            adjustments.append(
                {
                    "inventory_item_id": inventory_item_id,
                    "location_id": location_id,
                    "delta": remaining_delta,
                    "title": authoritative.get("title"),
                }
            )

        next_item = {
            **authoritative,
            "ordered_quantity": int(stored.get("ordered_quantity") or 0),
            "actual_quantity": desired,
            "shopify_received_quantity": received_now + max(0, desired - applied_before - remaining_delta),
            "inventory_applied_quantity": desired,
            "inventory_synced_at": datetime.now(timezone.utc).isoformat(),
        }
        merged.append(next_item)

    return merged, receive_groups, adjustments


async def _receive_inventory_shipments(
    store_key: str,
    receipt_id: int,
    receive_groups: dict[str, dict[str, Any]],
    transition: str,
) -> list[dict[str, Any]]:
    from .main import shopify_graphql

    operations: list[dict[str, Any]] = []
    for shipment_id, group in receive_groups.items():
        if group.get("status") == "DRAFT":
            data = await shopify_graphql(
                _SHIPMENT_MARK_IN_TRANSIT_MUTATION,
                {"id": shipment_id, "dateShipped": datetime.now(timezone.utc).isoformat()},
                store=store_key,
                api_version=_TRANSFER_API_VERSION,
            )
            error = _user_error_message(data.get("inventoryShipmentMarkInTransit") or {}, "mark the shipment in transit")
            if error:
                raise HTTPException(status_code=409, detail=error)

        line_items = group.get("line_items") or []
        data = await shopify_graphql(
            _SHIPMENT_RECEIVE_MUTATION,
            {
                "id": shipment_id,
                "lineItems": line_items,
                "idempotencyKey": _stable_key("receive", store_key, receipt_id, transition, shipment_id, line_items),
            },
            store=store_key,
            api_version=_TRANSFER_API_VERSION,
        )
        error = _user_error_message(data.get("inventoryShipmentReceive") or {}, "receive the shipment")
        if error:
            raise HTTPException(status_code=409, detail=error)
        operations.append(
            {
                "type": "shipment_receive",
                "quantity": sum(int(item["quantity"]) for item in line_items),
                "shipment_id": shipment_id,
            }
        )
    return operations


async def _adjust_inventory_quantities(
    store_key: str,
    receipt_id: int,
    adjustments: list[dict[str, Any]],
    transition: str,
) -> list[dict[str, Any]]:
    if not adjustments:
        return []

    from .main import shopify_graphql

    location_ids = {item["location_id"] for item in adjustments}
    if len(location_ids) != 1:
        raise HTTPException(status_code=409, detail="A receipt can update only one Shopify destination location")
    location_id = next(iter(location_ids))
    ids = [item["inventory_item_id"] for item in adjustments]
    levels_data = await shopify_graphql(
        _INVENTORY_LEVELS_QUERY,
        {"ids": ids, "locationId": location_id},
        store=store_key,
        api_version=_TRANSFER_API_VERSION,
    )
    available_by_id: dict[str, int] = {}
    for node in levels_data.get("nodes") or []:
        if not node:
            continue
        level = node.get("inventoryLevel") or {}
        available = next(
            (entry.get("quantity") for entry in (level.get("quantities") or []) if entry.get("name") == "available"),
            None,
        )
        if available is not None:
            available_by_id[str(node.get("id"))] = int(available)
    missing = [item["title"] or item["inventory_item_id"] for item in adjustments if item["inventory_item_id"] not in available_by_id]
    if missing:
        raise HTTPException(
            status_code=409,
            detail=f"These variants are not active at the transfer destination: {', '.join(missing)}",
        )

    changes = [
        {
            "inventoryItemId": item["inventory_item_id"],
            "locationId": item["location_id"],
            "delta": item["delta"],
            "changeFromQuantity": available_by_id[item["inventory_item_id"]],
        }
        for item in adjustments
    ]
    data = await shopify_graphql(
        _INVENTORY_ADJUST_MUTATION,
        {
            "input": {
                "name": "available",
                "reason": "correction",
                "referenceDocumentUri": f"gid://inventory-helper/Receipt/{receipt_id}",
                "changes": changes,
            },
            "idempotencyKey": _stable_key(
                "adjust",
                store_key,
                receipt_id,
                transition,
                [
                    {
                        "inventoryItemId": item["inventoryItemId"],
                        "locationId": item["locationId"],
                        "delta": item["delta"],
                    }
                    for item in changes
                ],
            ),
        },
        store=store_key,
        api_version=_TRANSFER_API_VERSION,
    )
    error = _user_error_message(data.get("inventoryAdjustQuantities") or {}, "adjust inventory")
    if error:
        status = 409 if "STALE" in error.upper() else 400
        raise HTTPException(status_code=status, detail=error)

    # Read back the latest Shopify quantities so the agent sees concrete proof
    # of what changed instead of a generic success message. A concurrent order
    # can move available stock again immediately, so expose both the expected
    # post-adjustment value and Shopify's latest value without treating that
    # later movement as a failed mutation.
    verify_data = await shopify_graphql(
        _INVENTORY_LEVELS_QUERY,
        {"ids": ids, "locationId": location_id},
        store=store_key,
        api_version=_TRANSFER_API_VERSION,
    )
    latest_by_id: dict[str, int] = {}
    for node in verify_data.get("nodes") or []:
        if not node:
            continue
        level = node.get("inventoryLevel") or {}
        available = next(
            (entry.get("quantity") for entry in (level.get("quantities") or []) if entry.get("name") == "available"),
            None,
        )
        if available is not None:
            latest_by_id[str(node.get("id"))] = int(available)

    return [
        {
            "type": "inventory_adjustment",
            "inventory_item_id": item["inventory_item_id"],
            "title": item.get("title"),
            "delta": int(item["delta"]),
            "before_quantity": available_by_id[item["inventory_item_id"]],
            "expected_after_quantity": available_by_id[item["inventory_item_id"]] + int(item["delta"]),
            "after_quantity": latest_by_id.get(item["inventory_item_id"]),
        }
        for item in adjustments
    ]


@router.get("/lookup")
async def lookup_shopify_order(
    reference: str = Query(..., min_length=1, max_length=128),
    store: str = Query(...),
    _: User = Depends(require_admin),
):
    """Find the inventory transfer linked to a Shopify purchase order."""
    from .main import shopify_graphql

    ref = reference.strip()
    store_key = _clean_store(store)
    transfer: Optional[dict[str, Any]] = None

    try:
        if ref.startswith("gid://shopify/InventoryTransfer/"):
            transfer = await _shopify_transfer_by_id(store_key, ref, detailed=False)
        else:
            normalized = ref.lstrip("#").replace('"', "").strip()
            query = f"query InventoryHelperTransfer($query: String!) {{ inventoryTransfers(first: 20, query: $query, sortKey: CREATED_AT, reverse: true) {{ nodes {{ {_TRANSFER_CARD_FIELDS} }} }} }}"
            data = await shopify_graphql(
                query,
                {"query": normalized},
                store=store_key,
                api_version=_TRANSFER_API_VERSION,
            )
            nodes = ((data.get("inventoryTransfers") or {}).get("nodes")) or []
            wanted = normalized.casefold()
            candidate = next(
                (
                    node
                    for node in nodes
                    if wanted
                    in {
                        str(node.get("name") or "").lstrip("#").casefold(),
                        str(node.get("referenceName") or "").lstrip("#").casefold(),
                        str(node.get("id") or "").rsplit("/", 1)[-1].casefold(),
                    }
                ),
                nodes[0] if len(nodes) == 1 else None,
            )
            transfer = (
                await _shopify_transfer_by_id(
                    store_key,
                    str(candidate.get("id")),
                    detailed=False,
                )
                if candidate and candidate.get("id")
                else None
            )
    except HTTPException as exc:
        _translate_shopify_access_error(exc)

    if not transfer:
        raise HTTPException(
            status_code=404,
            detail="Shopify does not expose native purchase-order numbers to production apps. Open this PO in Shopify, create its linked inventory transfer, then search the transfer name or browse by date.",
        )

    return _shopify_transfer_payload(transfer, store_key)


@router.get("/available")
async def available_shopify_transfers(
    purchase_date: date = Query(...),
    store: str = Query(...),
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    """Return linked PO transfers created on a selected Casablanca calendar date."""
    from .main import shopify_graphql

    store_key = _clean_store(store)
    query = f"query InventoryHelperTransfersByDate($query: String!, $after: String) {{ inventoryTransfers(first: 50, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {{ nodes {{ {_TRANSFER_CARD_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }} }}"
    transfers: list[dict[str, Any]] = []
    after: Optional[str] = None
    try:
        while True:
            data = await shopify_graphql(
                query,
                {"query": _date_search_query(purchase_date), "after": after},
                store=store_key,
                api_version=_TRANSFER_API_VERSION,
            )
            connection = data.get("inventoryTransfers") or {}
            transfers.extend(connection.get("nodes") or [])
            page_info = connection.get("pageInfo") or {}
            after = page_info.get("endCursor")
            if not page_info.get("hasNextPage") or not after:
                break
    except HTTPException as exc:
        _translate_shopify_access_error(exc)

    transfer_ids = [str(item.get("id")) for item in transfers if item.get("id")]
    existing_ids: set[str] = set()
    if transfer_ids:
        existing_ids = set(
            (
                await db.scalars(
                    select(InventoryReceipt.shopify_order_gid).where(
                        InventoryReceipt.store_key == store_key,
                        InventoryReceipt.shopify_order_gid.in_(transfer_ids),
                    )
                )
            ).all()
        )
    return {
        "purchase_date": purchase_date.isoformat(),
        "transfers": [
            {**_shopify_transfer_payload(item, store_key), "already_added": str(item.get("id")) in existing_ids}
            for item in transfers
        ],
    }


async def _shopify_transfers_for_period(
    store_key: str,
    selected_from: date,
    selected_to: date,
) -> list[dict[str, Any]]:
    """Load every Shopify inventory transfer created in the selected period."""
    from .main import shopify_graphql

    # Keep the home-page query below Shopify's maximum query cost. Full variant
    # details are loaded for one receipt only when the agent opens its card.
    query = f"query InventoryHelperTransfersForPeriod($query: String!, $after: String) {{ inventoryTransfers(first: 50, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {{ nodes {{ {_TRANSFER_CARD_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }} }}"
    transfers: list[dict[str, Any]] = []
    after: Optional[str] = None
    try:
        while True:
            data = await shopify_graphql(
                query,
                {"query": _date_range_search_query(selected_from, selected_to), "after": after},
                store=store_key,
                api_version=_TRANSFER_API_VERSION,
            )
            connection = data.get("inventoryTransfers") or {}
            transfers.extend(connection.get("nodes") or [])
            page_info = connection.get("pageInfo") or {}
            after = page_info.get("endCursor")
            if not page_info.get("hasNextPage") or not after:
                break
    except HTTPException as exc:
        _translate_shopify_access_error(exc)
    return transfers


async def _sync_shopify_transfers_for_period(
    db: AsyncSession,
    store_key: str,
    selected_from: date,
    selected_to: date,
    user: User,
) -> int:
    """Create queue cards automatically while preserving started/final history."""
    transfers = await _shopify_transfers_for_period(store_key, selected_from, selected_to)
    transfer_ids = [str(transfer.get("id")) for transfer in transfers if transfer.get("id")]
    if not transfer_ids:
        return 0

    existing_rows = (
        await db.scalars(
            select(InventoryReceipt).where(
                InventoryReceipt.store_key == store_key,
                InventoryReceipt.shopify_order_gid.in_(transfer_ids),
            )
        )
    ).all()
    existing_by_gid = {row.shopify_order_gid: row for row in existing_rows}
    created = 0
    for transfer in transfers:
        payload = _shopify_transfer_payload(transfer, store_key)
        transfer_id = str(payload.get("shopify_order_gid") or "")
        if not transfer_id:
            continue
        row = existing_by_gid.get(transfer_id)
        if row:
            # Keep finalized snapshots immutable. For active receipts, refresh
            # transfer metadata and the tag-derived crate plan. Untouched rows
            # also receive the latest Shopify variant list and quantities.
            if row.status not in {"complete", "incomplete"}:
                row.order_number = str(payload.get("order_number") or row.order_number)
                row.po_number = payload.get("po_number")
                row.shopify_created_at = payload.get("shopify_created_at")
                row.shopify_tags = payload.get("shopify_tags") or []
                row.ordered_crates = int(payload.get("ordered_crates") or 0)
                if row.actual_items is None and not row.shopify_details_loaded:
                    row.line_items = payload.get("line_items") or []
                    row.expected_items = int(payload.get("expected_items") or 0)
            continue

        items = payload.get("line_items") or []
        row = InventoryReceipt(
            store_key=store_key,
            shopify_order_gid=transfer_id,
            order_number=str(payload.get("order_number") or "Shopify transfer"),
            po_number=payload.get("po_number"),
            shopify_created_at=payload.get("shopify_created_at"),
            shopify_tags=payload.get("shopify_tags") or [],
            shopify_details_loaded=False,
            line_items=items,
            ordered_crates=int(payload.get("ordered_crates") or 0),
            expected_items=int(payload.get("expected_items") or 0),
            status="new",
            created_by_id=user.id,
        )
        db.add(row)
        existing_by_gid[transfer_id] = row
        created += 1

    await db.commit()
    return created


@router.get("/receipts")
async def list_receipts(
    store: Optional[str] = Query(default=None),
    purchase_date: Optional[date] = Query(default=None),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    store_key = _clean_store(store) if store else None
    selected_from = date_from or purchase_date
    selected_to = date_to or selected_from
    if date_to and not selected_from:
        raise HTTPException(status_code=400, detail="Choose a start date before the end date")
    if selected_from and selected_to:
        try:
            _stored_receipt_range_prefixes(selected_from, selected_to)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if store_key:
            await _sync_shopify_transfers_for_period(
                db,
                store_key,
                selected_from,
                selected_to,
                user,
            )

    stmt = (
        select(InventoryReceipt)
        .options(
            selectinload(InventoryReceipt.created_by),
            selectinload(InventoryReceipt.counted_by),
            selectinload(InventoryReceipt.photos),
        )
        .order_by(InventoryReceipt.shopify_created_at.desc(), InventoryReceipt.id.desc())
        .limit(1000)
    )
    if store_key:
        stmt = stmt.where(InventoryReceipt.store_key == store_key)
    if selected_from and selected_to:
        # New transfers normally use ISO-8601, while older Shopify Date scalar
        # values in production were saved as MM/DD/YYYY. Keep both searchable
        # across either one selected day or a selected period.
        prefixes = _stored_receipt_range_prefixes(selected_from, selected_to)
        stmt = stmt.where(
            or_(*[
                InventoryReceipt.shopify_created_at.like(f"{prefix}%")
                for prefix in prefixes
            ])
        )
    # Legacy rows imported from Shopify's customer Order API stay preserved in
    # the database, but they are not purchase orders and must not appear here.
    stmt = stmt.where(InventoryReceipt.shopify_order_gid.like("gid://shopify/InventoryTransfer/%"))
    stmt = stmt.where(InventoryReceipt.status.notin_(("complete", "incomplete")))
    rows = (await db.scalars(stmt)).all()

    history_stmt = (
        select(InventoryReceipt)
        .options(
            selectinload(InventoryReceipt.created_by),
            selectinload(InventoryReceipt.counted_by),
            selectinload(InventoryReceipt.photos),
        )
        .where(
            InventoryReceipt.shopify_order_gid.like("gid://shopify/InventoryTransfer/%"),
            InventoryReceipt.status.in_(("complete", "incomplete")),
        )
        .order_by(InventoryReceipt.finalized_at.desc(), InventoryReceipt.id.desc())
        .limit(500)
    )
    if store_key:
        history_stmt = history_stmt.where(InventoryReceipt.store_key == store_key)
    history_rows = (await db.scalars(history_stmt)).all()
    return {
        "date_from": selected_from.isoformat() if selected_from else None,
        "date_to": selected_to.isoformat() if selected_to else None,
        "receipts": [_serialize(row) for row in rows],
        "history": [_serialize(row) for row in history_rows],
    }


@router.post("/receipts", status_code=201)
async def create_receipt(
    body: InventoryReceiptCreate,
    db: AsyncSession = Depends(get_session),
    admin: User = Depends(require_admin),
):
    if not body.shopify_order_gid.startswith("gid://shopify/InventoryTransfer/"):
        raise HTTPException(status_code=400, detail="Only Shopify inventory transfers can create purchase-order cards")
    existing = await db.scalar(
        select(InventoryReceipt).where(
            InventoryReceipt.store_key == _clean_store(body.store),
            InventoryReceipt.shopify_order_gid == body.shopify_order_gid,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="This Shopify inventory transfer is already in Inventory Helper")
    items = [item.model_dump() for item in body.line_items]
    row = InventoryReceipt(
        store_key=_clean_store(body.store),
        shopify_order_gid=body.shopify_order_gid,
        order_number=body.order_number.strip(),
        po_number=(body.po_number or "").strip() or None,
        shopify_created_at=body.shopify_created_at,
        shopify_tags=body.shopify_tags,
        shopify_details_loaded=True,
        line_items=items,
        ordered_crates=body.ordered_crates,
        expected_items=sum(item["ordered_quantity"] for item in items),
        status="new",
        created_by_id=admin.id,
    )
    db.add(row)
    await db.commit()
    return _serialize(await _loaded_receipt(db, row.id))


@router.patch("/receipts/{receipt_id}/details")
async def load_receipt_details(
    receipt_id: int,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
):
    """Hydrate one lightweight queue card with its complete Shopify variants."""
    row = await _loaded_receipt(db, receipt_id)
    if row.shopify_details_loaded:
        return _serialize(row)
    if row.actual_items is not None:
        row.shopify_details_loaded = True
        await db.commit()
        return _serialize(await _loaded_receipt(db, row.id))

    try:
        transfer = await _shopify_transfer_by_id(
            row.store_key,
            row.shopify_order_gid,
            detailed=False,
        )
    except HTTPException as exc:
        _translate_shopify_access_error(exc)
    payload = _shopify_transfer_payload(transfer, row.store_key)
    row.order_number = str(payload.get("order_number") or row.order_number)
    row.po_number = payload.get("po_number")
    row.shopify_created_at = payload.get("shopify_created_at")
    row.shopify_tags = payload.get("shopify_tags") or []
    row.ordered_crates = int(payload.get("ordered_crates") or 0)
    row.line_items = payload.get("line_items") or []
    row.expected_items = int(payload.get("expected_items") or 0)
    row.shopify_details_loaded = True
    await db.commit()
    return _serialize(await _loaded_receipt(db, row.id))


@router.patch("/receipts/{receipt_id}/admin")
async def update_receipt_admin(
    receipt_id: int,
    body: InventoryAdminUpdate,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    row = await _loaded_receipt(db, receipt_id)
    _ensure_receipt_open(row)
    if not row.shopify_details_loaded:
        raise HTTPException(status_code=409, detail="Open this purchase order to load every Shopify variant first")
    items = _merge_admin_items(list(row.line_items or []), body.line_items)
    row.line_items = items
    row.ordered_crates = body.ordered_crates
    row.expected_items = sum(item["ordered_quantity"] for item in items)
    if row.actual_items is not None:
        row.status = "pending"
    await db.commit()
    return _serialize(await _loaded_receipt(db, row.id))


@router.patch("/receipts/{receipt_id}/count")
async def update_receipt_count(
    receipt_id: int,
    body: InventoryCountUpdate,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    row = await _loaded_receipt(db, receipt_id)
    _ensure_receipt_open(row)
    if not row.shopify_details_loaded:
        raise HTTPException(status_code=409, detail="Open this purchase order to load every Shopify variant first")
    stored_items = list(row.line_items or [])
    if not body.line_items:
        raise HTTPException(status_code=400, detail="Enter the received quantity for every variant")

    try:
        transfer = await _shopify_transfer_by_id(row.store_key, row.shopify_order_gid, detailed=True)
        merged_items, receive_groups, adjustments = _build_inventory_sync_plan(
            stored_items,
            body.line_items,
            transfer,
        )
        transition = _stable_key(
            row.store_key,
            row.id,
            [
                {
                    "id": item.get("id"),
                    "from": stored.get("inventory_applied_quantity"),
                    "to": item.get("actual_quantity"),
                }
                for item, stored in zip(merged_items, stored_items)
            ],
        )
        operations: list[dict[str, Any]] = []
        if body.sync_inventory:
            operations.extend(
                await _receive_inventory_shipments(
                    row.store_key,
                    row.id,
                    receive_groups,
                    transition,
                )
            )
            operations.extend(
                await _adjust_inventory_quantities(
                    row.store_key,
                    row.id,
                    adjustments,
                    transition,
                )
            )
            adjustment_by_item = {
                str(operation.get("inventory_item_id")): operation
                for operation in operations
                if operation.get("type") == "inventory_adjustment"
            }
            for item in merged_items:
                audit = adjustment_by_item.get(str(item.get("inventory_item_id")))
                if audit:
                    item["last_inventory_change"] = {
                        "delta": audit["delta"],
                        "before_quantity": audit["before_quantity"],
                        "expected_after_quantity": audit["expected_after_quantity"],
                        "after_quantity": audit["after_quantity"],
                        "synced_at": item.get("inventory_synced_at"),
                    }
        else:
            for merged, stored in zip(merged_items, stored_items):
                merged["inventory_applied_quantity"] = int(
                    stored.get("inventory_applied_quantity") or 0
                )
                merged["inventory_synced_at"] = stored.get("inventory_synced_at")
    except HTTPException as exc:
        _translate_shopify_access_error(exc)

    actual_items = sum(int(item.get("actual_quantity") or 0) for item in merged_items)
    row.line_items = merged_items
    row.actual_crates = body.actual_crates
    row.actual_items = actual_items
    row.reported_items_received = body.total_items_received
    row.agent_note = (body.agent_note or "").strip() or None
    row.counted_by_id = user.id
    row.counted_at = datetime.now(timezone.utc)
    row.finalized_at = None
    # Saving or editing never completes a card. This prevents an agent from
    # accidentally turning a purchase order green before the final review.
    row.status = "pending"
    await db.commit()
    result = _serialize(await _loaded_receipt(db, row.id))
    result["inventory_operations"] = operations
    return result


@router.patch("/receipts/{receipt_id}/complete")
async def complete_receipt(
    receipt_id: int,
    body: Optional[InventoryFinalizeUpdate] = None,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    row = await _loaded_receipt(db, receipt_id)
    if row.actual_items is None or row.actual_crates is None:
        raise HTTPException(status_code=409, detail="Save the receiving count before choosing the final status")
    if row.reported_items_received is None:
        raise HTTPException(status_code=409, detail="Enter the total items received before choosing the final status")
    _ensure_receipt_open(row)
    now = datetime.now(timezone.utc)
    # The receiving agent chooses the final outcome. Keep the crate-derived
    # fallback temporarily so an older frontend remains compatible while a new
    # Cloud Run revision is rolling out.
    row.status = body.outcome if body else _final_receipt_status(row.ordered_crates, row.actual_crates)
    row.counted_by_id = user.id
    row.counted_at = now
    row.finalized_at = now
    await db.commit()
    return _serialize(await _loaded_receipt(db, row.id))


@router.patch("/receipts/{receipt_id}/reopen")
async def reopen_receipt(
    receipt_id: int,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    row = await _loaded_receipt(db, receipt_id)
    if row.status not in {"complete", "incomplete"}:
        raise HTTPException(status_code=409, detail="This purchase order is already in the receiving queue")
    row.status = "pending"
    row.finalized_at = None
    await db.commit()
    return _serialize(await _loaded_receipt(db, row.id))


@router.post("/receipts/{receipt_id}/photos", status_code=201)
async def upload_receipt_photo(
    receipt_id: int,
    photo: UploadFile = File(...),
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    row = await _loaded_receipt(db, receipt_id)
    _ensure_receipt_open(row)
    if len(row.photos or []) >= _MAX_PHOTOS:
        raise HTTPException(status_code=400, detail=f"A maximum of {_MAX_PHOTOS} photos is allowed")
    content_type = (photo.content_type or "").lower()
    if content_type not in _ALLOWED_PHOTO_TYPES:
        raise HTTPException(status_code=400, detail="Use a JPG, PNG, or WebP image")
    data = await photo.read(_MAX_PHOTO_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="The photo is empty")
    if len(data) > _MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="Photo must be 6 MB or smaller")
    saved = InventoryReceiptPhoto(
        receipt_id=row.id,
        filename=(photo.filename or "crate-photo")[:255],
        content_type=content_type,
        data=data,
        uploaded_by_id=user.id,
    )
    db.add(saved)
    row.status = "pending"
    await db.commit()
    return _serialize(await _loaded_receipt(db, row.id))


@router.get("/photos/{photo_id}")
async def get_receipt_photo(
    photo_id: int,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
):
    photo = await db.get(InventoryReceiptPhoto, photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="photo not found")
    return Response(
        content=photo.data,
        media_type=photo.content_type,
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.delete("/photos/{photo_id}", status_code=204)
async def delete_receipt_photo(
    photo_id: int,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    photo = await db.get(InventoryReceiptPhoto, photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="photo not found")
    if user.role != "admin" and photo.uploaded_by_id != user.id:
        raise HTTPException(status_code=403, detail="Only the uploader or an admin can remove this photo")
    row = await _loaded_receipt(db, photo.receipt_id)
    _ensure_receipt_open(row)
    await db.delete(photo)
    row.status = "pending"
    await db.commit()
    return Response(status_code=204)
