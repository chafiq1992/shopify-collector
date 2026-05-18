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

import os
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth_routes import get_current_user, hash_password, require_admin
from .db import get_session
from .models import User

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


def build_queue_query(tags: List[str], today_label: str) -> Optional[str]:
    tags = [t for t in (tags or []) if t]
    if not tags:
        return None
    tag_or = " OR ".join(f"tag:{_escape_tag(t)}" for t in tags)
    parts = [
        "status:open",
        "fulfillment_status:unshipped",
        f"({tag_or})",
        f"-tag:{_escape_tag(today_label)}",
    ]
    return " ".join(parts)


QUEUE_QUERY_GQL = """
query AgentQueue($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
    edges {
      cursor
      node {
        id
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
    user: User = Depends(get_current_user),
):
    if user.role not in ("agent", "admin"):
        raise HTTPException(status_code=403, detail="agent role required")
    tags = list(user.agent_tags or [])
    if not tags and user.role == "agent":
        return {"ok": True, "orders": [], "assigned_total": 0, "nextCursor": None, "today_label": today_cod_label()}
    today_label = today_cod_label()
    q = build_queue_query(tags, today_label)
    if not q:
        return {"ok": True, "orders": [], "assigned_total": 0, "nextCursor": None, "today_label": today_label}

    # Import lazily to avoid a circular import with main.py at module load time.
    from .main import shopify_graphql  # type: ignore

    try:
        data = await shopify_graphql(
            QUEUE_QUERY_GQL,
            {"first": max(1, min(100, int(limit or 50))), "after": cursor, "query": q},
            store=store,
        )
    except HTTPException as he:
        raise he
    edges = ((data or {}).get("orders") or {}).get("edges") or []
    orders = [_flatten_order(e.get("node") or {}) for e in edges]
    page_info = ((data or {}).get("orders") or {}).get("pageInfo") or {}
    has_next = bool(page_info.get("hasNextPage"))
    next_cursor = edges[-1].get("cursor") if (has_next and edges) else None
    assigned_total = int(((data or {}).get("ordersCount") or {}).get("count") or 0)
    return {
        "ok": True,
        "orders": orders,
        "assigned_total": assigned_total,
        "nextCursor": next_cursor,
        "today_label": today_label,
    }


# ---------- Agent team stats (confirmed today across team) ----------

@router.get("/api/agent/team-stats")
async def team_stats(
    store: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    today_label = today_cod_label()
    # Fetch the active agents and their tags.
    res = await db.execute(
        select(User).where(User.role == "agent", User.is_active == True)  # noqa: E712
    )
    agents = res.scalars().all()

    if not agents:
        return {"ok": True, "agents": [], "today_label": today_label}

    from .main import shopify_graphql  # type: ignore

    q = f"status:any tag:{_escape_tag(today_label)}"
    gql = """
    query ConfirmedToday($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
        edges {
          cursor
          node { tags }
        }
        pageInfo { hasNextPage }
      }
    }
    """
    counts: Dict[str, int] = {a.id: 0 for a in agents}
    after: Optional[str] = None
    # Cap the number of pages we scan for safety.
    for _page in range(20):
        data = await shopify_graphql(gql, {"first": 100, "after": after, "query": q}, store=store)
        edges = ((data or {}).get("orders") or {}).get("edges") or []
        page_info = ((data or {}).get("orders") or {}).get("pageInfo") or {}
        for e in edges:
            tags_l = {str(t or "").lower() for t in ((e.get("node") or {}).get("tags") or [])}
            for a in agents:
                a_tags = {str(t or "").lower() for t in (a.agent_tags or [])}
                if a_tags & tags_l:
                    counts[a.id] += 1
        if not page_info.get("hasNextPage") or not edges:
            break
        after = edges[-1].get("cursor")

    return {
        "ok": True,
        "today_label": today_label,
        "agents": [
            {
                "id": a.id,
                "email": a.email,
                "name": a.name,
                "tags": list(a.agent_tags or []),
                "confirmed_today": counts.get(a.id, 0),
            }
            for a in agents
        ],
    }
