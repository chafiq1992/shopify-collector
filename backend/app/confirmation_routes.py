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
from typing import Any, Dict, FrozenSet, List, NamedTuple, Optional, Tuple
from zoneinfo import ZoneInfo
from .web_confirmation_status import enrich as enrich_web_confirmations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import case, func, or_, select, text
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
        select(User).where(User.is_active == True, User.role == "agent")  # noqa: E712
    )
    out: set = set()
    for u in res.scalars().all():
        if exclude_user_id and u.id == exclude_user_id:
            continue
        for t in (u.agent_tags or []):
            if t:
                out.add(t)
    return sorted(out)


async def _other_agents_all_tags(db: AsyncSession, exclude_user_id: Optional[str] = None) -> List[str]:
    """Every Shopify tag claimed by some OTHER user, whatever their role or active flag.

    Wider than :func:`_other_agents_active_tags` on purpose. That one defines the
    *unassigned* pool, so it only counts agents who are still working. This one is
    what a pull *strips*: an order carrying the tag of a deactivated agent (or of
    someone whose role has since changed) is still an order with somebody else's
    name on it, and the invariant we want is that exactly one agent tag survives
    a pull.
    """
    res = await db.execute(select(User))
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


async def queue_filter_for_user(db: AsyncSession, user: User) -> "LiveTagFilter":
    """Live-tag restatement of :func:`query_for_user` (see :class:`LiveTagFilter`)."""
    tags = list(user.agent_tags or [])
    if tags:
        return LiveTagFilter(require=(_lower_tags(tags),))
    if user.role == "agent":
        other = await _other_agents_active_tags(db, exclude_user_id=user.id)
        return LiveTagFilter(forbid=_lower_tags(other))
    return LiveTagFilter()


_VALID_LEVELS = {"n1", "n2", "n3", "n4", "nowtp", "enatt", "new"}
_NOWTP_TAGS = ("nowtp1", "nowtp2", "nowtp3", "nowtp4")
_ENATT_TAGS = ("enatt1", "enatt2", "enatt3", "enatt4")


def _confirmation_metric_action_predicate():
    return or_(
        OrderEvent.action.in_(
            (
                "confirmation_phone_n1",
                "confirmation_phone_n2",
                "confirmation_phone_n3",
                "confirmation_phone_n4",
                "confirmation_confirmed",
                "confirmation_cancelled",
            )
        ),
        OrderEvent.action.like("confirmation_nowtp%"),
        OrderEvent.action.like("confirmation_enatt%"),
    )


def _confirmation_actor_predicate():
    """Recognize both legacy agent events and any durable Confirmation-page action."""
    metadata_source = func.coalesce(OrderEvent.event_metadata["source"].as_string(), "")
    metadata_role = func.coalesce(OrderEvent.event_metadata["role"].as_string(), "")
    return or_(metadata_source == "confirmation", metadata_role == "agent")


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


def _lower_tags(tags: Any) -> FrozenSet[str]:
    return frozenset(str(t or "").strip().lower() for t in (tags or []) if str(t or "").strip())


# ---------- Live-tag re-validation ----------
#
# Shopify's order *search index* trails tag writes by seconds to minutes, but the
# `tags` field on each returned node is always live. Without re-checking, an order
# that was just pulled away from an agent keeps matching their old query (and the
# "unassigned" pool keeps counting orders that were assigned a minute ago), which
# is exactly the "the number never changes after I assign orders" bug. Every scan
# below therefore re-validates each hit against the query's intent using the live
# tags, so counts move the moment the tag write lands.

class LiveTagFilter(NamedTuple):
    """Tag-level restatement of a Shopify search query.

    ``require``: every group must share at least one tag with the order.
    ``forbid``: the order must carry none of these tags.
    """
    require: Tuple[FrozenSet[str], ...] = ()
    forbid: FrozenSet[str] = frozenset()

    def matches(self, tags: Any) -> bool:
        tl = _lower_tags(tags)
        if self.forbid and (tl & self.forbid):
            return False
        for group in self.require:
            if group and not (tl & group):
                return False
        return True


_PHONE_LEVELS = ("n1", "n2", "n3", "n4")


def _matches_level(tags: Any, level: Optional[str]) -> bool:
    """Python mirror of :func:`apply_level_filter` for live-tag re-validation."""
    lv = (level or "").lower().strip()
    if not lv or lv not in _VALID_LEVELS:
        return True
    tl = _lower_tags(tags)
    if lv in _PHONE_LEVELS:
        return lv in tl
    if lv == "nowtp":
        return any(t in tl for t in _NOWTP_TAGS)
    if lv == "enatt":
        return any(t in tl for t in _ENATT_TAGS)
    if lv == "new":
        return not any(t in tl for t in (*_PHONE_LEVELS, *_NOWTP_TAGS, *_ENATT_TAGS))
    return True


# (store, order_gid) -> (timestamp, lowercased tags added). Filled whenever this app
# adds a tag, so an order that was just assigned to an agent shows up in their queue
# (and counts) immediately instead of waiting for Shopify to re-index it. In-process
# on purpose: the app runs a single uvicorn worker (see deploy/collector/compose.yaml).
_RECENT_TAG_ADDS: Dict[Tuple[str, str], Tuple[float, FrozenSet[str]]] = {}
_RECENT_TAG_ADDS_TTL_SECONDS = 15 * 60
_RECENT_TAG_ADDS_MAX = 5000
_RECENT_OVERLAY_MAX_IDS = 100


def _store_key(store: Optional[str]) -> str:
    return str(store or "").strip().lower()


def note_recent_tag_add(store: Optional[str], order_gid: Optional[str], tags: Any) -> None:
    gid = str(order_gid or "").strip()
    added = _lower_tags(tags if isinstance(tags, (list, tuple, set, frozenset)) else [tags])
    if not gid or not added:
        return
    key = (_store_key(store), gid)
    prev = _RECENT_TAG_ADDS.get(key)
    if prev and (time.time() - prev[0]) < _RECENT_TAG_ADDS_TTL_SECONDS:
        added = added | prev[1]
    _RECENT_TAG_ADDS[key] = (time.time(), added)
    if len(_RECENT_TAG_ADDS) > _RECENT_TAG_ADDS_MAX:
        _prune_recent_tag_adds(force=True)


def _prune_recent_tag_adds(force: bool = False) -> None:
    cutoff = time.time() - _RECENT_TAG_ADDS_TTL_SECONDS
    for key, (ts, _tags) in list(_RECENT_TAG_ADDS.items()):
        if ts < cutoff:
            _RECENT_TAG_ADDS.pop(key, None)
    if force and len(_RECENT_TAG_ADDS) > _RECENT_TAG_ADDS_MAX:
        oldest = sorted(_RECENT_TAG_ADDS.items(), key=lambda kv: kv[1][0])
        for key, _v in oldest[: len(_RECENT_TAG_ADDS) - _RECENT_TAG_ADDS_MAX]:
            _RECENT_TAG_ADDS.pop(key, None)


def recent_orders_tagged_with(store: Optional[str], tags: Any) -> List[str]:
    """Order GIDs in ``store`` that this app tagged with any of ``tags`` recently,
    newest first."""
    wanted = _lower_tags(tags)
    if not wanted:
        return []
    _prune_recent_tag_adds()
    sk = _store_key(store)
    hits = [
        (ts, gid)
        for (s, gid), (ts, added) in _RECENT_TAG_ADDS.items()
        if s == sk and (added & wanted)
    ]
    hits.sort(reverse=True)
    return [gid for _ts, gid in hits[:_RECENT_OVERLAY_MAX_IDS]]


_FULFILLED_STATUSES = {"FULFILLED", "PARTIALLY_FULFILLED", "RESTOCKED"}


def _node_is_open_unshipped(node: Dict[str, Any]) -> bool:
    """Python mirror of ``status:open fulfillment_status:unshipped`` for nodes
    fetched by ID (which bypasses the search query)."""
    if not node:
        return False
    if node.get("cancelledAt") or node.get("closed"):
        return False
    status = str(node.get("displayFulfillmentStatus") or "").upper()
    return status not in _FULFILLED_STATUSES


async def _fetch_nodes_by_id(store: str, gids: List[str], fields: str) -> List[Dict[str, Any]]:
    """Fetch orders by GID (live data, no search index involved)."""
    if not gids:
        return []
    from .main import shopify_graphql  # type: ignore

    gql = f"""
    query Nodes($ids: [ID!]!) {{
      nodes(ids: $ids) {{ ... on Order {{ {fields} }} }}
    }}
    """
    out: List[Dict[str, Any]] = []
    for i in range(0, len(gids), 50):
        chunk = gids[i:i + 50]
        try:
            data = await shopify_graphql(gql, {"ids": chunk}, store=store)
        except Exception:
            logger.exception("recent-order overlay fetch failed (store=%s)", store)
            continue
        for node in ((data or {}).get("nodes") or []):
            if node and node.get("id"):
                out.append(node)
    return out


# (key=(user_id, store, base_query)) → (timestamp_seconds, breakdown_dict). One full
# pagination scan produces the total count AND the per-level (n1/n2/n3/n4/new) counts;
# the queue endpoint and team-stats both read from this cache so the 15-second polling
# and the per-level filter pills don't trigger fresh scans.
_BREAKDOWN_CACHE: Dict[Tuple[str, str, str], Tuple[float, Dict[str, int]]] = {}
_BREAKDOWN_INFLIGHT: Dict[Tuple[str, str, str], asyncio.Task] = {}
_BREAKDOWN_CACHE_GENERATION = 0
_BREAKDOWN_TTL_SECONDS = 60
_BREAKDOWN_SCAN_PAGE = 250  # Shopify's max page size
_BREAKDOWN_HARD_CAP = 10_000  # safety net

# Team stats are identical for every authenticated confirmation user. A short cache
# collapses the burst created when many open tabs poll on the same 15-second boundary.
_TEAM_STATS_CACHE: Optional[Tuple[float, Dict[str, Any]]] = None
_TEAM_STATS_CACHE_SECONDS = 10
_TEAM_STATS_LOCK = asyncio.Lock()


def _empty_breakdown() -> Dict[str, int]:
    return {"total": 0, "n1": 0, "n2": 0, "n3": 0, "n4": 0, "nowtp": 0, "enatt": 0, "new": 0}


def _count_into_breakdown(counts: Dict[str, int], tags_list: List[str]) -> None:
    counts["total"] += 1
    tlower = _lower_tags(tags_list)
    has_any = False
    for lv in _PHONE_LEVELS:
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


async def _compute_assigned_breakdown(
    store: str,
    user_id: str,
    base_q: str,
    generation: int,
    live_filter: Optional[LiveTagFilter] = None,
) -> Dict[str, int]:
    key = (user_id, store, base_q)
    from .main import shopify_graphql  # type: ignore

    gql = """
    query Q($first: Int!, $after: String, $q: String) {
      orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges { cursor node { id tags } }
        pageInfo { hasNextPage }
      }
    }
    """
    counts = _empty_breakdown()
    seen: set = set()
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
            node = e.get("node") or {}
            tags_list = list(node.get("tags") or [])
            if node.get("id"):
                seen.add(node["id"])
            if has_cod_tag(tags_list):
                continue
            # The search index can lag a tag removal; the node's tags cannot.
            if live_filter is not None and not live_filter.matches(tags_list):
                continue
            _count_into_breakdown(counts, tags_list)
        page_info = ((data or {}).get("orders") or {}).get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            break
        cursor = edges[-1].get("cursor")

    # Orders this app just assigned to the agent that Shopify hasn't indexed yet.
    owner_tags = live_filter.require[0] if (live_filter and live_filter.require) else frozenset()
    missing = [g for g in recent_orders_tagged_with(store, owner_tags) if g not in seen]
    if missing:
        nodes = await _fetch_nodes_by_id(
            store, missing, "id tags cancelledAt closed displayFulfillmentStatus",
        )
        for node in nodes:
            tags_list = list(node.get("tags") or [])
            if (
                _node_is_open_unshipped(node)
                and not has_cod_tag(tags_list)
                and live_filter.matches(tags_list)
            ):
                _count_into_breakdown(counts, tags_list)

    # A tag mutation may invalidate the cache while this scan is running. Return the
    # result to its original caller, but never repopulate the cache with that stale scan.
    if generation == _BREAKDOWN_CACHE_GENERATION:
        _BREAKDOWN_CACHE[key] = (time.time(), counts)
    return counts


async def accurate_assigned_breakdown(
    store: str,
    user_id: str,
    base_q: str,
    live_filter: Optional[LiveTagFilter] = None,
) -> Dict[str, int]:
    """Return an accurate queue breakdown with TTL caching and request coalescing.

    When several tabs miss the same cache key simultaneously, only one Shopify
    pagination scan runs; the other requests await that same task.
    """
    key = (user_id, store, base_q)
    now = time.time()
    cached = _BREAKDOWN_CACHE.get(key)
    if cached and (now - cached[0]) < _BREAKDOWN_TTL_SECONDS:
        return cached[1]

    task = _BREAKDOWN_INFLIGHT.get(key)
    if task is None:
        task = asyncio.create_task(
            _compute_assigned_breakdown(
                store, user_id, base_q, _BREAKDOWN_CACHE_GENERATION, live_filter,
            )
        )
        _BREAKDOWN_INFLIGHT[key] = task
    try:
        return await asyncio.shield(task)
    finally:
        if task.done() and _BREAKDOWN_INFLIGHT.get(key) is task:
            _BREAKDOWN_INFLIGHT.pop(key, None)


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
    global _BREAKDOWN_CACHE_GENERATION, _TEAM_STATS_CACHE
    if not user_id:
        return 0
    _BREAKDOWN_CACHE_GENERATION += 1
    _TEAM_STATS_CACHE = None
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
        _BREAKDOWN_INFLIGHT.pop(k, None)
    return len(keys)


def invalidate_all_breakdown_caches() -> int:
    """Wipe every breakdown cache entry (used when a tag change might affect any agent's
    counts — e.g. when a confirmation tag is added that takes an order out of every
    queue at once)."""
    global _BREAKDOWN_CACHE_GENERATION, _TEAM_STATS_CACHE
    n = len(_BREAKDOWN_CACHE)
    _BREAKDOWN_CACHE_GENERATION += 1
    _TEAM_STATS_CACHE = None
    _BREAKDOWN_CACHE.clear()
    _BREAKDOWN_INFLIGHT.clear()
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
customAttributes { key value }
displayFinancialStatus
displayFulfillmentStatus
currentTotalPriceSet { shopMoney { amount currencyCode } }
shippingAddress {
  name
  firstName
  lastName
  company
  city
  phone
  address1
  address2
  zip
  province
  country
}
customer { id displayName phone email }
lineItems(first: 50) {
  edges {
    node {
      id
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

# Global search does not need all 50 product rows just to identify and act on
# an order. Keeping this connection bounded prevents customer + nested-order
# searches from exceeding Shopify's 1,000-point single-query cost ceiling.
_SEARCH_ORDER_NODE_FIELDS = _ORDER_NODE_FIELDS.replace(
    "lineItems(first: 50)",
    "lineItems(first: 20)",
)


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


# Set by the Chattbase COD form when the order was confirmed in a chat on the store (whatsapp-last
# backend/storefront_confirmation.py); the value is that chat's session id.
WEB_CONFIRMATION_ATTRIBUTE = "Chattbase confirmation"


def _web_confirmation(node: Dict[str, Any]) -> Optional[Dict[str, str]]:
    for attr in node.get("customAttributes") or []:
        if isinstance(attr, dict) and str(attr.get("key") or "").strip() == WEB_CONFIRMATION_ATTRIBUTE:
            value = str(attr.get("value") or "").strip()
            if re.fullmatch(r"[a-f0-9]{32}", value):
                return {"session_id": value}
    return None


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
            "id": n.get("id") or "",
            "title": n.get("title") or product.get("title") or "",
            "variant_title": variant.get("title") or "",
            "variant_id": variant.get("id") or "",
            "product_id": product.get("id") or "",
            "options": variant.get("selectedOptions") or [],
            "sku": n.get("sku") or variant.get("sku") or "",
            "quantity": current_qty,
            "unfulfilled_quantity": max(0, int(n.get("unfulfilledQuantity") or 0)),
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
        "web_confirmation": _web_confirmation(node),
        "financial_status": node.get("displayFinancialStatus") or "",
        "fulfillment_status": node.get("displayFulfillmentStatus") or "",
        "customer_name": (shipping.get("name") or cust.get("displayName") or "").strip(),
        "phone": _gather_phone(node),
        "shipping_first_name": shipping.get("firstName") or "",
        "shipping_last_name": shipping.get("lastName") or "",
        "shipping_company": shipping.get("company") or "",
        "shipping_address1": shipping.get("address1") or "",
        "shipping_address2": shipping.get("address2") or "",
        "shipping_city": shipping.get("city") or "",
        "shipping_province": shipping.get("province") or "",
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
    live_filter = await queue_filter_for_user(db, user)

    def _still_mine(tags_list: List[str]) -> bool:
        # Re-validate against live tags: the search index may still list an order
        # that was just pulled away or moved to another level.
        return (
            not has_cod_tag(tags_list)
            and live_filter.matches(tags_list)
            and _matches_level(tags_list, level)
        )

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
            if not _still_mine(tags_list):
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

    # Page 1 also shows orders that were just assigned to this agent but that
    # Shopify's search index doesn't return yet, so a pull lands instantly.
    if cursor is None and live_filter.require:
        present = {o.get("id") for o in orders}
        missing = [
            g for g in recent_orders_tagged_with(store, live_filter.require[0])
            if g not in present
        ]
        if missing:
            extra_nodes = await _fetch_nodes_by_id(
                store, missing, f"closed\n{_ORDER_NODE_FIELDS}",
            )
            extra = [
                _flatten_order(n) for n in extra_nodes
                if _node_is_open_unshipped(n) and _still_mine(list(n.get("tags") or []))
            ]
            if extra:
                orders = sorted(
                    orders + extra,
                    key=lambda o: str(o.get("created_at") or ""),
                    reverse=True,
                )

    # Compute the per-level breakdown ONCE on page 1 (or use a fresh cache hit on follow-up
    # pages). The breakdown is derived from `base_q` — i.e. the agent's full tag-criteria
    # query WITHOUT any active level filter — so the N1/N2/N3/N4/New pills always show
    # the same totals regardless of which pill is currently selected.
    if cursor is None:
        try:
            breakdown = await accurate_assigned_breakdown(store, user.id, base_q, live_filter)
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
        "orders": await enrich_web_confirmations(store, orders),
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
query CustomerOrders($id: ID!, $first: Int!, $after: String) {{
  customer(id: $id) {{
    id
    displayName
    numberOfOrders
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {{
      pageInfo {{ hasNextPage endCursor }}
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
      node {{ {_SEARCH_ORDER_NODE_FIELDS} }}
    }}
  }}
}}
"""

SEARCH_CUSTOMERS_GQL = f"""
query SearchCustomers($first: Int!, $ordersFirst: Int!, $query: String) {{
  customers(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {{
    edges {{
      node {{
        id
        displayName
        firstName
        lastName
        email
        phone
        numberOfOrders
        defaultAddress {{ city country }}
        orders(first: $ordersFirst, sortKey: CREATED_AT, reverse: true) {{
          edges {{
            node {{ {_SEARCH_ORDER_NODE_FIELDS} }}
          }}
        }}
      }}
    }}
  }}
}}
"""

PHONE_SCAN_GQL = """
query PhoneOrderScan($after: String) {
  orders(first: 250, after: $after, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    edges { cursor node { id shippingAddress { phone } customer { phone } } }
  }
}
"""

PHONE_ORDERS_GQL = f"""
query PhoneOrders($ids: [ID!]!) {{
  nodes(ids: $ids) {{
    ... on Order {{ {_ORDER_NODE_FIELDS} }}
  }}
}}
"""

# Shared by same-store agent reads for one minute. A lightweight page is fetched
# once, rather than scanning Shopify separately for every customer opened.
_PHONE_SCAN_CACHE: Dict[Tuple[str, Optional[str]], Tuple[float, Dict[str, Any]]] = {}


# ---------- Reliable, idempotent Confirmation action writes ----------

class AgentTagActionBody(BaseModel):
    order_id: str
    tag: str
    op: str
    store: str
    client_action_id: str
    actor_id: Optional[str] = None


async def _lock_client_action(db: AsyncSession, client_action_id: str) -> None:
    """Serialize one browser action across Cloud Run instances.

    PostgreSQL transaction advisory locks close the race where two open tabs
    both see no audit row, both write Shopify, and then one crashes on the
    unique audit key. The lock is released automatically on commit/rollback.
    SQLite is already serialized for writes and is used only in local tests.
    """
    bind = db.get_bind()
    if bind is not None and bind.dialect.name == "postgresql":
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": client_action_id},
        )


def _same_client_action(
    event: OrderEvent,
    *,
    user_id: str,
    order_id: str,
    store_key: str,
    tag: str,
    op: str,
) -> bool:
    metadata = event.event_metadata or {}
    return (
        event.user_id == user_id
        and event.order_gid == order_id
        and event.store_key == store_key
        and str(metadata.get("tag") or "").strip().lower() == tag.lower()
        and str(metadata.get("op") or "").strip().lower() == op
    )


@router.post("/api/agent/tag-action")
async def agent_tag_action(
    body: AgentTagActionBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Apply one Confirmation tag write and durably attribute it to its agent.

    The browser supplies one stable client_action_id per click. A successful
    response therefore means both the Shopify mutation and the audit event are
    durable. Retried requests return the original event instead of double-counting.
    """
    order_id = (body.order_id or "").strip()
    tag = (body.tag or "").strip()
    op = (body.op or "").strip().lower()
    store = (body.store or "").strip()
    client_action_id = (body.client_action_id or "").strip()
    actor_id = (body.actor_id or "").strip()
    if not order_id:
        raise HTTPException(status_code=400, detail="order_id is required")
    if not tag or len(tag) > 255:
        raise HTTPException(status_code=400, detail="tag is required and must be at most 255 characters")
    if op not in {"add", "remove"}:
        raise HTTPException(status_code=400, detail="op must be add or remove")
    if not store:
        raise HTTPException(status_code=400, detail="store is required")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", client_action_id):
        raise HTTPException(status_code=400, detail="invalid client_action_id")
    if actor_id and actor_id != user.id:
        # A localStorage queue can survive logout. Never let the next signed-in
        # user replay and inherit another agent's queued actions.
        raise HTTPException(status_code=409, detail="queued action belongs to another agent")

    from .main import (  # type: ignore
        _classify_agent_tag_action,
        _normalize_store,
        _record_user_action,
        _shopify_add_tag,
        _shopify_remove_tag,
    )

    store_key = _normalize_store(store)
    await _lock_client_action(db, client_action_id)
    existing = await db.scalar(
        select(OrderEvent).where(OrderEvent.client_action_id == client_action_id)
    )
    if existing is not None:
        if not _same_client_action(
            existing,
            user_id=user.id,
            order_id=order_id,
            store_key=store_key,
            tag=tag,
            op=op,
        ):
            raise HTTPException(status_code=409, detail="client_action_id was already used for a different action")
        return {
            "ok": True,
            "audited": True,
            "deduped": True,
            "action": existing.action,
            "event_id": existing.id,
        }

    try:
        if op == "add":
            await _shopify_add_tag(order_id, tag, store)
            note_recent_tag_add(store, order_id, [tag])
        else:
            await _shopify_remove_tag(order_id, tag, store)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "confirmation tag write failed (order=%s tag=%s op=%s user=%s)",
            order_id, tag, op, user.id,
        )
        raise HTTPException(status_code=502, detail=f"Shopify tag write failed: {exc}") from exc

    action_name = (
        _classify_agent_tag_action(tag)
        if op == "add"
        else None
    ) or f"confirmation_tag_{op}"
    metadata = {
        "tag": tag,
        "op": op,
        "role": getattr(user, "role", None),
        "source": "confirmation",
        "confirmation_actor": True,
        "client_action_id": client_action_id,
    }
    try:
        await _record_user_action(
            db,
            user_id=user.id,
            order_number=None,
            order_gid=order_id,
            store_key=store_key,
            action=action_name,
            metadata=metadata,
            client_action_id=client_action_id,
        )
        await db.commit()
    except IntegrityError:
        try:
            await db.rollback()
        except Exception:
            pass
        # Another tab can race the same localStorage item. The unique key picks
        # one winner; verify that the winner represents this exact action.
        existing = await db.scalar(
            select(OrderEvent).where(OrderEvent.client_action_id == client_action_id)
        )
        if existing is None or not _same_client_action(
            existing,
            user_id=user.id,
            order_id=order_id,
            store_key=store_key,
            tag=tag,
            op=op,
        ):
            logger.warning(
                "confirmation audit idempotency conflict (client_action_id=%s)",
                client_action_id,
            )
            raise HTTPException(status_code=503, detail="action audit could not be verified; retrying is safe")
        return {
            "ok": True,
            "audited": True,
            "deduped": True,
            "action": existing.action,
            "event_id": existing.id,
        }
    except Exception as exc:
        await db.rollback()
        # Do not acknowledge the queue item. Shopify add/remove-tag is
        # idempotent, so the client can safely retry until attribution commits.
        logger.exception(
            "confirmation audit failed after Shopify write (order=%s user=%s action=%s)",
            order_id, user.id, action_name,
        )
        raise HTTPException(status_code=503, detail="action was not audited yet; retrying is safe") from exc

    invalidate_all_breakdown_caches()
    return {
        "ok": True,
        "audited": True,
        "deduped": False,
        "action": action_name,
        "event_id": None,
    }


def _confirmation_phone_variants(raw: str) -> Dict[str, Any]:
    """Normalize pasted Moroccan phone formats into exact Shopify search values."""
    digits = re.sub(r"\D", "", raw or "")
    without_00 = digits[2:] if digits.startswith("00") else digits
    national = ""
    if without_00.startswith("212") and len(without_00) == 12:
        national = without_00[3:]
    elif without_00.startswith("0") and len(without_00) == 10:
        national = without_00[1:]
    elif len(without_00) == 9:
        national = without_00

    variants: List[str] = []
    if national:
        candidates = [
            f"+212{national}",
            f"212{national}",
            f"00212{national}",
            f"0{national}",
            national,
        ]
        normalized_phone = f"+212{national}"
    else:
        candidates = [
            f"+{without_00}" if without_00 else "",
            without_00,
            digits,
        ]
        normalized_phone = (f"+{without_00}" if without_00 else "")

    seen = set()
    for value in candidates:
        if value and value not in seen:
            seen.add(value)
            variants.append(value)
    return {
        "digits": digits,
        "normalized_phone": normalized_phone or None,
        "variants": variants,
    }


def _classify_confirmation_search(raw: str) -> Dict[str, Any]:
    cleaned = (raw or "").strip()
    details = _confirmation_phone_variants(cleaned)
    digits = details["digits"]
    compact = re.sub(r"[\s().+/\-]", "", cleaned)
    numeric_only = bool(compact) and compact.isdigit()

    if cleaned.startswith("#") or (numeric_only and 2 <= len(digits) <= 8):
        return {
            "kind": "order",
            "digits": digits,
            "order_query": f"(name:{digits}) OR (name:#{digits})",
        }
    if numeric_only and len(digits) >= 9:
        variants = details["variants"]
        return {
            "kind": "phone",
            "digits": digits,
            "normalized_phone": details["normalized_phone"],
            "customer_query": " OR ".join(f"(phone:{value})" for value in variants),
        }

    # Keep free-text support for customer names/emails while making phone and
    # order-number searches take the smallest, fastest API path.
    safe = cleaned.replace("\\", "\\\\").replace('"', '\\"')
    phrase = f'"{safe}"'
    return {
        "kind": "text",
        "digits": digits,
        "order_query": phrase,
        "customer_query": phrase,
    }


@router.get("/api/agent/search")
async def agent_search(
    store: str,
    q: str = "",
    user: User = Depends(get_current_user),
):
    """Fast order/customer lookup with explicit phone and order-number paths."""
    raw = (q or "").strip()
    if not raw or len(raw) < 2:
        return {
            "ok": True,
            "orders": [],
            "customers": [],
            "shop_domain": "",
            "query": raw,
            "search_kind": "empty",
        }

    search = _classify_confirmation_search(raw)
    from .main import shopify_graphql, resolve_store_settings_effective  # type: ignore

    orders_out: List[Dict[str, Any]] = []
    customers_out: List[Dict[str, Any]] = []
    warnings: List[str] = []

    async def _resolve_domain() -> str:
        try:
            domain, _token, _api = await resolve_store_settings_effective(store)
            return (domain or "").strip()
        except Exception:
            return ""

    async def _order_search(query: str, first: int = 25):
        return await shopify_graphql(
            SEARCH_ORDERS_GQL,
            {"first": first, "query": query},
            store=store,
        )

    async def _customer_search(
        query: str,
        *,
        first: int,
        orders_first: int,
    ):
        variables = {
            "first": max(1, min(5, first)),
            "ordersFirst": max(1, min(15, orders_first)),
            "query": query,
        }
        try:
            return await shopify_graphql(
                SEARCH_CUSTOMERS_GQL,
                variables,
                store=store,
            )
        except HTTPException as exc:
            # The query is deliberately below Shopify's normal max cost. Keep a
            # deterministic smaller retry so a future cost-model adjustment does
            # not turn a valid phone lookup into a user-facing 502.
            if "MAX_COST_EXCEEDED" not in str(getattr(exc, "detail", exc)):
                raise
            return await shopify_graphql(
                SEARCH_CUSTOMERS_GQL,
                {
                    "first": 1,
                    "ordersFirst": min(10, variables["ordersFirst"]),
                    "query": query,
                },
                store=store,
            )

    domain_task = asyncio.create_task(_resolve_domain())
    requested: List[Tuple[str, Any]] = []
    if search["kind"] == "phone":
        requested.append((
            "customers",
            _customer_search(
                search["customer_query"],
                first=3,
                orders_first=15,
            ),
        ))
    elif search["kind"] == "order":
        requested.append(("orders", _order_search(search["order_query"], first=8)))
    else:
        requested.extend([
            ("orders", _order_search(search["order_query"], first=25)),
            (
                "customers",
                _customer_search(
                    search["customer_query"],
                    first=5,
                    orders_first=10,
                ),
            ),
        ])

    responses = await asyncio.gather(
        *(task for _name, task in requested),
        return_exceptions=True,
    )
    successful = 0
    customer_order_nodes: List[Dict[str, Any]] = []
    direct_order_nodes: List[Dict[str, Any]] = []
    for (name, _task), result in zip(requested, responses):
        if isinstance(result, Exception):
            warnings.append(f"{name} lookup failed")
            logger.warning(
                "confirmation search %s lookup failed (store=%s kind=%s query=%r): %s",
                name, store, search["kind"], raw, result,
            )
            continue
        successful += 1
        if name == "orders":
            edges = ((result or {}).get("orders") or {}).get("edges") or []
            direct_order_nodes.extend((edge.get("node") or {}) for edge in edges)
            continue

        edges = ((result or {}).get("customers") or {}).get("edges") or []
        for edge in edges:
            node = edge.get("node") or {}
            addr = node.get("defaultAddress") or {}
            nested_edges = ((node.get("orders") or {}).get("edges")) or []
            nested_orders = [_flatten_order(e.get("node") or {}) for e in nested_edges]
            customer_order_nodes.extend(e.get("node") or {} for e in nested_edges)
            customers_out.append({
                "id": node.get("id"),
                "name": node.get("displayName") or " ".join(
                    x for x in [node.get("firstName"), node.get("lastName")] if x
                ) or "",
                "email": node.get("email") or "",
                "phone": node.get("phone") or "",
                "orders_count": int(node.get("numberOfOrders") or 0),
                "city": addr.get("city") or "",
                "country": addr.get("country") or "",
                "orders": nested_orders,
            })

    shop_domain = await domain_task
    if successful == 0:
        raise HTTPException(
            status_code=502,
            detail="Shopify search is temporarily unavailable; please retry",
        )

    # Customer-derived orders always come first. A pasted phone number becomes
    # immediately useful without requiring a second customer-card click.
    seen_order_ids = set()
    for node in [*customer_order_nodes, *direct_order_nodes]:
        oid = str(node.get("id") or "")
        if not oid or oid in seen_order_ids:
            continue
        seen_order_ids.add(oid)
        orders_out.append(_flatten_order(node))

    return {
        "ok": True,
        "query": raw,
        "search_kind": search["kind"],
        "normalized_digits": search.get("digits") or "",
        "normalized_phone": search.get("normalized_phone"),
        "orders": await enrich_web_confirmations(store, orders_out),
        "customers": customers_out,
        "shop_domain": shop_domain,
        "warnings": warnings,
    }


@router.get("/api/agent/customer-orders")
async def customer_orders(
    store: str,
    customer_id: str,
    first: int = 20,
    after: Optional[str] = None,
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
            {"id": cid, "first": max(1, min(50, int(first or 20))), "after": after or None},
            store=store,
        )
    except HTTPException as he:
        raise he
    customer = (data or {}).get("customer") or {}
    edges = ((customer.get("orders") or {}).get("edges") or [])
    page_info = (customer.get("orders") or {}).get("pageInfo") or {}
    # Full order shape (with line items + tags etc.) so the frontend can render the
    # same interactive card it uses for the queue and global search.
    orders_out: List[Dict[str, Any]] = [_flatten_order(e.get("node") or {}) for e in edges]
    return {
        "ok": True,
        "customer_id": customer.get("id") or cid,
        "display_name": customer.get("displayName") or "",
        "total_orders": int(customer.get("numberOfOrders") or 0),
        "orders": await enrich_web_confirmations(store, orders_out),
        "page_info": {
            "has_next_page": bool(page_info.get("hasNextPage")),
            "end_cursor": page_info.get("endCursor"),
        },
        "shop_domain": shop_domain,
    }


@router.get("/api/agent/phone-orders")
async def phone_orders(
    store: str, phone: str, first: int = 20, after: Optional[str] = None,
    user: User = Depends(get_current_user),
):
    """Exact order-phone history, including COD customers with no profile phone.

    Each read scans at most 1,000 lightweight orders, then loads full cards only
    for matches. The cursor lets an agent continue older history without an
    unbounded search or a heavy request on the purchase path.
    """
    details = _confirmation_phone_variants(phone)
    canonical = details['normalized_phone']
    if not canonical or not re.fullmatch(r'\+\d{8,15}', canonical):
        raise HTTPException(422, 'A valid phone number is required')
    from .main import shopify_graphql
    ids, cursor, has_more, scanned = [], after or None, False, 0
    size = max(1, min(20, first))
    for _ in range(4):
        key = (store, cursor)
        cached = _PHONE_SCAN_CACHE.get(key)
        if cached and cached[0] > time.monotonic():
            data = cached[1]
        else:
            data = await shopify_graphql(PHONE_SCAN_GQL, {'after': cursor}, store=store)
            if len(_PHONE_SCAN_CACHE) >= 64:
                _PHONE_SCAN_CACHE.clear()
            _PHONE_SCAN_CACHE[key] = (time.monotonic() + 60, data)
        connection = (data or {}).get('orders') or {}
        edges = connection.get('edges') or []
        info = connection.get('pageInfo') or {}
        has_more = bool(edges) and bool(info.get('hasNextPage'))
        for index, edge in enumerate(edges):
            scanned += 1
            node = edge.get('node') or {}
            if _confirmation_phone_variants(_gather_phone(node))['normalized_phone'] == canonical and re.fullmatch(r'gid://shopify/Order/\d+', str(node.get('id') or '')) and node['id'] not in ids:
                ids.append(node['id'])
            cursor = edge.get('cursor')
            has_more = index < len(edges) - 1 or bool(info.get('hasNextPage'))
            if len(ids) >= size:
                break
        if not edges or not has_more or len(ids) >= size:
            break
    data = await shopify_graphql(PHONE_ORDERS_GQL, {'ids': ids}, store=store) if ids else {}
    nodes = data.get('nodes') or []
    by_id = {node['id']: node for node in nodes if isinstance(node, dict) and node.get('id')}
    orders = [_flatten_order(by_id[oid]) for oid in ids if oid in by_id]
    orders = [order for order in orders if _confirmation_phone_variants(order['phone'])['normalized_phone'] == canonical]
    return {'ok': True, 'orders': await enrich_web_confirmations(store, orders), 'normalized_phone': canonical,
            'scanned_orders': scanned, 'page_info': {'has_next_page': has_more, 'end_cursor': cursor}}


# ---------- Edit Shopify order items and shipping ----------

PRODUCT_VARIANTS_SEARCH_GQL = """
query ConfirmationProductVariants($first: Int!, $query: String!) {
  productVariants(first: $first, query: $query, sortKey: RELEVANCE) {
    nodes {
      id
      title
      sku
      price
      inventoryQuantity
      selectedOptions { name value }
      image { url }
      product {
        id
        title
        featuredImage { url }
      }
    }
  }
}
"""

ORDER_EDIT_BEGIN_GQL = """
mutation ConfirmationOrderEditBegin($id: ID!) {
  orderEditBegin(id: $id) {
    calculatedOrder {
      id
      lineItems(first: 100) {
        nodes {
          id
          quantity
          editableQuantity
        }
      }
    }
    userErrors { field message }
  }
}
"""

ORDER_EDIT_SET_QUANTITY_GQL = """
mutation ConfirmationOrderEditSetQuantity(
  $id: ID!,
  $lineItemId: ID!,
  $quantity: Int!,
  $restock: Boolean
) {
  orderEditSetQuantity(
    id: $id,
    lineItemId: $lineItemId,
    quantity: $quantity,
    restock: $restock
  ) {
    calculatedLineItem { id quantity }
    userErrors { field message }
  }
}
"""

ORDER_EDIT_ADD_VARIANT_GQL = """
mutation ConfirmationOrderEditAddVariant(
  $id: ID!,
  $variantId: ID!,
  $quantity: Int!
) {
  orderEditAddVariant(
    id: $id,
    variantId: $variantId,
    quantity: $quantity,
    allowDuplicates: true
  ) {
    calculatedLineItem { id quantity }
    userErrors { field message }
  }
}
"""

ORDER_EDIT_COMMIT_GQL = f"""
mutation ConfirmationOrderEditCommit(
  $id: ID!,
  $notifyCustomer: Boolean,
  $staffNote: String
) {{
  orderEditCommit(
    id: $id,
    notifyCustomer: $notifyCustomer,
    staffNote: $staffNote
  ) {{
    order {{ {_ORDER_NODE_FIELDS} }}
    successMessages
    userErrors {{ field message }}
  }}
}}
"""

ORDER_SHIPPING_UPDATE_GQL = f"""
mutation ConfirmationOrderShippingUpdate($input: OrderInput!) {{
  orderUpdate(input: $input) {{
    order {{ {_ORDER_NODE_FIELDS} }}
    userErrors {{ field message }}
  }}
}}
"""


class OrderLineQuantityInput(BaseModel):
    line_item_id: str
    quantity: int


class OrderVariantAdditionInput(BaseModel):
    variant_id: str
    quantity: int = 1


class OrderItemsEditBody(BaseModel):
    store: str
    order_id: str
    items: List[OrderLineQuantityInput]
    additions: Optional[List[OrderVariantAdditionInput]] = None
    restock: bool = True
    notify_customer: bool = False
    staff_note: Optional[str] = None


class OrderShippingAddressInput(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    company: Optional[str] = None
    phone: Optional[str] = None
    address1: Optional[str] = None
    address2: Optional[str] = None
    city: Optional[str] = None
    province: Optional[str] = None
    zip: Optional[str] = None
    country: Optional[str] = None


class OrderShippingEditBody(BaseModel):
    store: str
    order_id: str
    shipping_address: OrderShippingAddressInput


def _mutation_payload_or_error(data: Dict[str, Any], key: str) -> Dict[str, Any]:
    payload = (data or {}).get(key) or {}
    errors = payload.get("userErrors") or []
    if errors:
        messages = []
        for error in errors:
            field = ".".join(str(x) for x in (error.get("field") or []) if x)
            message = str(error.get("message") or "Shopify rejected the change")
            messages.append(f"{field}: {message}" if field else message)
        raise HTTPException(status_code=422, detail="; ".join(messages))
    return payload


def _shopify_gid_resource_key(value: str) -> str:
    """Return the numeric/resource tail shared by LineItem and CalculatedLineItem GIDs."""
    return str(value or "").strip().rsplit("/", 1)[-1]


def _raise_clear_order_edit_error(error: HTTPException) -> None:
    detail = str(getattr(error, "detail", "") or "")
    upper = detail.upper()
    if "ACCESS_DENIED" in upper or "WRITE_ORDER_EDITS" in upper:
        raise HTTPException(
            status_code=403,
            detail=(
                "This store has not granted order-edit permission yet. "
                "Reconnect it from Shopify Connect, then try again."
            ),
        ) from error
    raise error


async def _audit_confirmation_order_change(
    db: AsyncSession,
    *,
    user: User,
    store: str,
    order_id: str,
    action: str,
    metadata: Dict[str, Any],
) -> None:
    """Best-effort audit entry; editing must not fail because audit storage is offline."""
    try:
        from .main import _normalize_store, _record_user_action  # type: ignore

        await _record_user_action(
            db,
            user_id=user.id,
            order_number=None,
            order_gid=order_id,
            store_key=_normalize_store(store),
            action=action,
            metadata={**metadata, "role": getattr(user, "role", None)},
        )
        await db.commit()
    except Exception:
        logger.exception(
            "confirmation order-change audit failed (order=%s action=%s user=%s)",
            order_id,
            action,
            getattr(user, "id", None),
        )
        try:
            await db.rollback()
        except Exception:
            pass


@router.get("/api/agent/product-variants/search")
async def search_product_variants(
    store: str,
    q: str,
    first: int = 20,
    _: User = Depends(get_current_user),
):
    query = (q or "").strip()
    if len(query) < 2:
        return {"ok": True, "variants": [], "query": query}

    from .main import shopify_graphql  # type: ignore

    data = await shopify_graphql(
        PRODUCT_VARIANTS_SEARCH_GQL,
        {"first": max(1, min(30, int(first or 20))), "query": query},
        store=(store or "").strip(),
    )
    nodes = ((data or {}).get("productVariants") or {}).get("nodes") or []
    variants = []
    for node in nodes:
        product = node.get("product") or {}
        image = (node.get("image") or {}).get("url") or (
            (product.get("featuredImage") or {}).get("url")
        )
        variants.append({
            "id": node.get("id") or "",
            "product_id": product.get("id") or "",
            "product_title": product.get("title") or "",
            "variant_title": node.get("title") or "",
            "options": node.get("selectedOptions") or [],
            "sku": node.get("sku") or "",
            "price": str(node.get("price") or "0"),
            "inventory_quantity": node.get("inventoryQuantity"),
            "image": image,
        })
    return {"ok": True, "variants": variants, "query": query}


@router.post("/api/agent/order-items/edit")
async def edit_order_items(
    body: OrderItemsEditBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    store = (body.store or "").strip()
    order_id = (body.order_id or "").strip()
    if not store or not order_id:
        raise HTTPException(status_code=400, detail="store and order_id are required")

    requested_quantities: Dict[str, int] = {}
    for item in body.items or []:
        line_id = (item.line_item_id or "").strip()
        if not line_id:
            raise HTTPException(status_code=400, detail="Every edited item needs a line_item_id")
        quantity = int(item.quantity)
        if quantity < 0 or quantity > 999:
            raise HTTPException(status_code=400, detail="Item quantity must be between 0 and 999")
        requested_quantities[line_id] = quantity

    requested_additions: Dict[str, int] = {}
    for addition in body.additions or []:
        variant_id = (addition.variant_id or "").strip()
        quantity = int(addition.quantity)
        if not variant_id:
            raise HTTPException(status_code=400, detail="Every added item needs a variant_id")
        if quantity < 1 or quantity > 999:
            raise HTTPException(status_code=400, detail="Added quantity must be between 1 and 999")
        requested_additions[variant_id] = min(
            999,
            requested_additions.get(variant_id, 0) + quantity,
        )

    if not requested_quantities and not requested_additions:
        raise HTTPException(status_code=400, detail="No item changes were provided")

    from .main import shopify_graphql  # type: ignore

    try:
        begin_data = await shopify_graphql(
            ORDER_EDIT_BEGIN_GQL,
            {"id": order_id},
            store=store,
        )
        begin = _mutation_payload_or_error(begin_data, "orderEditBegin")
        calculated_order = begin.get("calculatedOrder") or {}
        calculated_id = calculated_order.get("id")
        if not calculated_id:
            raise HTTPException(status_code=502, detail="Shopify did not start the order edit")

        line_map: Dict[str, Dict[str, Any]] = {}
        for line in ((calculated_order.get("lineItems") or {}).get("nodes") or []):
            calculated_line_id = str(line.get("id") or "")
            entry = {
                "calculated_id": calculated_line_id,
                "quantity": int(line.get("quantity") or 0),
                "editable_quantity": int(line.get("editableQuantity") or 0),
            }
            if calculated_line_id:
                line_map[calculated_line_id] = entry
                # Shopify represents an original Order LineItem and its edit-session
                # CalculatedLineItem with the same numeric resource key but a different
                # GID type. Index that stable key so the UI can send the order line ID
                # it already has without ever guessing a CalculatedLineItem GID.
                line_map[_shopify_gid_resource_key(calculated_line_id)] = entry

        changed_count = 0
        for requested_line_id, quantity in requested_quantities.items():
            mapped = line_map.get(requested_line_id) or line_map.get(
                _shopify_gid_resource_key(requested_line_id)
            )
            if not mapped:
                raise HTTPException(
                    status_code=409,
                    detail="An order item changed in Shopify. Refresh the order and try again.",
                )
            if quantity == mapped["quantity"]:
                continue
            set_data = await shopify_graphql(
                ORDER_EDIT_SET_QUANTITY_GQL,
                {
                    "id": calculated_id,
                    "lineItemId": mapped["calculated_id"],
                    "quantity": quantity,
                    "restock": bool(body.restock),
                },
                store=store,
            )
            _mutation_payload_or_error(set_data, "orderEditSetQuantity")
            changed_count += 1

        for variant_id, quantity in requested_additions.items():
            add_data = await shopify_graphql(
                ORDER_EDIT_ADD_VARIANT_GQL,
                {
                    "id": calculated_id,
                    "variantId": variant_id,
                    "quantity": quantity,
                },
                store=store,
            )
            _mutation_payload_or_error(add_data, "orderEditAddVariant")
            changed_count += 1

        if changed_count == 0:
            raise HTTPException(status_code=400, detail="No item quantities changed")

        staff_note = (body.staff_note or "").strip()
        if not staff_note:
            staff_note = f"Edited in confirmation app by {user.email}"
        commit_data = await shopify_graphql(
            ORDER_EDIT_COMMIT_GQL,
            {
                "id": calculated_id,
                "notifyCustomer": bool(body.notify_customer),
                "staffNote": staff_note[:255],
            },
            store=store,
        )
        committed = _mutation_payload_or_error(commit_data, "orderEditCommit")
    except HTTPException as error:
        _raise_clear_order_edit_error(error)

    order_node = committed.get("order") or {}
    if not order_node:
        raise HTTPException(status_code=502, detail="Shopify saved the edit but returned no order")
    flattened = _flatten_order(order_node)
    await _audit_confirmation_order_change(
        db,
        user=user,
        store=store,
        order_id=order_id,
        action="order_items_edit",
        metadata={
            "changed_lines": changed_count,
            "added_variants": len(requested_additions),
            "notify_customer": bool(body.notify_customer),
        },
    )
    return {
        "ok": True,
        "order": flattened,
        "success_messages": committed.get("successMessages") or [],
    }


@router.post("/api/agent/order-shipping/update")
async def update_order_shipping(
    body: OrderShippingEditBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    store = (body.store or "").strip()
    order_id = (body.order_id or "").strip()
    if not store or not order_id:
        raise HTTPException(status_code=400, detail="store and order_id are required")

    source = body.shipping_address
    address = {
        "firstName": (source.first_name or "").strip(),
        "lastName": (source.last_name or "").strip(),
        "company": (source.company or "").strip(),
        "phone": (source.phone or "").strip(),
        "address1": (source.address1 or "").strip(),
        "address2": (source.address2 or "").strip(),
        "city": (source.city or "").strip(),
        "province": (source.province or "").strip(),
        "zip": (source.zip or "").strip(),
        "country": (source.country or "").strip(),
    }

    from .main import shopify_graphql  # type: ignore

    try:
        data = await shopify_graphql(
            ORDER_SHIPPING_UPDATE_GQL,
            {"input": {"id": order_id, "shippingAddress": address}},
            store=store,
        )
        updated = _mutation_payload_or_error(data, "orderUpdate")
    except HTTPException as error:
        _raise_clear_order_edit_error(error)

    order_node = updated.get("order") or {}
    if not order_node:
        raise HTTPException(status_code=502, detail="Shopify saved the address but returned no order")
    flattened = _flatten_order(order_node)
    await _audit_confirmation_order_change(
        db,
        user=user,
        store=store,
        order_id=order_id,
        action="order_shipping_edit",
        metadata={"city": address["city"], "country": address["country"]},
    )
    return {"ok": True, "order": flattened}


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
                    "source": "confirmation",
                    "confirmation_actor": True,
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
                note_recent_tag_add(store, oid, [tag])
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
                    "source": "confirmation",
                    "confirmation_actor": True,
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

    # A bulk tag can move orders between queues (agent tags) or out of every queue
    # (cod tags), so no cached count survives it.
    if tagged:
        invalidate_all_breakdown_caches()

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
#
# Both flows can be narrowed to one current owner (``source_agent_id``: a specific
# agent, or PULL_SOURCE_UNASSIGNED), which is how orders move from one agent to
# another. An admin can also fill someone else's queue (``target_agent_id``).

_PULL_LEVEL_NEW = "new"
_PULL_LEVELS_SINGLE = {"n1", "n2", "n3", "n4"}
_PULL_LEVELS_GROUP = {"nowtp", "enatt"}
_PULL_VALID_LEVELS = {_PULL_LEVEL_NEW} | _PULL_LEVELS_SINGLE | _PULL_LEVELS_GROUP

# `source_agent_id` value meaning "only orders nobody owns".
PULL_SOURCE_UNASSIGNED = "__unassigned__"


class PullPlan(NamedTuple):
    """Everything a pull needs to know about its pool.

    - ``query``: Shopify search query for the pool (None = invalid level).
    - ``agent_tag_default``: first of the owner's tags (the tag the frontend
      proposes to apply; the execute body can pick another of the owner's tags).
    - ``other_agent_tags``: tags claimed by some OTHER active confirmation user.
    - ``strip_tags``: every tag belonging to anyone else (active or not), i.e.
      what execute takes *off* a pulled order so it ends up carrying exactly one
      agent tag: the owner's.
    - ``live_filter``: the same pool restated over live tags, to drop hits the
      lagging search index still returns.
    """
    query: Optional[str]
    agent_tag_default: str
    other_agent_tags: List[str]
    strip_tags: List[str]
    live_filter: LiveTagFilter


def _level_tag_group(lv: str) -> Tuple[str, ...]:
    if lv in _PULL_LEVELS_SINGLE:
        return (lv,)
    if lv == "nowtp":
        return _NOWTP_TAGS
    if lv == "enatt":
        return _ENATT_TAGS
    return ()


async def build_pull_query(
    db: AsyncSession,
    user: User,
    *,
    level: Optional[str],
    exclude_tags: Optional[List[str]] = None,
    include_assigned: bool = False,
    source_tags: Optional[List[str]] = None,
    source_unassigned: bool = False,
) -> PullPlan:
    """Build the Shopify search query for a pull into ``user``'s queue.

    ``user`` is the order's future owner — normally the puller, or the agent an
    admin is assigning to.

    ``include_assigned`` only affects "new": without it the pool is orders no
    other active agent owns. The level pools (n1…n4, nowtp, enatt) already reach
    into other agents' queues by design.

    ``source_tags`` narrows the pool to orders carrying one of those tags (one
    specific agent's orders — implies ``include_assigned``). ``source_unassigned``
    narrows it to orders carrying nobody else's tag at all.
    """
    lv = (level or _PULL_LEVEL_NEW).lower().strip()
    if lv not in _PULL_VALID_LEVELS:
        return PullPlan(None, "", [], [], LiveTagFilter())

    my_tags = list(user.agent_tags or [])
    other_active = await _other_agents_active_tags(db, exclude_user_id=user.id)
    strip_tags = await _other_agents_all_tags(db, exclude_user_id=user.id)
    source_tags = [t for t in (source_tags or []) if t]

    parts: List[str] = ["status:open", "fulfillment_status:unshipped", _COD_EXCLUSION]
    require: List[FrozenSet[str]] = []
    forbid = set(_lower_tags(my_tags)) | set(_lower_tags(exclude_tags))

    if lv == _PULL_LEVEL_NEW:
        # Unassigned pool: no other agent tag, no own tag. With include_assigned
        # (or a source agent) the other-agent exclusions drop away, so the pool
        # becomes "anything not already mine" — including orders sitting in
        # someone else's queue, which execute re-assigns by stripping their tag.
        if not (include_assigned or source_tags or source_unassigned):
            for t in other_active:
                parts.append(f"-tag:{_escape_tag(t)}")
            forbid |= _lower_tags(other_active)
    else:
        # Level-scoped pool. We do NOT exclude other agents' tags here — the
        # whole point is to be able to pull n1/n2/... orders that currently sit
        # in another agent's queue.
        group = _level_tag_group(lv)
        if len(group) == 1:
            parts.append(f"tag:{_escape_tag(group[0])}")
        else:
            parts.append("(" + " OR ".join(f"tag:{_escape_tag(t)}" for t in group) + ")")
        require.append(frozenset(group))

    if source_unassigned:
        # Nobody's order: carries no tag of any other user, active or not.
        for t in strip_tags:
            parts.append(f"-tag:{_escape_tag(t)}")
        forbid |= _lower_tags(strip_tags)
    elif source_tags:
        parts.append("(" + " OR ".join(f"tag:{_escape_tag(t)}" for t in source_tags) + ")")
        require.append(_lower_tags(source_tags))

    # Free-form extra exclusions if the agent wants them.
    for t in (exclude_tags or []):
        if t:
            parts.append(f"-tag:{_escape_tag(t)}")

    # Always keep orders already in the owner's queue out of the pull pool.
    for t in my_tags:
        if t:
            parts.append(f"-tag:{_escape_tag(t)}")

    return PullPlan(
        " ".join(parts),
        my_tags[0] if my_tags else "",
        other_active,
        strip_tags,
        LiveTagFilter(require=tuple(require), forbid=frozenset(forbid)),
    )


class PoolScan(NamedTuple):
    total: int
    orders: List[Dict[str, Any]]
    # How many orders carry one of the ``assigned_tags`` (someone else owns them).
    assigned_total: int
    # owner user id -> how many pool orders carry one of that user's tags.
    by_owner: Dict[str, int]


async def _scan_pull_pool(
    *,
    store: str,
    query: str,
    limit: int,
    collect_orders: bool,
    assigned_tags: Optional[List[str]] = None,
    live_filter: Optional[LiveTagFilter] = None,
    owner_of_tag: Optional[Dict[str, str]] = None,
) -> PoolScan:
    """Walk Shopify pages for ``query``, dropping cod-tagged stragglers in Python
    (Shopify's tag-wildcard exclusion can't match multi-word ``cod dd/mm/yy``)
    and hits whose live tags no longer match ``live_filter``.

    ``orders`` is up to ``limit`` ``{id, tags}`` dicts when ``collect_orders`` is
    True (used by execute) and empty otherwise (preview only needs the counts).
    """
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
    total = 0
    assigned_total = 0
    by_owner: Dict[str, int] = {}
    out: List[Dict[str, Any]] = []
    assigned_lower = _lower_tags(assigned_tags)
    owner_of_tag = owner_of_tag or {}
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
            if live_filter is not None and not live_filter.matches(tags_list):
                continue
            total += 1
            tl = _lower_tags(tags_list)
            if assigned_lower and (tl & assigned_lower):
                assigned_total += 1
            for owner_id in {owner_of_tag[t] for t in tl if t in owner_of_tag}:
                by_owner[owner_id] = by_owner.get(owner_id, 0) + 1
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
    return PoolScan(total, out, assigned_total, by_owner)


async def _tag_owners(db: AsyncSession, exclude_user_id: Optional[str]) -> Tuple[Dict[str, str], Dict[str, User]]:
    """Map each lowercased agent tag to the user who owns it (active users win
    when two users share a tag), skipping ``exclude_user_id``."""
    res = await db.execute(select(User))
    users = [
        u for u in res.scalars().all()
        if (u.agent_tags or []) and u.id != exclude_user_id
    ]
    users.sort(key=lambda u: (not bool(u.is_active), str(u.created_at or ""), u.id))
    owner_of_tag: Dict[str, str] = {}
    for u in users:
        for t in _lower_tags(u.agent_tags):
            owner_of_tag.setdefault(t, u.id)
    return owner_of_tag, {u.id: u for u in users}


async def _resolve_pull_owner(db: AsyncSession, user: User, target_agent_id: Optional[str]) -> User:
    """Whose queue the pull fills: the caller's, or — for admins — another agent's."""
    tid = (target_agent_id or "").strip()
    if not tid or tid == user.id:
        return user
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="only an admin can assign orders to another agent")
    target = await db.get(User, tid)
    if target is None or not target.is_active:
        raise HTTPException(status_code=404, detail="target agent not found")
    if not (target.agent_tags or []):
        raise HTTPException(status_code=400, detail="that agent has no tag yet; give them one in /admin first")
    return target


async def _resolve_pull_source(
    db: AsyncSession, owner: User, source_agent_id: Optional[str],
) -> Tuple[Optional[List[str]], bool]:
    """``(source_tags, source_unassigned)`` for a ``source_agent_id``."""
    sid = (source_agent_id or "").strip()
    if not sid:
        return None, False
    if sid == PULL_SOURCE_UNASSIGNED:
        return None, True
    if sid == owner.id:
        raise HTTPException(status_code=400, detail="those orders are already in this queue")
    source = await db.get(User, sid)
    tags = list((source.agent_tags if source else None) or [])
    if not tags:
        raise HTTPException(status_code=404, detail="source agent has no tagged orders")
    return tags, False


def _agent_summary(u: User, count: int) -> Dict[str, Any]:
    return {
        "id": u.id,
        "name": u.name,
        "email": u.email,
        "tags": list(u.agent_tags or []),
        "is_active": bool(u.is_active),
        "count": int(count),
    }


class PullPreviewBody(BaseModel):
    store: str
    level: Optional[str] = None          # "new" | "n1".."n4" | "nowtp" | "enatt"
    exclude_tags: Optional[List[str]] = None
    include_assigned: bool = False       # "new" mode: also show other agents' orders
    source_agent_id: Optional[str] = None  # only this agent's orders (or PULL_SOURCE_UNASSIGNED)
    target_agent_id: Optional[str] = None  # admin: fill this agent's queue instead of mine


@router.post("/api/agent/pull/preview")
async def pull_preview(
    body: PullPreviewBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Count how many orders could be pulled right now under the given filters,
    plus who currently owns them. Cheap to call — used to populate the pull
    modal as the agent edits the filters."""
    store = (body.store or "").strip()
    if not store:
        raise HTTPException(status_code=400, detail="store is required")
    owner = await _resolve_pull_owner(db, user, body.target_agent_id)
    source_tags, source_unassigned = await _resolve_pull_source(db, owner, body.source_agent_id)
    source_id = (body.source_agent_id or "").strip()
    # Scan the pool WITHOUT the source narrowing so every owner's chip keeps its
    # count while one of them is selected; the selected count is derived below.
    plan = await build_pull_query(
        db, owner,
        level=body.level,
        exclude_tags=body.exclude_tags,
        include_assigned=body.include_assigned or bool(source_id),
    )
    if not plan.query:
        raise HTTPException(status_code=400, detail=f"invalid level: {body.level!r}")
    owner_of_tag, users_by_id = await _tag_owners(db, exclude_user_id=owner.id)
    scan = await _scan_pull_pool(
        store=store, query=plan.query, limit=0, collect_orders=False,
        assigned_tags=plan.strip_tags, live_filter=plan.live_filter,
        owner_of_tag=owner_of_tag,
    )
    unassigned = max(0, scan.total - scan.assigned_total)
    if source_unassigned:
        available, assigned_available = unassigned, 0
    elif source_tags:
        available = assigned_available = int(scan.by_owner.get(source_id, 0))
    else:
        available, assigned_available = scan.total, scan.assigned_total

    by_agent = sorted(
        (
            _agent_summary(users_by_id[uid], n)
            for uid, n in scan.by_owner.items() if uid in users_by_id
        ),
        key=lambda a: (-a["count"], (a["name"] or a["email"] or "").lower()),
    )
    return {
        "ok": True,
        "store": store,
        "level": (body.level or _PULL_LEVEL_NEW).lower().strip(),
        "exclude_tags": [t for t in (body.exclude_tags or []) if t],
        "include_assigned": bool(body.include_assigned),
        "source_agent_id": source_id or None,
        "target_agent_id": owner.id,
        "available": int(available),
        # How many of `available` would be taken off another agent.
        "assigned_available": int(assigned_available),
        # Whole pool, split by current owner (independent of source_agent_id).
        "pool_total": int(scan.total),
        "unassigned_available": int(unassigned),
        "by_agent": by_agent,
        "agent_tag": plan.agent_tag_default,
        "agent_tags": list(owner.agent_tags or []),
        "other_agent_tags": plan.other_agent_tags,
    }


class PullExecuteBody(BaseModel):
    store: str
    level: Optional[str] = None
    exclude_tags: Optional[List[str]] = None
    limit: Optional[int] = None          # how many to pull; 0 / None = take everything
    agent_tag: Optional[str] = None      # which of the owner's tags to apply
    include_assigned: bool = False       # "new" mode: also claim other agents' orders
    source_agent_id: Optional[str] = None  # only take this agent's orders (or PULL_SOURCE_UNASSIGNED)
    target_agent_id: Optional[str] = None  # admin: move the orders to this agent


_PULL_HARD_CAP = 2000


@router.post("/api/agent/pull/execute")
async def pull_execute(
    body: PullExecuteBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Claim up to ``limit`` orders into the caller's queue (or, for an admin,
    into ``target_agent_id``'s queue).

    For every order pulled we:
      - Add the owner's tag (defaults to the first of their assigned tags;
        ``agent_tag`` body field can override, but must be one the owner has).
      - Remove every OTHER agent's tag that's currently on the order — active or
        not. That's what makes the assignment exclusive — Laila's "laila" tag,
        ndcon's "ndcon" tag, etc. all come off so the order shows up only in the
        owner's queue, and an order never carries two agent tags at once.
    """
    store = (body.store or "").strip()
    if not store:
        raise HTTPException(status_code=400, detail="store is required")

    owner = await _resolve_pull_owner(db, user, body.target_agent_id)
    source_tags, source_unassigned = await _resolve_pull_source(db, owner, body.source_agent_id)
    plan = await build_pull_query(
        db, owner,
        level=body.level,
        exclude_tags=body.exclude_tags,
        include_assigned=body.include_assigned,
        source_tags=source_tags,
        source_unassigned=source_unassigned,
    )
    if not plan.query:
        raise HTTPException(status_code=400, detail=f"invalid level: {body.level!r}")

    my_tags = list(owner.agent_tags or [])
    chosen_tag = (body.agent_tag or plan.agent_tag_default or "").strip()
    if not chosen_tag:
        raise HTTPException(
            status_code=400,
            detail="no agent tag available; ask admin to assign at least one tag to your account",
        )
    if my_tags and chosen_tag.lower() not in _lower_tags(my_tags):
        raise HTTPException(status_code=400, detail="agent_tag must be one of the agent's assigned tags")

    # Never strip a tag we're about to apply, nor any of the owner's own tags:
    # if "chosen_tag" overlaps with somebody else's claimed tag (shouldn't happen
    # in a well-configured roster, but be defensive) the order still has to end up
    # tagged for this pull.
    keep_lower = {chosen_tag.lower()} | set(_lower_tags(my_tags))
    strip_tags = [t for t in plan.strip_tags if (t or "").lower() not in keep_lower]
    strip_lower = _lower_tags(strip_tags)

    # Resolve how many to take.
    raw_limit = int(body.limit or 0)
    if raw_limit <= 0:
        target = _PULL_HARD_CAP
    else:
        target = min(raw_limit, _PULL_HARD_CAP)

    level_norm = (body.level or _PULL_LEVEL_NEW).lower().strip()
    scan = await _scan_pull_pool(
        store=store, query=plan.query, limit=target, collect_orders=True,
        assigned_tags=strip_tags, live_filter=plan.live_filter,
    )
    candidates = scan.orders
    if not candidates:
        return {
            "ok": True, "pulled": 0, "audited": 0,
            "requested": raw_limit, "available_seen": 0,
            "agent_tag": chosen_tag, "store": store,
            "level": level_norm, "target_agent_id": owner.id,
            "order_ids": [], "reassigned": 0, "reassign_failed": 0,
        }

    from .main import (  # type: ignore
        _shopify_add_tag,
        _shopify_remove_tag,
        _record_user_action,
        _normalize_store,
        _already_logged_today,
    )

    sem = asyncio.Semaphore(_BULK_CONCURRENCY)

    async def _claim_one(item: Dict[str, Any]) -> Optional[Tuple[str, List[str], List[str]]]:
        """Tag one order for the owner and take every other agent's tag off it.

        Returns ``(order_gid, removed, stuck)`` — ``stuck`` being other agents'
        tags Shopify refused to remove, which would leave the order double-owned.
        """
        async with sem:
            oid = item["id"]
            try:
                await _shopify_add_tag(oid, chosen_tag, store)
            except Exception:
                logger.exception("pull add-tag failed (order=%s tag=%s)", oid, chosen_tag)
                return None
            note_recent_tag_add(store, oid, [chosen_tag])
            # Strip the other agents' tags so this order becomes exclusively the owner's.
            removed: List[str] = []
            stuck: List[str] = []
            for t in (item.get("tags") or []):
                tl = str(t or "").strip().lower()
                if tl and tl in strip_lower:
                    try:
                        await _shopify_remove_tag(oid, t, store)
                        removed.append(t)
                    except Exception:
                        logger.exception("pull remove-tag failed (order=%s tag=%s)", oid, t)
                        stuck.append(t)
            return oid, removed, stuck

    results = await asyncio.gather(*[_claim_one(it) for it in candidates])
    claims = [r for r in results if r]
    pulled_ids = [oid for oid, _removed, _stuck in claims]
    removed_by_order = {oid: removed for oid, removed, _stuck in claims}
    # Orders that kept somebody else's tag because the removal call failed. They
    # now carry two agent tags, so surface them instead of swallowing the log line.
    stuck_orders = {oid: stuck for oid, _removed, stuck in claims if stuck}
    reassigned = sum(1 for _oid, removed, _stuck in claims if removed)

    # Audit log each successful pull. The event belongs to the order's new owner
    # (intake analytics follow it); an admin assignment records who did it.
    store_key_norm = _normalize_store(store)
    audited = 0
    for oid in pulled_ids:
        try:
            if await _already_logged_today(
                db,
                user_id=owner.id,
                order_gid=oid,
                store_key=store_key_norm,
                action="confirmation_pulled",
            ):
                continue
            metadata = {
                "tag": chosen_tag,
                "level": level_norm,
                "exclude_tags": [t for t in (body.exclude_tags or []) if t],
                "include_assigned": bool(body.include_assigned),
                "removed_other_agent_tags": removed_by_order.get(oid, []),
                "role": getattr(owner, "role", None),
                "source": "confirmation",
                "confirmation_actor": True,
            }
            if body.source_agent_id:
                metadata["source_agent_id"] = body.source_agent_id
            if owner.id != user.id:
                metadata["assigned_by"] = user.id
            await _record_user_action(
                db,
                user_id=owner.id,
                order_number=None,
                order_gid=oid,
                store_key=store_key_norm,
                action="confirmation_pulled",
                metadata=metadata,
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
        "target_agent_id": owner.id,
        "pulled": len(pulled_ids),
        "order_ids": pulled_ids,
        "audited": audited,
        "requested": raw_limit,
        "available_seen": len(candidates),
        "include_assigned": bool(body.include_assigned),
        # How many of the pulled orders were taken off another agent.
        "reassigned": reassigned,
        "reassign_failed": len(stuck_orders),
    }


# ---------- Agent team stats (confirmed today across team) ----------

async def _team_stats_uncached(
    store: Optional[str],  # accepted for backwards compatibility, but ignored
    user: User,
    db: AsyncSession,
):
    """Per-agent breakdown aggregated across EVERY connected store, plus confirmed-today
    from the audit log (which is already cross-store). The `store` query param is kept
    for backwards compatibility but no longer scopes the output."""
    today_label = today_cod_label()

    tz = _tz()
    today_local = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_local = today_local + timedelta(days=1)
    today_utc = today_local.astimezone(timezone.utc)
    tomorrow_utc = tomorrow_local.astimezone(timezone.utc)

    # Keep configured agents visible, and also include any active user who has
    # genuinely acted from the Confirmation page today. This matches the page's
    # long-standing rule that any signed-in staff member can help with an order,
    # while preventing a role misconfiguration from losing the click or counter.
    actor_ids = select(OrderEvent.user_id).where(
        or_(
            _confirmation_metric_action_predicate(),
            OrderEvent.action == "confirmation_pulled",
        ),
        _confirmation_actor_predicate(),
        OrderEvent.created_at >= today_utc,
        OrderEvent.created_at < tomorrow_utc,
    ).distinct()
    res = await db.execute(
        select(User)
        .where(
            User.is_active == True,  # noqa: E712
            or_(User.role == "agent", User.id.in_(actor_ids)),
        )
        .order_by(User.name.asc(), User.email.asc())
    )
    agents = res.scalars().all()
    if not agents:
        return {"ok": True, "agents": [], "today_label": today_label, "stores": []}

    # ----- Confirmed today (audit log) -----
    # An agent's confirmed_today is the number of distinct orders they marked Confirmed
    # today in the app timezone, regardless of which delivery date they chose OR which
    # store the order belongs to. The OrderEvent query does not constrain by store_key
    # so the result is already cross-store.
    agent_ids = [a.id for a in agents]
    confirmed_map: Dict[str, int] = {a.id: 0 for a in agents}
    if agent_ids:
        rows = await db.execute(
            select(OrderEvent.user_id, func.count(OrderEvent.id))
            .where(
                OrderEvent.action == "confirmation_confirmed",
                OrderEvent.user_id.in_(agent_ids),
                func.coalesce(OrderEvent.event_metadata["op"].as_string(), "") != "remove",
                _confirmation_actor_predicate(),
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
    filters_by_agent: Dict[str, LiveTagFilter] = {}
    for a in agents:
        queries_by_agent[a.id] = await query_for_user(db, a)
        filters_by_agent[a.id] = await queue_filter_for_user(db, a)

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
                bd = await accurate_assigned_breakdown(
                    store_key, agent_id, q, filters_by_agent.get(agent_id),
                )
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


@router.get("/api/agent/team-stats")
async def team_stats(
    store: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Return shared team stats while coalescing polling bursts across open tabs."""
    global _TEAM_STATS_CACHE
    now = time.time()
    cached = _TEAM_STATS_CACHE
    if cached and (now - cached[0]) < _TEAM_STATS_CACHE_SECONDS:
        return cached[1]

    async with _TEAM_STATS_LOCK:
        now = time.time()
        cached = _TEAM_STATS_CACHE
        if cached and (now - cached[0]) < _TEAM_STATS_CACHE_SECONDS:
            return cached[1]
        generation = _BREAKDOWN_CACHE_GENERATION
        payload = await _team_stats_uncached(store=store, user=user, db=db)
        if generation == _BREAKDOWN_CACHE_GENERATION:
            _TEAM_STATS_CACHE = (time.time(), payload)
        return payload


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


_INTAKE_LEVELS = ("new", "n1", "n2", "n3", "n4", "nowtp", "enatt")
_INTAKE_NEXT_STAGE = {
    "new": ("n1", "confirmation_phone_n1"),
    "n1": ("n2", "confirmation_phone_n2"),
    "n2": ("n3", "confirmation_phone_n3"),
    "n3": ("n4", "confirmation_phone_n4"),
}


def _empty_intake_bucket(level: str) -> Dict[str, Any]:
    next_stage = (_INTAKE_NEXT_STAGE.get(level) or (None, None))[0]
    return {
        "level": level,
        "taken": 0,
        "confirmed": 0,
        "cancelled": 0,
        "open": 0,
        "advanced": 0,
        "advanced_to": next_stage,
        "confirmation_rate": 0.0,
        "resolution_rate": 0.0,
        "advanced_rate": 0.0,
    }


def _finalize_intake_bucket(bucket: Dict[str, Any]) -> Dict[str, Any]:
    taken = int(bucket.get("taken") or 0)
    confirmed = int(bucket.get("confirmed") or 0)
    cancelled = int(bucket.get("cancelled") or 0)
    advanced = int(bucket.get("advanced") or 0)
    bucket["open"] = max(0, taken - confirmed - cancelled)
    bucket["confirmation_rate"] = round((confirmed / taken) * 100, 1) if taken else 0.0
    bucket["resolution_rate"] = (
        round(((confirmed + cancelled) / taken) * 100, 1) if taken else 0.0
    )
    bucket["advanced_rate"] = round((advanced / taken) * 100, 1) if taken else 0.0
    return bucket


def _aggregate_intake_cohorts(
    pulls: List[Dict[str, Any]],
    followups: List[Dict[str, Any]],
    agent_ids: List[str],
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
    """Attribute later actions to the most recent matching Get-more-orders intake.

    Ownership follows the intake event, not the person who later clicked the
    outcome. If another agent explicitly re-pulls the order, that newer intake
    owns subsequent progress.
    """
    by_user: Dict[str, Dict[str, Any]] = {
        uid: {
            "total_taken": 0,
            "confirmed": 0,
            "cancelled": 0,
            "open": 0,
            "confirmation_rate": 0.0,
            "cohorts": {level: _empty_intake_bucket(level) for level in _INTAKE_LEVELS},
        }
        for uid in agent_ids
    }
    records: Dict[int, Dict[str, Any]] = {}
    timeline: Dict[Tuple[str, str], List[Tuple[Any, int, int, Dict[str, Any]]]] = {}

    for pull in pulls:
        uid = str(pull.get("user_id") or "")
        order_gid = str(pull.get("order_gid") or "")
        store_key = str(pull.get("store_key") or "")
        pull_id = int(pull.get("id") or 0)
        if uid not in by_user or not order_gid or not pull_id:
            continue
        level = str(pull.get("level") or "new").strip().lower()
        if level not in _INTAKE_LEVELS:
            level = "new"
        record = {
            "id": pull_id,
            "user_id": uid,
            "level": level,
            "terminal": None,
            "advanced": False,
        }
        records[pull_id] = record
        key = (store_key, order_gid)
        timeline.setdefault(key, []).append(
            (pull.get("created_at"), pull_id, 0, {"kind": "pull", "pull_id": pull_id})
        )

    for event in followups:
        uid = str(event.get("user_id") or "")
        order_gid = str(event.get("order_gid") or "")
        store_key = str(event.get("store_key") or "")
        event_id = int(event.get("id") or 0)
        if uid not in by_user or not order_gid or not event_id:
            continue
        key = (store_key, order_gid)
        if key not in timeline:
            continue
        timeline[key].append(
            (
                event.get("created_at"),
                event_id,
                1,
                {"kind": "action", "action": str(event.get("action") or "")},
            )
        )

    for events in timeline.values():
        events.sort(key=lambda item: (item[0], item[1], item[2]))
        current: Optional[Dict[str, Any]] = None
        for _created_at, _event_id, _kind_order, item in events:
            if item["kind"] == "pull":
                current = records.get(int(item["pull_id"]))
                continue
            if current is None:
                continue
            action = item["action"]
            if action == "confirmation_confirmed":
                current["terminal"] = "confirmed"
            elif action == "confirmation_cancelled":
                current["terminal"] = "cancelled"
            next_action = (_INTAKE_NEXT_STAGE.get(current["level"]) or (None, None))[1]
            if next_action and action == next_action:
                current["advanced"] = True

    for record in records.values():
        user_bucket = by_user[record["user_id"]]
        cohort = user_bucket["cohorts"][record["level"]]
        user_bucket["total_taken"] += 1
        cohort["taken"] += 1
        if record["terminal"] == "confirmed":
            user_bucket["confirmed"] += 1
            cohort["confirmed"] += 1
        elif record["terminal"] == "cancelled":
            user_bucket["cancelled"] += 1
            cohort["cancelled"] += 1
        if record["advanced"]:
            cohort["advanced"] += 1

    summary: Dict[str, Any] = {
        "total_taken": 0,
        "confirmed": 0,
        "cancelled": 0,
        "open": 0,
        "confirmation_rate": 0.0,
        "cohorts": {level: _empty_intake_bucket(level) for level in _INTAKE_LEVELS},
    }
    for user_bucket in by_user.values():
        user_bucket["open"] = max(
            0,
            int(user_bucket["total_taken"])
            - int(user_bucket["confirmed"])
            - int(user_bucket["cancelled"]),
        )
        user_bucket["confirmation_rate"] = (
            round((user_bucket["confirmed"] / user_bucket["total_taken"]) * 100, 1)
            if user_bucket["total_taken"]
            else 0.0
        )
        summary["total_taken"] += user_bucket["total_taken"]
        summary["confirmed"] += user_bucket["confirmed"]
        summary["cancelled"] += user_bucket["cancelled"]
        for level in _INTAKE_LEVELS:
            source = _finalize_intake_bucket(user_bucket["cohorts"][level])
            target = summary["cohorts"][level]
            for key in ("taken", "confirmed", "cancelled", "advanced"):
                target[key] += int(source.get(key) or 0)

    summary["open"] = max(
        0, summary["total_taken"] - summary["confirmed"] - summary["cancelled"]
    )
    summary["confirmation_rate"] = (
        round((summary["confirmed"] / summary["total_taken"]) * 100, 1)
        if summary["total_taken"]
        else 0.0
    )
    for level in _INTAKE_LEVELS:
        _finalize_intake_bucket(summary["cohorts"][level])
    return by_user, summary


@router.get("/api/admin/confirmation-stats")
async def admin_confirmation_stats(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    store: Optional[str] = None,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    """Per-user counts of genuine Confirmation-page actions in a date range."""
    from_dt = _parse_date_bound(from_date, end=False)
    to_dt = _parse_date_bound(to_date, end=True)
    if from_dt is None:
        # Default: last 7 days inclusive.
        today_local = datetime.now(_tz()).replace(hour=0, minute=0, second=0, microsecond=0)
        from_dt = (today_local - timedelta(days=6)).astimezone(timezone.utc)
    if to_dt is None:
        today_local = datetime.now(_tz()).replace(hour=0, minute=0, second=0, microsecond=0)
        to_dt = (today_local + timedelta(days=1)).astimezone(timezone.utc)

    relevant_action = _confirmation_metric_action_predicate()
    actor_ids = select(OrderEvent.user_id).where(
        OrderEvent.created_at >= from_dt,
        OrderEvent.created_at < to_dt,
        or_(relevant_action, OrderEvent.action == "confirmation_pulled"),
        _confirmation_actor_predicate(),
    ).distinct()

    # Configured agents stay visible with zero activity. Staff who actually used
    # the Confirmation page also appear even if their role was configured
    # incorrectly, so their successful clicks are never hidden from analytics.
    agent_res = await db.execute(
        select(User)
        .where(
            User.is_active == True,  # noqa: E712
            or_(User.role == "agent", User.id.in_(actor_ids)),
        )
        .order_by(User.name.asc(), User.email.asc())
    )
    agents = agent_res.scalars().all()
    agent_ids = [a.id for a in agents]

    metadata_op = func.coalesce(OrderEvent.event_metadata["op"].as_string(), "")
    conds = [
        OrderEvent.created_at >= from_dt,
        OrderEvent.created_at < to_dt,
        relevant_action,
        metadata_op != "remove",
        _confirmation_actor_predicate(),
    ]
    if agent_ids:
        conds.append(OrderEvent.user_id.in_(agent_ids))
    else:
        # Avoid scanning/aggregating unrelated events when no confirmation team exists.
        conds.append(OrderEvent.user_id.in_([]))
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
            func.count(func.distinct(OrderEvent.order_gid)).label("orders_touched"),
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
            "orders_touched": int(m["orders_touched"] or 0),
        }

    # Anchor the report to the intake date, then follow those orders through the
    # present. This answers "what happened to the orders taken in this range?"
    pull_conds = [
        OrderEvent.action == "confirmation_pulled",
        OrderEvent.created_at >= from_dt,
        OrderEvent.created_at < to_dt,
    ]
    if agent_ids:
        pull_conds.append(OrderEvent.user_id.in_(agent_ids))
    else:
        pull_conds.append(OrderEvent.user_id.in_([]))
    if store_key and store_key != "all":
        pull_conds.append(OrderEvent.store_key == store_key)
    pull_res = await db.execute(
        select(
            OrderEvent.id,
            OrderEvent.user_id,
            OrderEvent.order_gid,
            OrderEvent.store_key,
            OrderEvent.created_at,
            OrderEvent.event_metadata,
        )
        .where(*pull_conds)
        .order_by(OrderEvent.created_at.asc(), OrderEvent.id.asc())
    )
    pulls: List[Dict[str, Any]] = []
    for row in pull_res.all():
        m = row._mapping
        metadata = m["event_metadata"] or {}
        pulls.append(
            {
                "id": m["id"],
                "user_id": m["user_id"],
                "order_gid": m["order_gid"],
                "store_key": m["store_key"],
                "created_at": m["created_at"],
                "level": metadata.get("level") or "new",
            }
        )

    followups: List[Dict[str, Any]] = []
    if pulls:
        earliest_pull = min(p["created_at"] for p in pulls)
        followup_conds = [
            OrderEvent.created_at >= earliest_pull,
            OrderEvent.action.in_(
                (
                    "confirmation_phone_n1",
                    "confirmation_phone_n2",
                    "confirmation_phone_n3",
                    "confirmation_phone_n4",
                    "confirmation_confirmed",
                    "confirmation_cancelled",
                )
            ),
            metadata_op != "remove",
            _confirmation_actor_predicate(),
            OrderEvent.user_id.in_(agent_ids),
        ]
        if store_key and store_key != "all":
            followup_conds.append(OrderEvent.store_key == store_key)
        followup_res = await db.execute(
            select(
                OrderEvent.id,
                OrderEvent.user_id,
                OrderEvent.order_gid,
                OrderEvent.store_key,
                OrderEvent.action,
                OrderEvent.created_at,
            )
            .where(*followup_conds)
            .order_by(OrderEvent.created_at.asc(), OrderEvent.id.asc())
        )
        followups = [dict(row._mapping) for row in followup_res.all()]

    intake_by_user, intake_summary = _aggregate_intake_cohorts(
        pulls, followups, agent_ids
    )

    rows: List[Dict[str, Any]] = []
    summary = {
        "n1": 0,
        "n2": 0,
        "n3": 0,
        "n4": 0,
        "nowtp": 0,
        "enatt": 0,
        "confirmed": 0,
        "cancelled": 0,
        "contact_attempts": 0,
        "outcomes": 0,
        "orders_touched": 0,
        "total_actions": 0,
        # Backwards-compatible alias for older clients.
        "total_attempts": 0,
    }
    for agent in agents:
        uid = agent.id
        counts = by_user.get(
            uid,
            {
                "n1": 0,
                "n2": 0,
                "n3": 0,
                "n4": 0,
                "nowtp": 0,
                "enatt": 0,
                "confirmed": 0,
                "cancelled": 0,
                "orders_touched": 0,
            },
        )
        contact_attempts = sum(counts[k] for k in ("n1", "n2", "n3", "n4", "nowtp", "enatt"))
        outcomes = counts["confirmed"] + counts["cancelled"]
        total_actions = contact_attempts + outcomes
        confirmation_rate = round((counts["confirmed"] / outcomes) * 100, 1) if outcomes else 0.0
        rows.append({
            "user_id": uid,
            "email": agent.email or "",
            "name": agent.name or "",
            "role": agent.role or "",
            "tags": list(agent.agent_tags or []),
            **counts,
            "contact_attempts": contact_attempts,
            "outcomes": outcomes,
            "confirmation_rate": confirmation_rate,
            "total_actions": total_actions,
            "total_attempts": total_actions,
            "intake": intake_by_user.get(uid),
        })
        for key in ("n1", "n2", "n3", "n4", "nowtp", "enatt", "confirmed", "cancelled", "orders_touched"):
            summary[key] += counts.get(key, 0)
        summary["contact_attempts"] += contact_attempts
        summary["outcomes"] += outcomes
        summary["total_actions"] += total_actions
        summary["total_attempts"] += total_actions

    summary["confirmation_rate"] = (
        round((summary["confirmed"] / summary["outcomes"]) * 100, 1)
        if summary["outcomes"]
        else 0.0
    )

    # Stable productivity order while keeping zero-activity team members visible.
    rows.sort(
        key=lambda r: (
            -(r.get("total_actions") or 0),
            -(r.get("confirmed") or 0),
            r.get("email") or "",
        )
    )

    return {
        "ok": True,
        "from_date": from_date or from_dt.date().isoformat(),
        "to_date": to_date or (to_dt - timedelta(days=1)).date().isoformat(),
        "store": store_key or "all",
        "rows": rows,
        "summary": summary,
        "intake_summary": intake_summary,
        "intake_definition": {
            "date_scope": "taken_at",
            "outcomes_followed_through": datetime.now(timezone.utc).isoformat(),
            "levels": list(_INTAKE_LEVELS),
        },
    }
