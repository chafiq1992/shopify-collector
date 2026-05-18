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
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
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


def build_queue_query(tags: List[str]) -> Optional[str]:
    """Build a Shopify search query that returns open, unshipped orders carrying any of the
    agent's tags. COD-dated orders are excluded in Python post-filtering (Shopify search does
    not support reliable wildcard exclusions for multi-word tags like "cod 15/05/26")."""
    tags = [t for t in (tags or []) if t]
    if not tags:
        return None
    tag_or = " OR ".join(f"tag:{_escape_tag(t)}" for t in tags)
    parts = [
        "status:open",
        "fulfillment_status:unshipped",
        f"({tag_or})",
    ]
    return " ".join(parts)


def build_catchall_query() -> str:
    """Build a Shopify search query for an "untagged" agent: every open, unshipped order.
    Cancelled orders are already excluded by `status:open`. COD-dated orders are stripped
    by the Python post-filter (Shopify search has no reliable multi-word wildcard
    exclusion for tags like "cod 18/05/26")."""
    return "status:open fulfillment_status:unshipped"


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


_VALID_LEVELS = {"n1", "n2", "n3", "new"}


def apply_level_filter(q: str, level: Optional[str]) -> str:
    """Narrow an agent's queue query by call-attempt level.

    n1/n2/n3 → only orders carrying that exact attempt tag.
    new      → orders with none of n1/n2/n3 (i.e. not yet called).
    """
    if not q or not level:
        return q
    lv = level.lower().strip()
    if lv not in _VALID_LEVELS:
        return q
    if lv in ("n1", "n2", "n3"):
        return f"{q} tag:{_escape_tag(lv)}"
    if lv == "new":
        return f"{q} -tag:n1 -tag:n2 -tag:n3"
    return q


_COD_TAG_RE = re.compile(r"^\s*cod(\s|$)", re.IGNORECASE)


def has_cod_tag(tags: List[str]) -> bool:
    for t in tags or []:
        if _COD_TAG_RE.match(str(t or "")):
            return True
    return False


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
        customer { displayName phone }
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

    # Shopify's tag search has no reliable wildcard exclusion for multi-word tags
    # ("cod 15/05/26"), so we drop any order carrying a cod-prefixed tag here.
    # The raw `ordersCount` includes those orders; subtract them so "assigned" reflects
    # actually-actionable orders.
    assigned_total_raw = int(((data or {}).get("ordersCount") or {}).get("count") or 0)
    excluded_in_page = 0
    orders: List[Dict[str, Any]] = []
    for e in edges:
        node = e.get("node") or {}
        tags_list = list(node.get("tags") or [])
        if has_cod_tag(tags_list):
            excluded_in_page += 1
            continue
        orders.append(_flatten_order(node))
    # Conservative estimate: assume excluded ratio holds across the full result set.
    if edges:
        assigned_total = max(0, assigned_total_raw - excluded_in_page)
    else:
        assigned_total = assigned_total_raw

    return {
        "ok": True,
        "orders": orders,
        "assigned_total": assigned_total,
        "nextCursor": next_cursor,
        "today_label": today_label,
        "shop_domain": shop_domain,
    }


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

    async def _count(q: Optional[str]) -> int:
        if not q:
            return 0
        gql = "query Q($q: String) { ordersCount(query: $q) { count } }"
        try:
            data = await shopify_graphql(gql, {"q": q}, store=store)
            return int(((data or {}).get("ordersCount") or {}).get("count") or 0)
        except Exception:
            return 0

    counts = await asyncio.gather(*[_count(q) for q in queries])
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
