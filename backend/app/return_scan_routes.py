"""Return Scanner API routes.

Provides endpoints for the return-scanner page:
  - POST /api/return-scan        — scan a barcode and look up in Shopify
  - GET  /api/return-scans       — list return scans for the current user
  - POST /api/return-scans/manual — manually add a return scan
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import ReturnScan, User
from .auth_routes import get_current_user

router = APIRouter()

_barcode_re = re.compile(r"\d+")

# Maximum digits allowed in a barcode (matches order-scanner-1 behaviour)
MAX_BARCODE_DIGITS = 6


def _clean(barcode: str) -> str:
    """Normalise a raw barcode string to a Shopify-style order name like ``#123456``."""
    s = str(barcode or "").strip()
    # Some systems prefix with merchant id: "7-125652" → keep last part
    if "-" in s:
        s = s.split("-")[-1]
    digits = "".join(_barcode_re.findall(s)).lstrip("0")
    if not digits or len(digits) > MAX_BARCODE_DIGITS:
        raise ValueError("Invalid barcode")
    return "#" + digits


# ---- Pydantic schemas ----

class ScanIn(BaseModel):
    barcode: str


class ManualScanIn(BaseModel):
    order_name: str


class ReturnScanOut(BaseModel):
    result: str
    order: str
    store: str = ""
    fulfillment: str = ""
    status: str = ""
    financial: str = ""
    ts: str = ""


class ReturnScanRecord(BaseModel):
    id: int
    ts: str
    order_name: str
    user_id: str = ""
    user_name: str = ""
    user_email: str = ""
    tags: str = ""
    store: str = ""
    fulfillment: str = ""
    status: str = ""
    financial: str = ""
    result: str = ""


# ---- Shopify lookup helper (uses the main app's GraphQL) ----

async def _find_order_in_shopify(order_name: str) -> dict:
    """Look up *order_name* (e.g. ``#123456``) across configured Shopify stores.

    Uses the main app's ``shopify_graphql`` helper.  Tries both stores
    (irrakids, irranova) and returns the first match.
    """
    # Import lazily to avoid circular imports
    from .main import shopify_graphql

    query = """
    query FindOrder($first: Int!, $query: String) {
      orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            tags
            displayFulfillmentStatus
            displayFinancialStatus
            cancelledAt
          }
        }
      }
    }
    """
    # Strip '#' for the Shopify search query
    name_q = order_name.lstrip("#")

    for store_key in ("irrakids", "irranova"):
        try:
            data = await shopify_graphql(
                query, {"first": 1, "query": f"name:{name_q}"}, store=store_key
            )
            edges = (data.get("orders") or {}).get("edges") or []
            if not edges:
                continue
            node = edges[0].get("node") or {}
            cancelled = bool(node.get("cancelledAt"))
            fulfillment_raw = (node.get("displayFulfillmentStatus") or "UNFULFILLED").lower()
            financial_raw = (node.get("displayFinancialStatus") or "").lower()
            # Map Shopify GraphQL display statuses to simpler labels
            fulfillment = fulfillment_raw.replace("_", " ")
            financial = financial_raw.replace("_", " ")
            status = "cancelled" if cancelled else "open"
            result = (
                "⚠️ Cancelled" if cancelled
                else ("❌ Unfulfilled" if "unfulfilled" in fulfillment else "✅ OK")
            )
            return {
                "found": True,
                "store": store_key,
                "tags": ", ".join(node.get("tags") or []),
                "fulfillment": fulfillment,
                "status": status,
                "financial": financial,
                "result": result,
            }
        except Exception:
            continue

    return {
        "found": False,
        "store": "",
        "tags": "",
        "fulfillment": "",
        "status": "",
        "financial": "",
        "result": "❌ Not Found",
    }


def _row_to_record(row: ReturnScan) -> dict:
    return {
        "id": row.id,
        "ts": row.ts.isoformat() if row.ts else "",
        "order_name": row.order_name or "",
        "user_id": row.user_id or "",
        "user_name": (row.user.name if row.user else "") or "",
        "user_email": (row.user.email if row.user else "") or "",
        "tags": row.tags or "",
        "store": row.store or "",
        "fulfillment": row.fulfillment or "",
        "status": row.status or "",
        "financial": row.financial or "",
        "result": row.result or "",
    }


# ---- Endpoints ----

@router.post("/api/return-scan", response_model=ReturnScanOut)
async def return_scan(
    data: ScanIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Scan a barcode → look up the order in Shopify → persist the result."""
    try:
        order_name = _clean(data.barcode)
    except ValueError:
        raise HTTPException(400, "❌ Invalid barcode")

    order = await _find_order_in_shopify(order_name)
    found = order.get("found", False)
    result_text = order.get("result", "❌ Not Found")
    now = datetime.now(timezone.utc)

    row = ReturnScan(
        order_name=order_name,
        user_id=user.id,
        tags=order.get("tags", "") if found else "",
        store=order.get("store", ""),
        fulfillment=order.get("fulfillment", ""),
        status=order.get("status", ""),
        financial=order.get("financial", ""),
        result=result_text,
    )
    db.add(row)
    try:
        await db.commit()
    except Exception:
        await db.rollback()

    return ReturnScanOut(
        result=result_text,
        order=order_name,
        store=order.get("store", "") if found else "",
        fulfillment=order.get("fulfillment", "") if found else "",
        status=order.get("status", "") if found else "",
        financial=order.get("financial", "") if found else "",
        ts=now.isoformat(),
    )


@router.get("/api/return-scans")
async def list_return_scans(
    start: str,
    end: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """List return scans for the current user in a [start, end] date range (YYYY-MM-DD, UTC)."""
    start_day = datetime.fromisoformat(start).replace(
        hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc
    )
    end_str = end or start
    end_day = (
        datetime.fromisoformat(end_str).replace(
            hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc
        )
        + timedelta(days=1)
    )

    from sqlalchemy.orm import selectinload

    stmt = (
        select(ReturnScan)
        .options(selectinload(ReturnScan.user))
        .where(
            ReturnScan.user_id == user.id,
            ReturnScan.ts >= start_day,
            ReturnScan.ts < end_day,
        )
        .order_by(ReturnScan.ts.desc())
    )
    q = await db.execute(stmt)
    rows = q.scalars().all()
    return {"rows": [_row_to_record(r) for r in rows]}


@router.post("/api/return-scans/manual")
async def manual_return_scan(
    data: ManualScanIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Manually add a return scan by typing an order number."""
    try:
        order_name = _clean(data.order_name)
    except ValueError:
        raise HTTPException(400, "❌ Invalid order number")

    order = await _find_order_in_shopify(order_name)
    found = order.get("found", False)
    result_text = order.get("result", "❌ Not Found")

    row = ReturnScan(
        order_name=order_name,
        user_id=user.id,
        tags=order.get("tags", "") if found else "",
        store=order.get("store", ""),
        fulfillment=order.get("fulfillment", ""),
        status=order.get("status", ""),
        financial=order.get("financial", ""),
        result=result_text,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    return _row_to_record(row)
