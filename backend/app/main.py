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
    image: Optional[str] = None
    sku: Optional[str] = None
    qty: int

class OrderDTO(BaseModel):
    id: str
    number: str
    customer: Optional[str] = None
    tags: List[str] = []
    note: Optional[str] = None
    variants: List[OrderVariant] = []

# ---------- Helpers ----------
def build_query_string(base_query: str, status_filter: Optional[str], tag_filter: Optional[str], search: Optional[str]) -> str:
    q = base_query.strip() if base_query else ""
    # Status filter based on 'pc' tag presence
    if status_filter == "untagged":
        q += " -tag:pc"
    elif status_filter == "tagged_pc":
        q += " tag:pc"
    # Tag chip filter
    if tag_filter:
        q += f" tag:{tag_filter}"
    # Search: try to search by order name if numeric, else client filters by SKU
    if search:
        s = search.strip().lstrip("#")
        if s.isdigit():
            q += f" name:{s}"
    return q.strip()

def map_order_node(node: Dict[str, Any]) -> OrderDTO:
    variants: List[OrderVariant] = []
    for edge in node.get("lineItems", {}).get("edges", []):
        li = edge["node"]
        img = None
        var = li.get("variant")
        if var and var.get("image"):
            img = var["image"].get("url")
        variants.append(OrderVariant(
            id=(var or {}).get("id"),
            image=img,
            sku=li.get("sku"),
            qty=li.get("quantity", 0),
        ))
    return OrderDTO(
        id=node["id"],
        number=node["name"],
        customer=(node.get("customer") or {}).get("displayName"),
        tags=node.get("tags") or [],
        note=node.get("note"),
        variants=variants,
    )

# ---------- Routes ----------
@app.get("/api/health")
async def health():
    return {"ok": True}

@app.get("/api/orders")
async def list_orders(
    limit: int = Query(25, ge=1, le=100),
    cursor: Optional[str] = None,
    status_filter: Optional[str] = Query(None, pattern="^(all|untagged|tagged_pc)$"),
    tag_filter: Optional[str] = None,
    search: Optional[str] = None,
):
    if not SHOP_DOMAIN or not SHOP_PASSWORD:
        return JSONResponse({"orders": [], "pageInfo": {"hasNextPage": False}, "error": "Shopify env not configured"}, status_code=200)

    q = build_query_string("", status_filter, tag_filter, search)

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
            customer { displayName }
            lineItems(first: 50) {
              edges {
                node {
                  quantity
                  sku
                  variant {
                    id
                    image { url }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
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

    # Gather unique tags for chips
    unique_tags = sorted({t for o in items for t in (o.tags or [])})

    return {
        "orders": [json.loads(o.json()) for o in items],
        "pageInfo": ords["pageInfo"],
        "tags": unique_tags
    }

class TagPayload(BaseModel):
    tag: str

@app.post("/api/orders/{order_gid}/add-tag")
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

class AppendNotePayload(BaseModel):
    append: str

@app.post("/api/orders/{order_gid}/append-note")
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
