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
import logging
import os
import re
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

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


def build_catchall_query(exclude_tags: Optional[List[str]] = None) -> str:
    """Build a Shopify search query for an "untagged" agent — every open, unshipped order
    that doesn't carry any OTHER agent's tag (so two agents never see the same order).
    Cancelled orders are already excluded by `status:open`; cod-dated ones are dropped
    by the Python post-filter (Shopify's tag wildcards don't match multi-word tags)."""
    parts: List[str] = ["status:open", "fulfillment_status:unshipped", _COD_EXCLUSION]
    for t in (exclude_tags or []):
        if t:
            parts.append(f"-tag:{_escape_tag(t)}")
    return " ".join(parts)


async def _other_agents_active_tags(db: AsyncSession, exclude_user_id: Optional[str] = None) -> List[str]:
    """Every Shopify tag claimed by some OTHER active confirmation user, sorted + deduped."""
    res = await db.execute(
        select(User).where(User.is_active == True)  # noqa: E712
    )
    out: set = set()
    for u in res.scalars().all():
        if exclude_user_id and u.id == exclude_user_id:
            continue
        for t in (u.agent_tags or []):
            if t:
                out.add(t)
    return sorted(out)


async def query_for_user(db: AsyncSession, user: User) -> Optional[str]:
    """Return the Shopify search query an agent's queue should use.

    - Tags assigned             → positive OR-of-tags query
    - No tags but role=="agent" → catch-all: open + unshipped + no cod + none of the
                                  OTHER active agents' tags
    - Otherwise                 → None (their queue is intentionally empty)
    """
    tags = list(user.agent_tags or [])
    if tags:
        return build_queue_query(tags)
    if user.role == "agent":
        other = await _other_agents_active_tags(db, exclude_user_id=user.id)
        return build_catchall_query(other)
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


# Shared GraphQL field set for any "interactive" order card (queue, global search,
# customer expansion). _flatten_order consumes the same shape, so the frontend gets
# identical data regardless of which endpoint it came from.
_ORDER_NODE_FIELDS = """
id
legacyResourceId
name
createdAt
cancelledAt
tags
note
displayFinancialStatus
displayFulfillmentStatus
currentTotalPriceSet { shopMoney { amount currencyCode } }
shippingAddress { name city phone address1 address2 zip province country }
customer { id displayName phone email }
lineItems(first: 50) {
  edges {
    node {
      quantity
      currentQuantity
      unfulfilledQuantity
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
"""


QUEUE_QUERY_GQL = f"""
query AgentQueue($first: Int!, $after: String, $query: String) {{
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {{
    edges {{
      cursor
      node {{ {_ORDER_NODE_FIELDS} }}
    }}
    pageInfo {{ hasNextPage }}
  }}
  ordersCount(query: $query) {{ count }}
}}
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
        # Skip "Removed" line items (edited off the order). Shopify keeps the row in the
        # lineItems collection but sets currentQuantity to 0. Match the Shopify admin
        # view that splits Unfulfilled vs. Removed sections.
        try:
            current_qty = int(n.get("currentQuantity"))
        except Exception:
            current_qty = int(n.get("quantity") or 0)
        if current_qty <= 0:
            continue
        variant = n.get("variant") or {}
        product = variant.get("product") or {}
        img = (variant.get("image") or {}).get("url") or ((product.get("featuredImage") or {}).get("url"))
        unit = _money(n.get("originalUnitPriceSet"))
        line_items.append({
            "title": n.get("title") or product.get("title") or "",
            "variant_title": variant.get("title") or "",
            "options": variant.get("selectedOptions") or [],
            "sku": n.get("sku") or variant.get("sku") or "",
            "quantity": current_qty,
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
        "customer_email": (cust.get("email") or ""),
        "created_at": node.get("createdAt"),
        "cancelled_at": node.get("cancelledAt"),
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

    # Iteratively pull Shopify pages, dropping cod-tagged orders, until we have a full
    # page_size of actionable orders to return. This keeps every page the agent sees at
    # the requested size — Shopify's tag-wildcard exclusion is unreliable for multi-word
    # tags like "cod 18/05/26", so we filter in Python here and just keep pulling.
    orders: List[Dict[str, Any]] = []
    next_cursor: Optional[str] = None
    inner_cursor: Optional[str] = cursor
    BATCH = 100
    MAX_BATCHES = 12
    last_data: Optional[Dict[str, Any]] = None
    for _ in range(MAX_BATCHES):
        try:
            data = await shopify_graphql(
                QUEUE_QUERY_GQL,
                {"first": BATCH, "after": inner_cursor, "query": q},
                store=store,
            )
        except HTTPException as he:
            if not orders:
                raise he
            break
        last_data = data
        edges = ((data or {}).get("orders") or {}).get("edges") or []
        page_info = ((data or {}).get("orders") or {}).get("pageInfo") or {}
        if not edges:
            next_cursor = None
            break

        filled = False
        for idx, e in enumerate(edges):
            node = e.get("node") or {}
            tags_list = list(node.get("tags") or [])
            if has_cod_tag(tags_list):
                continue
            orders.append(_flatten_order(node))
            if len(orders) >= page_size:
                # Did we exhaust this batch + the next page is empty? If so we're done.
                more_remaining = (idx < len(edges) - 1) or bool(page_info.get("hasNextPage"))
                next_cursor = e.get("cursor") if more_remaining else None
                filled = True
                break
        if filled:
            break

        # Burned through this batch without filling — continue from the last edge.
        if not page_info.get("hasNextPage"):
            next_cursor = None
            break
        inner_cursor = edges[-1].get("cursor")
    data = last_data or {}

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

CUSTOMER_ORDERS_GQL = f"""
query CustomerOrders($id: ID!, $first: Int!) {{
  customer(id: $id) {{
    id
    displayName
    numberOfOrders
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {{
      edges {{
        node {{ {_ORDER_NODE_FIELDS} }}
      }}
    }}
  }}
}}
"""


# ---------- Global Shopify search (orders + customers) ----------

SEARCH_ORDERS_GQL = f"""
query SearchOrders($first: Int!, $query: String) {{
  orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {{
    edges {{
      node {{ {_ORDER_NODE_FIELDS} }}
    }}
  }}
}}
"""

SEARCH_CUSTOMERS_GQL = """
query SearchCustomers($first: Int!, $query: String) {
  customers(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
    edges {
      node {
        id
        displayName
        firstName
        lastName
        email
        phone
        numberOfOrders
        defaultAddress { city country }
      }
    }
  }
}
"""


@router.get("/api/agent/search")
async def agent_search(
    store: str,
    q: str = "",
    user: User = Depends(get_current_user),
):
    """Free-text lookup across orders + customers in the selected store. Accepts the kind
    of messy input agents actually type: `+212 614 162-654`, `#71779`, `71779`, `Khadija`.

    Phone-like queries are normalized (strip `+`, spaces, dashes) and matched as a
    wildcard suffix so a Moroccan number works whether typed as `0614162654` or
    `+212614162654`.
    """
    raw = (q or "").strip()
    if not raw or len(raw) < 2:
        return {"ok": True, "orders": [], "customers": [], "shop_domain": "", "query": raw}

    digits = re.sub(r"\D", "", raw)
    # Drop a leading 0 / 212 country code so the wildcard match catches all formats.
    norm_tail = digits
    if norm_tail.startswith("00"):
        norm_tail = norm_tail[2:]
    if norm_tail.startswith("212"):
        norm_tail = norm_tail[3:]
    elif norm_tail.startswith("0"):
        norm_tail = norm_tail[1:]
    # Use up to the last 9 digits as the wildcard tail — long enough to be unique, short
    # enough to survive whatever country-code prefix the data was stored with.
    tail = norm_tail[-9:] if len(norm_tail) >= 9 else norm_tail

    has_digits = bool(digits)
    looks_like_phone = has_digits and len(digits) >= 6

    # Resolve store domain so the frontend can deep-link rows to Shopify admin.
    from .main import shopify_graphql, resolve_store_settings_effective  # type: ignore
    shop_domain = ""
    try:
        d, _t, _a = await resolve_store_settings_effective(store)
        shop_domain = (d or "").strip()
    except Exception:
        shop_domain = ""

    # Build order + customer search queries.
    order_terms: List[str] = []
    customer_terms: List[str] = []
    if has_digits:
        # Order-number match — Shopify accepts both `name:1001` and `name:#1001`.
        order_terms.append(f"name:{digits}")
        order_terms.append(f"name:#{digits}")
    if looks_like_phone and tail:
        order_terms.append(f"phone:*{tail}*")
        customer_terms.append(f"phone:*{tail}*")
    if not has_digits:
        # Free-text — let Shopify try a default match across customer name / email.
        order_terms.append(raw)
        customer_terms.append(raw)
    elif raw != digits:
        # Mixed input (e.g. "John 1001") — also try the raw string as a fallback.
        order_terms.append(raw)
        customer_terms.append(raw)

    order_query = " OR ".join(f"({t})" for t in order_terms) if order_terms else None
    customer_query = " OR ".join(f"({t})" for t in customer_terms) if customer_terms else None

    orders_out: List[Dict[str, Any]] = []
    customers_out: List[Dict[str, Any]] = []

    if order_query:
        try:
            data = await shopify_graphql(SEARCH_ORDERS_GQL, {"first": 25, "query": order_query}, store=store)
            edges = ((data or {}).get("orders") or {}).get("edges") or []
            for e in edges:
                node = e.get("node") or {}
                orders_out.append(_flatten_order(node))
        except Exception:
            # Search failures shouldn't 500 — return whatever we have.
            pass

    if customer_query:
        try:
            data = await shopify_graphql(SEARCH_CUSTOMERS_GQL, {"first": 10, "query": customer_query}, store=store)
            edges = ((data or {}).get("customers") or {}).get("edges") or []
            for e in edges:
                node = e.get("node") or {}
                addr = node.get("defaultAddress") or {}
                customers_out.append({
                    "id": node.get("id"),
                    "name": node.get("displayName") or " ".join([x for x in [node.get("firstName"), node.get("lastName")] if x]) or "",
                    "email": node.get("email") or "",
                    "phone": node.get("phone") or "",
                    "orders_count": int(node.get("numberOfOrders") or 0),
                    "city": addr.get("city") or "",
                    "country": addr.get("country") or "",
                })
        except Exception:
            pass

    return {
        "ok": True,
        "query": raw,
        "normalized_digits": digits,
        "orders": orders_out,
        "customers": customers_out,
        "shop_domain": shop_domain,
    }


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
    # Full order shape (with line items + tags etc.) so the frontend can render the
    # same interactive card it uses for the queue and global search.
    orders_out: List[Dict[str, Any]] = [_flatten_order(e.get("node") or {}) for e in edges]
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

    # Best-effort audit log (independent of any tag mutations). Dedupe per-day
    # per-user so a double-click doesn't double-count but a re-cancel on a
    # different day from a different agent does.
    from .main import _already_logged_today  # type: ignore
    store_key_norm = _normalize_store(store)
    try:
        if not await _already_logged_today(
            db,
            user_id=user.id,
            order_gid=order_gid,
            store_key=store_key_norm,
            action="confirmation_cancelled",
        ):
            await _record_user_action(
                db,
                user_id=user.id,
                order_number=None,
                order_gid=order_gid,
                store_key=store_key_norm,
                action="confirmation_cancelled",
                metadata={
                    "reason": reason,
                    "restock": bool(body.restock),
                    "refund": bool(body.refund),
                    "staff_note": (body.staff_note or "").strip() or None,
                    "role": getattr(user, "role", None),
                },
            )
            await db.commit()
    except IntegrityError:
        try: await db.rollback()
        except Exception: pass
    except Exception:
        logger.exception(
            "cancel audit failed (order=%s user=%s store=%s)",
            order_gid, getattr(user, "id", None), store_key_norm,
        )
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
    from .main import (  # type: ignore
        _shopify_add_tag,
        _record_user_action,
        _normalize_store,
        _classify_agent_tag_action,
        _already_logged_today,
    )

    sem = asyncio.Semaphore(_BULK_CONCURRENCY)
    audit_records: List[Dict[str, Any]] = []

    async def _tag_one(oid: str) -> bool:
        async with sem:
            try:
                await _shopify_add_tag(oid, tag, store)
                audit_records.append({"order_gid": oid})
                return True
            except Exception:
                logger.exception("bulk tag write failed (order=%s tag=%s)", oid, tag)
                return False

    results = await asyncio.gather(*[_tag_one(o) for o in order_ids])
    tagged = sum(1 for r in results if r)

    # Audit log: commit per record so one failure doesn't roll back the others.
    # Dedupe per-(user, order, action, local day) so worker retries / re-applies
    # don't inflate counts while still recording every distinct attempt.
    action_name = _classify_agent_tag_action(tag) or "confirmation_tag_add"
    store_key_norm = _normalize_store(store)
    audited = 0
    for rec in audit_records:
        try:
            if await _already_logged_today(
                db,
                user_id=user.id,
                order_gid=rec["order_gid"],
                store_key=store_key_norm,
                action=action_name,
            ):
                continue
            await _record_user_action(
                db,
                user_id=user.id,
                order_number=None,
                order_gid=rec["order_gid"],
                store_key=store_key_norm,
                action=action_name,
                metadata={
                    "tag": tag,
                    "op": "add",
                    "bulk": True,
                    "role": getattr(user, "role", None),
                },
            )
            await db.commit()
            audited += 1
        except IntegrityError:
            try: await db.rollback()
            except Exception: pass
        except Exception:
            logger.exception(
                "bulk tag audit failed (order=%s tag=%s user=%s)",
                rec["order_gid"], tag, getattr(user, "id", None),
            )
            try: await db.rollback()
            except Exception: pass

    return {"ok": True, "tagged": tagged, "total": len(order_ids), "tag": tag, "audited": audited}


# ---------- Pull orders into the agent's queue ----------
#
# Two flows, same endpoint pair (preview/execute):
#
#   1. mode="new"      -> orders that no other active agent has claimed (no other
#                          agent tag is on them). Pre-condition: order is open,
#                          unshipped, has no cod date tag.
#
#   2. mode="level"    -> orders carrying a specific call-attempt tag (n1/n2/n3/n4
#                          or nowtp*/enatt*) but NOT carrying any of the up-to-2
#                          exclude_tags the agent typed in (e.g. "n2 but not fz and
#                          not zineb"). These orders may currently belong to other
#                          agents; on execute we strip every other active agent's
#                          tag so the order becomes exclusively this agent's.
#
# On execute we also exclude the agent's OWN existing tags from the search, so the
# pull never re-claims something that's already in their queue.

_PULL_LEVEL_NEW = "new"
_PULL_LEVELS_SINGLE = {"n1", "n2", "n3", "n4"}
_PULL_LEVELS_GROUP = {"nowtp", "enatt"}
_PULL_VALID_LEVELS = {_PULL_LEVEL_NEW} | _PULL_LEVELS_SINGLE | _PULL_LEVELS_GROUP


async def build_pull_query(
    db: AsyncSession,
    user: User,
    *,
    level: Optional[str],
    exclude_tags: Optional[List[str]] = None,
) -> Tuple[Optional[str], str, List[str]]:
    """Build the Shopify search query for the agent's pull pool.

    Returns ``(query, agent_tag_default, other_agent_tags)``.

    - ``agent_tag_default`` = first of ``user.agent_tags`` (the tag the frontend
      proposes to apply; can be overridden in the execute body if the user has
      multiple tags).
    - ``other_agent_tags`` = every Shopify tag currently claimed by some OTHER
      active confirmation user. We exclude those tags from the search (so "new"
      really means unassigned) and on execute we *strip* whichever of them is on
      a pulled order — that's how the order becomes exclusively the puller's.
    """
    lv = (level or _PULL_LEVEL_NEW).lower().strip()
    if lv not in _PULL_VALID_LEVELS:
        return None, "", []

    my_tags = list(user.agent_tags or [])
    other_active = await _other_agents_active_tags(db, exclude_user_id=user.id)

    parts: List[str] = ["status:open", "fulfillment_status:unshipped", _COD_EXCLUSION]

    if lv == _PULL_LEVEL_NEW:
        # Unassigned pool: no other agent tag, no own tag.
        for t in other_active:
            if t:
                parts.append(f"-tag:{_escape_tag(t)}")
        # Free-form extra exclusions if the agent wants them.
        for t in (exclude_tags or []):
            if t:
                parts.append(f"-tag:{_escape_tag(t)}")
    else:
        # Level-scoped pool. Add the level tag(s), then apply user-supplied
        # exclusions. We do NOT exclude other agents' tags here — the whole
        # point is to be able to pull n1/n2/... orders that currently sit in
        # another agent's queue.
        if lv in _PULL_LEVELS_SINGLE:
            parts.append(f"tag:{_escape_tag(lv)}")
        elif lv == "nowtp":
            tag_or = " OR ".join(f"tag:{_escape_tag(t)}" for t in _NOWTP_TAGS)
            parts.append(f"({tag_or})")
        elif lv == "enatt":
            tag_or = " OR ".join(f"tag:{_escape_tag(t)}" for t in _ENATT_TAGS)
            parts.append(f"({tag_or})")
        for t in (exclude_tags or []):
            if t:
                parts.append(f"-tag:{_escape_tag(t)}")

    # Always keep orders already in the agent's queue out of the pull pool.
    for t in my_tags:
        if t:
            parts.append(f"-tag:{_escape_tag(t)}")

    return " ".join(parts), (my_tags[0] if my_tags else ""), other_active


async def _scan_pull_pool(
    *,
    store: str,
    query: str,
    limit: int,
    collect_orders: bool,
) -> Tuple[int, List[Dict[str, Any]]]:
    """Walk Shopify pages for ``query``, dropping cod-tagged stragglers in Python
    (Shopify's tag-wildcard exclusion can't match multi-word ``cod dd/mm/yy``).

    If ``collect_orders`` is True, returns up to ``limit`` ``{id, tags}`` dicts
    (used by execute). Otherwise returns just the total count (used by preview).
    """
    from .main import shopify_graphql  # type: ignore

    gql_count = """
    query Q($first: Int!, $after: String, $q: String) {
      orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges { cursor node { tags } }
        pageInfo { hasNextPage }
      }
    }
    """
    gql_collect = """
    query Q($first: Int!, $after: String, $q: String) {
      orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges { cursor node { id tags } }
        pageInfo { hasNextPage }
      }
    }
    """
    gql = gql_collect if collect_orders else gql_count
    cursor: Optional[str] = None
    total = 0
    out: List[Dict[str, Any]] = []
    cap = max(0, int(limit))
    while True:
        if collect_orders and len(out) >= cap:
            break
        try:
            data = await shopify_graphql(
                gql, {"first": 250, "after": cursor, "q": query}, store=store,
            )
        except Exception:
            logger.exception("pull scan failed (store=%s q=%s)", store, query)
            break
        edges = ((data or {}).get("orders") or {}).get("edges") or []
        if not edges:
            break
        for e in edges:
            node = e.get("node") or {}
            tags_list = list(node.get("tags") or [])
            if has_cod_tag(tags_list):
                continue
            total += 1
            if collect_orders:
                gid = node.get("id")
                if gid:
                    out.append({"id": gid, "tags": tags_list})
                    if len(out) >= cap:
                        break
        page_info = ((data or {}).get("orders") or {}).get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            break
        # When counting (no cap on `out`) keep going. When collecting, stop only
        # if we've filled the cap (handled at top of loop).
        cursor = edges[-1].get("cursor")
        # Safety net on counting paths: don't walk forever on a runaway query.
        if not collect_orders and total >= _BREAKDOWN_HARD_CAP:
            break
    return total, out


class PullPreviewBody(BaseModel):
    store: str
    level: Optional[str] = None          # "new" | "n1".."n4" | "nowtp" | "enatt"
    exclude_tags: Optional[List[str]] = None


@router.post("/api/agent/pull/preview")
async def pull_preview(
    body: PullPreviewBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Count how many orders the agent could pull right now under the given
    level + exclude-tag filters. Cheap to call — used to populate the count
    inside the pull modal as the agent edits the exclude inputs."""
    store = (body.store or "").strip()
    if not store:
        raise HTTPException(status_code=400, detail="store is required")
    q, default_tag, other_active = await build_pull_query(
        db, user, level=body.level, exclude_tags=body.exclude_tags
    )
    if not q:
        raise HTTPException(status_code=400, detail=f"invalid level: {body.level!r}")
    available, _ = await _scan_pull_pool(store=store, query=q, limit=0, collect_orders=False)
    return {
        "ok": True,
        "store": store,
        "level": (body.level or _PULL_LEVEL_NEW).lower().strip(),
        "exclude_tags": [t for t in (body.exclude_tags or []) if t],
        "available": int(available),
        "agent_tag": default_tag,
        "agent_tags": list(user.agent_tags or []),
        "other_agent_tags": other_active,
    }


class PullExecuteBody(BaseModel):
    store: str
    level: Optional[str] = None
    exclude_tags: Optional[List[str]] = None
    limit: Optional[int] = None          # how many to pull; 0 / None = take everything
    agent_tag: Optional[str] = None      # which of the user's own tags to apply


_PULL_HARD_CAP = 2000


@router.post("/api/agent/pull/execute")
async def pull_execute(
    body: PullExecuteBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Claim up to ``limit`` orders into this agent's queue.

    For every order pulled we:
      - Add the agent's tag (defaults to the first of their assigned tags;
        ``agent_tag`` body field can override, but must be one the user owns).
      - Remove every OTHER active agent's tag that's currently on the order.
        That's what makes the assignment exclusive — Laila's "laila" tag,
        ndcon's "ndcon" tag, etc. all come off so the order shows up only in
        the pulling agent's queue.
    """
    store = (body.store or "").strip()
    if not store:
        raise HTTPException(status_code=400, detail="store is required")

    q, default_tag, other_active = await build_pull_query(
        db, user, level=body.level, exclude_tags=body.exclude_tags
    )
    if not q:
        raise HTTPException(status_code=400, detail=f"invalid level: {body.level!r}")

    my_tags = list(user.agent_tags or [])
    chosen_tag = (body.agent_tag or default_tag or "").strip()
    if not chosen_tag:
        raise HTTPException(
            status_code=400,
            detail="no agent tag available; ask admin to assign at least one tag to your account",
        )
    if my_tags and chosen_tag.lower() not in {t.lower() for t in my_tags if t}:
        raise HTTPException(status_code=400, detail="agent_tag must be one of your assigned tags")

    # If "chosen_tag" happens to overlap with another agent's claimed tag (shouldn't
    # happen in a well-configured roster but be defensive) we must not strip it.
    chosen_lower = chosen_tag.lower()
    other_active = [t for t in other_active if (t or "").lower() != chosen_lower]
    other_active_lower = {t.lower() for t in other_active}

    # Resolve how many to take.
    raw_limit = int(body.limit or 0)
    if raw_limit <= 0:
        target = _PULL_HARD_CAP
    else:
        target = min(raw_limit, _PULL_HARD_CAP)

    _total, candidates = await _scan_pull_pool(
        store=store, query=q, limit=target, collect_orders=True,
    )
    if not candidates:
        return {
            "ok": True, "pulled": 0, "audited": 0,
            "requested": raw_limit, "available_seen": 0,
            "agent_tag": chosen_tag, "store": store,
            "level": (body.level or _PULL_LEVEL_NEW).lower().strip(),
        }

    from .main import (  # type: ignore
        _shopify_add_tag,
        _shopify_remove_tag,
        _record_user_action,
        _normalize_store,
        _already_logged_today,
    )

    sem = asyncio.Semaphore(_BULK_CONCURRENCY)
    pulled_ids: List[str] = []

    async def _claim_one(item: Dict[str, Any]) -> Optional[str]:
        async with sem:
            oid = item["id"]
            try:
                await _shopify_add_tag(oid, chosen_tag, store)
            except Exception:
                logger.exception("pull add-tag failed (order=%s tag=%s)", oid, chosen_tag)
                return None
            # Strip the other agents' tags so this order becomes exclusively ours.
            for t in (item.get("tags") or []):
                tl = str(t or "").strip().lower()
                if tl and tl in other_active_lower:
                    try:
                        await _shopify_remove_tag(oid, t, store)
                    except Exception:
                        logger.exception("pull remove-tag failed (order=%s tag=%s)", oid, t)
            return oid

    results = await asyncio.gather(*[_claim_one(it) for it in candidates])
    pulled_ids = [oid for oid in results if oid]

    # Audit log each successful pull.
    store_key_norm = _normalize_store(store)
    audited = 0
    level_norm = (body.level or _PULL_LEVEL_NEW).lower().strip()
    for oid in pulled_ids:
        try:
            if await _already_logged_today(
                db,
                user_id=user.id,
                order_gid=oid,
                store_key=store_key_norm,
                action="confirmation_pulled",
            ):
                continue
            await _record_user_action(
                db,
                user_id=user.id,
                order_number=None,
                order_gid=oid,
                store_key=store_key_norm,
                action="confirmation_pulled",
                metadata={
                    "tag": chosen_tag,
                    "level": level_norm,
                    "exclude_tags": [t for t in (body.exclude_tags or []) if t],
                    "removed_other_agent_tags": other_active,
                    "role": getattr(user, "role", None),
                },
            )
            await db.commit()
            audited += 1
        except IntegrityError:
            try: await db.rollback()
            except Exception: pass
        except Exception:
            logger.exception("pull audit failed (order=%s)", oid)
            try: await db.rollback()
            except Exception: pass

    # The pull touches multiple agents' queues (tags added on ours, removed on
    # theirs). Wipe every cached breakdown so nobody sees stale counts.
    invalidate_all_breakdown_caches()

    return {
        "ok": True,
        "store": store,
        "level": level_norm,
        "agent_tag": chosen_tag,
        "pulled": len(pulled_ids),
        "audited": audited,
        "requested": raw_limit,
        "available_seen": len(candidates),
        "removed_other_agent_tags": other_active,
    }


# ---------- Agent team stats (confirmed today across team) ----------

@router.get("/api/agent/team-stats")
async def team_stats(
    store: Optional[str] = None,  # noqa: ARG001 — accepted for backwards compat, but ignored
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Per-agent breakdown aggregated across EVERY connected store, plus confirmed-today
    from the audit log (which is already cross-store). The `store` query param is kept
    for backwards compatibility but no longer scopes the output."""
    today_label = today_cod_label()

    # Roster: any active user who is either intentionally an "agent" or has tags assigned.
    res = await db.execute(select(User).where(User.is_active == True))  # noqa: E712
    all_active = res.scalars().all()
    agents = [u for u in all_active if u.role == "agent" or (u.agent_tags or [])]
    if not agents:
        return {"ok": True, "agents": [], "today_label": today_label, "stores": []}

    # ----- Confirmed today (audit log) -----
    # An agent's confirmed_today is the number of distinct orders they marked Confirmed
    # today in the app timezone, regardless of which delivery date they chose OR which
    # store the order belongs to. The OrderEvent query does not constrain by store_key
    # so the result is already cross-store.
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

    # ----- Assigned per agent (Shopify, all stores combined) -----
    # Build each agent's query once (it doesn't depend on the store), then ask each
    # connected store for that agent's breakdown and sum the results.
    from .main import known_store_labels  # type: ignore

    queries_by_agent: Dict[str, Optional[str]] = {}
    for a in agents:
        queries_by_agent[a.id] = await query_for_user(db, a)

    try:
        stores: List[str] = await known_store_labels()
    except Exception:
        stores = []

    breakdown_map: Dict[str, Dict[str, int]] = {a.id: _empty_breakdown() for a in agents}

    if stores:
        async def _bd(agent_id: str, q: Optional[str], store_key: str) -> Tuple[str, Dict[str, int]]:
            if not q:
                return (agent_id, _empty_breakdown())
            try:
                bd = await accurate_assigned_breakdown(store_key, agent_id, q)
                return (agent_id, bd)
            except Exception:
                return (agent_id, _empty_breakdown())

        coros = []
        for a in agents:
            q = queries_by_agent[a.id]
            for s in stores:
                coros.append(_bd(a.id, q, s))
        results = await asyncio.gather(*coros)
        for agent_id, bd in results:
            agg = breakdown_map[agent_id]
            for k in agg:
                agg[k] += int(bd.get(k) or 0)

    return {
        "ok": True,
        "today_label": today_label,
        "stores": stores,
        "agents": [
            {
                "id": a.id,
                "email": a.email,
                "name": a.name,
                "role": a.role,
                "tags": list(a.agent_tags or []),
                "is_catchall": (a.role == "agent" and not (a.agent_tags or [])),
                # `assigned` kept for backward compat; clients should prefer `breakdown.total`.
                "assigned": int((breakdown_map.get(a.id) or {}).get("total") or 0),
                "breakdown": breakdown_map.get(a.id) or _empty_breakdown(),
                "confirmed_today": confirmed_map.get(a.id, 0),
            }
            for a in agents
        ],
    }


# ---------- Admin confirmation analytics ----------

def _parse_date_bound(value: Optional[str], end: bool = False) -> Optional[datetime]:
    """Parse a YYYY-MM-DD string in the app timezone, returning a UTC datetime. If `end`
    is True the bound is the start of the FOLLOWING day so the range is half-open."""
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        dt_local = datetime.fromisoformat(s).replace(tzinfo=_tz())
    except Exception:
        return None
    if end:
        dt_local = dt_local + timedelta(days=1)
    return dt_local.astimezone(timezone.utc)


@router.get("/api/admin/confirmation-stats")
async def admin_confirmation_stats(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    store: Optional[str] = None,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    """Per-user counts of confirmation-page actions in a date range.

    Reads the OrderEvent audit table (single source of truth) and buckets the action
    names into n1..n4 / nowtp / enatt / confirmed / cancelled. Returns one row per
    active user that took at least one such action, plus a summary across all users.
    """
    from_dt = _parse_date_bound(from_date, end=False)
    to_dt = _parse_date_bound(to_date, end=True)
    if from_dt is None:
        # Default: last 7 days inclusive.
        today_local = datetime.now(_tz()).replace(hour=0, minute=0, second=0, microsecond=0)
        from_dt = (today_local - timedelta(days=6)).astimezone(timezone.utc)
    if to_dt is None:
        today_local = datetime.now(_tz()).replace(hour=0, minute=0, second=0, microsecond=0)
        to_dt = (today_local + timedelta(days=1)).astimezone(timezone.utc)

    conds = [OrderEvent.created_at >= from_dt, OrderEvent.created_at < to_dt]
    store_key = (store or "").strip().lower()
    if store_key and store_key != "all":
        conds.append(OrderEvent.store_key == store_key)

    def _sum_when(predicate) -> Any:
        return func.coalesce(func.sum(case((predicate, 1), else_=0)), 0)

    stmt = (
        select(
            OrderEvent.user_id.label("user_id"),
            _sum_when(OrderEvent.action == "confirmation_phone_n1").label("n1"),
            _sum_when(OrderEvent.action == "confirmation_phone_n2").label("n2"),
            _sum_when(OrderEvent.action == "confirmation_phone_n3").label("n3"),
            _sum_when(OrderEvent.action == "confirmation_phone_n4").label("n4"),
            _sum_when(OrderEvent.action.like("confirmation_nowtp%")).label("nowtp"),
            _sum_when(OrderEvent.action.like("confirmation_enatt%")).label("enatt"),
            _sum_when(OrderEvent.action == "confirmation_confirmed").label("confirmed"),
            _sum_when(OrderEvent.action == "confirmation_cancelled").label("cancelled"),
        )
        .where(*conds)
        .group_by(OrderEvent.user_id)
    )

    res = await db.execute(stmt)
    by_user: Dict[str, Dict[str, int]] = {}
    for row in res.all():
        m = row._mapping
        by_user[str(m["user_id"])] = {
            "n1": int(m["n1"] or 0),
            "n2": int(m["n2"] or 0),
            "n3": int(m["n3"] or 0),
            "n4": int(m["n4"] or 0),
            "nowtp": int(m["nowtp"] or 0),
            "enatt": int(m["enatt"] or 0),
            "confirmed": int(m["confirmed"] or 0),
            "cancelled": int(m["cancelled"] or 0),
        }

    # Pull user identity for the rows we found.
    user_ids = list(by_user.keys())
    name_by_id: Dict[str, Tuple[str, str, str]] = {}
    if user_ids:
        u_res = await db.execute(select(User).where(User.id.in_(user_ids)))
        for u in u_res.scalars().all():
            name_by_id[u.id] = (u.email or "", u.name or "", u.role or "")

    rows: List[Dict[str, Any]] = []
    summary = {"n1": 0, "n2": 0, "n3": 0, "n4": 0, "nowtp": 0, "enatt": 0, "confirmed": 0, "cancelled": 0, "total_attempts": 0}
    for uid, counts in by_user.items():
        email, name, role = name_by_id.get(uid, ("", "", ""))
        total_attempts = sum(counts.values())
        rows.append({
            "user_id": uid,
            "email": email,
            "name": name,
            "role": role,
            **counts,
            "total_attempts": total_attempts,
        })
        for k in summary:
            if k == "total_attempts":
                summary[k] += total_attempts
            else:
                summary[k] += counts.get(k, 0)

    # Stable order: confirmed-today desc, then cancelled desc, then email.
    rows.sort(key=lambda r: (-(r.get("confirmed") or 0), -(r.get("cancelled") or 0), r.get("email") or ""))

    return {
        "ok": True,
        "from_date": from_date or from_dt.date().isoformat(),
        "to_date": to_date or (to_dt - timedelta(days=1)).date().isoformat(),
        "store": store_key or "all",
        "rows": rows,
        "summary": summary,
    }
