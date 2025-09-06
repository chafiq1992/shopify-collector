import os
import json
from typing import List, Optional, Dict, Any, Tuple
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
import httpx
import hmac, hashlib, base64
from datetime import datetime, timezone
from pydantic import BaseModel

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

    if key == "irranova":
        domain = os.environ.get("IRRANOVA_STORE_DOMAIN", "").strip()
        password = os.environ.get("IRRANOVA_SHOPIFY_PASSWORD", "").strip() or DEFAULT_PASSWORD
        api_key = os.environ.get("IRRANOVA_SHOPIFY_API_KEY", "").strip() or DEFAULT_API_KEY
    else:
        # irrakids
        domain = os.environ.get("IRRAKIDS_STORE_DOMAIN", DEFAULT_DOMAIN).strip()
        password = os.environ.get("IRRAKIDS_SHOPIFY_PASSWORD", "").strip() or DEFAULT_PASSWORD
        api_key = os.environ.get("IRRAKIDS_SHOPIFY_API_KEY", "").strip() or DEFAULT_API_KEY

    return (domain, password, api_key)

# ---------- FastAPI ----------
app = FastAPI(title="Order Collector API", version="1.0.0")

# CORS (relaxed for simplicity; tighten in prod)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

# Optional dedupe/cutoff controls
PC_TAG_MIN_CREATED_AT = os.environ.get("PC_TAG_MIN_CREATED_AT", "").strip()  # ISO8601 e.g., 2025-01-01T00:00:00Z
RECENT_ENQUEUE_SECONDS = int(os.environ.get("RECENT_ENQUEUE_SECONDS", "30").strip() or 30)
RECENT_ENQUEUED_ORDERS: Dict[str, int] = {}

# In-memory queue: { pc_id -> [ { job_id, ts, orders, copies, pdf_url? } ] }
JOBS: Dict[str, list] = {}
# In-memory minimal customer override cache: { order_no -> { customer, shippingAddress, phone, email, tags } }
ORDER_OVERRIDES: Dict[str, Dict[str, Any]] = {}

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
    # If API key is provided, support basic auth style URL
    if api_key and password:
        return f"https://{api_key}:{password}@{domain}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"
    return f"https://{domain}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"

async def shopify_graphql(query: str, variables: Dict[str, Any] | None, *, store: Optional[str]) -> Dict[str, Any]:
    domain, password, api_key = resolve_store_settings(store)
    if not domain or not password:
        raise HTTPException(status_code=400, detail="Shopify credentials not configured for selected store")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    # If not using basic auth in URL, send token/password header
    if not (api_key and password):
        headers["X-Shopify-Access-Token"] = password
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(_shopify_graphql_url(domain, password, api_key), headers=headers, json={"query": query, "variables": variables or {}})
        r.raise_for_status()
        data = r.json()
        if "errors" in data:
            raise RuntimeError(f"Shopify GraphQL errors: {data['errors']}")
        return data["data"]

# ---------- Schemas ----------
class OrderVariant(BaseModel):
    id: Optional[str] = None
    product_id: Optional[str] = None
    image: Optional[str] = None
    sku: Optional[str] = None
    title: Optional[str] = None
    qty: int
    status: Optional[str] = None  # fulfilled | unfulfilled | removed | unknown

class OrderDTO(BaseModel):
    id: str
    number: str
    customer: Optional[str] = None
    shipping_city: Optional[str] = None
    tags: List[str] = []
    note: Optional[str] = None
    variants: List[OrderVariant] = []
    total_price: float = 0.0
    considered_fulfilled: bool = False

# ---------- Helpers ----------
def build_query_string(
    base_query: str,
    status_filter: Optional[str],
    tag_filter: Optional[str],
    search: Optional[str],
    cod_date: Optional[str],
    collect_prefix: Optional[str] = None,
    collect_exclude_tag: Optional[str] = None,
    verification_include_tag: Optional[str] = None,
    exclude_out: bool = False,
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
    # Optional COD date tag: expect dd/mm/yy, add as tag:"cod DD/MM/YY"
    if cod_date:
        tag_val = cod_date.strip()
        if tag_val:
            # quote because of space
            prefix = (collect_prefix or "cod").strip()
            q += f' tag:"{prefix} {tag_val}"'
    # Search: try to search by order name if numeric, else client filters by SKU
    if search:
        s = search.strip().lstrip("#")
        if s.isdigit():
            q += f" name:{s}"
    return q.strip()

def map_order_node(node: Dict[str, Any]) -> OrderDTO:
    variants: List[OrderVariant] = []
    # Use all lineItems; Shopify 2025-01 removed unfulfilledLineItems on Order
    li_edges = node.get("lineItems", {}).get("edges", [])
    for edge in li_edges:
        li = edge["node"]
        img = None
        var = li.get("variant")
        if var and var.get("image"):
            img = var["image"].get("url")
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
            image=img,
            sku=li.get("sku"),
            title=(var or {}).get("title"),
            qty=qty,
            status=status_val,
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
    return OrderDTO(
        id=node["id"],
        number=node["name"],
        customer=(node.get("customer") or {}).get("displayName"),
        shipping_city=((node.get("shippingAddress") or {}) or {}).get("city"),
        tags=node.get("tags") or [],
        note=node.get("note"),
        variants=variants,
        total_price=price,
        considered_fulfilled=considered_fulfilled,
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
    collect_prefix: Optional[str] = Query(None, description="Prefix for COD tag, e.g. 'cod'"),
    collect_exclude_tag: Optional[str] = Query(None, description="Exclude tag for collect filter, e.g. 'pc'"),
    verification_include_tag: Optional[str] = Query(None, description="Include tag for verification filter, e.g. 'pc'"),
    exclude_out: bool = Query(False, description="Exclude orders tagged with 'out'"),
    base_query: Optional[str] = Query(None, description="Raw Shopify query prefix to start from"),
    store: Optional[str] = Query(None, description="Select store: 'irrakids' (default) or 'irranova'"),
):
    domain, password, _ = resolve_store_settings(store)
    if not domain or not password:
        return JSONResponse({"orders": [], "pageInfo": {"hasNextPage": False}, "error": "Shopify env not configured"}, status_code=200)

    q = build_query_string(
        (base_query or ""),
        status_filter,
        tag_filter,
        search,
        cod_date,
        collect_prefix,
        collect_exclude_tag,
        verification_include_tag,
        exclude_out,
    )

    # Build GraphQL query based on store capabilities
    if (store or "irrakids").strip().lower() == "irranova":
        # Avoid PII (customer, shippingAddress) but keep variant fields
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
                      variant {
                        id
                        title
                        image { url }
                        product { id }
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
    else:
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
                shippingAddress { city }
                customer { displayName }
                currentTotalPriceSet { shopMoney { amount currencyCode } }
                totalPriceSet { shopMoney { amount currencyCode } }
                lineItems(first: 50) {
                  edges {
                    node {
                      quantity
                      unfulfilledQuantity
                      sku
                      variant {
                        id
                        title
                        image { url }
                        product { id }
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
    variables = {"first": limit, "after": cursor, "query": q or None}
    data = await shopify_graphql(query, variables, store=store)
    ords = data["orders"]
    items: List[OrderDTO] = [map_order_node(e["node"]) for e in ords["edges"]]

    # Optional client-side SKU filter if search is non-numeric
    if search and not search.strip().lstrip("#").isdigit():
        ss = search.lower().strip()
        items = [o for o in items if any((v.sku or "").lower().find(ss) >= 0 for v in o.variants) or ss in o.number.lower()]

    # Collect: compute ranking globally across a larger window of orders
    if status_filter == "collect":
        target_window = 200
        chunk = 50
        accumulated_edges = []
        after_cursor = None
        # Always try to use a wider window irrespective of incoming limit
        while len(accumulated_edges) < target_window:
            variables2 = {"first": min(chunk, target_window - len(accumulated_edges)), "after": after_cursor, "query": q or None}
            page = await shopify_graphql(query, variables2, store=store)
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
        # Gather unique tags for chips and return with computed page info
        unique_tags = sorted({t for o in items for t in (o.tags or [])})
        total_count_val = 0
        try:
            total_count_val = int((data.get("ordersCount") or {}).get("count") or 0)
        except Exception:
            total_count_val = len(all_items)
        return {
            "orders": [json.loads(o.json()) for o in items],
            "pageInfo": {"hasNextPage": len(all_items) > limit},
            "tags": unique_tags,
            "totalCount": total_count_val,
        }

    # Gather unique tags for chips
    unique_tags = sorted({t for o in items for t in (o.tags or [])})

    total_count_val = 0
    try:
        total_count_val = int((data.get("ordersCount") or {}).get("count") or 0)
    except Exception:
        total_count_val = len(items)
    return {
        "orders": [json.loads(o.json()) for o in items],
        "pageInfo": ords["pageInfo"],
        "tags": unique_tags,
        "totalCount": total_count_val,
    }

class TagPayload(BaseModel):
    tag: str

@app.post("/api/orders/{order_gid:path}/add-tag")
async def add_tag(order_gid: str, payload: TagPayload, store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    mutation = """
    mutation AddTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
    """
    data = await shopify_graphql(mutation, {"id": order_gid, "tags": [payload.tag]}, store=store)
    await manager.broadcast({"type": "order.tag_added", "id": order_gid, "tag": payload.tag})
    return {"ok": True, "result": data}

@app.post("/api/orders/{order_gid:path}/remove-tag")
async def remove_tag(order_gid: str, payload: TagPayload, store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    mutation = """
    mutation RemoveTag($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
    """
    data = await shopify_graphql(mutation, {"id": order_gid, "tags": [payload.tag]}, store=store)
    await manager.broadcast({"type": "order.tag_removed", "id": order_gid, "tag": payload.tag})
    return {"ok": True, "result": data}

class AppendNotePayload(BaseModel):
    append: str

@app.post("/api/orders/{order_gid:path}/append-note")
async def append_note(order_gid: str, payload: AppendNotePayload, store: Optional[str] = Query(None, description="Select store: 'irrakids' or 'irranova'")):
    # Fetch current note
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
    new_note = (current_note + ("\n" if current_note and not current_note.endswith("\n") else "") + payload.append).strip()

    mutation = """
    mutation UpdateOrder($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
    """
    data2 = await shopify_graphql(mutation, {"input": {"id": order_gid, "note": new_note}}, store=store)
    await manager.broadcast({"type": "order.note_updated", "id": order_gid, "note": new_note})
    return {"ok": True, "result": data2}


# ---------- Shopify Webhook (orders/update) ----------
def _secret_for_shop(shop_domain: str) -> str:
    sd = (shop_domain or "").strip().lower()
    if "irranova" in sd and SHOPIFY_WEBHOOK_SECRET_IRRANOVA:
        return SHOPIFY_WEBHOOK_SECRET_IRRANOVA
    if "irrakids" in sd and SHOPIFY_WEBHOOK_SECRET_IRRAKIDS:
        return SHOPIFY_WEBHOOK_SECRET_IRRAKIDS
    return SHOPIFY_WEBHOOK_SECRET_DEFAULT

def _store_key_for_shop_domain(shop_domain: str) -> Optional[str]:
    sd = (shop_domain or "").strip().lower()
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
            overrides = {
                "customer": {
                    "displayName": (customer.get("first_name") or "").strip() + (" " + (customer.get("last_name") or "").strip() if customer.get("last_name") else ""),
                    "email": customer.get("email") or data.get("email"),
                    "phone": (customer.get("phone") or data.get("phone")),
                },
                "shippingAddress": {
                    "name": (shipping.get("name") or "").strip(),
                    "address1": shipping.get("address1"),
                    "address2": shipping.get("address2"),
                    "city": shipping.get("city"),
                    "zip": shipping.get("zip") or shipping.get("postal_code"),
                    "province": shipping.get("province"),
                    "country": shipping.get("country"),
                    "phone": shipping.get("phone"),
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
async def get_overrides(orders: str = Query("")):
    keys = [o.strip().lstrip("#") for o in (orders or "").split(",") if o.strip()]
    out = {k: ORDER_OVERRIDES.get(k) for k in keys if k in ORDER_OVERRIDES}
    return {"ok": True, "overrides": out}

# --------- Static frontend (mounted last) ---------
STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"))
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
else:
    print(f"[WARN] Static directory not found at {STATIC_DIR}. Build the frontend first.")

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
