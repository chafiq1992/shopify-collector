import os
import json
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
import httpx
from pydantic import BaseModel

# ---------- Settings ----------
# Preferred envs per user request
SHOP_DOMAIN = os.environ.get("IRRAKIDS_STORE_DOMAIN", "").strip()  # e.g. myshop.myshopify.com
SHOP_PASSWORD = os.environ.get("SHOPIFY_PASSWORD", "").strip()     # Private app password or Admin token
SHOP_API_KEY = os.environ.get("SHOPIFY_API_KEY", "").strip()        # Optional if using basic auth in URL
SHOPIFY_API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2025-01").strip()

if not SHOP_DOMAIN:
    print("[WARN] IRRAKIDS_STORE_DOMAIN is not set.")
if not SHOP_PASSWORD:
    print("[WARN] SHOPIFY_PASSWORD is not set.")

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
def _shopify_graphql_url() -> str:
    # If API key is provided, support basic auth style URL
    if SHOP_API_KEY and SHOP_PASSWORD:
        return f"https://{SHOP_API_KEY}:{SHOP_PASSWORD}@{SHOP_DOMAIN}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"
    return f"https://{SHOP_DOMAIN}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"

async def shopify_graphql(query: str, variables: Dict[str, Any] | None = None) -> Dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    # If not using basic auth in URL, send token/password header
    if not (SHOP_API_KEY and SHOP_PASSWORD):
        headers["X-Shopify-Access-Token"] = SHOP_PASSWORD
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(_shopify_graphql_url(), headers=headers, json={"query": query, "variables": variables or {}})
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
    return OrderDTO(
        id=node["id"],
        number=node["name"],
        customer=(node.get("customer") or {}).get("displayName"),
        shipping_city=((node.get("shippingAddress") or {}) or {}).get("city"),
        tags=node.get("tags") or [],
        note=node.get("note"),
        variants=variants,
        total_price=price,
    )

# ---------- Routes ----------
@app.get("/api/health")
async def health():
    return {"ok": True}

@app.get("/api/orders")
async def list_orders(
    limit: int = Query(25, ge=1, le=100),
    cursor: Optional[str] = None,
    status_filter: Optional[str] = Query(None, pattern="^(all|collect|verification|urgent)$"),
    tag_filter: Optional[str] = None,
    search: Optional[str] = None,
    cod_date: Optional[str] = Query(None, description="Date for COD tag in format DD/MM/YY"),
    collect_prefix: Optional[str] = Query(None, description="Prefix for COD tag, e.g. 'cod'"),
    collect_exclude_tag: Optional[str] = Query(None, description="Exclude tag for collect filter, e.g. 'pc'"),
    verification_include_tag: Optional[str] = Query(None, description="Include tag for verification filter, e.g. 'pc'"),
    exclude_out: bool = Query(False, description="Exclude orders tagged with 'out'"),
):
    if not SHOP_DOMAIN or not SHOP_PASSWORD:
        return JSONResponse({"orders": [], "pageInfo": {"hasNextPage": False}, "error": "Shopify env not configured"}, status_code=200)

    q = build_query_string(
        "",
        status_filter,
        tag_filter,
        search,
        cod_date,
        collect_prefix,
        collect_exclude_tag,
        verification_include_tag,
        exclude_out,
    )

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
    data = await shopify_graphql(query, variables)
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
            page = await shopify_graphql(query, variables2)
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
async def add_tag(order_gid: str, payload: TagPayload):
    mutation = """
    mutation AddTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
    """
    data = await shopify_graphql(mutation, {"id": order_gid, "tags": [payload.tag]})
    await manager.broadcast({"type": "order.tag_added", "id": order_gid, "tag": payload.tag})
    return {"ok": True, "result": data}

@app.post("/api/orders/{order_gid:path}/remove-tag")
async def remove_tag(order_gid: str, payload: TagPayload):
    mutation = """
    mutation RemoveTag($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
    """
    data = await shopify_graphql(mutation, {"id": order_gid, "tags": [payload.tag]})
    await manager.broadcast({"type": "order.tag_removed", "id": order_gid, "tag": payload.tag})
    return {"ok": True, "result": data}

class AppendNotePayload(BaseModel):
    append: str

@app.post("/api/orders/{order_gid:path}/append-note")
async def append_note(order_gid: str, payload: AppendNotePayload):
    # Fetch current note
    q = """
    query One($id: ID!) {
      node(id: $id) {
        ... on Order { id note }
      }
    }
    """
    data = await shopify_graphql(q, {"id": order_gid})
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
    data2 = await shopify_graphql(mutation, {"input": {"id": order_gid, "note": new_note}})
    await manager.broadcast({"type": "order.note_updated", "id": order_gid, "note": new_note})
    return {"ok": True, "result": data2}


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
