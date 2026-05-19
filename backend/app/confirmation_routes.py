"""
Call-center "Confirmation" feature: admin manages agents (users with role="agent")
who confirm Cash-on-Delivery Shopify orders by phone/WhatsApp.

Provides:
  - GET    /api/admin/agents                  -> list all agents
  - POST   /api/admin/agents                  -> create agent (email, password, name?, tags[])
  - PATCH  /api/admin/agents/{user_id}        -> rename, reset password, change tags
  - DELETE /api/admin/agents/{user_id}        -> deactivate agent
  - GET    /api/agent/me                      -> current agent info (tags, role)
  - GET    /api/agent/queue                   -> open orders carrying the agent's tags, excluding cod {today}
  - GET    /api/agent/team-stats              -> per-agent confirmed-today counts
"""

import asyncio
import os
import re
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth_routes import get_current_user, hash_password, require_admin
from .db import get_session
from .models import OrderEvent, User

router = APIRouter()

APP_TIMEZONE = os.environ.get("APP_TIMEZONE", "Africa/Casablanca").strip() or "Africa/Casablanca"


def _tz():
    try:
        return ZoneInfo(APP_TIMEZONE)
    except Exception:
        return ZoneInfo("UTC")


def today_cod_label() -> str:
    """`cod dd/mm/yy` value for 'today' in the app timezone."""
    now = datetime.now(_tz())
    return now.strftime("cod %d/%m/%y")


def today_ddmmyy() -> str:
    return datetime.now(_tz()).strftime("%d/%m/%y")


def _normalize_tags(raw: Any) -> List[str]:
    """Accept list or comma-separated string; trim, lowercase, de-dup, preserve order."""
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",")]
    else:
        try:
            parts = [str(p or "").strip() for p in list(raw)]
        except Exception:
            return []
    out: List[str] = []
    seen = set()
    for p in parts:
        if not p:
            continue
        # keep tag case as Shopify stores tags case-insensitively but renders the cased form
        key = p.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _agent_payload(u: User) -> Dict[str, Any]:
    return {
        "id": u.id,
        "email": u.email,
        "name": u.name,
        "role": u.role,
        "is_active": bool(u.is_active),
        "tags": list(u.agent_tags or []),
        "last_login_at": u.last_login_at.isoformat() if isinstance(u.last_login_at, datetime) else None,
        "created_at": u.created_at.isoformat() if isinstance(u.created_at, datetime) else None,
    }


# ---------- Admin: manage agents ----------

class AgentCreateBody(BaseModel):
    email: EmailStr
    password: str
    name: Optional[str] = None
    tags: Optional[List[str]] = None


class AgentUpdateBody(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    tags: Optional[List[str]] = None
    is_active: Optional[bool] = None


@router.get("/api/admin/agents")
async def list_agents(
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    res = await db.execute(
        select(User).where(User.role == "agent").order_by(User.created_at.desc())
    )
    users = res.scalars().all()
    return {"ok": True, "agents": [_agent_payload(u) for u in users]}


@router.post("/api/admin/agents")
async def create_agent(
    body: AgentCreateBody,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    email_norm = body.email.lower().strip()
    exists = await db.scalar(select(User).where(User.email == email_norm))
    if exists:
        raise HTTPException(status_code=400, detail="email already exists")
    user = User(
        email=email_norm,
        name=(body.name or "").strip() or None,
        password_hash=hash_password(body.password),
        role="agent",
        is_active=True,
        agent_tags=_normalize_tags(body.tags),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {"ok": True, "agent": _agent_payload(user)}


@router.patch("/api/admin/agents/{user_id}")
async def update_agent(
    user_id: str,
    body: AgentUpdateBody,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    user = await db.scalar(select(User).where(User.id == user_id))
    if not user or user.role != "agent":
        raise HTTPException(status_code=404, detail="agent not found")
    if body.name is not None:
        user.name = (body.name or "").strip() or None
    if body.password is not None and body.password.strip():
        user.password_hash = hash_password(body.password)
    if body.tags is not None:
        user.agent_tags = _normalize_tags(body.tags)
    if body.is_active is not None:
        user.is_active = bool(body.is_active)
    await db.commit()
    await db.refresh(user)
    return {"ok": True, "agent": _agent_payload(user)}


@router.delete("/api/admin/agents/{user_id}")
async def delete_agent(
    user_id: str,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    user = await db.scalar(select(User).where(User.id == user_id))
    if not user or user.role != "agent":
        raise HTTPException(status_code=404, detail="agent not found")
    # Soft delete: keep audit history (order_events FK) but block login & remove from queues.
    user.is_active = False
    user.agent_tags = []
    await db.commit()
    return {"ok": True}


# ---------- Agent self info ----------

@router.get("/api/agent/me")
async def agent_me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "tags": list(user.agent_tags or []),
    }


# ---------- Agent queue ----------

def _escape_tag(t: str) -> str:
    """Wrap a tag in double-quotes for Shopify search; escape internal quotes."""
    return '"' + str(t or "").replace('"', '\\"') + '"'


# Tag prefix wildcard that excludes every tag beginning with "cod" (e.g. "cod 18/05/26",
# "cod_done", "cod-pending"). Shopify search supports `tag:<prefix>*` and its negation
# `-tag:<prefix>*` on tag values. This lets the Shopify ordersCount and pagination match
# the Python post-filter, so "Assigned" agrees with what the agent can actually select.
_COD_EXCLUSION = "-tag:cod*"


def build_queue_query(tags: List[str]) -> Optional[str]:
    """Build a Shopify search query that returns open, unshipped, not-yet-confirmed orders
    carrying any of the agent's tags."""
    tags = [t for t in (tags or []) if t]
    if not tags:
        return None
    tag_or = " OR ".join(f"tag:{_escape_tag(t)}" for t in tags)
    parts = [
        "status:open",
        "fulfillment_status:unshipped",
        _COD_EXCLUSION,
        f"({tag_or})",
    ]
    return " ".join(parts)


def build_catchall_query() -> str:
    """Build a Shopify search query for an "untagged" agent: every open, unshipped order
    that isn't already confirmed. Cancelled orders are excluded by `status:open`."""
    return f"status:open fulfillment_status:unshipped {_COD_EXCLUSION}"


async def query_for_user(db: AsyncSession, user: User) -> Optional[str]:
    """Return the Shopify search query an agent's queue should use.

    - Tags assigned             → positive OR-of-tags query
    - No tags but role=="agent" → catch-all: every open, unshipped, not-yet-confirmed order
    - Otherwise                 → None (their queue is intentionally empty)
    """
    tags = list(user.agent_tags or [])
    if tags:
        return build_queue_query(tags)
    if user.role == "agent":
        return build_catchall_query()
    return None


_VALID_LEVELS = {"n1", "n2", "n3", "n4", "nowtp", "enatt", "new"}
_NOWTP_TAGS = ("nowtp1", "nowtp2", "nowtp3", "nowtp4")
_ENATT_TAGS = ("enatt1", "enatt2", "enatt3", "enatt4")


def apply_level_filter(q: str, level: Optional[str]) -> str:
    """Narrow an agent's queue query by call-attempt level.

    n1/n2/n3/n4 → only orders carrying that exact attempt tag.
    nowtp       → orders carrying any of nowtp1/nowtp2/nowtp3/nowtp4.
    enatt       → orders carrying any of enatt1/enatt2/enatt3/enatt4.
    new         → orders with none of n1/n2/n3/n4/nowtp*/enatt* (not yet handled).
    """
    if not q or not level:
        return q
    lv = level.lower().strip()
    if lv not in _VALID_LEVELS:
        return q
    if lv in ("n1", "n2", "n3", "n4"):
        return f"{q} tag:{_escape_tag(lv)}"
    if lv == "nowtp":
        nowtp_or = " OR ".join(f"tag:{_escape_tag(t)}" for t in _NOWTP_TAGS)
        return f"{q} ({nowtp_or})"
    if lv == "enatt":
        enatt_or = " OR ".join(f"tag:{_escape_tag(t)}" for t in _ENATT_TAGS)
        return f"{q} ({enatt_or})"
    if lv == "new":
        nowtp_neg = " ".join(f"-tag:{_escape_tag(t)}" for t in _NOWTP_TAGS)
        enatt_neg = " ".join(f"-tag:{_escape_tag(t)}" for t in _ENATT_TAGS)
        return f"{q} -tag:n1 -tag:n2 -tag:n3 -tag:n4 {nowtp_neg} {enatt_neg}"
    return q


_COD_TAG_RE = re.compile(r"^\s*cod(\s|$)", re.IGNORECASE)


def has_cod_tag(tags: List[str]) -> bool:
    for t in tags or []:
        if _COD_TAG_RE.match(str(t or "")):
            return True
    return False


# (key=(user_id, store, base_query)) → (timestamp_seconds, breakdown_dict). One full
# pagination scan produces the total count AND the per-level (n1/n2/n3/n4/new) counts;
# the queue endpoint and team-stats both read from this cache so the 15-second polling
# and the per-level filter pills don't trigger fresh scans.
_BREAKDOWN_CACHE: Dict[Tuple[str, str, str], Tuple[float, Dict[str, int]]] = {}
_BREAKDOWN_TTL_SECONDS = 60
_BREAKDOWN_SCAN_PAGE = 250  # Shopify's max page size
_BREAKDOWN_HARD_CAP = 10_000  # safety net


def _empty_breakdown() -> Dict[str, int]:
    return {"total": 0, "n1": 0, "n2": 0, "n3": 0, "n4": 0, "nowtp": 0, "enatt": 0, "new": 0}


async def accurate_assigned_breakdown(store: str, user_id: str, base_q: str) -> Dict[str, int]:
    """Walk every Shopify page for `base_q`, drop cod-tagged orders, and return the total
    plus counts for each call-attempt level (n1/n2/n3/n4/new).

    Cached per (user, store, base_query) for 60 seconds.
    """
    key = (user_id, store, base_q)
    now = time.time()
    cached = _BREAKDOWN_CACHE.get(key)
    if cached and (now - cached[0]) < _BREAKDOWN_TTL_SECONDS:
        return cached[1]

    from .main import shopify_graphql  # type: ignore

    gql = """
    query Q($first: Int!, $after: String, $q: String) {
      orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges { cursor node { tags } }
        pageInfo { hasNextPage }
      }
    }
    """
    counts = _empty_breakdown()
    cursor: Optional[str] = None
    while counts["total"] < _BREAKDOWN_HARD_CAP:
        try:
            data = await shopify_graphql(gql, {"first": _BREAKDOWN_SCAN_PAGE, "after": cursor, "q": base_q}, store=store)
        except Exception:
            break
        edges = ((data or {}).get("orders") or {}).get("edges") or []
        if not edges:
            break
        for e in edges:
            tags_list = list((e.get("node") or {}).get("tags") or [])
            if has_cod_tag(tags_list):
                continue
            counts["total"] += 1
            tlower = {str(t or "").strip().lower() for t in tags_list}
            has_any = False
            for lv in ("n1", "n2", "n3", "n4"):
                if lv in tlower:
                    counts[lv] += 1
                    has_any = True
            if any(t in tlower for t in _NOWTP_TAGS):
                counts["nowtp"] += 1
                has_any = True
            if any(t in tlower for t in _ENATT_TAGS):
                counts["enatt"] += 1
                has_any = True
            if not has_any:
                counts["new"] += 1
        page_info = ((data or {}).get("orders") or {}).get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            break
        cursor = edges[-1].get("cursor")

    _BREAKDOWN_CACHE[key] = (now, counts)
    return counts


def _cached_breakdown(store: str, user_id: str, base_q: str) -> Optional[Dict[str, int]]:
    """Return the cached breakdown if fresh, else None."""
    cached = _BREAKDOWN_CACHE.get((user_id, store, base_q))
    if cached and (time.time() - cached[0]) < _BREAKDOWN_TTL_SECONDS:
        return cached[1]
    return None


async def accurate_assigned_count(store: str, user_id: str, base_q: str) -> int:
    """Thin wrapper for callers that only need the total. Shares the breakdown cache."""
    bd = await accurate_assigned_breakdown(store, user_id, base_q)
    return int(bd.get("total") or 0)


def invalidate_breakdown_cache_for_user(user_id: str, store: Optional[str] = None) -> int:
    """Drop cached breakdowns for a user (optionally limited to a single store).

    Called after the agent writes a tag so the next /api/agent/queue (or team-stats)
    call recomputes counts instead of returning a stale snapshot. Returns the number
    of cache entries removed.
    """
    if not user_id:
        return 0
    keys = []
    for key in list(_BREAKDOWN_CACHE.keys()):
        u, s, _q = key
        if u != user_id:
            continue
        if store is not None and s != store:
            continue
        keys.append(key)
    for k in keys:
        _BREAKDOWN_CACHE.pop(k, None)
    return len(keys)


def invalidate_all_breakdown_caches() -> int:
    """Wipe every breakdown cache entry (used when a tag change might affect any agent's
    counts — e.g. when a confirmation tag is added that takes an order out of every
    queue at once)."""
    n = len(_BREAKDOWN_CACHE)
    _BREAKDOWN_CACHE.clear()
    return n


QUEUE_QUERY_GQL = """
query AgentQueue($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
    edges {
      cursor
      node {
        id
        legacyResourceId
        name
        createdAt
        tags
        note
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress { name city phone address1 address2 zip province country }
        customer { id displayName phone }
        lineItems(first: 50) {
          edges {
            node {
              quantity
              sku
              title
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              variant {
                id
                title
                sku
                selectedOptions { name value }
                image { url }
                product { id title featuredImage { url } }
              }
            }
          }
        }
      }
    }
    pageInfo { hasNextPage }
  }
  ordersCount(query: $query) { count }
}
"""


def _gather_phone(node: Dict[str, Any]) -> str:
    shipping = node.get("shippingAddress") or {}
    cust = node.get("customer") or {}
    return (
        (shipping.get("phone") or "").strip()
        or (cust.get("phone") or "").strip()
        or ""
    )


def _money(v: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    m = ((v or {}).get("shopMoney") or {})
    return {"amount": m.get("amount") or "0", "currency": m.get("currencyCode") or ""}


def _flatten_order(node: Dict[str, Any]) -> Dict[str, Any]:
    shipping = node.get("shippingAddress") or {}
    cust = node.get("customer") or {}
    line_edges = ((node.get("lineItems") or {}).get("edges")) or []
    line_items = []
    for e in line_edges:
        n = e.get("node") or {}
        variant = n.get("variant") or {}
        product = variant.get("product") or {}
        img = (variant.get("image") or {}).get("url") or ((product.get("featuredImage") or {}).get("url"))
        unit = _money(n.get("originalUnitPriceSet"))
        line_items.append({
            "title": n.get("title") or product.get("title") or "",
            "variant_title": variant.get("title") or "",
            "options": variant.get("selectedOptions") or [],
            "sku": n.get("sku") or variant.get("sku") or "",
            "quantity": int(n.get("quantity") or 0),
            "unit_price": unit["amount"],
            "currency": unit["currency"],
            "image": img,
        })
    total = _money(node.get("currentTotalPriceSet"))
    return {
        "id": node.get("id"),
        "legacy_id": str(node.get("legacyResourceId") or "").strip(),
        "number": (node.get("name") or "").lstrip("#"),
        "name": node.get("name") or "",
        "customer_id": (cust.get("id") or ""),
        "customer_phone": (cust.get("phone") or ""),
        "created_at": node.get("createdAt"),
        "tags": list(node.get("tags") or []),
        "note": node.get("note") or "",
        "financial_status": node.get("displayFinancialStatus") or "",
        "fulfillment_status": node.get("displayFulfillmentStatus") or "",
        "customer_name": (shipping.get("name") or cust.get("displayName") or "").strip(),
        "phone": _gather_phone(node),
        "shipping_address1": shipping.get("address1") or "",
        "shipping_address2": shipping.get("address2") or "",
        "shipping_city": shipping.get("city") or "",
        "shipping_country": shipping.get("country") or "",
        "shipping_zip": shipping.get("zip") or "",
        "total_price": total["amount"],
        "currency": total["currency"],
        "line_items": line_items,
    }


@router.get("/api/agent/queue")
async def agent_queue(
    store: str,
    limit: int = 50,
    cursor: Optional[str] = None,
    level: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    today_label = today_cod_label()
    # Resolve the shop domain so the agent UI can link to the Shopify admin order page.
    shop_domain = ""
    try:
        from .main import resolve_store_settings_effective  # type: ignore
        domain, _token, _api = await resolve_store_settings_effective(store)
        shop_domain = (domain or "").strip()
    except Exception:
        shop_domain = ""
    base_q = await query_for_user(db, user)
    if not base_q:
        return {
            "ok": True, "orders": [], "assigned_total": 0, "nextCursor": None,
            "today_label": today_label, "shop_domain": shop_domain,
        }
    q = apply_level_filter(base_q, level)

    # Import lazily to avoid a circular import with main.py at module load time.
    from .main import shopify_graphql  # type: ignore

    page_size = max(1, min(100, int(limit or 50)))
    try:
        data = await shopify_graphql(
            QUEUE_QUERY_GQL,
            {"first": page_size, "after": cursor, "query": q},
            store=store,
        )
    except HTTPException as he:
        raise he
    edges = ((data or {}).get("orders") or {}).get("edges") or []
    page_info = ((data or {}).get("orders") or {}).get("pageInfo") or {}
    has_next = bool(page_info.get("hasNextPage"))
    next_cursor = edges[-1].get("cursor") if (has_next and edges) else None

    # Build the current page's orders (dropping cod-tagged stragglers).
    orders: List[Dict[str, Any]] = []
    for e in edges:
        node = e.get("node") or {}
        tags_list = list(node.get("tags") or [])
        if has_cod_tag(tags_list):
            continue
        orders.append(_flatten_order(node))

    # Compute the per-level breakdown ONCE on page 1 (or use a fresh cache hit on follow-up
    # pages). The breakdown is derived from `base_q` — i.e. the agent's full tag-criteria
    # query WITHOUT any active level filter — so the N1/N2/N3/N4/New pills always show
    # the same totals regardless of which pill is currently selected.
    if cursor is None:
        try:
            breakdown = await accurate_assigned_breakdown(store, user.id, base_q)
        except Exception:
            breakdown = _empty_breakdown()
            breakdown["total"] = int(((data or {}).get("ordersCount") or {}).get("count") or 0)
    else:
        bd_cached = _cached_breakdown(store, user.id, base_q)
        if bd_cached is not None:
            breakdown = bd_cached
        else:
            breakdown = _empty_breakdown()
            breakdown["total"] = int(((data or {}).get("ordersCount") or {}).get("count") or 0)

    # `Assigned` reflects the active filter so it agrees with what's visible in the table.
    lv = (level or "").lower().strip()
    if lv in ("n1", "n2", "n3", "n4", "nowtp", "enatt", "new"):
        assigned_total = int(breakdown.get(lv, 0))
    else:
        assigned_total = int(breakdown.get("total", 0))

    return {
        "ok": True,
        "orders": orders,
        "assigned_total": assigned_total,
        "level_counts": {
            "total": int(breakdown.get("total", 0)),
            "n1": int(breakdown.get("n1", 0)),
            "n2": int(breakdown.get("n2", 0)),
            "n3": int(breakdown.get("n3", 0)),
            "n4": int(breakdown.get("n4", 0)),
            "nowtp": int(breakdown.get("nowtp", 0)),
            "enatt": int(breakdown.get("enatt", 0)),
            "new": int(breakdown.get("new", 0)),
        },
        "nextCursor": next_cursor,
        "today_label": today_label,
        "shop_domain": shop_domain,
    }


# ---------- Customer order history (for the row-expand panel) ----------

CUSTOMER_ORDERS_GQL = """
query CustomerOrders($id: ID!, $first: Int!) {
  customer(id: $id) {
    id
    displayName
    numberOfOrders
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          legacyResourceId
          name
          createdAt
          cancelledAt
          displayFulfillmentStatus
          displayFinancialStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }
}
"""


@router.get("/api/agent/customer-orders")
async def customer_orders(
    store: str,
    customer_id: str,
    first: int = 20,
    user: User = Depends(get_current_user),
):
    cid = (customer_id or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="customer_id is required")
    if not cid.startswith("gid://"):
        # Accept a numeric id as a convenience.
        cid = f"gid://shopify/Customer/{cid}"
    from .main import shopify_graphql, resolve_store_settings_effective  # type: ignore
    shop_domain = ""
    try:
        domain, _t, _a = await resolve_store_settings_effective(store)
        shop_domain = (domain or "").strip()
    except Exception:
        shop_domain = ""
    try:
        data = await shopify_graphql(
            CUSTOMER_ORDERS_GQL,
            {"id": cid, "first": max(1, min(50, int(first or 20)))},
            store=store,
        )
    except HTTPException as he:
        raise he
    customer = (data or {}).get("customer") or {}
    edges = ((customer.get("orders") or {}).get("edges") or [])
    orders_out: List[Dict[str, Any]] = []
    for e in edges:
        n = e.get("node") or {}
        money = ((n.get("currentTotalPriceSet") or {}).get("shopMoney") or {})
        orders_out.append({
            "id": n.get("id"),
            "legacy_id": str(n.get("legacyResourceId") or "").strip(),
            "name": n.get("name") or "",
            "number": (n.get("name") or "").lstrip("#"),
            "created_at": n.get("createdAt"),
            "cancelled_at": n.get("cancelledAt"),
            "fulfillment_status": n.get("displayFulfillmentStatus") or "",
            "financial_status": n.get("displayFinancialStatus") or "",
            "total_price": money.get("amount") or "0",
            "currency": money.get("currencyCode") or "",
        })
    return {
        "ok": True,
        "customer_id": customer.get("id") or cid,
        "display_name": customer.get("displayName") or "",
        "total_orders": int(customer.get("numberOfOrders") or 0),
        "orders": orders_out,
        "shop_domain": shop_domain,
    }


# ---------- Cancel a Shopify order ----------

_VALID_CANCEL_REASONS = {"CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "OTHER", "STAFF"}


class CancelOrderBody(BaseModel):
    store: str
    reason: str = "CUSTOMER"
    staff_note: Optional[str] = None
    restock: bool = True
    refund: bool = True
    notify_customer: bool = False


@router.post("/api/agent/orders/{order_gid:path}/cancel")
async def cancel_order(
    order_gid: str,
    body: CancelOrderBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    reason = (body.reason or "CUSTOMER").upper().strip()
    if reason not in _VALID_CANCEL_REASONS:
        raise HTTPException(status_code=400, detail=f"invalid reason; one of {sorted(_VALID_CANCEL_REASONS)}")
    store = (body.store or "").strip()
    if not store:
        raise HTTPException(status_code=400, detail="store is required")

    from .main import shopify_graphql, _record_user_action, _normalize_store  # type: ignore

    mutation = """
    mutation CancelOrder(
      $orderId: ID!,
      $reason: OrderCancelReason!,
      $refund: Boolean!,
      $restock: Boolean!,
      $staffNote: String,
      $notifyCustomer: Boolean
    ) {
      orderCancel(
        orderId: $orderId,
        reason: $reason,
        refund: $refund,
        restock: $restock,
        staffNote: $staffNote,
        notifyCustomer: $notifyCustomer
      ) {
        orderCancelUserErrors { code field message }
        userErrors { field message }
      }
    }
    """
    variables = {
        "orderId": order_gid,
        "reason": reason,
        "refund": bool(body.refund),
        "restock": bool(body.restock),
        "staffNote": (body.staff_note or "").strip() or None,
        "notifyCustomer": bool(body.notify_customer),
    }
    try:
        data = await shopify_graphql(mutation, variables, store=store)
    except HTTPException as he:
        raise he
    result = (data or {}).get("orderCancel") or {}
    errs = (result.get("orderCancelUserErrors") or []) + (result.get("userErrors") or [])
    if errs:
        msg = "; ".join(f"{e.get('field') or '?'}: {e.get('message') or ''}" for e in errs)
        raise HTTPException(status_code=400, detail=f"Shopify cancel failed: {msg}")

    # Best-effort audit log (independent of any tag mutations).
    try:
        await _record_user_action(
            db,
            user_id=user.id,
            order_number=None,
            order_gid=order_gid,
            store_key=_normalize_store(store),
            action="confirmation_cancelled",
            metadata={
                "reason": reason,
                "restock": bool(body.restock),
                "refund": bool(body.refund),
                "staff_note": (body.staff_note or "").strip() or None,
            },
        )
        await db.commit()
    except Exception:
        try: await db.rollback()
        except Exception: pass

    return {"ok": True}


# ---------- Bulk tag apply (entire queue or specific IDs) ----------

class BulkTagBody(BaseModel):
    tag: str
    store: str
    scope: Optional[str] = None     # "all" → apply to every order in the agent's queue
    level: Optional[str] = None     # narrows scope=="all" by n1/n2/n3/new
    order_ids: Optional[List[str]] = None  # used when scope != "all"


_BULK_CONCURRENCY = 10


@router.post("/api/agent/bulk-tag")
async def bulk_tag(
    body: BulkTagBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    tag = (body.tag or "").strip()
    if not tag:
        raise HTTPException(status_code=400, detail="tag is required")
    store = (body.store or "").strip()
    if not store:
        raise HTTPException(status_code=400, detail="store is required")

    # Resolve which order IDs to tag.
    order_ids: List[str] = []
    if (body.scope or "").lower() == "all":
        base_q = await query_for_user(db, user)
        if not base_q:
            raise HTTPException(status_code=400, detail="no queue access for this user")
        q = apply_level_filter(base_q, body.level)
        # Paginate through Shopify, collecting non-cod order IDs.
        from .main import shopify_graphql  # type: ignore
        gql = """
        query Q($first: Int!, $after: String, $q: String) {
          orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
            edges { cursor node { id tags } }
            pageInfo { hasNextPage }
          }
        }
        """
        cursor: Optional[str] = None
        # Safety cap so a runaway query doesn't tag thousands of orders.
        MAX_BULK = 2000
        while True:
            data = await shopify_graphql(gql, {"first": 100, "after": cursor, "q": q}, store=store)
            edges = ((data or {}).get("orders") or {}).get("edges") or []
            for e in edges:
                node = e.get("node") or {}
                if has_cod_tag(node.get("tags") or []):
                    continue
                gid = node.get("id")
                if gid:
                    order_ids.append(gid)
                    if len(order_ids) >= MAX_BULK:
                        break
            page_info = ((data or {}).get("orders") or {}).get("pageInfo") or {}
            if (not page_info.get("hasNextPage")) or (not edges) or len(order_ids) >= MAX_BULK:
                break
            cursor = edges[-1].get("cursor")
    else:
        order_ids = [str(x or "").strip() for x in (body.order_ids or []) if str(x or "").strip()]
        if not order_ids:
            raise HTTPException(status_code=400, detail="order_ids is required when scope != 'all'")

    if not order_ids:
        return {"ok": True, "tagged": 0, "total": 0, "tag": tag}

    # Tag each order with bounded concurrency.
    from .main import _shopify_add_tag, _record_user_action, _normalize_store, _classify_agent_tag_action  # type: ignore

    sem = asyncio.Semaphore(_BULK_CONCURRENCY)
    audit_records: List[Dict[str, Any]] = []

    async def _tag_one(oid: str) -> bool:
        async with sem:
            try:
                await _shopify_add_tag(oid, tag, store)
                audit_records.append({"order_gid": oid})
                return True
            except Exception:
                return False

    results = await asyncio.gather(*[_tag_one(o) for o in order_ids])
    tagged = sum(1 for r in results if r)

    # Best-effort audit log. We commit per record so a single unique-constraint clash
    # (e.g. the user already confirmed an order earlier) doesn't roll back the others.
    action_name = _classify_agent_tag_action(tag) or "confirmation_tag_add"
    store_key_norm = _normalize_store(store)
    for rec in audit_records:
        try:
            await _record_user_action(
                db,
                user_id=user.id,
                order_number=None,
                order_gid=rec["order_gid"],
                store_key=store_key_norm,
                action=action_name,
                metadata={"tag": tag, "op": "add", "bulk": True},
            )
            await db.commit()
        except Exception:
            try: await db.rollback()
            except Exception: pass

    return {"ok": True, "tagged": tagged, "total": len(order_ids), "tag": tag}


# ---------- Agent team stats (confirmed today across team) ----------

@router.get("/api/agent/team-stats")
async def team_stats(
    store: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    today_label = today_cod_label()

    # Roster: any active user who is either intentionally an "agent" or has tags assigned.
    res = await db.execute(select(User).where(User.is_active == True))  # noqa: E712
    all_active = res.scalars().all()
    agents = [u for u in all_active if u.role == "agent" or (u.agent_tags or [])]
    if not agents:
        return {"ok": True, "agents": [], "today_label": today_label}

    # ----- Confirmed today (audit log) -----
    # An agent's confirmed_today is the number of distinct orders they marked Confirmed today
    # in the app timezone, regardless of which delivery date they chose. This comes from the
    # OrderEvent rows written when a `cod ...` tag is added by a user.
    tz = _tz()
    today_local = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_local = today_local + timedelta(days=1)
    today_utc = today_local.astimezone(timezone.utc)
    tomorrow_utc = tomorrow_local.astimezone(timezone.utc)
    agent_ids = [a.id for a in agents]
    confirmed_map: Dict[str, int] = {a.id: 0 for a in agents}
    if agent_ids:
        rows = await db.execute(
            select(OrderEvent.user_id, func.count(OrderEvent.id))
            .where(
                OrderEvent.action == "confirmation_confirmed",
                OrderEvent.user_id.in_(agent_ids),
                OrderEvent.created_at >= today_utc,
                OrderEvent.created_at < tomorrow_utc,
            )
            .group_by(OrderEvent.user_id)
        )
        for uid, count in rows.all():
            confirmed_map[uid] = int(count or 0)

    # ----- Assigned per agent (Shopify ordersCount) -----
    # Run all per-agent counts in parallel. Inflates counts slightly because Shopify search
    # has no reliable wildcard exclusion for multi-word tags like "cod 18/05/26"; the agent's
    # own /confirmation queue post-filters them away.
    from .main import shopify_graphql  # type: ignore

    queries: List[Optional[str]] = []
    for a in agents:
        queries.append(await query_for_user(db, a))

    async def _accurate_count_for(idx: int) -> int:
        q = queries[idx]
        if not q:
            return 0
        try:
            return await accurate_assigned_count(store, agents[idx].id, q)
        except Exception:
            return 0

    counts = await asyncio.gather(*[_accurate_count_for(i) for i in range(len(agents))])
    assigned_map = {a.id: counts[i] for i, a in enumerate(agents)}

    return {
        "ok": True,
        "today_label": today_label,
        "agents": [
            {
                "id": a.id,
                "email": a.email,
                "name": a.name,
                "role": a.role,
                "tags": list(a.agent_tags or []),
                "is_catchall": (a.role == "agent" and not (a.agent_tags or [])),
                "assigned": assigned_map.get(a.id, 0),
                "confirmed_today": confirmed_map.get(a.id, 0),
            }
            for a in agents
        ],
    }
