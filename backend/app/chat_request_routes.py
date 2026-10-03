"""
"Chat confirmation": storefront call-back requests that replace the WhatsApp chat.

Instead of opening WhatsApp, the Shopify storefront widget
(shopify/chat-request-widget.liquid) asks the customer for a phone number and
posts it here. Agents then work those requests from the Chat confirmation tab
of /confirmation, the same way they work orders: call attempts N1..N4, en
attente, and a final outcome (ordered / not interested / wrong number).

Provides:
  - POST /api/public/chat-requests            -> storefront intake (no auth, rate limited)
  - GET  /api/chat-requests                   -> queue for a store (scope + level filters, search)
  - GET  /api/chat-requests/summary           -> badge counts for the tab switcher
  - POST /api/chat-requests/pull              -> claim the newest unassigned requests
  - POST /api/chat-requests/{id}/action       -> call / enatt / close / reopen / claim / note ...
  - GET  /api/chat-requests/{id}/history      -> audit trail of one request
  - GET  /api/chat-requests/{id}/conversation -> signed link to the read-only website chat
  - GET  /api/chat-requests/team-stats        -> per-agent calls / orders today
  - GET/POST /api/chat-labels, PATCH /api/chat-labels/{id} -> reason labels (size, price, later...)
  - GET  /api/chat-requests/reasons           -> outcomes by reason label over a period
"""

import logging
import hashlib
import hmac
import os
import re
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Deque, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .auth_routes import get_current_user
from .confirmation_routes import _confirmation_phone_variants, _tz
from .db import get_session
from .models import ChatLabel, ChatRequest, ChatRequestEvent, ChatRequestLabel, User

logger = logging.getLogger(__name__)

router = APIRouter()

_STORE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")

OPEN_STATUSES = ("new", "calling", "enatt")
CLOSED_STATUSES = ("ordered", "not_interested", "wrong_number", "cancelled")
MAX_ATTEMPTS = 4
_LEVELS = ("new", "n1", "n2", "n3", "n4", "enatt", "closed", "ordered", "cancelled", "lost", "any")
LOST_STATUSES = ("not_interested", "wrong_number", "cancelled")
# The "Closed" view: requests that ended without an order. Ordered and cancelled
# requests each have their own view, so no request shows up in two of them.
CLOSED_VIEW_STATUSES = ("not_interested", "wrong_number")
# Reason labels every store starts with; agents add more from the label picker.
DEFAULT_LABELS = (("size", "Size", "amber"), ("only_ask", "Only asking", "sky"), ("price", "Price", "rose"),
                  ("later", "Later", "fuchsia"), ("no_answer", "No answer", "slate"), ("other", "Other", "violet"))
LABEL_COLORS = ("slate", "indigo", "amber", "orange", "rose", "red", "violet", "fuchsia", "emerald", "sky")
_SCOPES = ("mine", "unassigned", "all")


def _clean(value: Any, limit: int) -> Optional[str]:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] or None


def _clean_multiline(value: Any, limit: int) -> Optional[str]:
    text = str(value or "").replace("\r\n", "\n").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text[:limit] or None


def _clean_url(value: Any) -> Optional[str]:
    url = _clean(value, 1024)
    if not url or not re.match(r"^https?://", url, re.IGNORECASE):
        return None
    return url


def normalize_phone(raw: str) -> Optional[str]:
    """Return the phone as "+<digits>" or None when it cannot be a real number."""
    details = _confirmation_phone_variants(raw or "")
    normalized = details.get("normalized_phone") or ""
    digits = re.sub(r"\D", "", normalized)
    if not (9 <= len(digits) <= 15):
        return None
    return normalized


def _normalize_store(store: Optional[str]) -> str:
    key = (store or "").strip().lower()
    if not _STORE_RE.match(key):
        raise HTTPException(status_code=400, detail="invalid store")
    return key


def _today_bounds_utc() -> Tuple[datetime, datetime]:
    today_local = datetime.now(_tz()).replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        today_local.astimezone(timezone.utc),
        (today_local + timedelta(days=1)).astimezone(timezone.utc),
    )


def _iso(value: Optional[datetime]) -> Optional[str]:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _user_brief(u: Optional[User]) -> Optional[Dict[str, Any]]:
    if u is None:
        return None
    return {"id": u.id, "name": u.name, "email": u.email}


def serialize_label(label: ChatLabel) -> Dict[str, Any]:
    return {"id": label.id, "key": label.key, "name": label.name, "color": label.color, "archived": bool(label.archived)}


async def _labels_for(db: AsyncSession, request_ids) -> Dict[int, List[Dict[str, Any]]]:
    ids = sorted({int(i) for i in request_ids if i})
    found: Dict[int, List[Dict[str, Any]]] = {i: [] for i in ids}
    if not ids:
        return found
    rows = await db.execute(
        select(ChatRequestLabel.request_id, ChatLabel)
        .join(ChatLabel, ChatLabel.id == ChatRequestLabel.label_id)
        .where(ChatRequestLabel.request_id.in_(ids))
        .order_by(ChatLabel.position, ChatLabel.id)
    )
    for request_id, label in rows.all():
        found[request_id].append(serialize_label(label))
    return found


def serialize_request(r: ChatRequest, users: Dict[str, User], labels: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    return {
        "labels": labels or [],
        "id": r.id,
        "store": r.store_key,
        "phone": r.phone,
        "phone_raw": r.phone_raw,
        "customer_name": r.customer_name,
        "message": r.message,
        "product_title": r.product_title,
        "product_url": r.product_url,
        "product_image": r.product_image,
        "variant_title": r.variant_title,
        "page_url": r.page_url,
        "status": r.status,
        "attempts": int(r.attempts or 0),
        "enatt": int(r.enatt or 0),
        "request_count": int(r.request_count or 1),
        "assigned_to": _user_brief(users.get(r.assigned_to_id)) if r.assigned_to_id else None,
        "note": r.note,
        "order_ref": r.order_ref,
        "created_at": _iso(r.created_at),
        "updated_at": _iso(r.updated_at),
        "last_action_at": _iso(r.last_action_at),
        "closed_at": _iso(r.closed_at),
        "closed_by": _user_brief(users.get(r.closed_by_id)) if r.closed_by_id else None,
    }


async def _users_by_id(db: AsyncSession, ids) -> Dict[str, User]:
    wanted = {i for i in ids if i}
    if not wanted:
        return {}
    rows = await db.execute(select(User).where(User.id.in_(wanted)))
    return {u.id: u for u in rows.scalars().all()}


# ---------- Storefront intake ----------

# Soft per-IP limit: a real customer asks once or twice, a script asks a lot.
_INTAKE_WINDOW_SECONDS = 10 * 60
_INTAKE_MAX_PER_WINDOW = 8
_INTAKE_HITS: Dict[str, Deque[float]] = {}
_INTAKE_HITS_MAX_KEYS = 20_000


def _client_ip(request: Request) -> str:
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return getattr(request.client, "host", "") or "unknown"


def _intake_allowed(ip: str, now: Optional[float] = None) -> bool:
    now = time.monotonic() if now is None else now
    if len(_INTAKE_HITS) > _INTAKE_HITS_MAX_KEYS:
        _INTAKE_HITS.clear()
    hits = _INTAKE_HITS.setdefault(ip, deque())
    while hits and now - hits[0] > _INTAKE_WINDOW_SECONDS:
        hits.popleft()
    if len(hits) >= _INTAKE_MAX_PER_WINDOW:
        return False
    hits.append(now)
    return True


_SHOP_DOMAIN_CACHE: Dict[str, Tuple[float, Optional[str]]] = {}
_SHOP_DOMAIN_TTL_SECONDS = 10 * 60


async def _known_stores() -> Optional[List[str]]:
    try:
        from .main import known_store_labels  # type: ignore

        return list(await known_store_labels())
    except Exception:
        return None


async def _store_for_shop_domain(shop: str, known: List[str]) -> Optional[str]:
    """Map "irrakids.myshopify.com" (what the theme knows) to our store key."""
    shop = (shop or "").strip().lower()
    shop = re.sub(r"^https?://", "", shop).split("/")[0]
    if not shop:
        return None
    cached = _SHOP_DOMAIN_CACHE.get(shop)
    if cached and time.monotonic() - cached[0] < _SHOP_DOMAIN_TTL_SECONDS:
        return cached[1]
    found: Optional[str] = None
    prefix = shop.split(".")[0]
    if prefix in known:
        found = prefix
    else:
        try:
            from .main import resolve_store_settings_effective  # type: ignore

            for label in known:
                domain, _token, _key = await resolve_store_settings_effective(label)
                if (domain or "").strip().lower() == shop:
                    found = label
                    break
        except Exception:
            found = None
    _SHOP_DOMAIN_CACHE[shop] = (time.monotonic(), found)
    return found


class ChatRequestIntakeBody(BaseModel):
    store: Optional[str] = None
    shop: Optional[str] = None
    phone: str
    name: Optional[str] = None
    message: Optional[str] = None
    product_title: Optional[str] = None
    product_url: Optional[str] = None
    product_image: Optional[str] = None
    variant_title: Optional[str] = None
    page_url: Optional[str] = None
    # Honeypot: hidden in the widget, so only bots fill it.
    website: Optional[str] = None
    source_id: Optional[str] = None
    order_ref: Optional[str] = None
    # Trusted integrations only: "ordered" when the website AI already placed the order.
    outcome: Optional[str] = None


@router.post("/api/public/chat-requests")
async def create_chat_request(
    body: ChatRequestIntakeBody,
    request: Request,
    db: AsyncSession = Depends(get_session),
):
    return await _create_chat_request(body, request, db, trusted=False)


@router.post("/api/integrations/chat-requests")
async def integration_chat_request(
    body: ChatRequestIntakeBody, request: Request, db: AsyncSession = Depends(get_session),
):
    """Server-to-server intake. Never expose this shared key in storefront code."""
    _require_integration_key(request)
    if not body.source_id or not re.fullmatch(r"[a-zA-Z0-9:_-]{1,160}", body.source_id):
        raise HTTPException(422, "Provide a stable source_id")
    if len(body.message or "") > 2000000:
        raise HTTPException(413, "Conversation is too large")
    return await _create_chat_request(body, request, db, trusted=True)


def _require_integration_key(request):
    secret = os.getenv("CHAT_INTAKE_SECRET", "")
    if not secret:
        raise HTTPException(503, "Chat integration is not configured")
    if not hmac.compare_digest(request.headers.get("x-chat-intake-key", "").encode(), secret.encode()):
        raise HTTPException(401, "Invalid integration key")


class ChatRequestCompleteBody(BaseModel):
    store: str
    phone: str
    session_id: str
    order_ref: str


@router.post('/api/integrations/chat-requests/complete')
async def integration_chat_complete(body: ChatRequestCompleteBody, request: Request, db: AsyncSession = Depends(get_session)):
    _require_integration_key(request)
    store = _normalize_store(body.store)
    phone = normalize_phone(body.phone)
    if not phone or not re.fullmatch(r'[a-f0-9]{32}', body.session_id) or not re.fullmatch(r'[a-zA-Z0-9#_-]{1,64}', body.order_ref):
        raise HTTPException(422, 'Invalid completed chat details')
    if db.bind.dialect.name == 'postgresql':
        lock = int.from_bytes(hashlib.sha256(f'chat:{store}:{phone}'.encode()).digest()[:8], 'big', signed=True)
        await db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': lock})
    row = await db.scalar(select(ChatRequest).join(ChatRequestEvent).where(
        ChatRequest.store_key == store, ChatRequest.phone == phone, ChatRequest.status.in_(OPEN_STATUSES),
        ChatRequestEvent.detail['source_id'].as_string().startswith('storefront:' + body.session_id + ':'),
    ).distinct().limit(1))
    if row:
        row.status = 'ordered'
        row.order_ref = body.order_ref
        row.closed_at = datetime.now(timezone.utc)
        row.updated_at = row.closed_at
        db.add(ChatRequestEvent(request_id=row.id, action='ordered', detail={'source': 'storefront-ai', 'order_ref': body.order_ref}))
        await db.commit()
    return {'ok': True, 'closed': bool(row)}


async def _create_chat_request(body, request, db, *, trusted):
    if (body.website or "").strip():
        # Pretend success so the bot does not adapt.
        return {"ok": True}

    known = await _known_stores()
    store_key: Optional[str] = None
    if body.store:
        store_key = _normalize_store(body.store)
        if known is not None and store_key not in known:
            raise HTTPException(status_code=400, detail="unknown store")
    elif body.shop:
        store_key = await _store_for_shop_domain(body.shop, known or [])
    if not store_key:
        raise HTTPException(status_code=400, detail="unknown store")

    phone = normalize_phone(body.phone)
    if not phone:
        raise HTTPException(status_code=422, detail="invalid phone number")

    if not trusted and not _intake_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="too many requests, please try again later")

    fields = {
        "customer_name": _clean(body.name, 255),
        "message": _clean_multiline(body.message, 2000000 if trusted else 2000),
        "product_title": _clean(body.product_title, 512),
        "product_url": _clean_url(body.product_url),
        "product_image": _clean_url(body.product_image),
        "variant_title": _clean(body.variant_title, 255),
        "page_url": _clean_url(body.page_url),
    }
    now = datetime.now(timezone.utc)
    # Serialise this phone across app workers, including public storefront intake.
    if db.bind.dialect.name == "postgresql":
        lock = int.from_bytes(hashlib.sha256(f"chat:{store_key}:{phone}".encode()).digest()[:8], "big", signed=True)
        await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock})
    if trusted:
        previous = await db.scalar(select(ChatRequestEvent).join(ChatRequest).where(
            ChatRequest.store_key == store_key,
            ChatRequestEvent.detail["source_id"].as_string() == body.source_id,
        ).limit(1))
        if previous:
            return {"ok": True, "id": previous.request_id, "repeat": True, "idempotent": True}
        fields["order_ref"] = _clean(body.order_ref, 64)
        if body.outcome == "ordered":
            return await _record_ordered_chat(db, store_key, phone, body, fields, now)

    # Same customer asking again while we have not closed their request yet:
    # refresh it rather than queueing a duplicate call.
    existing = await db.scalar(
        select(ChatRequest)
        .where(
            ChatRequest.store_key == store_key,
            ChatRequest.phone == phone,
            ChatRequest.status.in_(OPEN_STATUSES),
        )
        .order_by(ChatRequest.created_at.desc())
        .limit(1)
    )
    if existing is not None:
        for key, value in fields.items():
            if value:
                setattr(existing, key, value)
        existing.request_count = int(existing.request_count or 1) + 1
        existing.updated_at = now
        db.add(ChatRequestEvent(
            request_id=existing.id,
            action="requested_again",
            detail={**{k: v for k, v in fields.items() if v}, **({"source_id": body.source_id} if trusted else {})},
        ))
        await db.commit()
        return {"ok": True, "id": existing.id, "repeat": True}

    req = ChatRequest(
        store_key=store_key,
        phone=phone,
        phone_raw=_clean(body.phone, 64),
        status="new",
        attempts=0,
        enatt=0,
        request_count=1,
        **fields,
    )
    db.add(req)
    await db.flush()
    db.add(ChatRequestEvent(request_id=req.id, action="requested", detail={"page_url": fields["page_url"], **({"source_id": body.source_id} if trusted else {})}))
    await db.commit()
    return {"ok": True, "id": req.id, "repeat": False}


async def _record_ordered_chat(db, store_key, phone, body, fields, now):
    """The website AI placed this order: show the chat as ordered, closing any open call-back for it."""
    if not fields.get("order_ref"):
        raise HTTPException(422, "An ordered chat needs its order reference")
    session = re.fullmatch(r"storefront:([a-f0-9]{32}):[a-z0-9:]*", body.source_id or "")
    row = None
    if session:
        row = await db.scalar(select(ChatRequest).join(ChatRequestEvent).where(
            ChatRequest.store_key == store_key,
            ChatRequestEvent.detail["source_id"].as_string().startswith("storefront:" + session[1] + ":"),
        ).order_by(ChatRequest.created_at.desc()).limit(1))
    if row is None:
        row = await db.scalar(select(ChatRequest).where(
            ChatRequest.store_key == store_key, ChatRequest.phone == phone, ChatRequest.status.in_(OPEN_STATUSES),
        ).order_by(ChatRequest.created_at.desc()).limit(1))
    created = row is None
    if created:
        row = ChatRequest(store_key=store_key, phone=phone, phone_raw=_clean(body.phone, 64), status="ordered",
                          attempts=0, enatt=0, request_count=1, closed_at=now, **fields)
        db.add(row)
        await db.flush()
    action = "ordered"
    if created is False:
        # The customer came back to an ordered chat and wrote more: refresh the conversation.
        action = "chat_updated" if row.status == "ordered" and row.order_ref == fields["order_ref"] else "ordered"
        for key, value in fields.items():
            if value:
                setattr(row, key, value)
        if row.status != "ordered":
            row.status = "ordered"
            row.closed_at = now
        row.updated_at = now
    db.add(ChatRequestEvent(request_id=row.id, action=action,
                            detail={"source": "storefront-ai", "order_ref": fields["order_ref"], "source_id": body.source_id}))
    await db.commit()
    return {"ok": True, "id": row.id, "ordered": True}


# ---------- Agent queue ----------

async def _shop_domain(store_key: str) -> str:
    """The store's *.myshopify.com domain, for Shopify admin links in the UI."""
    try:
        from .main import resolve_store_settings_effective  # type: ignore

        domain, _token, _key = await resolve_store_settings_effective(store_key)
        return (domain or "").strip().lower()
    except Exception:
        return ""


def _level_clause(level: str):
    if level == "new":
        return ChatRequest.status == "new"
    if level in ("n1", "n2", "n3", "n4"):
        return and_(ChatRequest.status == "calling", ChatRequest.attempts == int(level[1]))
    if level == "enatt":
        return ChatRequest.status == "enatt"
    if level == "closed":
        return ChatRequest.status.in_(CLOSED_VIEW_STATUSES)
    if level == "ordered":
        return ChatRequest.status == "ordered"
    if level == "cancelled":
        return ChatRequest.status == "cancelled"
    if level == "lost":
        return ChatRequest.status.in_(LOST_STATUSES)
    if level == "any":
        return ChatRequest.id.is_not(None)
    return ChatRequest.status.in_(OPEN_STATUSES)


def _scope_clause(scope: str, user: User):
    if scope == "mine":
        return ChatRequest.assigned_to_id == user.id
    if scope == "unassigned":
        return ChatRequest.assigned_to_id.is_(None)
    return None


def _search_clause(q: str):
    q = (q or "").strip()
    if not q:
        return None
    clauses = []
    digits = re.sub(r"\D", "", q)
    if len(digits) >= 4:
        # Match on the national part so 06.., +2126.. and 2126.. all find the row.
        national = digits[3:] if digits.startswith("212") else digits.lstrip("0")
        clauses.append(ChatRequest.phone.contains(national or digits))
    if q.lstrip("#").isdigit() and len(q.lstrip("#")) <= 9:
        clauses.append(ChatRequest.id == int(q.lstrip("#")))
    like = f"%{q.lower()}%"
    clauses.append(func.lower(func.coalesce(ChatRequest.customer_name, "")).like(like))
    clauses.append(func.lower(func.coalesce(ChatRequest.product_title, "")).like(like))
    clauses.append(func.lower(func.coalesce(ChatRequest.order_ref, "")).like(like))
    return or_(*clauses)


async def _level_counts(db: AsyncSession, base_filters: List[Any], ordered_filters: Optional[List[Any]] = None) -> Dict[str, int]:
    rows = await db.execute(
        select(ChatRequest.status, ChatRequest.attempts, func.count(ChatRequest.id))
        .where(*base_filters, ChatRequest.status.in_(OPEN_STATUSES))
        .group_by(ChatRequest.status, ChatRequest.attempts)
    )
    counts = {"total": 0, "new": 0, "n1": 0, "n2": 0, "n3": 0, "n4": 0, "enatt": 0}
    for status, attempts, n in rows.all():
        n = int(n or 0)
        counts["total"] += n
        if status == "new":
            counts["new"] += n
        elif status == "enatt":
            counts["enatt"] += n
        elif status == "calling":
            key = f"n{min(max(int(attempts or 1), 1), MAX_ATTEMPTS)}"
            counts[key] += n
    closed_since = datetime.now(timezone.utc) - timedelta(days=30)
    counts["closed"] = int(await db.scalar(
        select(func.count(ChatRequest.id)).where(
            *base_filters,
            ChatRequest.status.in_(CLOSED_VIEW_STATUSES),
            ChatRequest.closed_at >= closed_since,
        )
    ) or 0)
    counts["cancelled"] = int(await db.scalar(
        select(func.count(ChatRequest.id)).where(
            *base_filters,
            ChatRequest.status == "cancelled",
            ChatRequest.closed_at >= closed_since,
        )
    ) or 0)
    counts["ordered"] = int(await db.scalar(
        select(func.count(ChatRequest.id)).where(
            *(ordered_filters if ordered_filters is not None else base_filters),
            ChatRequest.status == "ordered",
            ChatRequest.closed_at >= closed_since,
        )
    ) or 0)
    return counts


async def _scope_counts(db: AsyncSession, store: str, user: User) -> Dict[str, int]:
    open_in_store = [ChatRequest.store_key == store, ChatRequest.status.in_(OPEN_STATUSES)]
    mine = await db.scalar(select(func.count(ChatRequest.id)).where(*open_in_store, ChatRequest.assigned_to_id == user.id))
    unassigned = await db.scalar(select(func.count(ChatRequest.id)).where(*open_in_store, ChatRequest.assigned_to_id.is_(None)))
    unassigned_new = await db.scalar(select(func.count(ChatRequest.id)).where(
        ChatRequest.store_key == store, ChatRequest.status == "new", ChatRequest.assigned_to_id.is_(None),
    ))
    total = await db.scalar(select(func.count(ChatRequest.id)).where(*open_in_store))
    return {
        "mine": int(mine or 0),
        "unassigned": int(unassigned or 0),
        "unassigned_new": int(unassigned_new or 0),
        "all": int(total or 0),
    }


@router.get("/api/chat-requests")
async def list_chat_requests(
    store: str,
    scope: str = "mine",
    level: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    label: Optional[int] = None,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    store_key = _normalize_store(store)
    scope = scope if scope in _SCOPES else "mine"
    level = level if level in _LEVELS else ""
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))

    base_filters: List[Any] = [ChatRequest.store_key == store_key]
    search = _search_clause(q or "")
    if search is not None:
        base_filters.append(search)
    label_filter = None
    if label:
        label_filter = ChatRequest.id.in_(select(ChatRequestLabel.request_id).where(ChatRequestLabel.label_id == int(label)))
        base_filters.append(label_filter)
    # Ordered chats are shared by the whole team (the AI placed most of them), whatever the scope.
    store_filters = list(base_filters)
    scope_filter = _scope_clause(scope, user)
    if scope_filter is not None:
        base_filters.append(scope_filter)

    # Ordered, lost and labelled views are team analysis: every agent sees the whole store.
    filters = [*(store_filters if level in ("ordered", "lost", "any") else base_filters), _level_clause(level)]
    total = int(await db.scalar(select(func.count(ChatRequest.id)).where(*filters)) or 0)
    order_col = ChatRequest.closed_at.desc() if level in ("closed", "ordered", "cancelled", "lost") else ChatRequest.created_at.desc()
    rows = await db.execute(
        select(ChatRequest).where(*filters).order_by(order_col, ChatRequest.id.desc()).offset(offset).limit(limit)
    )
    items = rows.scalars().all()
    users = await _users_by_id(db, [r.assigned_to_id for r in items] + [r.closed_by_id for r in items])
    labels = await _labels_for(db, [r.id for r in items])
    # Per-label counts for the label pills: same view, any label.
    unlabelled = [f for f in filters if f is not label_filter]
    label_rows = await db.execute(
        select(ChatRequestLabel.label_id, func.count(ChatRequestLabel.request_id))
        .where(ChatRequestLabel.request_id.in_(select(ChatRequest.id).where(*unlabelled)))
        .group_by(ChatRequestLabel.label_id)
    )
    return {
        "label_counts": {str(label_id): int(n or 0) for label_id, n in label_rows.all()},
        "ok": True,
        "requests": [serialize_request(r, users, labels.get(r.id)) for r in items],
        "total": total,
        "offset": offset,
        "limit": limit,
        "shop_domain": await _shop_domain(store_key),
        "level_counts": await _level_counts(db, base_filters, store_filters),
        "scope_counts": await _scope_counts(db, store_key, user),
    }


@router.get("/api/chat-requests/summary")
async def chat_requests_summary(
    store: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    return {"ok": True, **(await _scope_counts(db, _normalize_store(store), user))}


class ChatPullBody(BaseModel):
    store: str
    limit: int = 10


@router.post("/api/chat-requests/pull")
async def pull_chat_requests(
    body: ChatPullBody,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    store_key = _normalize_store(body.store)
    limit = max(1, min(int(body.limit or 10), 100))
    stmt = (
        select(ChatRequest)
        .where(
            ChatRequest.store_key == store_key,
            ChatRequest.status.in_(OPEN_STATUSES),
            ChatRequest.assigned_to_id.is_(None),
        )
        # New requests first (a customer is waiting for the first call), then
        # the rest, newest first — matching the queue's order.
        .order_by((ChatRequest.status == "new").desc(), ChatRequest.created_at.desc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    rows = (await db.execute(stmt)).scalars().all()
    now = datetime.now(timezone.utc)
    for r in rows:
        r.assigned_to_id = user.id
        r.updated_at = now
        db.add(ChatRequestEvent(request_id=r.id, user_id=user.id, action="claimed", detail={"via": "pull"}))
    await db.commit()
    return {"ok": True, "pulled": len(rows)}


# ---------- Get more / move requests (mirrors the orders pull) ----------

PULL_SOURCE_UNASSIGNED = "__unassigned__"
# Admin target meaning "nobody": takes requests off agents and back into the pool.
PULL_TARGET_UNASSIGNED = "__unassigned__"
_PULL_LEVELS = ("all", "new", "n1", "n2", "n3", "n4", "enatt")
_PULL_HARD_CAP = 2000


class ChatPullPreviewBody(BaseModel):
    store: str
    level: str = "new"
    # "new"/"all" only: also offer requests another agent already holds. The
    # call-attempt levels always do, since those requests nearly always have one.
    include_assigned: bool = False
    source_agent_id: Optional[str] = None
    target_agent_id: Optional[str] = None


class ChatPullExecuteBody(ChatPullPreviewBody):
    limit: int = 10  # 0 = every request available


async def _resolve_pull_target(db: AsyncSession, user: User, target_agent_id: Optional[str]) -> Tuple[Optional[User], bool]:
    """(owner the requests go to, whether they are being unassigned instead)."""
    tid = (target_agent_id or "").strip()
    if not tid or tid == user.id:
        return user, False
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="only an admin can move requests to another agent or remove them from agents")
    if tid == PULL_TARGET_UNASSIGNED:
        return None, True
    target = await db.scalar(select(User).where(User.id == tid, User.is_active == True))  # noqa: E712
    if target is None:
        raise HTTPException(status_code=404, detail="agent not found")
    return target, False


def _pull_pool(store_key: str, body: ChatPullPreviewBody, target: Optional[User], unassign: bool) -> Tuple[List[Any], Optional[Any]]:
    """Filters for the whole pool, and the extra filter for the chosen source."""
    level = body.level if body.level in _PULL_LEVELS else "new"
    filters: List[Any] = [
        ChatRequest.store_key == store_key,
        ChatRequest.status.in_(OPEN_STATUSES) if level == "all" else _level_clause(level),
    ]
    includes_assigned = unassign or body.include_assigned or level not in ("new", "all")
    if unassign:
        filters.append(ChatRequest.assigned_to_id.is_not(None))
    elif not includes_assigned:
        filters.append(ChatRequest.assigned_to_id.is_(None))
    else:
        # Requests the target already holds are not "available" to them.
        filters.append(or_(ChatRequest.assigned_to_id.is_(None), ChatRequest.assigned_to_id != target.id))

    source = (body.source_agent_id or "").strip()
    source_filter = None
    if source == PULL_SOURCE_UNASSIGNED and not unassign:
        source_filter = ChatRequest.assigned_to_id.is_(None)
    elif source and source != PULL_SOURCE_UNASSIGNED and includes_assigned:
        source_filter = ChatRequest.assigned_to_id == source
    return filters, source_filter


@router.post("/api/chat-requests/pull/preview")
async def pull_chat_requests_preview(
    body: ChatPullPreviewBody,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    store_key = _normalize_store(body.store)
    target, unassign = await _resolve_pull_target(db, user, body.target_agent_id)
    filters, source_filter = _pull_pool(store_key, body, target, unassign)

    rows = await db.execute(
        select(ChatRequest.assigned_to_id, func.count(ChatRequest.id))
        .where(*filters)
        .group_by(ChatRequest.assigned_to_id)
    )
    per_owner = {owner: int(n or 0) for owner, n in rows.all()}
    unassigned_count = per_owner.pop(None, 0)
    pool_total = unassigned_count + sum(per_owner.values())

    source = (body.source_agent_id or "").strip()
    if source_filter is None:
        available, assigned_available = pool_total, pool_total - unassigned_count
    elif source == PULL_SOURCE_UNASSIGNED:
        available, assigned_available = unassigned_count, 0
    else:
        available = assigned_available = per_owner.get(source, 0)

    owners = await _users_by_id(db, per_owner.keys())
    by_agent = sorted(
        (
            {
                "id": uid,
                "name": owners[uid].name if uid in owners else None,
                "email": owners[uid].email if uid in owners else None,
                "is_active": bool(owners[uid].is_active) if uid in owners else False,
                "count": n,
            }
            for uid, n in per_owner.items()
        ),
        key=lambda a: (-a["count"], (a["name"] or a["email"] or "").lower()),
    )
    return {
        "ok": True,
        "available": available,
        "pool_total": pool_total,
        "unassigned_available": unassigned_count,
        "assigned_available": assigned_available,
        "by_agent": by_agent,
        "target_agent_id": target.id if target else None,
    }


@router.post("/api/chat-requests/pull/execute")
async def pull_chat_requests_execute(
    body: ChatPullExecuteBody,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    store_key = _normalize_store(body.store)
    target, unassign = await _resolve_pull_target(db, user, body.target_agent_id)
    filters, source_filter = _pull_pool(store_key, body, target, unassign)
    if source_filter is not None:
        filters.append(source_filter)
    requested = int(body.limit or 0)
    if requested < 0:
        raise HTTPException(status_code=400, detail="limit must be 0 (all) or more")
    limit = _PULL_HARD_CAP if requested == 0 else min(requested, _PULL_HARD_CAP)

    rows = (await db.execute(
        select(ChatRequest)
        .where(*filters)
        # New requests first (a customer is waiting for the first call), then
        # the rest, newest first — matching the queue's order.
        .order_by((ChatRequest.status == "new").desc(), ChatRequest.created_at.desc(), ChatRequest.id.desc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )).scalars().all()

    now = datetime.now(timezone.utc)
    reassigned = 0
    for r in rows:
        previous = r.assigned_to_id
        if previous:
            reassigned += 1
        r.assigned_to_id = target.id if target else None
        r.updated_at = now
        if unassign:
            action, detail = "release", {"previous_agent_id": previous, "via": "pull"}
        elif previous is None and target.id == user.id:
            action, detail = "claimed", {"via": "pull"}
        else:
            action, detail = "assign", {"previous_agent_id": previous, "agent_id": target.id, "via": "pull"}
        db.add(ChatRequestEvent(request_id=r.id, user_id=user.id, action=action, detail=detail))
    await db.commit()
    return {
        "ok": True,
        "pulled": len(rows),
        "reassigned": reassigned,
        "target_agent_id": target.id if target else None,
        "unassigned": unassign,
    }


class ChatActionBody(BaseModel):
    action: str
    labels: Optional[List[int]] = None
    order_ref: Optional[str] = None
    note: Optional[str] = None
    assign_to: Optional[str] = None
    client_action_id: Optional[str] = None


_ACTIONS = {
    "call", "enatt", "ordered", "not_interested", "wrong_number", "cancelled",
    "reopen", "claim", "release", "assign", "note", "undo_call", "labels",
}


def _open_status_for(r: ChatRequest) -> str:
    if int(r.enatt or 0) > 0:
        return "enatt"
    if int(r.attempts or 0) > 0:
        return "calling"
    return "new"


@router.post("/api/chat-requests/{request_id}/action")
async def chat_request_action(
    request_id: int,
    body: ChatActionBody,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    action = (body.action or "").strip().lower()
    if action not in _ACTIONS:
        raise HTTPException(status_code=400, detail="unknown action")

    r = await db.scalar(select(ChatRequest).where(ChatRequest.id == request_id).with_for_update())
    if r is None:
        raise HTTPException(status_code=404, detail="chat request not found")

    client_action_id = (body.client_action_id or "").strip()[:128] or None
    if client_action_id:
        # A retried click must not record a second call attempt.
        seen = await db.scalar(
            select(ChatRequestEvent.id).where(
                ChatRequestEvent.request_id == r.id,
                ChatRequestEvent.detail["client_action_id"].as_string() == client_action_id,
            ).limit(1)
        )
        if seen:
            users = await _users_by_id(db, [r.assigned_to_id, r.closed_by_id])
            return {"ok": True, "deduped": True, "request": serialize_request(r, users, (await _labels_for(db, [r.id]))[r.id])}

    is_admin = user.role == "admin"
    now = datetime.now(timezone.utc)
    detail: Dict[str, Any] = {}
    if client_action_id:
        detail["client_action_id"] = client_action_id

    is_closed = r.status in CLOSED_STATUSES
    # An ordered request can still be cancelled (the customer changed their mind).
    cancelling_order = action == "cancelled" and r.status == "ordered"
    if is_closed and not cancelling_order and action in ("call", "enatt", "undo_call", *CLOSED_STATUSES):
        raise HTTPException(status_code=409, detail="this request is already closed — reopen it first")

    if action == "call":
        r.attempts = min(int(r.attempts or 0) + 1, MAX_ATTEMPTS)
        r.status = _open_status_for(r)
        detail["attempt"] = r.attempts
    elif action == "undo_call":
        r.attempts = max(int(r.attempts or 0) - 1, 0)
        r.status = _open_status_for(r)
        detail["attempt"] = r.attempts
    elif action == "enatt":
        r.enatt = min(int(r.enatt or 0) + 1, MAX_ATTEMPTS)
        r.status = "enatt"
        detail["enatt"] = r.enatt
    elif action in CLOSED_STATUSES:
        if cancelling_order:
            # The order number stays, so the Cancelled view shows which order it was.
            detail["previous_status"] = r.status
            detail["order_ref"] = r.order_ref
        r.status = action
        r.closed_at = now
        r.closed_by_id = user.id
        if action == "ordered":
            r.order_ref = _clean(body.order_ref, 64)
            if r.order_ref:
                detail["order_ref"] = r.order_ref
    elif action == "reopen":
        if not is_closed:
            raise HTTPException(status_code=409, detail="this request is still open")
        detail["previous_status"] = r.status
        r.closed_at = None
        r.closed_by_id = None
        r.status = _open_status_for(r)
    elif action == "claim":
        if r.assigned_to_id and r.assigned_to_id != user.id and not is_admin:
            raise HTTPException(status_code=409, detail="another agent is already handling this request")
        detail["previous_agent_id"] = r.assigned_to_id
        r.assigned_to_id = user.id
    elif action == "release":
        if r.assigned_to_id and r.assigned_to_id != user.id and not is_admin:
            raise HTTPException(status_code=403, detail="only the assigned agent or an admin can release this request")
        detail["previous_agent_id"] = r.assigned_to_id
        r.assigned_to_id = None
    elif action == "assign":
        if not is_admin:
            raise HTTPException(status_code=403, detail="admin required")
        target_id = (body.assign_to or "").strip() or None
        if target_id:
            target = await db.scalar(select(User).where(User.id == target_id, User.is_active == True))  # noqa: E712
            if target is None:
                raise HTTPException(status_code=404, detail="agent not found")
        detail["previous_agent_id"] = r.assigned_to_id
        detail["agent_id"] = target_id
        r.assigned_to_id = target_id
    elif action == "labels":
        # The reasons behind this request (size, price, later...): the exact set replaces the old one.
        wanted = sorted({int(i) for i in (body.labels or [])})[:12]
        current = {row.label_id for row in (await db.execute(select(ChatRequestLabel).where(ChatRequestLabel.request_id == r.id))).scalars()}
        usable = {lab.id: lab for lab in (await db.execute(select(ChatLabel).where(ChatLabel.store_key == r.store_key, ChatLabel.id.in_(wanted or [0])))).scalars()}
        if any(i not in usable or (usable[i].archived and i not in current) for i in wanted):
            raise HTTPException(status_code=422, detail="unknown label for this store")
        added, removed = [i for i in wanted if i not in current], [i for i in current if i not in wanted]
        if removed:
            await db.execute(ChatRequestLabel.__table__.delete().where(ChatRequestLabel.request_id == r.id, ChatRequestLabel.label_id.in_(removed)))
        for i in added:
            db.add(ChatRequestLabel(request_id=r.id, label_id=i, created_by_id=user.id))
        names = {lab.id: lab.name for lab in (await db.execute(select(ChatLabel).where(ChatLabel.id.in_(added + removed or [0])))).scalars()}
        detail.update(added=[names.get(i, "") for i in added], removed=[names.get(i, "") for i in removed])
    elif action == "note":
        text = _clean_multiline(body.note, 1000)
        if not text:
            raise HTTPException(status_code=400, detail="note is empty")
        stamp = datetime.now(_tz()).strftime("%d/%m %H:%M")
        who = (user.name or user.email or "agent").split("@")[0]
        line = f"[{stamp} {who}] {text}"
        r.note = f"{r.note}\n{line}" if r.note else line
        r.note = r.note[-4000:]
        detail["note"] = text

    # Whoever works an unassigned request owns it from then on.
    if action in ("call", "enatt", *CLOSED_STATUSES) and not r.assigned_to_id:
        r.assigned_to_id = user.id
        detail["auto_assigned"] = True

    if action not in ("note", "claim", "release", "assign", "labels"):
        r.last_action_at = now
    r.updated_at = now
    db.add(ChatRequestEvent(request_id=r.id, user_id=user.id, action=action, detail=detail or None))
    await db.commit()
    await db.refresh(r)
    users = await _users_by_id(db, [r.assigned_to_id, r.closed_by_id])
    return {"ok": True, "deduped": False, "request": serialize_request(r, users, (await _labels_for(db, [r.id]))[r.id])}


@router.get("/api/chat-requests/{request_id}/history")
async def chat_request_history(
    request_id: int,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    exists = await db.scalar(select(ChatRequest.id).where(ChatRequest.id == request_id))
    if not exists:
        raise HTTPException(status_code=404, detail="chat request not found")
    rows = await db.execute(
        select(ChatRequestEvent)
        .where(ChatRequestEvent.request_id == request_id)
        .order_by(ChatRequestEvent.created_at.desc(), ChatRequestEvent.id.desc())
        .limit(200)
    )
    events = rows.scalars().all()
    users = await _users_by_id(db, [e.user_id for e in events])
    return {
        "ok": True,
        "events": [
            {
                "id": e.id,
                "action": e.action,
                "detail": e.detail or {},
                "created_at": _iso(e.created_at),
                "user": _user_brief(users.get(e.user_id)) if e.user_id else None,
            }
            for e in events
        ],
    }


CHAT_VIEW_TTL_SECONDS = 12 * 3600


def chat_view_url(session_id: str, now: Optional[float] = None) -> Tuple[str, int]:
    """A short-lived link to the read-only copy of a website chat, signed with the shared intake key.

    The chat backend checks `chat-view:<session>:<expiry>` with the same key and only shows the
    page inside this app (frame-ancestors)."""
    secret = os.getenv("CHAT_INTAKE_SECRET", "")
    if not secret:
        raise HTTPException(503, "Chat integration is not configured")
    expires = int((now or time.time()) + CHAT_VIEW_TTL_SECONDS)
    signature = hmac.new(secret.encode(), f"chat-view:{session_id}:{expires}".encode(), hashlib.sha256).hexdigest()
    base = os.getenv("CHAT_VIEW_BASE_URL", "https://wtp.chattbase.site").rstrip("/")
    return f"{base}/storefront/chat-view/{session_id}?token={expires}.{signature}", expires


@router.get("/api/chat-requests/{request_id}/conversation")
async def chat_request_conversation(
    request_id: int,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """The website chat behind this request, as the customer saw it (newest chat first)."""
    exists = await db.scalar(select(ChatRequest.id).where(ChatRequest.id == request_id))
    if not exists:
        raise HTTPException(status_code=404, detail="chat request not found")
    rows = await db.execute(
        select(ChatRequestEvent.detail)
        .where(ChatRequestEvent.request_id == request_id)
        .order_by(ChatRequestEvent.created_at.desc(), ChatRequestEvent.id.desc())
        .limit(200)
    )
    for detail in rows.scalars():
        match = re.fullmatch(r"storefront:([a-f0-9]{32}):[a-z0-9:]*", str((detail or {}).get("source_id") or ""))
        if match:
            url, expires = chat_view_url(match[1])
            return {"ok": True, "url": url, "expires_at": expires}
    raise HTTPException(status_code=404, detail="This request has no website chat")


# ---------- Reason labels ----------

def _label_key(name: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:40]
    return key


async def _store_labels(db: AsyncSession, store_key: str, *, include_archived: bool = False) -> List[ChatLabel]:
    labels = (await db.execute(select(ChatLabel).where(ChatLabel.store_key == store_key).order_by(ChatLabel.position, ChatLabel.id))).scalars().all()
    keys = {lab.key for lab in labels}
    # First use in this store: the usual reasons, which agents can extend. "Other" (with a note)
    # also reaches stores that were set up before it existed; it stays last.
    missing = [(position if not labels else 1000, key, name, color) for position, (key, name, color) in enumerate(DEFAULT_LABELS)
               if key not in keys and (not labels or key == "other")]
    if missing:
        for position, key, name, color in missing:
            db.add(ChatLabel(store_key=store_key, key=key, name=name, color=color, position=position))
        try:
            await db.commit()
        except Exception:
            await db.rollback()  # another agent seeded them at the same moment
        labels = (await db.execute(select(ChatLabel).where(ChatLabel.store_key == store_key).order_by(ChatLabel.position, ChatLabel.id))).scalars().all()
    return [lab for lab in labels if include_archived or not lab.archived]


@router.get("/api/chat-labels")
async def list_chat_labels(store: str, db: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)):
    labels = await _store_labels(db, _normalize_store(store), include_archived=user.role == "admin")
    return {"ok": True, "labels": [serialize_label(lab) for lab in labels], "colors": list(LABEL_COLORS), "can_manage": user.role == "admin"}


class ChatLabelBody(BaseModel):
    store: Optional[str] = None
    name: Optional[str] = None
    color: Optional[str] = None
    archived: Optional[bool] = None


@router.post("/api/chat-labels")
async def create_chat_label(body: ChatLabelBody, db: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)):
    """Any agent can add a reason they keep hearing; the same name twice returns the existing label."""
    store_key = _normalize_store(body.store or "")
    name = " ".join(str(body.name or "").split())[:60]
    if not name:
        raise HTTPException(status_code=422, detail="give the label a name")
    labels = await _store_labels(db, store_key, include_archived=True)
    same = next((lab for lab in labels if lab.name.casefold() == name.casefold()), None)
    if same:
        if same.archived:
            same.archived = False
            await db.commit()
        return {"ok": True, "label": serialize_label(same), "existing": True}
    if len([lab for lab in labels if not lab.archived]) >= 40:
        raise HTTPException(status_code=409, detail="this store already has 40 labels")
    taken = {lab.key for lab in labels}
    base = _label_key(name) or "label"
    key, n = base, 2
    while key in taken:
        key, n = f"{base}_{n}", n + 1
    color = body.color if body.color in LABEL_COLORS else LABEL_COLORS[len(labels) % len(LABEL_COLORS)]
    label = ChatLabel(store_key=store_key, key=key, name=name, color=color,
                      position=max([lab.position for lab in labels] or [0]) + 1, created_by_id=user.id)
    db.add(label)
    await db.commit()
    await db.refresh(label)
    return {"ok": True, "label": serialize_label(label), "existing": False}


@router.patch("/api/chat-labels/{label_id}")
async def update_chat_label(label_id: int, body: ChatLabelBody, db: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin required")
    label = await db.get(ChatLabel, label_id)
    if label is None:
        raise HTTPException(status_code=404, detail="label not found")
    if body.name is not None:
        name = " ".join(body.name.split())[:60]
        if not name:
            raise HTTPException(status_code=422, detail="give the label a name")
        label.name = name
    if body.color is not None:
        if body.color not in LABEL_COLORS:
            raise HTTPException(status_code=422, detail="unknown color")
        label.color = body.color
    if body.archived is not None:
        # Archived labels stay on past requests (and in the analysis) but are no longer offered.
        label.archived = bool(body.archived)
    await db.commit()
    return {"ok": True, "label": serialize_label(label)}


@router.get("/api/chat-requests/reasons")
async def chat_request_reasons(
    store: str,
    days: int = 30,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Where customers stop: outcomes of the requests created in the period, by reason label."""
    store_key = _normalize_store(store)
    days = max(1, min(int(days or 30), 365))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    in_period = [ChatRequest.store_key == store_key, ChatRequest.created_at >= since]
    outcomes = {"ordered": 0, "not_interested": 0, "wrong_number": 0, "open": 0}
    for status, n in (await db.execute(select(ChatRequest.status, func.count(ChatRequest.id)).where(*in_period).group_by(ChatRequest.status))).all():
        outcomes[status if status in outcomes else "open"] += int(n or 0)
    labels = await _store_labels(db, store_key, include_archived=True)
    by_label: Dict[int, Dict[str, int]] = {}
    rows = await db.execute(
        select(ChatRequestLabel.label_id, ChatRequest.status, func.count(ChatRequest.id))
        .join(ChatRequest, ChatRequest.id == ChatRequestLabel.request_id)
        .where(*in_period)
        .group_by(ChatRequestLabel.label_id, ChatRequest.status)
    )
    for label_id, status, n in rows.all():
        counts = by_label.setdefault(label_id, {"ordered": 0, "lost": 0, "open": 0})
        counts["ordered" if status == "ordered" else "lost" if status in LOST_STATUSES else "open"] += int(n or 0)
    labelled = select(ChatRequestLabel.request_id)
    lost_without = int(await db.scalar(select(func.count(ChatRequest.id)).where(
        *in_period, ChatRequest.status.in_(LOST_STATUSES), ChatRequest.id.not_in(labelled))) or 0)
    labelled_total = int(await db.scalar(select(func.count(ChatRequest.id)).where(*in_period, ChatRequest.id.in_(labelled))) or 0)
    result = []
    for lab in labels:
        counts = by_label.get(lab.id, {"ordered": 0, "lost": 0, "open": 0})
        total = sum(counts.values())
        if lab.archived and not total:
            continue
        result.append({**serialize_label(lab), **counts, "total": total})
    result.sort(key=lambda item: (-item["lost"], -item["total"], item["name"]))
    return {"ok": True, "days": days, "total": sum(outcomes.values()), "outcomes": outcomes,
            "labels": result, "labelled": labelled_total, "lost_without_label": lost_without}


@router.get("/api/chat-requests/team-stats")
async def chat_team_stats(
    store: Optional[str] = None,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Per-agent chat activity today, across every store (like the order team stats)."""
    start, end = _today_bounds_utc()
    rows = await db.execute(
        select(ChatRequestEvent.user_id, ChatRequestEvent.action, func.count(ChatRequestEvent.id))
        .where(
            ChatRequestEvent.user_id.is_not(None),
            ChatRequestEvent.created_at >= start,
            ChatRequestEvent.created_at < end,
            ChatRequestEvent.action.in_(("call", "enatt", *CLOSED_STATUSES)),
        )
        .group_by(ChatRequestEvent.user_id, ChatRequestEvent.action)
    )
    per_user: Dict[str, Dict[str, int]] = {}
    for uid, action, n in rows.all():
        per_user.setdefault(uid, {})[action] = int(n or 0)

    open_rows = await db.execute(
        select(ChatRequest.assigned_to_id, func.count(ChatRequest.id))
        .where(ChatRequest.assigned_to_id.is_not(None), ChatRequest.status.in_(OPEN_STATUSES))
        .group_by(ChatRequest.assigned_to_id)
    )
    open_map = {uid: int(n or 0) for uid, n in open_rows.all()}

    agent_rows = await db.execute(
        select(User).where(
            User.is_active == True,  # noqa: E712
            or_(User.role == "agent", User.id.in_(set(per_user) | set(open_map))),
        )
    )
    agents = []
    for a in agent_rows.scalars().all():
        acts = per_user.get(a.id, {})
        agents.append({
            "id": a.id,
            "name": a.name,
            "email": a.email,
            "role": a.role,
            "calls_today": acts.get("call", 0) + acts.get("enatt", 0),
            "ordered_today": acts.get("ordered", 0),
            "closed_today": sum(acts.get(s, 0) for s in CLOSED_STATUSES),
            "open_assigned": open_map.get(a.id, 0),
        })
    agents.sort(key=lambda x: (-x["ordered_today"], -x["calls_today"], (x["name"] or x["email"] or "").lower()))
    return {"ok": True, "agents": agents}
