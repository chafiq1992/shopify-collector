"""Return Scanner API routes.

Provides endpoints for the return-scanner page:
  - POST /api/return-scan        — scan a barcode and look up in Shopify
  - GET  /api/return-scans       — list return scans for the current user
  - POST /api/return-scans/manual — manually add a return scan
"""

import asyncio
import io
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
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
    tags: str = ""
    store: str = ""
    fulfillment: str = ""
    status: str = ""
    financial: str = ""
    total_price: str = ""
    currency: str = ""
    city: str = ""
    phone: str = ""
    fulfilled_at: str = ""
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
    total_price: str = ""
    currency: str = ""
    city: str = ""
    phone: str = ""
    fulfilled_at: str = ""


# ---- Shopify lookup helper (uses the main app's GraphQL) ----

_FIND_ORDER_QUERY = """
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
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress { city phone }
        billingAddress { city phone }
        customer { phone }
        fulfillments(first: 1) { createdAt }
      }
    }
  }
}
"""


def _parse_order_node(node: dict, store_key: str) -> dict:
    """Map a Shopify order node to the flat dict used by the scanner/DB."""
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

    money = ((node.get("totalPriceSet") or {}).get("shopMoney") or {})
    total_price = str(money.get("amount") or "")
    currency = str(money.get("currencyCode") or "")

    ship = node.get("shippingAddress") or {}
    bill = node.get("billingAddress") or {}
    cust = node.get("customer") or {}
    city = ship.get("city") or bill.get("city") or ""
    phone = ship.get("phone") or cust.get("phone") or bill.get("phone") or ""

    fulfilled_at = ""
    fulfillments = (node.get("fulfillments") or [])
    if fulfillments:
        fulfilled_at = fulfillments[0].get("createdAt") or ""

    return {
        "found": True,
        "store": store_key,
        "tags": ", ".join(node.get("tags") or []),
        "fulfillment": fulfillment,
        "status": status,
        "financial": financial,
        "result": result,
        "total_price": total_price,
        "currency": currency,
        "city": city,
        "phone": phone,
        "fulfilled_at": fulfilled_at,
    }


_NOT_FOUND = {
    "found": False,
    "store": "",
    "tags": "",
    "fulfillment": "",
    "status": "",
    "financial": "",
    "result": "❌ Not Found",
    "total_price": "",
    "currency": "",
    "city": "",
    "phone": "",
    "fulfilled_at": "",
}


async def _find_order_in_shopify(order_name: str) -> dict:
    """Look up *order_name* (e.g. ``#123456``) across configured Shopify stores.

    Queries all configured stores **in parallel** and returns the first match
    (in the stores' sorted order) for faster scanning.
    """
    # Import lazily to avoid circular imports
    from .main import known_store_labels, shopify_graphql

    # Strip '#' for the Shopify search query
    name_q = order_name.lstrip("#")
    stores = await known_store_labels()

    async def _lookup(store_key: str) -> Optional[dict]:
        try:
            data = await shopify_graphql(
                _FIND_ORDER_QUERY, {"first": 1, "query": f"name:{name_q}"}, store=store_key
            )
            edges = (data.get("orders") or {}).get("edges") or []
            if not edges:
                return None
            node = edges[0].get("node") or {}
            return _parse_order_node(node, store_key)
        except Exception:
            return None

    results = await asyncio.gather(*[_lookup(s) for s in stores])
    for res in results:
        if res:
            return res

    return dict(_NOT_FOUND)


def _tag_tokens(tags: str) -> list:
    """Split a stored ``tags`` string ("a, b, c") into normalised lowercase tokens."""
    return [t.strip().lower() for t in (tags or "").split(",") if t.strip()]


def _matches_company(row: ReturnScan, company: str) -> bool:
    """True if *row*'s order tags include *company* as a whole tag (case-insensitive)."""
    if not company:
        return True
    return company.strip().lower() in _tag_tokens(row.tags)


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
        "total_price": row.total_price or "",
        "currency": row.currency or "",
        "city": row.city or "",
        "phone": row.phone or "",
        "fulfilled_at": row.fulfilled_at or "",
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
        total_price=order.get("total_price", ""),
        currency=order.get("currency", ""),
        city=order.get("city", ""),
        phone=order.get("phone", ""),
        fulfilled_at=order.get("fulfilled_at", ""),
    )
    db.add(row)
    try:
        await db.commit()
    except Exception:
        await db.rollback()

    return ReturnScanOut(
        result=result_text,
        order=order_name,
        tags=order.get("tags", "") if found else "",
        store=order.get("store", "") if found else "",
        fulfillment=order.get("fulfillment", "") if found else "",
        status=order.get("status", "") if found else "",
        financial=order.get("financial", "") if found else "",
        total_price=order.get("total_price", "") if found else "",
        currency=order.get("currency", "") if found else "",
        city=order.get("city", "") if found else "",
        phone=order.get("phone", "") if found else "",
        fulfilled_at=order.get("fulfilled_at", "") if found else "",
        ts=now.isoformat(),
    )


async def _scans_in_range(
    db: AsyncSession,
    user: User,
    start: str,
    end: Optional[str],
    target_user_id: Optional[str] = None,
    company: Optional[str] = None,
):
    """Return ReturnScan rows in a [start, end] date range (YYYY-MM-DD, UTC).

    Scoping:
      - Admins see **all** users' scans by default, or a single user's scans
        when ``target_user_id`` is supplied.
      - Everyone else only ever sees their own scans (``target_user_id`` ignored).

    When ``company`` is supplied, only rows whose order tags include that
    delivery-company tag are returned.
    """
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

    is_admin = (getattr(user, "role", "") or "") == "admin"
    if is_admin:
        scope_user_id = target_user_id or None  # None => all users
    else:
        scope_user_id = user.id  # non-admins are always scoped to themselves

    from sqlalchemy.orm import selectinload

    conditions = [ReturnScan.ts >= start_day, ReturnScan.ts < end_day]
    if scope_user_id:
        conditions.append(ReturnScan.user_id == scope_user_id)

    stmt = (
        select(ReturnScan)
        .options(selectinload(ReturnScan.user))
        .where(*conditions)
        .order_by(ReturnScan.ts.desc())
    )
    q = await db.execute(stmt)
    rows = q.scalars().all()
    if company:
        rows = [r for r in rows if _matches_company(r, company)]
    return rows


@router.get("/api/return-scans")
async def list_return_scans(
    start: str,
    end: Optional[str] = None,
    user_id: Optional[str] = None,
    company: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """List return scans in a [start, end] date range (YYYY-MM-DD, UTC).

    Admins see all users (or one user via ``user_id``); others see only their own.
    Pass ``company`` to keep only orders tagged with that delivery company.
    """
    rows = await _scans_in_range(db, user, start, end, target_user_id=user_id, company=company)
    return {"rows": [_row_to_record(r) for r in rows]}


@router.get("/api/return-scans/search")
async def search_return_scans(
    order: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Search an exact return order across every scanner.

    Unlike the date-based history endpoint, this is intentionally not scoped to
    the current scanner. Any authenticated user can check whether an order was
    already scanned and see which agent scanned it.
    """
    try:
        order_name = _clean(order)
    except ValueError:
        raise HTTPException(400, "Invalid order number")

    from sqlalchemy.orm import selectinload

    stmt = (
        select(ReturnScan)
        .options(selectinload(ReturnScan.user))
        .where(ReturnScan.order_name == order_name)
        .order_by(ReturnScan.ts.desc())
        .limit(50)
    )
    q = await db.execute(stmt)
    rows = q.scalars().all()
    return {"order": order_name, "rows": [_row_to_record(r) for r in rows]}


@router.get("/api/return-scans/users")
async def return_scan_users(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """List users who have return scans (admin only) — powers the History user filter."""
    if (getattr(user, "role", "") or "") != "admin":
        return {"users": []}
    stmt = (
        select(User.id, User.email, User.name, func.count(ReturnScan.id).label("n"))
        .join(ReturnScan, User.id == ReturnScan.user_id)
        .group_by(User.id, User.email, User.name)
        .order_by(func.count(ReturnScan.id).desc())
    )
    q = await db.execute(stmt)
    return {
        "users": [
            {"id": uid, "email": email or "", "name": name or "", "count": int(n or 0)}
            for uid, email, name, n in q.all()
        ]
    }


def _fmt_dt(value, *, with_time: bool = True) -> str:
    """Format an ISO datetime string (or datetime) to a short, readable form."""
    if not value:
        return ""
    dt = value
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return value[:16].replace("T", " ")
    try:
        return dt.strftime("%Y-%m-%d %H:%M" if with_time else "%Y-%m-%d")
    except Exception:
        return str(value)


@router.get("/api/return-scans/pdf")
async def return_scans_pdf(
    start: str,
    end: Optional[str] = None,
    user_id: Optional[str] = None,
    company: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Generate a clean PDF table of return scans for a date range.

    Admins get all users (or one user via ``user_id``); others get their own.
    Pass ``company`` to keep only orders tagged with that delivery company.
    """
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate,
            Table,
            TableStyle,
            Paragraph,
            Spacer,
        )
    except Exception:
        raise HTTPException(
            500,
            "PDF support is not installed on the server (missing 'reportlab').",
        )

    rows = await _scans_in_range(db, user, start, end, target_user_id=user_id, company=company)

    is_admin = (getattr(user, "role", "") or "") == "admin"
    # Show a "Scanned by" column only when the table can span multiple users.
    show_user_col = is_admin and not user_id

    end_label = end or start
    range_label = start if end_label == start else f"{start} → {end_label}"
    if company:
        range_label += f" &nbsp;·&nbsp; {company.upper()}"
    if not is_admin:
        who = (user.name or user.email or "").strip()
    elif user_id:
        first_u = next((r.user for r in rows if r.user), None)
        who = ((first_u.name or first_u.email) if first_u else "").strip()
    else:
        who = "All users"

    styles = getSampleStyleSheet()
    title_style = styles["Title"]
    sub_style = ParagraphStyle("sub", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#475569"))
    cell_style = ParagraphStyle("cell", parent=styles["Normal"], fontSize=8, leading=10)
    head_style = ParagraphStyle(
        "head", parent=styles["Normal"], fontSize=8, leading=10,
        textColor=colors.white, fontName="Helvetica-Bold",
    )

    headers = ["Order #", "Store", "Total", "City", "Phone", "Fulfilled", "Scanned"]
    if show_user_col:
        headers.append("Scanned by")
    table_data = [[Paragraph(h, head_style) for h in headers]]

    for r in rows:
        total = (r.total_price or "").strip()
        if total and (r.currency or "").strip():
            total = f"{total} {r.currency.strip()}"
        cells = [
            r.order_name or "",
            (r.store or "").upper(),
            total,
            r.city or "",
            r.phone or "",
            _fmt_dt(r.fulfilled_at, with_time=False),
            _fmt_dt(r.ts, with_time=True),
        ]
        if show_user_col:
            cells.append((r.user.name or r.user.email) if r.user else "")
        table_data.append([Paragraph(str(c), cell_style) for c in cells])

    if len(table_data) == 1:
        table_data.append([Paragraph("No return scans for this date range.", cell_style)] + [Paragraph("", cell_style)] * (len(headers) - 1))

    # Column widths tuned for A4 landscape (~277mm usable).
    if show_user_col:
        col_widths = [25 * mm, 22 * mm, 25 * mm, 36 * mm, 34 * mm, 30 * mm, 34 * mm, 36 * mm]
    else:
        col_widths = [28 * mm, 26 * mm, 28 * mm, 45 * mm, 40 * mm, 38 * mm, 42 * mm]

    table = Table(table_data, colWidths=col_widths, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2563eb")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f1f5f9")]),
                ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
                ("LINEAFTER", (0, 0), (-2, -1), 0.4, colors.HexColor("#e2e8f0")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#94a3b8")),
            ]
        )
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=10 * mm,
        rightMargin=10 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title="Return Scans",
    )
    story = [
        Paragraph("Return Scans", title_style),
        Paragraph(
            f"{range_label} &nbsp;·&nbsp; {len(rows)} order(s)"
            + (f" &nbsp;·&nbsp; {who}" if who else ""),
            sub_style,
        ),
        Spacer(1, 8),
        table,
    ]
    doc.build(story)
    buf.seek(0)

    fname = (
        f"return-scans-{start}{('_' + end) if end and end != start else ''}"
        f"{('-' + company.lower()) if company else ''}.pdf"
    )
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


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
        total_price=order.get("total_price", ""),
        currency=order.get("currency", ""),
        city=order.get("city", ""),
        phone=order.get("phone", ""),
        fulfilled_at=order.get("fulfilled_at", ""),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    return _row_to_record(row)
