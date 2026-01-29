import os
import json
from typing import List, Optional, Dict, Any, Tuple
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, Header, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
import httpx
import hmac, hashlib, base64
from datetime import datetime, timezone, timedelta
import requests as _requests
from pydantic import BaseModel
import random
from functools import lru_cache
from io import BytesIO
import qrcode
from qrcode.constants import ERROR_CORRECT_M
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, case
from sqlalchemy.exc import IntegrityError

# Local auth/db modules (optional)
HAVE_AUTH_DB = True
try:
    from .db import get_session, init_db, SessionLocal
    from .models import User, OrderEvent, DailyUserStats, AppSetting
    from .auth_routes import router as auth_router, get_current_user, require_admin, hash_password
    from .admin_bootstrap_routes import router as admin_bootstrap_router
    from .shopify_oauth_routes import router as shopify_oauth_router
    from .settings_store import get_shopify_oauth_record
except Exception:
    HAVE_AUTH_DB = False
    get_session = None  # type: ignore
    init_db = None  # type: ignore
    SessionLocal = None  # type: ignore
    auth_router = None  # type: ignore
    admin_bootstrap_router = None  # type: ignore
    def get_current_user():  # type: ignore
        raise HTTPException(status_code=503, detail="auth not configured")
    def require_admin():  # type: ignore
        raise HTTPException(status_code=503, detail="auth not configured")
    class User(BaseModel):  # type: ignore
        id: str = "unknown"
        email: Optional[str] = None
        name: Optional[str] = None
    class OrderEvent:  # type: ignore
        # placeholder for typing only
        pass
    class DailyUserStats:  # type: ignore
        pass

# Order Tagger imports
from .geocode import geocode_order_address
from .geo_zones import load_zones, find_zone_match

# ---------- Settings (multi-store) ----------
SHOPIFY_API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2025-01").strip()

# Back-compat defaults (irrakids-only) while supporting per-store overrides
DEFAULT_DOMAIN = os.environ.get("IRRAKIDS_STORE_DOMAIN", "").strip()
DEFAULT_PASSWORD = os.environ.get("SHOPIFY_PASSWORD", "").strip()
DEFAULT_API_KEY = os.environ.get("SHOPIFY_API_KEY", "").strip()

def resolve_store_settings(store: Optional[str]) -> Tuple[str, str, str]:
    """Return (domain, password, api_key) for the requested store.

    - store == 'irranova' → IRRANOVA_* vars
    - store == 'irrakids' or None → IRRAKIDS_* or global fallbacks
    """
    key = (store or "irrakids").strip().lower()
    if key not in ("irrakids", "irranova"):
        # Unknown store → treat as irrakids to keep backward compatibility
        key = "irrakids"

    # New preferred env var convention:
    #   SHOPIFY_SHOP_DOMAIN_<STORE> and SHOPIFY_ACCESS_TOKEN_<STORE>
    # Back-compat:
    #   IRRAKIDS_STORE_DOMAIN / IRRANOVA_STORE_DOMAIN and *_SHOPIFY_PASSWORD / SHOPIFY_PASSWORD
    upper = key.upper()
    domain = os.environ.get(f"SHOPIFY_SHOP_DOMAIN_{upper}", "").strip()
    token = os.environ.get(f"SHOPIFY_ACCESS_TOKEN_{upper}", "").strip()
    api_key = os.environ.get(f"SHOPIFY_API_KEY_{upper}", "").strip()

    if key == "irranova":
        # IMPORTANT:
        # - Do NOT fall back to DEFAULT_PASSWORD for irranova.
        #   DEFAULT_PASSWORD is the global SHOPIFY_PASSWORD and is intended for irrakids.
        #   Falling back would send the wrong token to the wrong shop (causing 401),
        #   and would prevent OAuth DB fallback from ever being used.
        domain = domain or os.environ.get("IRRANOVA_STORE_DOMAIN", "").strip()
        token = token or os.environ.get("IRRANOVA_SHOPIFY_PASSWORD", "").strip()
        api_key = api_key or os.environ.get("IRRANOVA_SHOPIFY_API_KEY", "").strip()
    else:
        # irrakids keeps backward compatibility with global fallbacks
        domain = domain or os.environ.get("IRRAKIDS_STORE_DOMAIN", DEFAULT_DOMAIN).strip()
        token = token or (os.environ.get("IRRAKIDS_SHOPIFY_PASSWORD", "").strip() or DEFAULT_PASSWORD)
        api_key = api_key or (os.environ.get("IRRAKIDS_SHOPIFY_API_KEY", "").strip() or DEFAULT_API_KEY)

    return (domain, token, api_key)


def _oauth_enabled_stores() -> set[str]:
    raw = (os.environ.get("SHOPIFY_OAUTH_STORES") or "").strip()
    if not raw:
        return {"irranova"}  # safe default
    out: set[str] = set()
    for part in raw.split(","):
        p = (part or "").strip().lower()
        if p:
            out.add(p)
    return out


async def resolve_store_settings_effective(store: Optional[str]) -> Tuple[str, str, str]:
    """
    Mixed-mode Shopify credential resolver:
    - Prefer env for all stores (new vars first, then legacy)
    - If store is OAuth-enabled and env is missing, fall back to DB shopify_oauth record
    """
    domain, token, api_key = resolve_store_settings(store)
    if domain and token:
        return (domain, token, api_key)

    key = (store or "irrakids").strip().lower()
    if key not in ("irrakids", "irranova"):
        key = "irrakids"

    if (key in _oauth_enabled_stores()) and HAVE_AUTH_DB and SessionLocal is not None:
        try:
            async with SessionLocal() as db:  # type: ignore[misc]
                rec = await get_shopify_oauth_record(db, key)  # type: ignore[arg-type]
                if isinstance(rec, dict):
                    shop = (rec.get("shop") or "").strip().lower()
                    access_token = (rec.get("access_token") or "").strip()
                    if shop and access_token:
                        return (shop, access_token, api_key)
        except Exception:
            pass

    return (domain, token, api_key)

# ---------- FastAPI ----------
app = FastAPI(title="Order Collector API", version="1.0.0")
if HAVE_AUTH_DB and auth_router is not None:
    app.include_router(auth_router)
if HAVE_AUTH_DB and admin_bootstrap_router is not None:
    app.include_router(admin_bootstrap_router)
if HAVE_AUTH_DB and "shopify_oauth_router" in globals() and shopify_oauth_router is not None:  # type: ignore[name-defined]
    app.include_router(shopify_oauth_router)  # type: ignore[arg-type]

# CORS (relaxed for simplicity; tighten in prod)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Compress JSON responses to reduce payload sizes for large order lists
app.add_middleware(GZipMiddleware, minimum_size=500)

# NOTE: Static mount is added AFTER API routes to avoid shadowing /api paths.

# ---------- Lightweight Print Relay (in-memory) ----------
# This lets the same Cloud Run service act as the relay for phone → PC printing.

RELAY_API_KEY = os.environ.get("API_KEY", "CHANGE_ME_API_KEY").strip()

def _load_pcs_from_env() -> Dict[str, str]:
    pcs: Dict[str, str] = {}
    # Look for pairs like PC_ID_1 / PC_SECRET_1, PC_ID_2 / PC_SECRET_2, ...
    for i in range(1, 11):
        pid = os.environ.get(f"PC_ID_{i}")
        sec = os.environ.get(f"PC_SECRET_{i}")
        if pid and sec:
            pcs[pid] = sec
    # Back-compat: allow single pair PC_ID / PC_SECRET
    pid = os.environ.get("PC_ID")
    sec = os.environ.get("PC_SECRET")
    if pid and sec:
        pcs[pid] = sec
    return pcs

PCS: Dict[str, str] = _load_pcs_from_env() or {
    "pc-lab-1": "SECRET1",
}

# Default routing and webhook secrets
DEFAULT_PC_ID = os.environ.get("DEFAULT_PC_ID", next(iter(PCS.keys()), "pc-lab-1")).strip()
SHOPIFY_WEBHOOK_SECRET_DEFAULT = os.environ.get("SHOPIFY_WEBHOOK_SECRET", "").strip()
SHOPIFY_WEBHOOK_SECRET_IRRAKIDS = os.environ.get("IRRAKIDS_SHOPIFY_WEBHOOK_SECRET", "").strip()
SHOPIFY_WEBHOOK_SECRET_IRRANOVA = os.environ.get("IRRANOVA_SHOPIFY_WEBHOOK_SECRET", "").strip()
IRRAKIDS_STORE_DOMAIN = os.environ.get("IRRAKIDS_STORE_DOMAIN", "").strip().lower()
IRRANOVA_STORE_DOMAIN = os.environ.get("IRRANOVA_STORE_DOMAIN", "").strip().lower()
AUTO_TAGGING_ENABLED = os.environ.get("AUTO_TAGGING_ENABLED", "0").strip() in ("1", "true", "TRUE", "yes", "on")
AUTO_TAGGING_ENABLED_IRRAKIDS = os.environ.get("AUTO_TAGGING_ENABLED_IRRAKIDS", "").strip()
AUTO_TAGGING_ENABLED_IRRANOVA = os.environ.get("AUTO_TAGGING_ENABLED_IRRANOVA", "").strip()
ZONES_FILE_IRRAKIDS = os.environ.get("IRRAKIDS_ZONES_FILE", "").strip()
ZONES_FILE_IRRANOVA = os.environ.get("IRRANOVA_ZONES_FILE", "").strip()
ADDRESS_ALIAS_FILE = os.environ.get("ADDRESS_ALIAS_FILE", "").strip()
GEO_BOUNDS_SW = os.environ.get("GEO_BOUNDS_SW", "-13.5,20.5").strip()
GEO_BOUNDS_NE = os.environ.get("GEO_BOUNDS_NE", "-0.5,36.1").strip()

# Optional dedupe/cutoff controls
PC_TAG_MIN_CREATED_AT = os.environ.get("PC_TAG_MIN_CREATED_AT", "").strip()  # ISO8601 e.g., 2025-01-01T00:00:00Z
RECENT_ENQUEUE_SECONDS = int(os.environ.get("RECENT_ENQUEUE_SECONDS", "30").strip() or 30)
RECENT_ENQUEUED_ORDERS: Dict[str, int] = {}

# In-memory queue: { pc_id -> [ { job_id, ts, orders, copies, pdf_url? } ] }
JOBS: Dict[str, list] = {}
# In-memory minimal customer override cache: { order_no -> { customer, shippingAddress, phone, email, tags } }
ORDER_OVERRIDES: Dict[str, Dict[str, Any]] = {}

# Lightweight in-memory cache for orders API responses, with TTL and basic LRU trimming
from time import time as _now
ORDERS_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
ORDERS_CACHE_TTL_SECONDS = int(os.environ.get("ORDERS_CACHE_TTL_SECONDS", "5").strip() or 5)
ORDERS_CACHE_MAX_KEYS = int(os.environ.get("ORDERS_CACHE_MAX_KEYS", "200").strip() or 200)

def _orders_cache_key(payload: Dict[str, Any]) -> str:
    try:
        # Stable key using sorted JSON
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))
    except Exception:
        return str(payload)

def _orders_cache_get(key: str) -> Optional[Dict[str, Any]]:
    try:
        ts, val = ORDERS_CACHE.get(key, (0.0, None))
        if not val:
            return None
        if (_now() - ts) > ORDERS_CACHE_TTL_SECONDS:
            try: del ORDERS_CACHE[key]
            except Exception: pass
            return None
        return val
    except Exception:
        return None

def _orders_cache_set(key: str, val: Dict[str, Any]):
    try:
        ORDERS_CACHE[key] = (_now(), val)
        # Trim oldest if above limit
        if len(ORDERS_CACHE) > ORDERS_CACHE_MAX_KEYS:
            try:
                oldest_key = sorted(ORDERS_CACHE.items(), key=lambda kv: kv[1][0])[0][0]
                del ORDERS_CACHE[oldest_key]
            except Exception:
                pass
    except Exception:
        pass

@lru_cache(maxsize=4096)
def _qr_png_b64(text: str, box_size: int = 8, border: int = 2) -> str:
    """Generate a compact QR PNG (base64-encoded, ASCII) for the given text.

    Cached in-memory to handle bursts efficiently.
    """
    try:
        qr = qrcode.QRCode(
            version=None,
            error_correction=ERROR_CORRECT_M,
            box_size=box_size,
            border=border,
        )
        qr.add_data(text)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        # Fallback: return empty string on any unexpected issue
        return ""

class EnqueueBody(BaseModel):
    pc_id: str
    orders: List[str] = []
    copies: int = 1
    pdf_url: Optional[str] = None
    store: Optional[str] = None

class AckBody(BaseModel):
    pc_id: str
    secret: str
    job_id: str

def _require_api_key(x_api_key: Optional[str]):
    if RELAY_API_KEY and x_api_key != RELAY_API_KEY:
        raise HTTPException(status_code=401, detail="bad api key")

def _require_pc(pc_id: str, secret: str):
    expect = PCS.get(pc_id)
    if not expect or secret != expect:
        raise HTTPException(status_code=401, detail="unauthorized")

# ---------- Best-effort tagging to trigger webhook ----------
async def _find_order_gid_by_number(number: str, store: Optional[str]) -> Optional[str]:
    try:
        q = """
        query One($first: Int!, $query: String) {
          orders(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
            edges { node { id name } }
          }
        }
        """
        variables = {"first": 1, "query": f"name:{str(number).lstrip('#')}"}
        data = await shopify_graphql(q, variables, store=store)
        edges = (data.get("orders") or {}).get("edges") or []
        if not edges:
            return None
        node = edges[0].get("node") or {}
        return node.get("id")
    except Exception:
        return None

async def _tag_orders_before_print(numbers: List[str], store: Optional[str]):
    if not numbers:
        return
    # De-duplicate and limit to a small batch
    try:
        unique: List[str] = []
        seen = set()
        for n in numbers:
            k = str(n).lstrip('#')
            if k and k not in seen:
                seen.add(k)
                unique.append(k)
        unique = unique[:20]
    except Exception:
        unique = [str(n).lstrip('#') for n in numbers if str(n).strip()][:20]

    mutation = """
    mutation AddTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
    }
    """
    for num in unique:
        try:
            gid = await _find_order_gid_by_number(num, store)
            if not gid:
                continue
            # Ignore errors; webhook firing is best-effort
            try:
                await shopify_graphql(mutation, {"id": gid, "tags": ["cod print"]}, store=store)
            except Exception:
                continue
        except Exception:
            continue

@app.post("/enqueue")
async def enqueue(job: EnqueueBody, x_api_key: Optional[str] = Header(default=None)):
    _require_api_key(x_api_key)
    if job.pc_id not in PCS:
        raise HTTPException(status_code=404, detail="unknown pc_id")
    import time, uuid
    jid = str(uuid.uuid4())
    payload = {
        "job_id": jid,
        "ts": int(time.time()),
        "orders": [str(o).lstrip("#") for o in (job.orders or [])],
        "copies": max(1, job.copies),
        "pdf_url": job.pdf_url or None,
        "store": (job.store or None),
    }
    JOBS.setdefault(job.pc_id, []).append(payload)
    # Best-effort: tag orders with "cod print" to trigger webhook so overrides cache is populated
    try:
        if payload.get("orders"):
            asyncio.create_task(_tag_orders_before_print(payload["orders"], payload.get("store")))
    except Exception:
        pass
    return {"ok": True, "job_id": jid, "queued": len(JOBS[job.pc_id])}

@app.get("/pull")
async def pull(pc_id: str, secret: str, max_items: int = 5):
    _require_pc(pc_id, secret)
    q = JOBS.get(pc_id, [])
    if not q:
        return {"ok": True, "jobs": []}
    out = q[:max_items]
    JOBS[pc_id] = q[max_items:]
    return {"ok": True, "jobs": out}

@app.post("/ack")
async def ack(b: AckBody):
    _require_pc(b.pc_id, b.secret)
    # In-memory queue removes on pull; ack is a no-op here
    return {"ok": True}

# ---------- Shopify Webhook (orders/create) for Auto-Tagging by zone ----------
def _normalize_spaces(text: Optional[str]) -> str:
    try:
        import re as _re
        return _re.sub(r"\s+", " ", (text or "").strip())
    except Exception:
        return (text or "").strip()

def _parse_tags_from_webhook(val: Any) -> List[str]:
    try:
        if isinstance(val, list):
            return [str(x).strip() for x in val if str(x).strip()]
        if isinstance(val, str):
            # Shopify webhooks often send tags as comma-separated string
            parts = [p.strip() for p in val.split(",")]
            return [p for p in parts if p]
    except Exception:
        pass
    return []

def _log_order_tagger(payload: Dict[str, Any]) -> None:
    try:
        print(json.dumps({"component": "order_tagger", **payload}, ensure_ascii=False))
    except Exception:
        try:
            print({"component": "order_tagger", **payload})
        except Exception:
            pass

@app.post("/api/shopify/webhooks/orders/create")
async def orders_create_webhook(
    request: Request,
    x_shopify_hmac_sha256: Optional[str] = Header(default=None),
    x_shopify_shop_domain: Optional[str] = Header(default=None),
):
    # Verify HMAC
    raw = await request.body()
    secret = _secret_for_shop(x_shopify_shop_domain or "")
    if not _verify_shopify_hmac(raw, x_shopify_hmac_sha256 or "", secret):
        raise HTTPException(status_code=401, detail="bad hmac")

    data = await request.json()
    store_key = _store_key_for_shop_domain(x_shopify_shop_domain or "") or None

    # Extract shipping address
    shipping = data.get("shipping_address") or {}
    addr1 = _normalize_spaces(shipping.get("address1") or "")
    addr2 = _normalize_spaces(shipping.get("address2") or "")
    city_in = _normalize_spaces(shipping.get("city") or "")
    province = _normalize_spaces((shipping.get("province") or shipping.get("province_code") or ""))
    zip_code = _normalize_spaces((shipping.get("zip") or shipping.get("postal_code") or ""))

    # Build and geocode (with fallback to city-only). Prefer Shopify-provided coords from the
    # "View map" link so we avoid calling Google Maps Geocoding when lat/lng are already present.
    aliases = _load_address_aliases()
    bounds = _parse_bounds()
    geo = None

    lat_from_shopify = shipping.get("latitude")
    lng_from_shopify = shipping.get("longitude")
    try:
        if lat_from_shopify is not None and lng_from_shopify is not None:
            lat_val = float(lat_from_shopify)
            lng_val = float(lng_from_shopify)
            geo = {
                "ok": True,
                "address_string": ", ".join([p for p in [addr1, addr2, city_in, province, zip_code] if p]),
                "lat": lat_val,
                "lng": lng_val,
                "corrected_city": city_in or None,
                "raw": {"source": "shopify_shipping_coordinates"},
                "reason": None,
            }
    except Exception:
        geo = None

    if geo is None:
        geo = await geocode_order_address(addr1, addr2, city_in, province, zip_code, api_key=None, region="ma", alias_map=aliases, bounds=bounds, country="Morocco")

    order_id_num = data.get("id")
    order_name = (data.get("name") or "").strip()
    tags_from_payload = _parse_tags_from_webhook(data.get("tags"))
    corrected_city = geo.get("corrected_city")
    lat = geo.get("lat")
    lng = geo.get("lng")

    matched_tag = None
    status = "skipped"
    reason = None

    if geo.get("ok") and lat is not None and lng is not None:
        try:
            # Select per-store zones file if provided
            zones_path = None
            if (store_key or "") == "irranova" and ZONES_FILE_IRRANOVA:
                zones_path = ZONES_FILE_IRRANOVA
            elif (store_key or "") == "irrakids" and ZONES_FILE_IRRAKIDS:
                zones_path = ZONES_FILE_IRRAKIDS
            zones = load_zones(zones_path)
            match = find_zone_match(float(lng), float(lat), zones)
            if match and isinstance(match, dict):
                matched_tag = (match.get("tag") or match.get("properties", {}).get("tag") or "").strip() or None
        except Exception:
            matched_tag = None

        if matched_tag:
            # Idempotency: skip if tag already present
            already_has = any((t or "").strip().lower() == matched_tag.lower() for t in (tags_from_payload or []))
            if already_has:
                status = "skipped"
                reason = "already_tagged"
            elif _is_auto_tagging_enabled_for_store(store_key) and order_id_num:
                # GraphQL tagsAdd
                mutation = """
                mutation AddTag($id: ID!, $tags: [String!]!) {
                  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
                }
                """
                try:
                    gid = f"gid://shopify/Order/{int(order_id_num)}"
                except Exception:
                    gid = None
                if gid:
                    try:
                        resp = await shopify_graphql(mutation, {"id": gid, "tags": [matched_tag]}, store=store_key)
                        # Check userErrors for true success
                        ue = (((resp or {}).get("tagsAdd") or {}).get("userErrors")) or []
                        if ue:
                            status = "skipped"
                            reason = "shopify_user_errors"
                            try:
                                _log_order_tagger({"order_id": order_id_num, "store": store_key, "action": "tagsAdd", "userErrors": ue})
                            except Exception:
                                pass
                        else:
                            status = "tagged"
                            reason = None
                    except Exception as e:
                        status = "skipped"
                        reason = "shopify_tags_add_failed"
                else:
                    status = "skipped"
                    reason = "no_gid"
            else:
                # Feature disabled, log would-be tag
                status = "skipped"
                enabled = _is_auto_tagging_enabled_for_store(store_key)
                reason = "feature_disabled" if not enabled else "no_order_id"
        else:
            status = "skipped"
            reason = "no_zone"
    else:
        status = "skipped"
        reason = "geocode_failed"

    # Structured log
    _log_order_tagger({
        "order_id": order_id_num,
        "order_name": order_name,
        "address_string": geo.get("address_string"),
        "lat": lat,
        "lng": lng,
        "corrected_city": corrected_city,
        "matched_tag": matched_tag,
        "status": status,
        "reason": reason,
        "shop": x_shopify_shop_domain,
        "enabled": bool(_is_auto_tagging_enabled_for_store(store_key)),
        "store": store_key,
    })

    # Do not block order processing
    return {"ok": True}

# ---------- Order Tagger status endpoint ----------
@app.get("/api/order-tagger/status")
async def order_tagger_status(store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    try:
        sk = (store or "").strip().lower() or None
        zones_path = None
        if sk == "irranova" and ZONES_FILE_IRRANOVA:
            zones_path = ZONES_FILE_IRRANOVA
        elif sk == "irrakids" and ZONES_FILE_IRRAKIDS:
            zones_path = ZONES_FILE_IRRANOVA if False else ZONES_FILE_IRRAKIDS  # explicit
        zones = load_zones(zones_path)
        feats = (zones.get("features") or [])
        summary = [{
            "name": ((f.get("properties") or {}).get("name")),
            "tag": ((f.get("properties") or {}).get("tag")),
            "geometryType": (f.get("geometry") or {}).get("type"),
        } for f in feats]
    except Exception:
        summary = []
    return {
        "ok": True,
        "enabled": bool(_is_auto_tagging_enabled_for_store(sk)),
        "store": (sk or "default"),
        "zones": summary,
    }

# ---------- WebSocket Manager ----------
class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active.append(websocket)
    def disconnect(self, websocket: WebSocket):
        if websocket in self.active:
            self.active.remove(websocket)
    async def broadcast(self, message: Dict[str, Any]):
        for ws in list(self.active):
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                self.disconnect(ws)

manager = ConnectionManager()

@app.websocket("/ws")
async def ws_updates(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep-alive; we don't require messages from the client
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# ---------- Shopify GraphQL helper ----------
def _shopify_graphql_url(domain: str, password: str, api_key: str) -> str:
    # Always use header token auth; do not embed credentials in URL
    return f"https://{domain}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"

async def shopify_graphql(query: str, variables: Dict[str, Any] | None, *, store: Optional[str]) -> Dict[str, Any]:
    domain, access_token, api_key = await resolve_store_settings_effective(store)
    if not domain or not access_token:
        raise HTTPException(status_code=400, detail="Shopify credentials not configured for selected store")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    # Always use token/password header (custom/private app password)
    headers["X-Shopify-Access-Token"] = access_token

    max_retries = 5
    base_delay = 0.35
    last_exc: Optional[Exception] = None
    url = _shopify_graphql_url(domain, access_token, api_key)
    async with httpx.AsyncClient(timeout=30) as client:
        for attempt in range(max_retries):
            try:
                r = await client.post(url, headers=headers, json={"query": query, "variables": variables or {}})
                # Handle HTTP throttling
                if r.status_code in (429, 430, 503):
                    # Respect Retry-After when present
                    ra = r.headers.get("Retry-After")
                    if attempt < max_retries - 1:
                        try:
                            wait = float(ra) if ra else (base_delay * (2 ** attempt) + random.uniform(0, 0.15))
                        except Exception:
                            wait = base_delay * (2 ** attempt) + random.uniform(0, 0.15)
                        await asyncio.sleep(wait)
                        continue
                    else:
                        raise HTTPException(status_code=429, detail="Shopify API is throttling requests. Please try again shortly.")

                r.raise_for_status()
                data = r.json()
                # GraphQL-level errors
                if "errors" in data:
                    errs = data.get("errors") or []
                    # If throttled at GraphQL layer, backoff and retry
                    is_throttled = any(((e.get("extensions") or {}).get("code") or "").upper() == "THROTTLED" for e in errs)
                    if is_throttled and attempt < max_retries - 1:
                        wait = base_delay * (2 ** attempt) + random.uniform(0, 0.15)
                        await asyncio.sleep(wait)
                        continue
                    # Non-throttling errors → surface as 502
                    detail = f"Shopify GraphQL errors: {errs}"
                    raise HTTPException(status_code=502, detail=detail)
                return data["data"]
            except HTTPException as he:
                last_exc = he
                # Only retry HTTPException if throttling and attempts remain (handled above). Others break.
                break
            except Exception as e:
                last_exc = e
                # Retry transient network failures with backoff
                if attempt < max_retries - 1:
                    wait = base_delay * (2 ** attempt) + random.uniform(0, 0.15)
                    try:
                        await asyncio.sleep(wait)
                        continue
                    except Exception:
                        pass
                break

    # Final failure
    if isinstance(last_exc, HTTPException):
        raise last_exc
    raise HTTPException(status_code=502, detail=f"Shopify request failed: {last_exc}")


async def _enrich_orders_with_on_hand(items: List["OrderDTO"], *, store: Optional[str]) -> None:
    """
    Populate OrderVariant.on_hand_quantity by querying InventoryItem inventoryLevels in batch.

    We intentionally do this as a second query (instead of nesting inventoryLevels inside the Orders query),
    to keep the Orders query cheap enough to avoid Shopify throttling (which can reduce visible orders).
    """
    try:
        inv_ids: List[str] = []
        seen: set[str] = set()
        for o in (items or []):
            for v in (getattr(o, "variants", None) or []):
                try:
                    st = (getattr(v, "status", None) or "").strip().lower()
                    if st != "unfulfilled":
                        continue
                    iid = (getattr(v, "inventory_item_id", None) or "").strip()
                    if not iid or iid in seen:
                        continue
                    seen.add(iid)
                    inv_ids.append(iid)
                except Exception:
                    continue
        if not inv_ids:
            return

        # Shopify GraphQL nodes() supports batching; chunk for safety.
        CHUNK = 80
        inv_to_on_hand: Dict[str, int] = {}
        q = """
        query InvOnHand($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              inventoryLevels(first: 20) {
                edges {
                  node {
                    quantities(names: ["on_hand"]) { name quantity }
                  }
                }
              }
            }
          }
        }
        """
        for i in range(0, len(inv_ids), CHUNK):
            part = inv_ids[i:i+CHUNK]
            try:
                data = await shopify_graphql(q, {"ids": part}, store=store)
            except HTTPException:
                # Don't break orders listing if inventory scope is missing or if throttled.
                return
            nodes = (data or {}).get("nodes") or []
            for n in nodes:
                try:
                    if not n or not isinstance(n, dict):
                        continue
                    iid = (n.get("id") or "").strip()
                    if not iid:
                        continue
                    levels = (n.get("inventoryLevels") or {}).get("edges") or []
                    total = 0
                    found = False
                    for e in levels:
                        node_lvl = (e or {}).get("node") or {}
                        quants = node_lvl.get("quantities") or []
                        for qv in quants:
                            try:
                                if (qv or {}).get("name") == "on_hand":
                                    total += int((qv or {}).get("quantity") or 0)
                                    found = True
                            except Exception:
                                continue
                    if found:
                        inv_to_on_hand[iid] = total
                except Exception:
                    continue

        # Apply mapping
        for o in (items or []):
            for v in (getattr(o, "variants", None) or []):
                try:
                    iid = (getattr(v, "inventory_item_id", None) or "").strip()
                    if iid and iid in inv_to_on_hand:
                        v.on_hand_quantity = int(inv_to_on_hand[iid])
                except Exception:
                    continue
    except Exception:
        return

# ---------- Schemas ----------
class OrderVariant(BaseModel):
    id: Optional[str] = None
    product_id: Optional[str] = None
    product_title: Optional[str] = None
    image: Optional[str] = None
    barcode: Optional[str] = None
    sku: Optional[str] = None
    title: Optional[str] = None
    available_quantity: Optional[int] = None  # Shopify variant inventoryQuantity (AVAILABLE)
    on_hand_quantity: Optional[int] = None  # Sum of inventory levels quantities(name="on_hand") across locations
    inventory_item_id: Optional[str] = None  # Shopify InventoryItem GID (used to fetch on_hand in batch)
    qty: int
    status: Optional[str] = None  # fulfilled | unfulfilled | removed | unknown
    unfulfilled_qty: Optional[int] = None

class OrderDTO(BaseModel):
    id: str
    number: str
    customer: Optional[str] = None
    shipping_city: Optional[str] = None
    shipping_name: Optional[str] = None
    shipping_phone: Optional[str] = None
    shipping_address1: Optional[str] = None
    shipping_address2: Optional[str] = None
    shipping_zip: Optional[str] = None
    shipping_province: Optional[str] = None
    shipping_country: Optional[str] = None
    sales_channel: Optional[str] = None
    tags: List[str] = []
    note: Optional[str] = None
    variants: List[OrderVariant] = []
    total_price: float = 0.0
    considered_fulfilled: bool = False
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    fulfilled_at: Optional[str] = None
    # All fulfillment timestamps (createdAt) found on the order.
    # Used to match "Fulfilled on <date>" like Shopify Admin (any fulfillment in range, not only the latest).
    fulfillment_times: List[str] = []
    financial_status: Optional[str] = None

# ---------- Helpers ----------
def build_query_string(
    base_query: str,
    status_filter: Optional[str],
    tag_filter: Optional[str],
    search: Optional[str],
    cod_date: Optional[str],
    cod_dates: Optional[str] = None,
    collect_prefix: Optional[str] = None,
    collect_exclude_tag: Optional[str] = None,
    verification_include_tag: Optional[str] = None,
    exclude_out: bool = False,
    product_id: Optional[str] = None,
    financial_status: Optional[str] = None,
) -> str:
    q = base_query.strip() if base_query else ""
    # New filter modes
    if status_filter == "collect":
        # open, unfulfilled and NOT tagged with pc
        q += " status:open fulfillment_status:unfulfilled"
        ex = (collect_exclude_tag or "pc").strip()
        if ex:
            q += f" -tag:{ex}"
    elif status_filter == "verification":
        # open, unfulfilled and tagged with pc
        q += " status:open fulfillment_status:unfulfilled"
        inc = (verification_include_tag or "pc").strip()
        if inc:
            q += f" tag:{inc}"
    elif status_filter == "urgent":
        # open, unfulfilled and tagged urgent
        q += " status:open fulfillment_status:unfulfilled tag:urgent"
    # Tag chip filter
    if tag_filter:
        q += f" tag:{tag_filter}"
    # Global OUT exclusion
    if exclude_out:
        q += " -tag:out"
    # Financial status narrowing (paid | pending)
    if financial_status:
        fs = (financial_status or "").strip().lower()
        if fs == "paid":
            q += " financial_status:paid"
        elif fs == "pending":
            # Shopify "pending payment" in Admin can correspond to multiple internal values,
            # commonly: pending, authorized, partially_paid. Include all so the UI matches Admin.
            q += " (financial_status:pending OR financial_status:authorized OR financial_status:partially_paid)"
        elif fs in ("paid_or_pending", "paid,pending", "paid|pending", "paid_pending"):
            q += " (financial_status:paid OR financial_status:pending OR financial_status:authorized OR financial_status:partially_paid)"
    # Optional COD date tag(s): expect dd/mm/yy
    # If multiple provided (comma-separated), build an OR group across tags with the chosen prefix
    prefix = (collect_prefix or "cod").strip()
    dates_list: List[str] = []
    if cod_dates:
        try:
            dates_list = [d.strip() for d in (cod_dates or "").split(",") if d and d.strip()]
        except Exception:
            dates_list = []
    if dates_list:
        parts = [f'tag:"{prefix} {d}"' for d in dates_list]
        if parts:
            q += " (" + " OR ".join(parts) + ")"
    else:
        # Single date fallback for backward compatibility
        if cod_date:
            tag_val = cod_date.strip()
            if tag_val:
                # quote because of space
                q += f' tag:"{prefix} {tag_val}"'
    # Search: try to search by order name if numeric, else client filters by SKU
    if search:
        s = search.strip().lstrip("#")
        if s.isdigit():
            q += f" name:{s}"
    # Filter by product id if provided (supports Shopify GID or numeric id)
    if product_id:
        pid = (product_id or "").strip()
        if pid:
            # Extract trailing digits if a GID is passed
            import re
            m = re.search(r"(\d+)$", pid)
            numeric = m.group(1) if m else None
            if numeric:
                q += f" line_item.product_id:{numeric}"
            else:
                # Fallback to substring match on raw value (less reliable)
                q += f" line_item.product_id:{pid}"
    return q.strip()

def map_order_node(node: Dict[str, Any]) -> OrderDTO:
    variants: List[OrderVariant] = []
    # Use all lineItems; Shopify 2025-01 removed unfulfilledLineItems on Order
    li_edges = node.get("lineItems", {}).get("edges", [])
    for edge in li_edges:
        li = edge["node"]
        img = None
        var = li.get("variant")
        available_qty: Optional[int] = None
        inv_item_id: Optional[str] = None
        try:
            if var is not None and (var.get("inventoryQuantity") is not None):
                available_qty = int(var.get("inventoryQuantity"))
        except Exception:
            available_qty = None
        try:
            inv_item_id = (((var or {}).get("inventoryItem") or {}).get("id") or None)
        except Exception:
            inv_item_id = None
        if var and var.get("image"):
            img = var["image"].get("url")
        if (not img) and var and ((var.get("product") or {}).get("featuredImage")):
            try:
                img = (var.get("product") or {}).get("featuredImage", {}).get("url")
            except Exception:
                img = img
        qty = li.get("quantity", 0) or 0
        unfulfilled_qty = li.get("unfulfilledQuantity")
        status_val = "unknown"
        try:
            if int(qty) <= 0:
                status_val = "removed"
            else:
                if unfulfilled_qty is None:
                    status_val = "unfulfilled"
                else:
                    status_val = "fulfilled" if int(unfulfilled_qty) == 0 else "unfulfilled"
        except Exception:
            status_val = "unknown"
        variants.append(OrderVariant(
            id=(var or {}).get("id"),
            product_id=((var or {}).get("product") or {}).get("id"),
            product_title=((var or {}).get("product") or {}).get("title"),
            image=img,
            barcode=(var or {}).get("barcode"),
            sku=li.get("sku"),
            title=(var or {}).get("title"),
            available_quantity=available_qty,
            on_hand_quantity=None,
            inventory_item_id=inv_item_id,
            qty=qty,
            status=status_val,
            unfulfilled_qty=(None if unfulfilled_qty is None else int(unfulfilled_qty)),
        ))
    # Prefer currentTotalPriceSet if available, else totalPriceSet
    price = 0.0
    try:
        ctps = (node.get("currentTotalPriceSet") or {}).get("shopMoney") or {}
        tps = (node.get("totalPriceSet") or {}).get("shopMoney") or {}
        amt = ctps.get("amount") or tps.get("amount") or 0
        price = float(amt)
    except Exception:
        price = 0.0
    considered_fulfilled = any((getattr(v, "status", None) or "") == "fulfilled" for v in variants)
    # Determine the last fulfillment timestamp from fulfillments nodes if present
    fulfilled_at_val: Optional[str] = None
    fulfillment_times: List[str] = []
    try:
        # Shopify schema differs by version:
        # - Some versions: fulfillments is a list of objects [{createdAt, status}, ...]
        # - Others: fulfillments is a connection { nodes: [...] } or { edges: [{node: ...}] }
        fulf = node.get("fulfillments")
        if isinstance(fulf, list):
            for f in fulf:
                try:
                    ts = (f or {}).get("createdAt")
                    if ts:
                        fulfillment_times.append(str(ts))
                except Exception:
                    continue
        elif isinstance(fulf, dict):
            nodes = (fulf.get("nodes") or [])
            if isinstance(nodes, list):
                for f in nodes:
                    try:
                        ts = (f or {}).get("createdAt")
                        if ts:
                            fulfillment_times.append(str(ts))
                    except Exception:
                        continue
            edges = (fulf.get("edges") or [])
            if isinstance(edges, list):
                for e in edges:
                    try:
                        f = (e or {}).get("node") or {}
                        ts = (f or {}).get("createdAt")
                        if ts:
                            fulfillment_times.append(str(ts))
                    except Exception:
                        continue
        if fulfillment_times:
            fulfilled_at_val = max(fulfillment_times)  # latest (display)
    except Exception:
        fulfilled_at_val = None
    cust_name: Optional[str] = None
    try:
        cust_name = ((node.get("customer") or {}) or {}).get("displayName")
    except Exception:
        cust_name = None
    # Draft orders / some channels may not populate `customer`, but shippingAddress.name is usually present.
    if not cust_name:
        try:
            cust_name = ((node.get("shippingAddress") or {}) or {}).get("name") or None
        except Exception:
            cust_name = None
    ship = (node.get("shippingAddress") or {}) or {}

    return OrderDTO(
        id=node["id"],
        number=node["name"],
        customer=cust_name,
        shipping_city=ship.get("city"),
        shipping_name=ship.get("name"),
        shipping_phone=ship.get("phone"),
        shipping_address1=ship.get("address1"),
        shipping_address2=ship.get("address2"),
        shipping_zip=ship.get("zip"),
        shipping_province=ship.get("province"),
        shipping_country=ship.get("country"),
        sales_channel=node.get("sourceName"),
        tags=node.get("tags") or [],
        note=node.get("note"),
        variants=variants,
        total_price=price,
        considered_fulfilled=considered_fulfilled,
        created_at=node.get("createdAt"),
        updated_at=node.get("updatedAt"),
        fulfilled_at=fulfilled_at_val,
        fulfillment_times=fulfillment_times,
        financial_status=node.get("displayFinancialStatus"),
    )

# ---------- Routes ----------
@app.get("/api/health")
async def health():
    return {"ok": True}

@app.get("/api/orders")
async def list_orders(
    limit: int = Query(25, ge=1, le=250),
    cursor: Optional[str] = None,
    status_filter: Optional[str] = Query(None, pattern="^(all|collect|verification|urgent)$"),
    tag_filter: Optional[str] = None,
    search: Optional[str] = None,
    cod_date: Optional[str] = Query(None, description="Date for COD tag in format DD/MM/YY"),
    cod_dates: Optional[str] = Query(None, description="Comma-separated dates (DD/MM/YY) for OR-matching COD tags"),
    collect_prefix: Optional[str] = Query(None, description="Prefix for COD tag, e.g. 'cod'"),
    collect_exclude_tag: Optional[str] = Query(None, description="Exclude tag for collect filter, e.g. 'pc'"),
    verification_include_tag: Optional[str] = Query(None, description="Include tag for verification filter, e.g. 'pc'"),
    exclude_out: bool = Query(False, description="Exclude orders tagged with 'out'"),
    base_query: Optional[str] = Query(None, description="Raw Shopify query prefix to start from"),
    store: Optional[str] = Query(None, description="Select store: 'irrakids' (default) or 'irranova'"),
    product_id: Optional[str] = Query(None, description="Filter orders that contain this product id (Shopify GID or numeric)"),
    disable_collect_ranking: bool = Query(False, description="If true, skip special collect ranking and return raw results"),
    fulfillment_from: Optional[str] = Query(None, description="ISO date (YYYY-MM-DD) inclusive start for fulfillment date"),
    fulfillment_to: Optional[str] = Query(None, description="ISO date (YYYY-MM-DD) inclusive end for fulfillment date"),
    financial_status: Optional[str] = Query(None, description="Filter by payment status: paid, pending, or paid_or_pending"),
    debug: bool = Query(False, description="If true, include debug metadata (resolved Shopify query, scan stats)"),
):
    domain, access_token, _ = await resolve_store_settings_effective(store)
    if not domain or not access_token:
        return JSONResponse({"orders": [], "pageInfo": {"hasNextPage": False}, "error": "Shopify env not configured"}, status_code=200)

    # Preserve original fulfillment date filters. We may choose between:
    # - Fast server-side filtering (fulfillment_date:* query) when supported by Shopify search
    # - Fallback scan + post-filter using fulfillments/updatedAt if the fast query returns 0
    orig_fulfillment_from = (fulfillment_from or "").strip() or None
    orig_fulfillment_to = (fulfillment_to or "").strip() or None

    q = build_query_string(
        (base_query or ""),
        status_filter,
        tag_filter,
        search,
        cod_date,
        cod_dates,
        collect_prefix,
        collect_exclude_tag,
        verification_include_tag,
        exclude_out,
        product_id,
        financial_status,
    )
    # Fulfillment date filter strategy:
    # Prefer fast server-side query using fulfillment_date if possible; fallback to scan+post-filter.
    want_fulfillment_date = bool(orig_fulfillment_from or orig_fulfillment_to)
    q_fallback: Optional[str] = None
    do_post_filter = False
    if want_fulfillment_date:
        # Shopify order search defaults to open orders unless status:any is provided.
        # For fulfillment-date browsing we want to match Shopify Admin's "All orders" view,
        # including archived/closed fulfilled orders.
        try:
            import re
            if not re.search(r"(^|\s)status:", q):
                q = f"{q} status:any".strip()
        except Exception:
            pass
        # Ensure we only query fulfilled orders (idempotent)
        if "fulfillment_status:" not in q:
            q = f"{q} fulfillment_status:fulfilled".strip()

        # Fast path: let Shopify search filter by fulfillment date (if supported)
        fast_terms: List[str] = []
        if orig_fulfillment_from and orig_fulfillment_to and orig_fulfillment_from == orig_fulfillment_to:
            fast_terms.append(f"fulfillment_date:{orig_fulfillment_from}")
        else:
            if orig_fulfillment_from:
                fast_terms.append(f"fulfillment_date:>={orig_fulfillment_from}")
            if orig_fulfillment_to:
                fast_terms.append(f"fulfillment_date:<={orig_fulfillment_to}")
        q_fast = f"{q} {' '.join(fast_terms)}".strip()

        # Fallback path: constrain by updated_at window and then post-filter by fulfillments/updatedAt.
        q_fallback = q
        try:
            if orig_fulfillment_from:
                q_fallback = f"{q_fallback} updated_at:>={orig_fulfillment_from}".strip()
            if orig_fulfillment_to:
                # Allow a drift for updates that happen after fulfillment, but never cap earlier than "now"
                to_dt = datetime.fromisoformat(orig_fulfillment_to).replace(tzinfo=timezone.utc)
                drift_cap = (to_dt + timedelta(days=8)).date()
                now_cap = (datetime.now(timezone.utc).date() + timedelta(days=1))
                cap = (now_cap if drift_cap < now_cap else drift_cap).isoformat()
                q_fallback = f"{q_fallback} updated_at:<{cap}".strip()
        except Exception:
            pass

        # Start with fast query; we may fallback after the first fetch if it returns 0.
        q = q_fast

    # Build GraphQL query based on store capabilities

    # Cache key (includes resolved query) so repeated loads within a short window are instant
    cache_key = _orders_cache_key({
        "path": "/api/orders",
        "q": q,
        "limit": limit,
        "cursor": cursor,
        "status_filter": status_filter,
        "tag_filter": tag_filter,
        "search": search,
        "cod_date": cod_date,
        "cod_dates": cod_dates,
        "collect_prefix": collect_prefix,
        "collect_exclude_tag": collect_exclude_tag,
        "verification_include_tag": verification_include_tag,
        "exclude_out": exclude_out,
        "store": (store or "").strip().lower(),
        "product_id": product_id,
        "disable_collect_ranking": bool(disable_collect_ranking),
        "financial_status": (financial_status or "").strip().lower(),
        "fulfillment_from": (fulfillment_from or "").strip(),
        "fulfillment_to": (fulfillment_to or "").strip(),
    })
    cached = _orders_cache_get(cache_key)
    # If we are using the fast fulfillment-date query and it cached an empty response,
    # ignore it so we can attempt the slower fallback (otherwise we can get "stuck" at 0).
    if cached is not None:
        try:
            if want_fulfillment_date and int(cached.get("totalCount") or 0) == 0 and q_fallback:
                cached = None
        except Exception:
            pass
    if cached is not None:
        return cached
    query = """
    query Orders($first: Int!, $after: String, $query: String, $reverse: Boolean!) {
      orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: $reverse) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            updatedAt
            sourceName
            tags
            note
            fulfillments { createdAt status }
            shippingAddress { name city phone address1 address2 zip province country }
            customer { displayName }
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalPriceSet { shopMoney { amount currencyCode } }
            displayFinancialStatus
            lineItems(first: 50) {
              edges {
                node {
                  quantity
                  unfulfilledQuantity
                  sku
                  variant {
                    id
                    title
                    barcode
                    inventoryQuantity
                    inventoryItem { id }
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
    # Default ordering for normal browsing is newest first. For fulfillment-date fallback scanning
    # we will switch to oldest-first to reach the target day quickly.
    variables = {"first": limit, "after": cursor, "query": q or None, "reverse": True}
    try:
        data = await shopify_graphql(query, variables, store=store)
    except HTTPException as he:
        # If throttled, try progressively smaller page sizes with short delays
        async def _retry_smaller():
            for sz, wait in ((10, 0.6), (5, 1.0)):
                try:
                    await asyncio.sleep(wait)
                    data_small = await shopify_graphql(query, {**variables, "first": sz}, store=store)
                    return data_small
                except HTTPException as he2:
                    # Continue if still throttled or transient
                    if he2.status_code in (429, 502, 503) or "THROTTLED" in str(getattr(he2, "detail", "")).upper():
                        continue
                    raise
            return None
        if he.status_code in (429, 502, 503) or "THROTTLED" in str(getattr(he, "detail", "")).upper():
            data = await _retry_smaller()
            if data is None:
                resp = {"orders": [], "pageInfo": {"hasNextPage": False}, "tags": [], "totalCount": 0, "nextCursor": None, "error": he.detail}
                _orders_cache_set(cache_key, resp)
                return resp
        else:
            raise
    # If fast fulfillment_date query returned no rows OR appears to be ignored by Shopify search,
    # fallback to the slower scan+post-filter strategy.
    try:
        if want_fulfillment_date and q_fallback:
            edges0 = ((data.get("orders") or {}).get("edges")) or []
            cnt0 = int((data.get("ordersCount") or {}).get("count") or 0)
            should_fallback = (not edges0) and cnt0 == 0

            # Validation: if we used a fast query (q != q_fallback) but the returned orders
            # are not actually in the requested date range, assume Shopify ignored fulfillment_date:*.
            if (not should_fallback) and edges0 and (q != q_fallback):
                try:
                    # Build date window
                    start_dt = None
                    end_dt = None
                    if orig_fulfillment_from:
                        start_dt = datetime.fromisoformat(orig_fulfillment_from).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
                    if orig_fulfillment_to:
                        end_dt = datetime.fromisoformat(orig_fulfillment_to).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc) + timedelta(days=1)

                    def _in_range_ts(ts: Optional[str]) -> bool:
                        if not ts:
                            return False
                        dt = _parse_iso8601(ts)
                        if not dt:
                            return False
                        if not dt.tzinfo:
                            dt = dt.replace(tzinfo=timezone.utc)
                        if start_dt and dt < start_dt:
                            return False
                        if end_dt and dt >= end_dt:
                            return False
                        return True

                    def _any_ts_in_range(o: "OrderDTO") -> bool:
                        try:
                            ts_list = getattr(o, "fulfillment_times", None) or []
                            if ts_list:
                                return any(_in_range_ts(t) for t in ts_list)
                            if _in_range_ts(getattr(o, "fulfilled_at", None)):
                                return True
                            return _in_range_ts(getattr(o, "updated_at", None))
                        except Exception:
                            return False

                    # Validate first page only (cheap) to detect ignored search term.
                    page0_items: List[OrderDTO] = [map_order_node(e["node"]) for e in edges0 if (e or {}).get("node")]
                    mismatches = 0
                    for o in page0_items:
                        if not _any_ts_in_range(o):
                            mismatches += 1
                            # One mismatch is enough to suspect the fast filter is not applied.
                            break
                    if mismatches > 0:
                        should_fallback = True
                except Exception:
                    # If validation fails, do not force fallback; keep fast path.
                    pass

            if should_fallback:
                q = q_fallback
                do_post_filter = True
                # IMPORTANT: scan oldest->newest within updated_at window to reach the target day quickly
                scan_first = max(25, min(250, int(limit or 25)))
                variables = {"first": scan_first, "after": cursor, "query": q or None, "reverse": False}
                # Recompute cache for fallback query
                cache_key_fb = _orders_cache_key({
                    "path": "/api/orders",
                    "q": q,
                    "limit": limit,
                    "cursor": cursor,
                    "status_filter": status_filter,
                    "tag_filter": tag_filter,
                    "search": search,
                    "cod_date": cod_date,
                    "cod_dates": cod_dates,
                    "collect_prefix": collect_prefix,
                    "collect_exclude_tag": collect_exclude_tag,
                    "verification_include_tag": verification_include_tag,
                    "exclude_out": exclude_out,
                    "store": (store or "").strip().lower(),
                    "product_id": product_id,
                    "disable_collect_ranking": bool(disable_collect_ranking),
                    "financial_status": (financial_status or "").strip().lower(),
                    "fulfillment_from": (orig_fulfillment_from or ""),
                    "fulfillment_to": (orig_fulfillment_to or ""),
                })
                cached_fb = _orders_cache_get(cache_key_fb)
                if cached_fb is not None:
                    return cached_fb
                data = await shopify_graphql(query, variables, store=store)
                # Update cache_key variable so we cache the fallback response at the correct key
                cache_key = cache_key_fb
    except Exception:
        # If anything goes wrong, keep the fast path results
        do_post_filter = False

    ords = data["orders"]
    edges = ords.get("edges") or []
    items: List[OrderDTO] = [map_order_node(e["node"]) for e in edges]
    # Optional post-filter by fulfillment date range (inclusive)
    if want_fulfillment_date and do_post_filter:
        def _compute_range():
            try:
                sdt = None
                edt = None
                if orig_fulfillment_from:
                    sdt = datetime.fromisoformat(orig_fulfillment_from).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
                if orig_fulfillment_to:
                    edt = datetime.fromisoformat(orig_fulfillment_to).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
                    edt = edt + timedelta(days=1)
                return sdt, edt
            except Exception:
                return None, None
        start_dt, end_dt = _compute_range()
        def _in_range(ts: Optional[str]) -> bool:
            if not ts:
                return False
            try:
                dt = _parse_iso8601(ts)
                if not dt:
                    return False
                if not dt.tzinfo:
                    dt = dt.replace(tzinfo=timezone.utc)
                if start_dt and dt < start_dt:
                    return False
                if end_dt and dt >= end_dt:
                    return False
                return True
            except Exception:
                return False
        def _any_fulfillment_in_range(o: "OrderDTO") -> bool:
            try:
                ts_list = getattr(o, "fulfillment_times", None) or []
                if ts_list:
                    return any(_in_range(t) for t in ts_list)
                # Fallback to last fulfillment timestamp if list missing
                if _in_range(getattr(o, "fulfilled_at", None)):
                    return True
                # Final fallback: use updatedAt (approx) if fulfillments are unavailable
                return _in_range(getattr(o, "updated_at", None))
            except Exception:
                return False
        # Accumulate across pages to avoid missing results due to updated_at sorting
        matches: List[OrderDTO] = [o for o in items if _any_fulfillment_in_range(o)]
        local_next = None
        try:
            if edges:
                local_next = edges[-1].get("cursor")
        except Exception:
            local_next = None
        has_more = (ords.get("pageInfo") or {}).get("hasNextPage") or False
        pages = 1
        MAX_PAGES = 40  # safety cap
        while has_more and local_next and pages < MAX_PAGES:
            try:
                scan_first = max(25, min(250, int(limit or 25)))
                page = await shopify_graphql(query, {"first": scan_first, "after": local_next, "query": q or None, "reverse": False}, store=store)
            except HTTPException as he:
                if he.status_code in (429, 502, 503):
                    break
                raise
            ords2 = page["orders"]
            edges2 = ords2.get("edges") or []
            page_items: List[OrderDTO] = [map_order_node(e["node"]) for e in edges2]
            matches.extend([o for o in page_items if _any_fulfillment_in_range(o)])
            has_more = (ords2.get("pageInfo") or {}).get("hasNextPage") or False
            try:
                local_next = edges2[-1].get("cursor") if edges2 else None
            except Exception:
                local_next = None
            pages += 1
        unique_tags = sorted({t for o in matches for t in (o.tags or [])})
        try:
            await _enrich_orders_with_on_hand(matches, store=store)
        except Exception:
            pass
        resp: Dict[str, Any] = {
            "orders": [json.loads(o.json()) for o in matches],
            "pageInfo": {"hasNextPage": False},
            "tags": unique_tags,
            "totalCount": len(matches),
            "nextCursor": None,
        }
        if debug:
            try:
                sample = []
                for o in (matches[:5] if matches else items[:5]):
                    sample.append({
                        "number": getattr(o, "number", None),
                        "updated_at": getattr(o, "updated_at", None),
                        "fulfilled_at": getattr(o, "fulfilled_at", None),
                        "fulfillment_times_len": len(getattr(o, "fulfillment_times", None) or []),
                    })
                resp["debug"] = {
                    "resolved_query": q,
                    "first_page_edges": len(edges or []),
                    "matched_count": len(matches),
                    "sample": sample,
                }
            except Exception:
                resp["debug"] = {"resolved_query": q}
        _orders_cache_set(cache_key, resp)
        return resp

    # For Irranova, backfill customer/shipping city from cached overrides when available
    if (store or "irrakids").strip().lower() == "irranova":
        try:
            for o in items:
                key = (o.number or "").lstrip("#")
                ov = ORDER_OVERRIDES.get(key) or {}
                if (not o.customer) and ((ov.get("customer") or {}).get("displayName")):
                    o.customer = (ov.get("customer") or {}).get("displayName")
                shp = (ov.get("shippingAddress") or {})
                if (not o.shipping_city) and (shp.get("city")):
                    o.shipping_city = shp.get("city")
                if (not o.shipping_name) and (shp.get("name")):
                    o.shipping_name = shp.get("name")
                if (not o.shipping_phone) and (shp.get("phone")):
                    o.shipping_phone = shp.get("phone")
                if (not o.shipping_address1) and (shp.get("address1")):
                    o.shipping_address1 = shp.get("address1")
                if (not o.shipping_address2) and (shp.get("address2")):
                    o.shipping_address2 = shp.get("address2")
                if (not o.shipping_zip) and (shp.get("zip")):
                    o.shipping_zip = shp.get("zip")
                if (not o.shipping_province) and (shp.get("province")):
                    o.shipping_province = shp.get("province")
                if (not o.shipping_country) and (shp.get("country")):
                    o.shipping_country = shp.get("country")
        except Exception:
            pass

    # Optional client-side SKU filter if search is non-numeric
    if search and not search.strip().lstrip("#").isdigit():
        ss = search.lower().strip()
        items = [o for o in items if any((v.sku or "").lower().find(ss) >= 0 for v in o.variants) or ss in o.number.lower()]

    # Product mode: present oldest first within current page window
    if (product_id or "").strip():
        try:
            items.sort(key=lambda o: (getattr(o, "created_at", None) or ""))
        except Exception:
            pass

    # Collect: compute ranking globally across a larger window of orders
    if status_filter == "collect" and not disable_collect_ranking:
        # Use a smaller window to reduce latency while maintaining good grouping quality
        target_window = 250
        chunk = 50
        accumulated_edges = []
        after_cursor = None
        # Always try to use a wider window irrespective of incoming limit
        while len(accumulated_edges) < target_window:
            variables2 = {"first": min(chunk, target_window - len(accumulated_edges)), "after": after_cursor, "query": q or None, "reverse": True}
            try:
                page = await shopify_graphql(query, variables2, store=store)
            except HTTPException as he:
                # Stop widening window on throttling, use what we have
                break
            ords2 = page["orders"]
            edges2 = ords2.get("edges") or []
            if not edges2:
                break
            accumulated_edges.extend(edges2)
            if not (ords2.get("pageInfo") or {}).get("hasNextPage"):
                break
            after_cursor = edges2[-1].get("cursor")

        all_items: List[OrderDTO] = [map_order_node(e["node"]) for e in accumulated_edges] or items

        # Optional client-side SKU filter if search is non-numeric
        if search and not search.strip().lstrip("#").isdigit():
            ss = search.lower().strip()
            all_items = [o for o in all_items if any((v.sku or "").lower().find(ss) >= 0 for v in o.variants) or ss in o.number.lower()]

        # Build frequency of products across orders (prefer product_id)
        def product_keys_for_order(o: OrderDTO) -> List[str]:
            keys = []
            for v in o.variants:
                # Strictly prefer product_id; fallback to variant title only if product_id missing
                key = (getattr(v, "product_id", None) or "").strip() or (v.title or "").strip()
                if key:
                    keys.append(key)
            return list({k for k in keys})

        product_freq: Dict[str, int] = {}
        for o in all_items:
            for k in product_keys_for_order(o):
                product_freq[k] = product_freq.get(k, 0) + 1

        def representative_key_for_order(o: OrderDTO) -> str:
            ks = product_keys_for_order(o)
            if not ks:
                return "__misc__"
            # choose the product key with highest global frequency, tie-break by key
            return sorted(ks, key=lambda k: (-product_freq.get(k, 0), k))[0]

        # Group orders by chosen product key
        groups: Dict[str, List[OrderDTO]] = {}
        for o in all_items:
            rk = representative_key_for_order(o)
            groups.setdefault(rk, []).append(o)

        # Sort groups by frequency desc (misc last), then flatten each group by price desc
        sorted_group_keys = sorted([k for k in groups.keys() if k != "__misc__"], key=lambda k: (-product_freq.get(k, 0), k))
        if "__misc__" in groups:
            sorted_group_keys.append("__misc__")

        flattened: List[OrderDTO] = []
        for k in sorted_group_keys:
            grp = groups[k]
            grp.sort(key=lambda o: -float(o.total_price or 0.0))
            flattened.extend(grp)

        items = flattened[:limit]
        try:
            await _enrich_orders_with_on_hand(items, store=store)
        except Exception:
            pass
        # Gather unique tags for chips and return with computed page info
        unique_tags = sorted({t for o in items for t in (o.tags or [])})
        total_count_val = 0
        try:
            total_count_val = int((data.get("ordersCount") or {}).get("count") or 0)
        except Exception:
            total_count_val = len(all_items)
        resp = {
            "orders": [json.loads(o.json()) for o in items],
            "pageInfo": {"hasNextPage": len(all_items) > limit},
            "tags": unique_tags,
            "totalCount": total_count_val,
            # Collect ranking does not support true cursor pagination; omit nextCursor
            "nextCursor": None,
        }
        _orders_cache_set(cache_key, resp)
        return resp

    # Gather unique tags for chips
    unique_tags = sorted({t for o in items for t in (o.tags or [])})

    try:
        await _enrich_orders_with_on_hand(items, store=store)
    except Exception:
        pass

    total_count_val = 0
    try:
        total_count_val = int((data.get("ordersCount") or {}).get("count") or 0)
    except Exception:
        total_count_val = len(items)
    next_cursor = None
    try:
        if edges:
            next_cursor = edges[-1].get("cursor")
    except Exception:
        next_cursor = None

    resp = {
        "orders": [json.loads(o.json()) for o in items],
        "pageInfo": ords["pageInfo"],
        "tags": unique_tags,
        "totalCount": total_count_val,
        "nextCursor": next_cursor,
    }
    _orders_cache_set(cache_key, resp)
    return resp

class TagPayload(BaseModel):
    tag: str

class OrderActionBody(BaseModel):
    order_number: Optional[str] = None
    store: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


# ---------- Shared Shopify helpers for tags/notes ----------
async def _shopify_add_tag(order_gid: str, tag: str, store: Optional[str]):
    mutation = """
    mutation AddTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
    """
    data = await shopify_graphql(mutation, {"id": order_gid, "tags": [tag]}, store=store)
    errs = (((data or {}).get("tagsAdd") or {}).get("userErrors")) or []
    if errs:
        raise HTTPException(status_code=400, detail=f"Shopify tag add failed: {errs}")
    return data


async def _shopify_remove_tag(order_gid: str, tag: str, store: Optional[str]):
    mutation = """
    mutation RemoveTag($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
    """
    data = await shopify_graphql(mutation, {"id": order_gid, "tags": [tag]}, store=store)
    errs = (((data or {}).get("tagsRemove") or {}).get("userErrors")) or []
    if errs:
        raise HTTPException(status_code=400, detail=f"Shopify tag remove failed: {errs}")
    return data


async def _shopify_append_note(order_gid: str, append_text: str, store: Optional[str]):
    q = """
    query One($id: ID!) {
      node(id: $id) {
        ... on Order { id note }
      }
    }
    """
    data = await shopify_graphql(q, {"id": order_gid}, store=store)
    node = data["node"]
    current_note = (node or {}).get("note") or ""
    new_note = (current_note + ("\n" if current_note and not current_note.endswith("\n") else "") + append_text).strip()

    mutation = """
    mutation UpdateOrder($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
    """
    data2 = await shopify_graphql(mutation, {"input": {"id": order_gid, "note": new_note}}, store=store)
    errs = (((data2 or {}).get("orderUpdate") or {}).get("userErrors")) or []
    if errs:
        raise HTTPException(status_code=400, detail=f"Shopify note update failed: {errs}")
    return data2


# ---------- Audit/event helpers ----------
def _normalize_store(store: Optional[str]) -> str:
    val = (store or "irrakids").strip().lower()
    return val if val else "irrakids"


async def _record_user_action(
    session: AsyncSession,
    *,
    user_id: str,
    order_number: Optional[str],
    order_gid: Optional[str],
    store_key: str,
    action: str,
    metadata: Optional[Dict[str, Any]] = None,
):
    ev = OrderEvent(
        order_number=(order_number or "").lstrip("#") or (order_gid or ""),
        order_gid=order_gid,
        store_key=_normalize_store(store_key),
        user_id=user_id,
        action=action,
        event_metadata=metadata or {},
    )
    session.add(ev)
    await session.flush()
    await _bump_daily_stats(session, user_id=user_id, store_key=store_key, action=action)


async def _bump_daily_stats(session: AsyncSession, *, user_id: str, store_key: str, action: str):
    day = datetime.now(timezone.utc).date()
    key = (user_id, day, _normalize_store(store_key))
    row = await session.get(DailyUserStats, key)
    if not row:
        row = DailyUserStats(
            user_id=key[0],
            day=key[1],
            store_key=key[2],
            collected_count=1 if action == "collected" else 0,
            out_count=1 if action == "out" else 0,
        )
        session.add(row)
        await session.flush()
        return

    if action == "collected":
        row.collected_count = (row.collected_count or 0) + 1
    elif action == "out":
        row.out_count = (row.out_count or 0) + 1
    row.updated_at = datetime.now(timezone.utc)
    await session.flush()


def _parse_date(date_str: Optional[str]) -> Optional[datetime]:
    if not date_str:
        return None
    try:
        return datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)
    except Exception:
        return None

@app.post("/api/orders/{order_gid:path}/add-tag")
async def add_tag(order_gid: str, payload: TagPayload, store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    data = await _shopify_add_tag(order_gid, payload.tag, store)
    await manager.broadcast({"type": "order.tag_added", "id": order_gid, "tag": payload.tag})
    return {"ok": True, "result": data}

@app.post("/api/orders/{order_gid:path}/remove-tag")
async def remove_tag(order_gid: str, payload: TagPayload, store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    data = await _shopify_remove_tag(order_gid, payload.tag, store)
    await manager.broadcast({"type": "order.tag_removed", "id": order_gid, "tag": payload.tag})
    return {"ok": True, "result": data}

class AppendNotePayload(BaseModel):
    append: str

@app.post("/api/orders/{order_gid:path}/append-note")
async def append_note(order_gid: str, payload: AppendNotePayload, store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    data2 = await _shopify_append_note(order_gid, payload.append, store)
    await manager.broadcast({"type": "order.note_updated", "id": order_gid, "note": payload.append})
    return {"ok": True, "result": data2}


# ---------- Collector actions with audit logging ----------
if HAVE_AUTH_DB:
    @app.post("/api/orders/{order_gid:path}/collected")
    async def mark_collected(
        order_gid: str,
        body: OrderActionBody,
        store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'"),
        user: User = Depends(get_current_user),  # type: ignore
        session: AsyncSession = Depends(get_session),  # type: ignore
    ):
        store_key = _normalize_store(store or body.store)
        # Idempotency: if already recorded, do not bump counts again.
        try:
            existing = await session.scalar(
                select(OrderEvent).where(
                    OrderEvent.order_gid == order_gid,
                    OrderEvent.store_key == store_key,
                    OrderEvent.action == "collected",
                )
            )
        except Exception:
            existing = None
        try:
            await _shopify_add_tag(order_gid, "pc", store_key)
        except HTTPException as e:
            # surface Shopify errors cleanly
            raise e
        if existing:
            # IMPORTANT: don't touch ORM attributes after rollback/expire (can trigger async IO in sync context).
            return {"ok": True, "deduped": True}
        await _record_user_action(
            session,
            user_id=user.id,
            order_number=(body.order_number or "").lstrip("#"),
            order_gid=order_gid,
            store_key=store_key,
            action="collected",
            metadata=body.metadata,
        )
        try:
            await session.commit()
        except IntegrityError:
            # Race: another request inserted the same action concurrently.
            try:
                await session.rollback()
            except Exception:
                pass
            return {"ok": True, "deduped": True}
        await manager.broadcast({"type": "order.collected", "id": order_gid, "store": store_key, "user_id": user.id})
        return {"ok": True}
else:
    @app.post("/api/orders/{order_gid:path}/collected")
    async def mark_collected_unavailable(order_gid: str):
        raise HTTPException(status_code=503, detail="auth/db not configured")


if HAVE_AUTH_DB:
    @app.post("/api/orders/{order_gid:path}/out")
    async def mark_out(
        order_gid: str,
        body: OrderActionBody,
        store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'"),
        user: User = Depends(get_current_user),  # type: ignore
        session: AsyncSession = Depends(get_session),  # type: ignore
    ):
        store_key = _normalize_store(store or body.store)
        # Idempotency: if already recorded, do not bump counts again.
        try:
            existing = await session.scalar(
                select(OrderEvent).where(
                    OrderEvent.order_gid == order_gid,
                    OrderEvent.store_key == store_key,
                    OrderEvent.action == "out",
                )
            )
        except Exception:
            existing = None
        note_text = None
        if body.metadata:
            note_text = body.metadata.get("note") or body.metadata.get("titles")
        if note_text:
            await _shopify_append_note(order_gid, f"OUT: {note_text}", store_key)
        await _shopify_add_tag(order_gid, "out", store_key)
        if existing:
            return {"ok": True, "deduped": True}
        await _record_user_action(
            session,
            user_id=user.id,
            order_number=(body.order_number or "").lstrip("#"),
            order_gid=order_gid,
            store_key=store_key,
            action="out",
            metadata=body.metadata,
        )
        try:
            await session.commit()
        except IntegrityError:
            try:
                await session.rollback()
            except Exception:
                pass
            return {"ok": True, "deduped": True}
        await manager.broadcast({"type": "order.out", "id": order_gid, "store": store_key, "user_id": user.id})
        return {"ok": True}
else:
    @app.post("/api/orders/{order_gid:path}/out")
    async def mark_out_unavailable(order_gid: str):
        raise HTTPException(status_code=503, detail="auth/db not configured")


class StatsRow(BaseModel):
    user_id: str
    email: Optional[str] = None
    name: Optional[str] = None
    day: str
    store: str
    collected: int
    out: int
    total: int


if HAVE_AUTH_DB:
    @app.get("/api/admin/users/stats", response_model=Dict[str, Any])
    async def admin_user_stats(
        from_date: Optional[str] = Query(None, description="Inclusive start date (YYYY-MM-DD)"),
        to_date: Optional[str] = Query(None, description="Inclusive end date (YYYY-MM-DD)"),
        store: Optional[str] = Query(None, description="Optional store filter"),
        admin: User = Depends(require_admin),  # type: ignore
        session: AsyncSession = Depends(get_session),  # type: ignore
    ):
        start_dt = _parse_date(from_date) or (datetime.now(timezone.utc) - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
        end_dt = _parse_date(to_date) or datetime.now(timezone.utc)
        # make end inclusive by adding 1 day
        end_dt_inclusive = end_dt + timedelta(days=1)
        store_key = _normalize_store(store) if store else None

        stmt = (
            select(
                User.id,
                User.email,
                User.name,
                func.date(OrderEvent.created_at).label("day"),
                OrderEvent.store_key,
                func.sum(case((OrderEvent.action == "collected", 1), else_=0)).label("collected"),
                func.sum(case((OrderEvent.action == "out", 1), else_=0)).label("out"),
            )
            .join(OrderEvent, User.id == OrderEvent.user_id)
            .where(OrderEvent.created_at >= start_dt, OrderEvent.created_at < end_dt_inclusive)
            .group_by(User.id, User.email, User.name, func.date(OrderEvent.created_at), OrderEvent.store_key)
            .order_by(func.date(OrderEvent.created_at).desc())
        )
        if store_key:
            stmt = stmt.where(OrderEvent.store_key == store_key)

        result = await session.execute(stmt)
        rows = []
        for uid, email, name, day_val, store_val, collected, out in result.fetchall():
            day_str = day_val.isoformat() if hasattr(day_val, "isoformat") else str(day_val)
            collected_int = int(collected or 0)
            out_int = int(out or 0)
            rows.append(
                StatsRow(
                    user_id=uid,
                    email=email,
                    name=name,
                    day=day_str,
                    store=store_val,
                    collected=collected_int,
                    out=out_int,
                    total=collected_int + out_int,
                ).dict()
            )

        summary = {}
        for r in rows:
            user_key = r["user_id"]
            if user_key not in summary:
                summary[user_key] = {"email": r["email"], "name": r["name"], "collected": 0, "out": 0, "total": 0}
            summary[user_key]["collected"] += r["collected"]
            summary[user_key]["out"] += r["out"]
            summary[user_key]["total"] += r["total"]

        return {
            "ok": True,
            "rows": rows,
            "summary": summary,
            "from": start_dt.date().isoformat(),
            "to": end_dt.date().isoformat(),
            "store": store_key or "all",
        }
else:
    @app.get("/api/admin/users/stats", response_model=Dict[str, Any])
    async def admin_user_stats_unavailable():
        raise HTTPException(status_code=503, detail="auth/db not configured")


# ---------- Admin: OUT orders details ----------
if HAVE_AUTH_DB:
    @app.get("/api/admin/out-events", response_model=Dict[str, Any])
    async def admin_out_events(
        from_date: Optional[str] = Query(None, description="Inclusive start date (YYYY-MM-DD)"),
        to_date: Optional[str] = Query(None, description="Inclusive end date (YYYY-MM-DD)"),
        store: Optional[str] = Query(None, description="Optional store filter"),
        admin: User = Depends(require_admin),  # type: ignore
        session: AsyncSession = Depends(get_session),  # type: ignore
    ):
        start_dt = _parse_date(from_date) or (datetime.now(timezone.utc) - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
        end_dt = _parse_date(to_date) or datetime.now(timezone.utc)
        end_dt_inclusive = end_dt + timedelta(days=1)
        store_key = _normalize_store(store) if store else None

        stmt = (
            select(
                OrderEvent.order_number,
                OrderEvent.order_gid,
                OrderEvent.store_key,
                OrderEvent.created_at,
                OrderEvent.event_metadata,
                User.email,
                User.name,
                User.id,
            )
            .join(User, User.id == OrderEvent.user_id)
            .where(
                OrderEvent.action == "out",
                OrderEvent.created_at >= start_dt,
                OrderEvent.created_at < end_dt_inclusive,
            )
            .order_by(OrderEvent.created_at.desc())
        )
        if store_key:
            stmt = stmt.where(OrderEvent.store_key == store_key)

        result = await session.execute(stmt)
        out_rows: List[Dict[str, Any]] = []
        for order_number, order_gid, store_val, created_at, meta, email, name, uid in result.fetchall():
            titles = None
            try:
                titles = (meta or {}).get("titles")
            except Exception:
                titles = None
            out_rows.append(
                {
                    "order_number": order_number,
                    "order_gid": order_gid,
                    "store": store_val,
                    "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at),
                    "titles": titles,
                    "user": {"id": uid, "email": email, "name": name},
                }
            )

        return {"ok": True, "rows": out_rows, "from": start_dt.date().isoformat(), "to": end_dt.date().isoformat(), "store": store_key or "all"}
else:
    @app.get("/api/admin/out-events", response_model=Dict[str, Any])
    async def admin_out_events_unavailable():
        raise HTTPException(status_code=503, detail="auth/db not configured")


# ---------- Fulfillment (fulfill all remaining quantities) ----------
class FulfillSelectionItem(BaseModel):
    id: str
    quantity: int

class FulfillSelectionGroup(BaseModel):
    fulfillmentOrderId: str
    fulfillmentOrderLineItems: List[FulfillSelectionItem]

class FulfillRequest(BaseModel):
    lineItemsByFulfillmentOrder: Optional[List[FulfillSelectionGroup]] = None
    notifyCustomer: Optional[bool] = False

@app.post("/api/orders/{order_gid:path}/fulfill")
async def fulfill_order(order_gid: str, body: FulfillRequest, store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    # 1) Fetch fulfillment orders for the order and gather remaining quantities
    q = """
    query GetFO($id: ID!) {
      order(id: $id) {
        id
        fulfillmentOrders(first: 50) {
          nodes {
            id
            status
            lineItems(first: 100) {
              nodes {
                id
                remainingQuantity
                lineItem {
                  id
                  sku
                  variant { id title }
                }
              }
            }
          }
        }
      }
    }
    """
    data = await shopify_graphql(q, {"id": order_gid}, store=store)
    order_node = data.get("order") or {}
    fo_nodes = ((order_node.get("fulfillmentOrders") or {}).get("nodes")) or []
    groups_payload: List[Dict[str, Any]] = []
    if body and body.lineItemsByFulfillmentOrder:
        # Use explicit selections from the client
        for g in (body.lineItemsByFulfillmentOrder or []):
            try:
                groups_payload.append({
                    "fulfillmentOrderId": g.fulfillmentOrderId,
                    "fulfillmentOrderLineItems": [{"id": it.id, "quantity": int(it.quantity)} for it in (g.fulfillmentOrderLineItems or []) if int(it.quantity) > 0],
                })
            except Exception:
                continue
        # Drop empty groups
        groups_payload = [g for g in groups_payload if g.get("fulfillmentOrderLineItems")]
        if not groups_payload:
            return {"ok": False, "errors": [{"message": "No valid selections provided"}]}
    else:
        # Default: fulfill all remaining
        for fo in fo_nodes:
            try:
                fo_id = fo.get("id")
                items: List[Dict[str, Any]] = []
                for li in ((fo.get("lineItems") or {}).get("nodes") or []):
                    rem = int(li.get("remainingQuantity") or 0)
                    if rem > 0:
                        items.append({"id": li.get("id"), "quantity": rem})
                if items:
                    groups_payload.append({"fulfillmentOrderId": fo_id, "fulfillmentOrderLineItems": items})
            except Exception:
                continue
        if not groups_payload:
            return {"ok": True, "fulfilled": False, "reason": "no_remaining"}
    # 2) Create fulfillment for all remaining quantities
    mutation = """
    mutation Fulfill($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }
    """
    payload = {
        "lineItemsByFulfillmentOrder": groups_payload,
        "notifyCustomer": bool(getattr(body, "notifyCustomer", False) if body else False),
    }
    resp = await shopify_graphql(mutation, {"fulfillment": payload}, store=store)
    res = (resp.get("fulfillmentCreateV2") or {})
    ues = res.get("userErrors") or []
    if ues:
        # Return errors but 200 to surface in UI
        return {"ok": False, "errors": ues}
    # Notify clients best-effort
    try:
        await manager.broadcast({"type": "order.fulfilled", "id": order_gid})
    except Exception:
        pass
    return {"ok": True, "result": res}

@app.get("/api/orders/{order_gid:path}/fulfillment-orders")
async def get_fulfillment_orders(order_gid: str, store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    q = """
    query GetFO($id: ID!) {
      order(id: $id) {
        id
        fulfillmentOrders(first: 50) {
          nodes {
            id
            status
            lineItems(first: 100) {
              nodes {
                id
                remainingQuantity
                lineItem {
                  id
                  sku
                  variant { id title }
                }
              }
            }
          }
        }
      }
    }
    """
    data = await shopify_graphql(q, {"id": order_gid}, store=store)
    order_node = data.get("order") or {}
    fo_nodes = ((order_node.get("fulfillmentOrders") or {}).get("nodes")) or []
    out: List[Dict[str, Any]] = []
    for fo in fo_nodes:
        items = []
        for li in ((fo.get("lineItems") or {}).get("nodes") or []):
            try:
                itm = {
                    "id": li.get("id"),
                    "remainingQuantity": int(li.get("remainingQuantity") or 0),
                    "sku": (((li.get("lineItem") or {}) or {}).get("sku")),
                    "variantId": ((((li.get("lineItem") or {}) or {}).get("variant") or {}) or {}).get("id"),
                    "title": ((((li.get("lineItem") or {}) or {}).get("variant") or {}) or {}).get("title"),
                }
                items.append(itm)
            except Exception:
                continue
        out.append({"id": fo.get("id"), "status": fo.get("status"), "lineItems": items})
    return {"ok": True, "fulfillmentOrders": out}


# ---------- Invoice verifier helpers ----------
class InvoiceLookupRequest(BaseModel):
    order_numbers: List[str]
    # If the max-min spread across order numbers is >= gap_threshold, we split stores by midpoint:
    # larger numbers => irrakids, smaller => irranova.
    gap_threshold: int = 30000


class InvoiceLookupRow(BaseModel):
    order_number: str
    store: Optional[str] = None
    found: bool = False
    order_gid: Optional[str] = None
    total_price: Optional[float] = None
    financial_status: Optional[str] = None
    error: Optional[str] = None


def _infer_store_by_number_cluster(order_numbers: List[str], *, gap_threshold: int = 30000) -> Dict[str, Optional[str]]:
    """
    Returns mapping order_number -> inferred store (irrakids|irranova|None).
    If we can't confidently split, values will be None (caller can try both stores).
    """
    nums: List[Tuple[str, int]] = []
    for s in (order_numbers or []):
        try:
            raw = (s or "").strip().lstrip("#")
            if not raw:
                continue
            # keep digits only (defensive)
            import re
            m = re.search(r"(\d+)", raw)
            if not m:
                continue
            nums.append((raw, int(m.group(1))))
        except Exception:
            continue
    if not nums:
        return {str(s or "").strip().lstrip("#"): None for s in (order_numbers or []) if str(s or "").strip()}
    values = [n for _, n in nums]
    mn = min(values)
    mx = max(values)
    if (mx - mn) < int(gap_threshold or 30000):
        # ambiguous; do not guess
        return {k: None for k, _ in nums}
    mid = (mx + mn) / 2.0
    out: Dict[str, Optional[str]] = {}
    for k, n in nums:
        out[k] = "irrakids" if n > mid else "irranova"
    return out


async def _shopify_find_order_by_number(order_number: str, *, store: str) -> Optional[Dict[str, Any]]:
    n = (order_number or "").strip().lstrip("#")
    if not n or not n.isdigit():
        return None
    # Ensure we can match archived/closed as well.
    q = f"status:any name:{n}"
    query = """
    query FindOrderByNumber($first: Int!, $query: String!) {
      orders(first: $first, query: $query) {
        edges {
          node {
            id
            name
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalPriceSet { shopMoney { amount currencyCode } }
            displayFinancialStatus
          }
        }
      }
    }
    """
    data = await shopify_graphql(query, {"first": 1, "query": q}, store=store)
    edges = ((data.get("orders") or {}).get("edges")) or []
    if not edges:
        return None
    node = (edges[0] or {}).get("node") or {}
    if not node:
        return None
    # Price logic mirrors map_order_node()
    price = 0.0
    try:
        ctps = (node.get("currentTotalPriceSet") or {}).get("shopMoney") or {}
        tps = (node.get("totalPriceSet") or {}).get("shopMoney") or {}
        amt = ctps.get("amount") or tps.get("amount") or 0
        price = float(amt)
    except Exception:
        price = 0.0
    return {
        "id": node.get("id"),
        "name": node.get("name"),
        "total_price": price,
        "financial_status": node.get("displayFinancialStatus"),
    }


@app.post("/api/invoices/lookup-orders", response_model=Dict[str, Any])
async def invoice_lookup_orders(body: InvoiceLookupRequest, admin: User = Depends(require_admin)):  # type: ignore
    # Normalize + dedupe while preserving order
    nums: List[str] = []
    seen = set()
    for x in (body.order_numbers or []):
        k = (str(x or "").strip().lstrip("#"))
        if not k:
            continue
        if k in seen:
            continue
        seen.add(k)
        nums.append(k)

    inferred = _infer_store_by_number_cluster(nums, gap_threshold=int(body.gap_threshold or 30000))
    rows: List[InvoiceLookupRow] = []

    # Quick env sanity check per store (so we can return friendly errors)
    async def _store_ready(store_key: str) -> bool:
        try:
            domain, token, _ = await resolve_store_settings_effective(store_key)
            return bool(domain and token)
        except Exception:
            return False

    store_ready = {
        "irrakids": await _store_ready("irrakids"),
        "irranova": await _store_ready("irranova"),
    }

    sem = asyncio.Semaphore(8)

    async def _lookup_one(n: str) -> InvoiceLookupRow:
        async with sem:
            preferred = (inferred.get(n) or "").strip().lower() or None
            stores_to_try = []
            if preferred in ("irrakids", "irranova"):
                stores_to_try = [preferred, ("irranova" if preferred == "irrakids" else "irrakids")]
            else:
                stores_to_try = ["irrakids", "irranova"]

            last_err = None
            for st in stores_to_try:
                if not store_ready.get(st):
                    last_err = f"Shopify store '{st}' not configured"
                    continue
                try:
                    found = await _shopify_find_order_by_number(n, store=st)
                    if found:
                        return InvoiceLookupRow(
                            order_number=n,
                            store=st,
                            found=True,
                            order_gid=found.get("id"),
                            total_price=float(found.get("total_price") or 0),
                            financial_status=found.get("financial_status"),
                        )
                except Exception as e:
                    last_err = str(getattr(e, "detail", None) or getattr(e, "message", None) or str(e))
                    continue
            return InvoiceLookupRow(order_number=n, store=preferred, found=False, error=last_err or "Order not found")

    results = await asyncio.gather(*[_lookup_one(n) for n in nums])
    rows = [r for r in results if r]
    return {"ok": True, "rows": [json.loads(r.json()) for r in rows]}


class InvoiceMarkPaidOrder(BaseModel):
    order_gid: str
    store: str


class InvoiceMarkPaidRequest(BaseModel):
    orders: List[InvoiceMarkPaidOrder]


@app.post("/api/invoices/mark-paid", response_model=Dict[str, Any])
async def invoice_mark_paid(body: InvoiceMarkPaidRequest, admin: User = Depends(require_admin)):  # type: ignore
    items = body.orders or []
    # Defensive dedupe
    dedup: List[InvoiceMarkPaidOrder] = []
    seen = set()
    for it in items:
        try:
            gid = (it.order_gid or "").strip()
            st = (it.store or "").strip().lower()
            if not gid or st not in ("irrakids", "irranova"):
                continue
            key = f"{st}|{gid}"
            if key in seen:
                continue
            seen.add(key)
            dedup.append(InvoiceMarkPaidOrder(order_gid=gid, store=st))
        except Exception:
            continue

    mutation = """
    mutation MarkOrderPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        order { id displayFinancialStatus }
        userErrors { field message }
      }
    }
    """

    sem = asyncio.Semaphore(6)

    async def _mark_one(it: InvoiceMarkPaidOrder) -> Dict[str, Any]:
        async with sem:
            try:
                resp = await shopify_graphql(mutation, {"input": {"id": it.order_gid}}, store=it.store)
                payload = (resp.get("orderMarkAsPaid") or {})
                errs = payload.get("userErrors") or []
                if errs:
                    return {"ok": False, "store": it.store, "order_gid": it.order_gid, "errors": errs}
                return {
                    "ok": True,
                    "store": it.store,
                    "order_gid": it.order_gid,
                    "financial_status": ((payload.get("order") or {}) or {}).get("displayFinancialStatus"),
                }
            except Exception as e:
                return {"ok": False, "store": it.store, "order_gid": it.order_gid, "error": str(getattr(e, "detail", None) or str(e))}

    results = await asyncio.gather(*[_mark_one(it) for it in dedup])
    ok_count = sum(1 for r in results if r and r.get("ok"))
    return {"ok": True, "updated": ok_count, "results": results}

# ---------- Shopify Webhook (orders/update) ----------
def _secret_for_shop(shop_domain: str) -> str:
    sd = (shop_domain or "").strip().lower()
    # Exact domain match has priority
    if IRRANOVA_STORE_DOMAIN and sd == IRRANOVA_STORE_DOMAIN and SHOPIFY_WEBHOOK_SECRET_IRRANOVA:
        return SHOPIFY_WEBHOOK_SECRET_IRRANOVA
    if IRRAKIDS_STORE_DOMAIN and sd == IRRAKIDS_STORE_DOMAIN and SHOPIFY_WEBHOOK_SECRET_IRRAKIDS:
        return SHOPIFY_WEBHOOK_SECRET_IRRAKIDS
    # Fallback to substring match
    if "irranova" in sd and SHOPIFY_WEBHOOK_SECRET_IRRANOVA:
        return SHOPIFY_WEBHOOK_SECRET_IRRANOVA
    if "irrakids" in sd and SHOPIFY_WEBHOOK_SECRET_IRRAKIDS:
        return SHOPIFY_WEBHOOK_SECRET_IRRAKIDS
    return SHOPIFY_WEBHOOK_SECRET_DEFAULT

def _store_key_for_shop_domain(shop_domain: str) -> Optional[str]:
    sd = (shop_domain or "").strip().lower()
    # Prefer explicit domain mapping
    if IRRANOVA_STORE_DOMAIN and sd == IRRANOVA_STORE_DOMAIN:
        return "irranova"
    if IRRAKIDS_STORE_DOMAIN and sd == IRRAKIDS_STORE_DOMAIN:
        return "irrakids"
    # Fallback by substring
    if "irranova" in sd:
        return "irranova"
    if "irrakids" in sd:
        return "irrakids"
    return None

def _verify_shopify_hmac(raw_body: bytes, recv_hmac: str, secret: str) -> bool:
    if not secret:
        return True
    calc = base64.b64encode(hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).digest()).decode()
    return hmac.compare_digest((recv_hmac or "").strip(), calc)

def _is_auto_tagging_enabled_for_store(store_key: Optional[str]) -> bool:
    sk = (store_key or "").strip().lower()
    # Specific per-store override if explicitly set, else fall back to global flag
    if sk == "irrakids" and AUTO_TAGGING_ENABLED_IRRAKIDS:
        val = AUTO_TAGGING_ENABLED_IRRAKIDS
        return val in ("1", "true", "TRUE", "yes", "on")
    if sk == "irranova" and AUTO_TAGGING_ENABLED_IRRANOVA:
        val = AUTO_TAGGING_ENABLED_IRRANOVA
        return val in ("1", "true", "TRUE", "yes", "on")
    return bool(AUTO_TAGGING_ENABLED)

@lru_cache(maxsize=1)
def _load_address_aliases() -> Dict[str, str]:
    path = (ADDRESS_ALIAS_FILE or "").strip()
    if not path:
        return {}
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    # Normalize keys/values to strings
                    out = {}
                    for k, v in data.items():
                        try:
                            out[str(k)] = str(v)
                        except Exception:
                            continue
                    return out
    except Exception:
        pass
    return {}

def _parse_bounds() -> Optional[Tuple[Tuple[float, float], Tuple[float, float]]]:
    try:
        sw_parts = [float(x) for x in GEO_BOUNDS_SW.split(",")]
        ne_parts = [float(x) for x in GEO_BOUNDS_NE.split(",")]
        if len(sw_parts) == 2 and len(ne_parts) == 2:
            return ((sw_parts[0], sw_parts[1]), (ne_parts[0], ne_parts[1]))
    except Exception:
        return None
    return None

def _parse_iso8601(s: str) -> Optional[datetime]:
    try:
        st = s.strip()
        if st.endswith("Z"):
            st = st[:-1] + "+00:00"
        return datetime.fromisoformat(st)
    except Exception:
        return None

def _created_at_passes_cutoff(created_at_str: Optional[str]) -> bool:
    if not PC_TAG_MIN_CREATED_AT:
        return True
    try:
        cutoff = _parse_iso8601(PC_TAG_MIN_CREATED_AT)
        created = _parse_iso8601((created_at_str or "").strip())
        if not cutoff or not created:
            return True
        # Normalize to UTC for compare
        if not cutoff.tzinfo:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
        if not created.tzinfo:
            created = created.replace(tzinfo=timezone.utc)
        return created >= cutoff
    except Exception:
        return True

@app.post("/api/shopify/webhooks/orders/update")
async def orders_update_webhook(
    request: Request,
    x_shopify_hmac_sha256: Optional[str] = Header(default=None),
    x_shopify_shop_domain: Optional[str] = Header(default=None),
):
    import time
    raw = await request.body()
    secret = _secret_for_shop(x_shopify_shop_domain or "")
    if not _verify_shopify_hmac(raw, x_shopify_hmac_sha256 or "", secret):
        raise HTTPException(status_code=401, detail="bad hmac")

    data = await request.json()
    # Only collect minimal customer info for overrides cache; do not enqueue here
    try:
        order_name = (data.get("name") or "").strip()
        if order_name:
            key = order_name.lstrip("#")
            customer = data.get("customer") or {}
            shipping = data.get("shipping_address") or {}
            store_key = _store_key_for_shop_domain(x_shopify_shop_domain or "")
            overrides = {
                "store": store_key,
                "customer": {
                    "displayName": ((customer.get("first_name") or "").strip() + (" " + (customer.get("last_name") or "").strip() if customer.get("last_name") else "")).strip(),
                    "email": customer.get("email") or data.get("email"),
                    "phone": (customer.get("phone") or data.get("phone")),
                },
                "shippingAddress": {
                    "name": (shipping.get("name") or (str(shipping.get("first_name") or "").strip() + " " + str(shipping.get("last_name") or "").strip()).strip()),
                    "address1": shipping.get("address1"),
                    "address2": shipping.get("address2"),
                    "city": shipping.get("city"),
                    "zip": shipping.get("zip") or shipping.get("postal_code"),
                    "province": shipping.get("province"),
                    "country": shipping.get("country"),
                    "phone": shipping.get("phone") or customer.get("phone") or data.get("phone"),
                },
                "email": data.get("email"),
                "phone": data.get("phone"),
                "tags": data.get("tags"),
            }
            ORDER_OVERRIDES[key] = overrides
            # keep dedupe timestamps minimal to avoid growth
            RECENT_ENQUEUED_ORDERS[key] = int(time.time())
    except Exception:
        pass
    return {"ok": True}

@app.get("/api/overrides")
async def get_overrides(
    orders: str = Query(""),
    store: Optional[str] = Query(None),
    force_live: bool = Query(False, description="If true, attempt live fetch even if cached"),
):
    keys = [o.strip().lstrip("#") for o in (orders or "").split(",") if o.strip()]
    out: Dict[str, Any] = {}

    def _override_is_complete(ov: Dict[str, Any]) -> bool:
        try:
            cust = (ov.get("customer") or {})
            shp = (ov.get("shippingAddress") or {})
            # Minimal completeness: name present (from customer or shipping) AND at least one contact (email/phone)
            name_ok = bool(((cust.get("displayName") or "").strip()) or ((shp.get("name") or "").strip()))
            contact_ok = bool(((cust.get("email") or ov.get("email") or "").strip()) or ((cust.get("phone") or ov.get("phone") or (shp.get("phone") or "")).strip()))
            return name_ok and contact_ok
        except Exception:
            return False

    # Seed with cache if present
    for k in keys:
        if k in ORDER_OVERRIDES:
            out[k] = ORDER_OVERRIDES[k]

    async def _fetch_live_for_store(store_key: str):
        try:
            domain, access_token, api_key = await resolve_store_settings_effective(store_key)
            if not domain or not access_token:
                return
            for k in keys:
                # Skip if we already have complete data and not forcing live
                if (k in out) and _override_is_complete(out[k]) and not force_live:
                    continue
                try:
                    name = _requests.utils.quote(f"#{k}")
                    url = f"https://{domain}/admin/api/{SHOPIFY_API_VERSION}/orders.json?name={name}&status=any"
                    headers = {"X-Shopify-Access-Token": access_token, "Accept": "application/json"}
                    r = _requests.get(url, headers=headers, timeout=30)
                    r.raise_for_status()
                    js = r.json().get("orders", [])
                    if not js:
                        continue
                    oid = js[0]["id"]
                    r2 = _requests.get(f"https://{domain}/admin/api/{SHOPIFY_API_VERSION}/orders/{oid}.json", headers=headers, timeout=30)
                    r2.raise_for_status()
                    ord_full = (r2.json() or {}).get("order") or {}
                    cust = (ord_full.get("customer") or {})
                    shp = (ord_full.get("shipping_address") or {})
                    # Root-level contact fallbacks
                    root_email = (ord_full.get("email") or "").strip()
                    root_phone = (ord_full.get("phone") or "").strip()
                    ov = {
                        "store": store_key,
                        "customer": {
                            "displayName": ((cust.get("first_name") or "").strip() + (" " + (cust.get("last_name") or "").strip() if cust.get("last_name") else "")).strip(),
                            "email": (cust.get("email") or root_email or None),
                            "phone": (cust.get("phone") or root_phone or None),
                        },
                        "shippingAddress": {
                            "name": (shp.get("name") or (str(shp.get("first_name") or "").strip() + " " + str(shp.get("last_name") or "").strip()).strip()),
                            "address1": shp.get("address1"),
                            "address2": shp.get("address2"),
                            "city": shp.get("city"),
                            "zip": shp.get("zip") or shp.get("postal_code"),
                            "province": shp.get("province"),
                            "country": shp.get("country"),
                            "phone": shp.get("phone") or cust.get("phone") or root_phone or None,
                        },
                        # Keep convenience root-level contact copies too
                        "email": (root_email or cust.get("email")),
                        "phone": (root_phone or cust.get("phone")),
                    }
                    # Save result
                    out[k] = ov
                    ORDER_OVERRIDES[k] = ov
                except Exception:
                    continue
        except Exception:
            return

    store_key = (store or "").strip().lower()
    # Attempt live enrichment for the requested store; if none provided, try both
    if store_key:
        await _fetch_live_for_store(store_key)
    else:
        await _fetch_live_for_store("irrakids")
        await _fetch_live_for_store("irranova")

    return {"ok": True, "overrides": out}

# Print-friendly data: only unfulfilled items and current total
@app.get("/api/print-data")
async def get_print_data(numbers: str = Query("", description="Comma-separated order names (e.g. #1234,#1235)"), store: Optional[str] = Query(None)):
    # Normalize numbers
    nums = [n.strip().lstrip("#") for n in (numbers or "").split(",") if n.strip()]
    if not nums:
        return {"ok": True, "orders": []}

    # Query template: fetch minimal fields for mapping
    query = """
    query Orders($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
        edges {
          cursor
          node {
            id
            name
            tags
            note
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 50) {
              edges {
                node {
                  quantity
                  unfulfilledQuantity
                  sku
                  variant { id title barcode image { url } product { id featuredImage { url } } }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
    """

    out = []
    for n in nums:
        try:
            variables = {"first": 1, "after": None, "query": f"name:{n}"}
            data = await shopify_graphql(query, variables, store=store)
            edges = (data.get("orders") or {}).get("edges") or []
            if not edges:
                continue
            dto = map_order_node(edges[0]["node"])
            items = []
            for v in (dto.variants or []):
                st = (getattr(v, "status", None) or "").strip().lower()
                if st != "unfulfilled":
                    continue
                uq = getattr(v, "unfulfilled_qty", None)
                qv = int(uq) if (uq is not None and int(uq) > 0) else int(getattr(v, "qty", 0) or 0)
                if qv <= 0:
                    continue
                items.append({
                    "id": getattr(v, "id", None),
                    "sku": getattr(v, "sku", None),
                    "title": getattr(v, "title", None),
                    "qty": qv,
                })
            out.append({
                "number": dto.number,
                "total_price": dto.total_price,
                "variants": items,
                # Include QR code data for reliable local rendering
                "qr_text": f"ORDER:{dto.number}",
                "qr_png_b64": _qr_png_b64(f"ORDER:{dto.number}"),
            })
        except Exception:
            continue

    return {"ok": True, "orders": out}

# --------- SPA client-side routes (serve index.html) ---------
def _frontend_dist_dir() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"))


def _frontend_index_path() -> str:
    return os.path.join(_frontend_dist_dir(), "index.html")


async def _serve_frontend_index_or_404():
    try:
        index_path = _frontend_index_path()
        if os.path.isfile(index_path):
            return FileResponse(index_path)
    except Exception:
        pass
    # Keep default-style response but include useful hint
    return JSONResponse(
        {"detail": "Not Found", "hint": "frontend build missing; expected frontend/dist/index.html in container"},
        status_code=404,
    )


@app.get("/order-lookup")
async def _spa_order_lookup():
    return await _serve_frontend_index_or_404()

@app.get("/order-tagger")
async def _spa_order_tagger():
    return await _serve_frontend_index_or_404()

@app.get("/order-browser")
async def _spa_order_browser():
    return await _serve_frontend_index_or_404()

@app.get("/admin")
async def _spa_admin():
    return await _serve_frontend_index_or_404()


@app.get("/shopify-connect")
async def _spa_shopify_connect():
    return await _serve_frontend_index_or_404()


@app.get("/{full_path:path}")
async def _spa_fallback(full_path: str):
    """
    SPA fallback:
    - Serve static assets if present in frontend/dist
    - Otherwise serve index.html for client-side routes (e.g. /shopify-connect)
    - Never intercept API/WebSocket paths
    """
    p = (full_path or "").lstrip("/")
    if p.startswith("api/") or p == "api" or p.startswith("ws") or p == "ws":
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    try:
        base = _frontend_dist_dir()
        # Serve actual file if it exists (assets, index.css, etc.)
        candidate = os.path.abspath(os.path.join(base, p))
        if candidate.startswith(base) and os.path.isfile(candidate):
            return FileResponse(candidate)
    except Exception:
        pass
    return await _serve_frontend_index_or_404()

# --------- Static frontend (mounted last) ---------
STATIC_DIR = _frontend_dist_dir()
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
else:
    print(f"[WARN] Static directory not found at {STATIC_DIR}. Build the frontend first.")

# Ensure database tables exist on startup (optional)
if HAVE_AUTH_DB and init_db is not None:
    @app.on_event("startup")
    async def _init_db_tables():
        try:
            # Warn loudly if using local SQLite on Cloud Run (not durable, can split per instance).
            try:
                db_url = (os.environ.get("DATABASE_URL") or "sqlite+aiosqlite:///./local.db").strip()
                is_cloud_run = bool(os.environ.get("K_SERVICE") or os.environ.get("K_REVISION"))
                if is_cloud_run and ("sqlite" in db_url.lower()):
                    print("[DB][WARN] Using SQLite on Cloud Run is NOT durable and may cause missing analytics across instances/restarts.")
                    print("[DB][WARN] Configure DATABASE_URL to a persistent database (e.g. Cloud SQL Postgres) for reliable collector analytics.")
            except Exception:
                pass
            await init_db()  # type: ignore
        except Exception as e:
            print(f"[DB] Failed to init tables: {e}")

# Log routes on startup to verify ordering and presence
@app.on_event("startup")
async def _log_routes():
    try:
        print("[ROUTES] Registered routes in order:")
        for r in app.router.routes:
            path = getattr(r, "path", getattr(getattr(r, "router", None), "path", "?"))
            name = getattr(r, "name", getattr(getattr(r, "app", None), "name", ""))
            route_type = r.__class__.__name__
            print(f" - {route_type}: {path} ({name})")
    except Exception as e:
        print(f"[ROUTES] Failed to list routes: {e}")


# ---------- Optional default admin bootstrap (env-based) ----------
# Creates an admin user ONLY IF no admin exists. Useful for first deploy / recovery.
ADMIN_DEFAULT_EMAIL = (os.environ.get("ADMIN_DEFAULT_EMAIL") or "").strip().lower()
ADMIN_DEFAULT_PASSWORD = (os.environ.get("ADMIN_DEFAULT_PASSWORD") or "").strip()
ADMIN_DEFAULT_NAME = (os.environ.get("ADMIN_DEFAULT_NAME") or "").strip()

if HAVE_AUTH_DB:
    @app.on_event("startup")
    async def _ensure_default_admin():
        try:
            if not ADMIN_DEFAULT_EMAIL or not ADMIN_DEFAULT_PASSWORD:
                return
            if SessionLocal is None:
                return
            async with SessionLocal() as session:  # type: ignore
                admin_count = await session.scalar(select(func.count()).select_from(User).where(User.role == "admin"))
                if (admin_count or 0) > 0:
                    return
                email = ADMIN_DEFAULT_EMAIL
                user = await session.scalar(select(User).where(User.email == email))
                if not user:
                    user = User(
                        email=email,
                        name=(ADMIN_DEFAULT_NAME or None),
                        password_hash=hash_password(ADMIN_DEFAULT_PASSWORD),
                        role="admin",
                        is_active=True,
                    )
                    session.add(user)
                else:
                    user.email = email
                    user.name = (ADMIN_DEFAULT_NAME or user.name or "").strip() or None
                    user.password_hash = hash_password(ADMIN_DEFAULT_PASSWORD)
                    user.role = "admin"
                    user.is_active = True
                await session.commit()
                print(f"[AUTH] Default admin ensured: {email}")
        except Exception as e:
            # Never fail startup for this helper
            try:
                print(f"[AUTH] Default admin bootstrap skipped/failed: {e}")
            except Exception:
                pass
