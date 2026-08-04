"""Inventory Helper API: import Shopify inventory transfers and verify receipts."""

from datetime import datetime, timezone
import os
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
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

_TRANSFER_FIELDS = """
  id
  name
  referenceName
  dateCreated
  status
  note
  totalQuantity
  lineItems(first: 100) {
    nodes {
      id
      title
      totalQuantity
      inventoryItem {
        id
        sku
        variant {
          id
          title
          image { url altText }
          product { title }
        }
      }
    }
  }
"""


class InventoryLineItemInput(BaseModel):
    id: str
    variant_id: Optional[str] = None
    title: str
    variant_title: Optional[str] = None
    sku: Optional[str] = None
    image_url: Optional[str] = None
    shopify_quantity: int = Field(ge=0)
    ordered_quantity: int = Field(ge=0)


class InventoryReceiptCreate(BaseModel):
    store: str
    shopify_order_gid: str
    order_number: str
    po_number: Optional[str] = None
    shopify_created_at: Optional[str] = None
    ordered_crates: int = Field(ge=0)
    line_items: list[InventoryLineItemInput]


class InventoryAdminUpdate(BaseModel):
    ordered_crates: int = Field(ge=0)
    line_items: list[InventoryLineItemInput]


class InventoryCountUpdate(BaseModel):
    actual_crates: int = Field(ge=0)
    actual_items: int = Field(ge=0)
    agent_note: Optional[str] = Field(default=None, max_length=2000)


def _clean_store(value: str) -> str:
    store = (value or "").strip().lower()
    if not store or len(store) > 63 or not all(c.isalnum() or c in "_-" for c in store):
        raise HTTPException(status_code=400, detail="invalid store")
    return store


def _status(expected_crates: int, expected_items: int, actual_crates: Optional[int], actual_items: Optional[int]) -> str:
    if actual_crates is None or actual_items is None:
        return "waiting"
    # Zero means the admin has not entered a crate plan yet. In that case the
    # extracted Shopify item total can still be fully verified by the agent.
    crates_match = expected_crates <= 0 or actual_crates == expected_crates
    if crates_match and actual_items == expected_items:
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
        "line_items": row.line_items or [],
        "ordered_crates": row.ordered_crates,
        "expected_items": row.expected_items,
        "actual_crates": row.actual_crates,
        "actual_items": row.actual_items,
        "agent_note": row.agent_note or "",
        "status": row.status,
        "created_by": _person(row.created_by),
        "counted_by": _person(row.counted_by),
        "counted_at": row.counted_at.isoformat() if row.counted_at else None,
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


def _line_items_from_shopify(transfer: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in (((transfer.get("lineItems") or {}).get("nodes")) or []):
        inventory_item = item.get("inventoryItem") or {}
        variant = inventory_item.get("variant") or {}
        product = variant.get("product") or {}
        image = variant.get("image") or {}
        quantity = max(0, int(item.get("totalQuantity") or 0))
        result.append(
            {
                "id": str(item.get("id") or inventory_item.get("id") or len(result)),
                "variant_id": variant.get("id"),
                "title": product.get("title") or item.get("title") or "Untitled item",
                "variant_title": variant.get("title"),
                "sku": inventory_item.get("sku"),
                "image_url": image.get("url"),
                "image_alt": image.get("altText"),
                "shopify_quantity": quantity,
                "ordered_quantity": quantity,
            }
        )
    return result


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
            query = f"query InventoryHelperTransferById($id: ID!) {{ inventoryTransfer(id: $id) {{ {_TRANSFER_FIELDS} }} }}"
            data = await shopify_graphql(
                query,
                {"id": ref},
                store=store_key,
                api_version=_TRANSFER_API_VERSION,
            )
            transfer = data.get("inventoryTransfer")
        else:
            normalized = ref.lstrip("#").replace('"', "").strip()
            query = f"query InventoryHelperTransfer($query: String!) {{ inventoryTransfers(first: 20, query: $query, sortKey: CREATED_AT, reverse: true) {{ nodes {{ {_TRANSFER_FIELDS} }} }} }}"
            data = await shopify_graphql(
                query,
                {"query": normalized},
                store=store_key,
                api_version=_TRANSFER_API_VERSION,
            )
            nodes = ((data.get("inventoryTransfers") or {}).get("nodes")) or []
            wanted = normalized.casefold()
            transfer = next(
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
    except HTTPException as exc:
        detail = str(exc.detail)
        if exc.status_code == 502 and (
            "ACCESS_DENIED" in detail.upper()
            or "ACCESS DENIED" in detail.upper()
            or "INVENTORYTRANSFERS" in detail.upper()
        ):
            raise HTTPException(
                status_code=403,
                detail="Reconnect this Shopify store to grant Inventory Helper access to inventory transfers.",
            ) from exc
        raise

    if not transfer:
        raise HTTPException(
            status_code=404,
            detail="No linked inventory transfer found. Mark the purchase order as ordered, create its inventory transfer in Shopify, then paste the transfer name or PO reference.",
        )

    items = _line_items_from_shopify(transfer)
    display_name = transfer.get("referenceName") or transfer.get("name") or ref
    transfer_name = transfer.get("name")
    return {
        "store": store_key,
        "shopify_order_gid": transfer.get("id"),
        "order_number": display_name,
        "po_number": transfer_name if transfer_name != display_name else None,
        "shopify_created_at": transfer.get("dateCreated"),
        "line_items": items,
        "expected_items": sum(item["ordered_quantity"] for item in items),
    }


@router.get("/receipts")
async def list_receipts(
    store: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(InventoryReceipt)
        .options(
            selectinload(InventoryReceipt.created_by),
            selectinload(InventoryReceipt.counted_by),
            selectinload(InventoryReceipt.photos),
        )
        .order_by(InventoryReceipt.created_at.desc(), InventoryReceipt.id.desc())
        .limit(1000)
    )
    if store:
        stmt = stmt.where(InventoryReceipt.store_key == _clean_store(store))
    # Legacy rows imported from Shopify's customer Order API stay preserved in
    # the database, but they are not purchase orders and must not appear here.
    stmt = stmt.where(InventoryReceipt.shopify_order_gid.like("gid://shopify/InventoryTransfer/%"))
    rows = (await db.scalars(stmt)).all()
    return {"receipts": [_serialize(row) for row in rows]}


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
        line_items=items,
        ordered_crates=body.ordered_crates,
        expected_items=sum(item["ordered_quantity"] for item in items),
        status="waiting",
        created_by_id=admin.id,
    )
    db.add(row)
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
    items = [item.model_dump() for item in body.line_items]
    row.line_items = items
    row.ordered_crates = body.ordered_crates
    row.expected_items = sum(item["ordered_quantity"] for item in items)
    row.status = _status(row.ordered_crates, row.expected_items, row.actual_crates, row.actual_items)
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
    row.actual_crates = body.actual_crates
    row.actual_items = body.actual_items
    row.agent_note = (body.agent_note or "").strip() or None
    row.counted_by_id = user.id
    row.counted_at = datetime.now(timezone.utc)
    row.status = _status(row.ordered_crates, row.expected_items, row.actual_crates, row.actual_items)
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
    await db.delete(photo)
    await db.commit()
    return Response(status_code=204)
