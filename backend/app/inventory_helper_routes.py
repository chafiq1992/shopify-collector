"""Inventory Helper API: import Shopify orders, compare crate counts, and store photos."""

from datetime import date as date_type, datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .auth_routes import get_current_user, require_admin
from .db import get_session
from .models import InventoryReceipt, InventoryReceiptPhoto, User


router = APIRouter(prefix="/api/inventory-helper", tags=["inventory-helper"])

_MAX_PHOTOS = 4
_MAX_PHOTO_BYTES = 6 * 1024 * 1024
_ALLOWED_PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}

_ORDER_FIELDS = """
  id
  name
  poNumber
  createdAt
  lineItems(first: 100) {
    nodes {
      id
      name
      sku
      quantity
      image { url altText }
      variant { id title }
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


def _day_bounds(value: str) -> tuple[str, str]:
    try:
        day = datetime.strptime((value or "").strip(), "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must use YYYY-MM-DD")
    if day > date_type.today() + timedelta(days=1):
        raise HTTPException(status_code=400, detail="date cannot be in the future")
    return day.isoformat(), (day + timedelta(days=1)).isoformat()


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


def _line_items_from_shopify(order: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in (((order.get("lineItems") or {}).get("nodes")) or []):
        variant = item.get("variant") or {}
        image = item.get("image") or {}
        quantity = max(0, int(item.get("quantity") or 0))
        result.append(
            {
                "id": str(item.get("id") or variant.get("id") or len(result)),
                "variant_id": variant.get("id"),
                "title": item.get("name") or "Untitled item",
                "variant_title": variant.get("title"),
                "sku": item.get("sku"),
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
    """Find a Shopify order by GraphQL ID, order number/name, or PO number."""
    from .main import shopify_graphql

    ref = reference.strip()
    store_key = _clean_store(store)
    order: Optional[dict[str, Any]] = None

    if ref.startswith("gid://shopify/Order/"):
        gid = ref if ref.startswith("gid://") else f"gid://shopify/Order/{ref}"
        query = f"query InventoryHelperOrderById($id: ID!) {{ order(id: $id) {{ {_ORDER_FIELDS} }} }}"
        data = await shopify_graphql(query, {"id": gid}, store=store_key)
        order = data.get("order")
    else:
        normalized = ref.lstrip("#").replace('"', "")
        query = f"query InventoryHelperOrder($query: String!) {{ orders(first: 1, query: $query) {{ nodes {{ {_ORDER_FIELDS} }} }} }}"
        for search_query in (f'name:"{normalized}"', f'po_number:"{normalized}"'):
            data = await shopify_graphql(query, {"query": search_query}, store=store_key)
            nodes = ((data.get("orders") or {}).get("nodes")) or []
            if nodes:
                order = nodes[0]
                break
        # A long numeric value may be Shopify's legacy order ID. Search order/PO
        # numbers first so a valid numeric PO is never mistaken for an internal ID.
        if not order and normalized.isdigit() and len(normalized) >= 9:
            gid = f"gid://shopify/Order/{normalized}"
            id_query = f"query InventoryHelperOrderById($id: ID!) {{ order(id: $id) {{ {_ORDER_FIELDS} }} }}"
            data = await shopify_graphql(id_query, {"id": gid}, store=store_key)
            order = data.get("order")

    if not order:
        raise HTTPException(status_code=404, detail="No Shopify order found for that ID, order number, or PO number")

    items = _line_items_from_shopify(order)
    return {
        "store": store_key,
        "shopify_order_gid": order.get("id"),
        "order_number": order.get("name") or ref,
        "po_number": order.get("poNumber"),
        "shopify_created_at": order.get("createdAt"),
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
        .limit(250)
    )
    if store:
        stmt = stmt.where(InventoryReceipt.store_key == _clean_store(store))
    rows = (await db.scalars(stmt)).all()
    return {"receipts": [_serialize(row) for row in rows]}


@router.post("/sync-day")
async def sync_shopify_day(
    date: str = Query(..., description="Shop date in YYYY-MM-DD format"),
    store: str = Query(...),
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Import a day's Shopify orders without changing existing receiving work."""
    from .main import shopify_graphql

    day_start, next_day = _day_bounds(date)
    store_key = _clean_store(store)
    search_query = f"created_at:>={day_start} created_at:<{next_day}"
    query = f"""
      query InventoryHelperDay($first: Int!, $after: String, $query: String!) {{
        orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {{
          nodes {{ {_ORDER_FIELDS} }}
          pageInfo {{ hasNextPage endCursor }}
        }}
      }}
    """

    shopify_orders: list[dict[str, Any]] = []
    cursor: Optional[str] = None
    # 1,250 orders is a generous safety ceiling for a single receiving day.
    for _ in range(25):
        data = await shopify_graphql(
            query,
            {"first": 50, "after": cursor, "query": search_query},
            store=store_key,
        )
        connection = data.get("orders") or {}
        shopify_orders.extend(connection.get("nodes") or [])
        page_info = connection.get("pageInfo") or {}
        if not page_info.get("hasNextPage") or not page_info.get("endCursor"):
            break
        cursor = page_info.get("endCursor")

    gids = [str(order.get("id") or "") for order in shopify_orders if order.get("id")]
    existing_gids: set[str] = set()
    if gids:
        existing_gids = set(
            (await db.scalars(
                select(InventoryReceipt.shopify_order_gid).where(
                    InventoryReceipt.store_key == store_key,
                    InventoryReceipt.shopify_order_gid.in_(gids),
                )
            )).all()
        )

    imported_count = 0
    for order in shopify_orders:
        gid = str(order.get("id") or "")
        if not gid or gid in existing_gids:
            continue
        items = _line_items_from_shopify(order)
        db.add(
            InventoryReceipt(
                store_key=store_key,
                shopify_order_gid=gid,
                order_number=str(order.get("name") or gid.rsplit("/", 1)[-1]),
                po_number=(str(order.get("poNumber") or "").strip() or None),
                shopify_created_at=order.get("createdAt"),
                line_items=items,
                ordered_crates=0,
                expected_items=sum(item["ordered_quantity"] for item in items),
                status="waiting",
                created_by_id=user.id,
            )
        )
        existing_gids.add(gid)
        imported_count += 1

    if imported_count:
        try:
            await db.commit()
        except IntegrityError:
            # Another device may have synced the same order at the same moment.
            await db.rollback()

    rows = (
        await db.scalars(
            select(InventoryReceipt)
            .options(
                selectinload(InventoryReceipt.created_by),
                selectinload(InventoryReceipt.counted_by),
                selectinload(InventoryReceipt.photos),
            )
            .where(
                InventoryReceipt.store_key == store_key,
                InventoryReceipt.shopify_created_at.like(f"{day_start}%"),
            )
            .order_by(InventoryReceipt.shopify_created_at.desc(), InventoryReceipt.id.desc())
        )
    ).all()
    return {
        "date": day_start,
        "shopify_count": len(shopify_orders),
        "imported_count": imported_count,
        "receipts": [_serialize(row) for row in rows],
    }


@router.post("/receipts", status_code=201)
async def create_receipt(
    body: InventoryReceiptCreate,
    db: AsyncSession = Depends(get_session),
    admin: User = Depends(require_admin),
):
    existing = await db.scalar(
        select(InventoryReceipt).where(
            InventoryReceipt.store_key == _clean_store(body.store),
            InventoryReceipt.shopify_order_gid == body.shopify_order_gid,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="This Shopify order is already in Inventory Helper")
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
