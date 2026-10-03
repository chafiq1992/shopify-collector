"""
Create a Shopify order from a chat request (Chat confirmation tab → "Create order").

Provides:
  - GET  /api/chat-requests/customers/lookup     -> Shopify customers by phone / name / email,
                                                    with their address and recent orders
  - GET  /api/chat-requests/product-options      -> one product with every variant and its
                                                    options (size, colour…), resolved from the
                                                    chat's product link or title
  - POST /api/chat-requests/{id}/create-order    -> creates the order in Shopify (cash on
                                                    delivery, payment pending) and closes the
                                                    request as ordered with the new order number
"""

import logging
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth_routes import get_current_user
from .chat_request_routes import (
    CLOSED_STATUSES,
    _clean,
    _clean_multiline,
    _labels_for,
    _normalize_store,
    _shop_domain,
    _users_by_id,
    normalize_phone,
    serialize_request,
)
from .confirmation_routes import _SEARCH_ORDER_NODE_FIELDS, _confirmation_phone_variants, _flatten_order
from .db import get_session
from .models import ChatRequest, ChatRequestEvent, User

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------- Customer lookup ----------

CUSTOMER_LOOKUP_GQL = f"""
query ChatCustomerLookup($first: Int!, $ordersFirst: Int!, $query: String) {{
  customers(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {{
    nodes {{
      id
      displayName
      firstName
      lastName
      email
      phone
      numberOfOrders
      defaultAddress {{ firstName lastName phone address1 address2 city zip countryCodeV2 }}
      orders(first: $ordersFirst, sortKey: CREATED_AT, reverse: true) {{
        edges {{ node {{ {_SEARCH_ORDER_NODE_FIELDS} }} }}
      }}
    }}
  }}
}}
"""


def _customer_query(raw: str) -> Optional[str]:
    q = (raw or "").strip()
    if len(q) < 2:
        return None
    compact = re.sub(r"[\s().+/\-]", "", q)
    details = _confirmation_phone_variants(q)
    if compact.isdigit() and len(details["digits"]) >= 9:
        return " OR ".join(f"(phone:{v})" for v in details["variants"])
    safe = q.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{safe}"'


def _customer_payload(node: Dict[str, Any]) -> Dict[str, Any]:
    orders = [
        _flatten_order(edge.get("node") or {})
        for edge in ((node.get("orders") or {}).get("edges") or [])
        if edge.get("node")
    ]
    addr = node.get("defaultAddress") or {}
    latest = orders[0] if orders else {}
    # The default address can be empty for customers created by checkout; their
    # last order's shipping address is then the best guess.
    address = {
        "first_name": addr.get("firstName") or latest.get("shipping_first_name") or node.get("firstName") or "",
        "last_name": addr.get("lastName") or latest.get("shipping_last_name") or node.get("lastName") or "",
        "phone": addr.get("phone") or node.get("phone") or latest.get("phone") or "",
        "address1": addr.get("address1") or latest.get("shipping_address1") or "",
        "address2": addr.get("address2") or latest.get("shipping_address2") or "",
        "city": addr.get("city") or latest.get("shipping_city") or "",
        "zip": addr.get("zip") or latest.get("shipping_zip") or "",
        "country_code": addr.get("countryCodeV2") or "MA",
    }
    return {
        "id": node.get("id"),
        "name": node.get("displayName") or " ".join(p for p in (node.get("firstName"), node.get("lastName")) if p),
        "first_name": node.get("firstName") or "",
        "last_name": node.get("lastName") or "",
        "email": node.get("email") or "",
        "phone": node.get("phone") or "",
        "orders_count": int(node.get("numberOfOrders") or 0),
        "address": address,
        "orders": orders,
    }


@router.get("/api/chat-requests/customers/lookup")
async def chat_customer_lookup(
    store: str,
    q: str,
    _: User = Depends(get_current_user),
):
    store_key = _normalize_store(store)
    query = _customer_query(q)
    if not query:
        return {"ok": True, "customers": []}

    from .main import shopify_graphql  # type: ignore

    variables = {"first": 5, "ordersFirst": 5, "query": query}
    try:
        data = await shopify_graphql(CUSTOMER_LOOKUP_GQL, variables, store=store_key)
    except HTTPException as exc:
        if "MAX_COST_EXCEEDED" not in str(getattr(exc, "detail", exc)):
            raise
        data = await shopify_graphql(CUSTOMER_LOOKUP_GQL, {**variables, "first": 2}, store=store_key)
    nodes = ((data or {}).get("customers") or {}).get("nodes") or []
    return {"ok": True, "customers": [_customer_payload(n) for n in nodes]}


# ---------- Product options ----------

_PRODUCT_FIELDS = """
id
title
handle
status
featuredImage { url }
variants(first: 100) {
  nodes {
    id
    title
    sku
    price
    availableForSale
    inventoryQuantity
    inventoryPolicy
    selectedOptions { name value }
    image { url }
  }
}
"""

PRODUCT_BY_ID_GQL = f"""
query ChatProductById($id: ID!) {{
  product(id: $id) {{ {_PRODUCT_FIELDS} }}
}}
"""

PRODUCTS_SEARCH_GQL = f"""
query ChatProductsSearch($query: String!) {{
  products(first: 5, query: $query) {{ nodes {{ {_PRODUCT_FIELDS} }} }}
}}
"""


def handle_from_url(url: Optional[str]) -> Optional[str]:
    try:
        path = urlparse(url or "").path
    except Exception:
        return None
    m = re.search(r"/products/([^/?#]+)", path or "")
    return unquote(m.group(1)).strip().lower() if m else None


def _norm(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def _product_payload(node: Dict[str, Any]) -> Dict[str, Any]:
    variants = []
    option_names: List[str] = []
    for v in ((node.get("variants") or {}).get("nodes") or []):
        options = [{"name": o.get("name") or "", "value": o.get("value") or ""} for o in (v.get("selectedOptions") or [])]
        for o in options:
            if o["name"] and o["name"] not in option_names:
                option_names.append(o["name"])
        variants.append({
            "id": v.get("id"),
            "title": v.get("title") or "",
            "sku": v.get("sku") or "",
            "price": str(v.get("price") or "0"),
            "available": bool(v.get("availableForSale")),
            "inventory_quantity": v.get("inventoryQuantity"),
            "inventory_policy": v.get("inventoryPolicy") or "",
            "options": options,
            "image": (v.get("image") or {}).get("url") or "",
        })
    # A product without real options has one "Title: Default Title" variant.
    if option_names == ["Title"] and len(variants) == 1:
        option_names = []
    return {
        "id": node.get("id"),
        "title": node.get("title") or "",
        "handle": node.get("handle") or "",
        "status": node.get("status") or "",
        "image": (node.get("featuredImage") or {}).get("url") or "",
        "option_names": option_names,
        "variants": variants,
    }


def match_variant(product: Dict[str, Any], variant_title: Optional[str]) -> Optional[str]:
    """The variant the customer picked on the website ("Brown / 12-18 months")."""
    wanted = _norm(variant_title)
    if not wanted:
        return None
    parts = sorted(_norm(p) for p in re.split(r"\s*/\s*", variant_title or "") if p.strip())
    for v in product["variants"]:
        if _norm(v["title"]) == wanted:
            return v["id"]
    for v in product["variants"]:
        if sorted(_norm(o["value"]) for o in v["options"]) == parts:
            return v["id"]
    return None


@router.get("/api/chat-requests/product-options")
async def chat_product_options(
    store: str,
    product_id: Optional[str] = None,
    product_url: Optional[str] = None,
    title: Optional[str] = None,
    variant_title: Optional[str] = None,
    _: User = Depends(get_current_user),
):
    store_key = _normalize_store(store)

    from .main import shopify_graphql  # type: ignore

    node: Optional[Dict[str, Any]] = None
    pid = (product_id or "").strip()
    if pid:
        if not pid.startswith("gid://shopify/Product/"):
            raise HTTPException(status_code=400, detail="invalid product id")
        data = await shopify_graphql(PRODUCT_BY_ID_GQL, {"id": pid}, store=store_key)
        node = (data or {}).get("product")
    else:
        handle = handle_from_url(product_url)
        if handle:
            safe = handle.replace("\\", "\\\\").replace("'", "\\'")
            data = await shopify_graphql(PRODUCTS_SEARCH_GQL, {"query": f"handle:'{safe}'"}, store=store_key)
            nodes = ((data or {}).get("products") or {}).get("nodes") or []
            node = next((n for n in nodes if _norm(n.get("handle")) == _norm(handle)), None)
        wanted_title = (title or "").strip()
        if node is None and wanted_title:
            safe = wanted_title.replace("\\", "\\\\").replace('"', '\\"')
            data = await shopify_graphql(PRODUCTS_SEARCH_GQL, {"query": f'title:"{safe}"'}, store=store_key)
            nodes = ((data or {}).get("products") or {}).get("nodes") or []
            node = next((n for n in nodes if _norm(n.get("title")) == _norm(wanted_title)), nodes[0] if nodes else None)
    if not node:
        return {"ok": True, "product": None, "matched_variant_id": None}
    product = _product_payload(node)
    return {"ok": True, "product": product, "matched_variant_id": match_variant(product, variant_title)}


# ---------- Create the order ----------

ORDER_VARIANTS_GQL = """
query ChatOrderVariants($ids: [ID!]!) {
  shop { currencyCode }
  nodes(ids: $ids) {
    ... on ProductVariant { id title price product { title } }
  }
}
"""

ORDER_CREATE_GQL = """
mutation ChatOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name legacyResourceId }
    userErrors { field message }
  }
}
"""

# A timeout or 5xx while creating leaves us not knowing whether Shopify made the
# order; this event makes the next attempt ask before possibly making it twice.
UNKNOWN_EVENT = "order_create_unknown"


class ChatOrderLine(BaseModel):
    variant_id: str
    quantity: int = 1


class ChatCreateOrderBody(BaseModel):
    customer_id: Optional[str] = None
    first_name: str
    last_name: Optional[str] = None
    phone: str
    email: Optional[str] = None
    address1: str
    address2: Optional[str] = None
    city: str
    zip: Optional[str] = None
    country_code: str = "MA"
    lines: List[ChatOrderLine]
    tags: List[str] = []
    note: Optional[str] = None
    shipping_title: Optional[str] = None
    shipping_price: Optional[str] = None
    # Set after the agent was warned that a previous attempt may have created it.
    confirm_possible_duplicate: bool = False
    client_action_id: Optional[str] = None


def clean_tags(tags: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for t in tags or []:
        # Shopify splits tags on commas, so a comma would silently make two.
        tag = re.sub(r"\s+", " ", str(t or "").replace(",", " ")).strip()[:40]
        if tag and tag.lower() not in seen:
            seen.add(tag.lower())
            out.append(tag)
    return out[:20]


def _money(value: Optional[str], field: str) -> Decimal:
    raw = str(value or "0").strip().replace(",", ".") or "0"
    try:
        amount = Decimal(raw)
    except InvalidOperation:
        raise HTTPException(status_code=422, detail=f"{field} must be a number")
    if amount < 0 or amount > Decimal("100000"):
        raise HTTPException(status_code=422, detail=f"{field} is out of range")
    return amount.quantize(Decimal("0.01"))


def _is_unknown_outcome(error: HTTPException) -> bool:
    """True when the request may have reached Shopify and been applied."""
    detail = str(getattr(error, "detail", "") or "")
    if error.status_code in (400, 401, 403, 404, 422, 429):
        return False
    # GraphQL-level errors are returned before the mutation runs.
    return not detail.startswith("Shopify GraphQL errors")


@router.post("/api/chat-requests/{request_id}/create-order")
async def chat_create_order(
    request_id: int,
    body: ChatCreateOrderBody,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    # Locked for the whole call, so a double click waits and then sees the order.
    r = await db.scalar(select(ChatRequest).where(ChatRequest.id == request_id).with_for_update())
    if r is None:
        raise HTTPException(status_code=404, detail="chat request not found")
    if r.status == "ordered":
        ref = f" as {r.order_ref}" if r.order_ref else ""
        raise HTTPException(status_code=409, detail=f"this request is already ordered{ref}")
    if r.status in CLOSED_STATUSES:
        raise HTTPException(status_code=409, detail="this request is closed — reopen it first")

    first_name = _clean(body.first_name, 100)
    last_name = _clean(body.last_name, 100)
    address1 = _clean(body.address1, 255)
    address2 = _clean(body.address2, 255)
    city = _clean(body.city, 100)
    phone = normalize_phone(body.phone)
    missing = [label for label, value in (("name", first_name), ("phone", phone), ("city", city), ("address", address1)) if not value]
    if missing:
        raise HTTPException(status_code=422, detail=f"missing or invalid: {', '.join(missing)}")
    country = (body.country_code or "MA").strip().upper()
    if not re.fullmatch(r"[A-Z]{2}", country):
        raise HTTPException(status_code=422, detail="invalid country")
    email = _clean(body.email, 255)
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(status_code=422, detail="invalid email")
    customer_id = (body.customer_id or "").strip() or None
    if customer_id and not customer_id.startswith("gid://shopify/Customer/"):
        raise HTTPException(status_code=422, detail="invalid customer")

    lines: Dict[str, int] = {}
    for line in body.lines or []:
        vid = (line.variant_id or "").strip()
        if not vid.startswith("gid://shopify/ProductVariant/"):
            raise HTTPException(status_code=422, detail="pick a size / colour for every product")
        qty = int(line.quantity or 0)
        if qty < 1 or qty > 999:
            raise HTTPException(status_code=422, detail="quantity must be between 1 and 999")
        lines[vid] = lines.get(vid, 0) + qty
    if not lines:
        raise HTTPException(status_code=422, detail="add at least one product")
    if len(lines) > 50:
        raise HTTPException(status_code=422, detail="too many products in one order")
    shipping_price = _money(body.shipping_price, "shipping price")
    tags = clean_tags(body.tags)
    note = _clean_multiline(body.note, 5000)

    if not body.confirm_possible_duplicate:
        last_attempt = await db.scalar(
            select(ChatRequestEvent.action)
            .where(ChatRequestEvent.request_id == r.id, ChatRequestEvent.action.in_((UNKNOWN_EVENT, "order_create_failed")))
            .order_by(ChatRequestEvent.created_at.desc(), ChatRequestEvent.id.desc())
            .limit(1)
        )
        if last_attempt == UNKNOWN_EVENT:
            raise HTTPException(status_code=409, detail={
                "code": "maybe_created",
                "message": "The last attempt may already have created this order in Shopify. "
                           "Check the customer's recent orders before creating it again.",
            })

    from .main import shopify_graphql  # type: ignore

    data = await shopify_graphql(ORDER_VARIANTS_GQL, {"ids": list(lines)}, store=r.store_key)
    currency = (((data or {}).get("shop") or {}).get("currencyCode")) or "MAD"
    variants = {n.get("id"): n for n in ((data or {}).get("nodes") or []) if n and n.get("id")}
    gone = [vid for vid in lines if vid not in variants]
    if gone:
        raise HTTPException(status_code=422, detail="a product in this order no longer exists in Shopify — remove it and pick again")

    def money(amount: Any) -> Dict[str, Any]:
        return {"shopMoney": {"amount": str(amount), "currencyCode": currency}}

    address = {
        "firstName": first_name,
        "lastName": last_name or "",
        "phone": phone,
        "address1": address1,
        "address2": address2 or "",
        "city": city,
        "zip": _clean(body.zip, 20) or "",
        "countryCode": country,
    }
    order: Dict[str, Any] = {
        "currency": currency,
        # Cash on delivery: nothing is paid yet.
        "financialStatus": "PENDING",
        "lineItems": [
            {"variantId": vid, "quantity": qty, "priceSet": money(variants[vid].get("price") or "0")}
            for vid, qty in lines.items()
        ],
        "shippingAddress": address,
        "billingAddress": address,
        "phone": phone,
        "tags": tags,
        "sourceIdentifier": f"chat-request-{r.id}",
    }
    if note:
        order["note"] = note
    if email:
        order["email"] = email
    if customer_id:
        order["customer"] = {"toAssociate": {"id": customer_id}}
    else:
        upsert: Dict[str, Any] = {"firstName": first_name, "lastName": last_name or "", "phone": phone}
        if email:
            upsert["email"] = email
        order["customer"] = {"toUpsert": upsert}
    if shipping_price > 0 or (body.shipping_title or "").strip():
        order["shippingLines"] = [{
            "title": _clean(body.shipping_title, 100) or "Livraison",
            "priceSet": money(shipping_price),
        }]
    options = {
        # Same stock rule as the website: never sell what is not there.
        "inventoryBehaviour": "DECREMENT_OBEYING_POLICY",
        "sendReceipt": False,
        "sendFulfillmentReceipt": False,
    }

    client_action_id = (body.client_action_id or "").strip()[:128] or None
    try:
        result = await shopify_graphql(
            ORDER_CREATE_GQL, {"order": order, "options": options}, store=r.store_key, retry_transient=False,
        )
    except HTTPException as error:
        unknown = _is_unknown_outcome(error)
        db.add(ChatRequestEvent(
            request_id=r.id, user_id=user.id,
            action=UNKNOWN_EVENT if unknown else "order_create_failed",
            detail={"error": str(error.detail)[:500], "client_action_id": client_action_id},
        ))
        await db.commit()
        if unknown:
            raise HTTPException(status_code=502, detail=(
                "Shopify did not confirm the order. It may still have been created — "
                "check the customer's recent orders before trying again."
            ))
        raise HTTPException(status_code=error.status_code if error.status_code < 500 else 502, detail=str(error.detail))

    payload = (result or {}).get("orderCreate") or {}
    errors = [e.get("message") for e in (payload.get("userErrors") or []) if e.get("message")]
    created = payload.get("order") or {}
    if errors or not created.get("id"):
        message = "; ".join(errors) or "Shopify did not create the order"
        db.add(ChatRequestEvent(
            request_id=r.id, user_id=user.id, action="order_create_failed",
            detail={"error": message[:500], "client_action_id": client_action_id},
        ))
        await db.commit()
        raise HTTPException(status_code=422, detail=f"Shopify refused the order: {message}")

    now = datetime.now(timezone.utc)
    name = created.get("name") or ""
    r.status = "ordered"
    r.order_ref = name[:64] or None
    r.closed_at = now
    r.closed_by_id = user.id
    r.last_action_at = now
    r.updated_at = now
    if not r.assigned_to_id:
        r.assigned_to_id = user.id
    subtotal = sum(Decimal(str(variants[vid].get("price") or "0")) * qty for vid, qty in lines.items())
    db.add(ChatRequestEvent(
        request_id=r.id, user_id=user.id, action="ordered",
        detail={
            "order_ref": r.order_ref,
            "order_id": created.get("id"),
            "created": True,
            "total": str(subtotal + shipping_price),
            "currency": currency,
            "client_action_id": client_action_id,
        },
    ))
    await db.commit()
    await db.refresh(r)

    domain = await _shop_domain(r.store_key)
    legacy = str(created.get("legacyResourceId") or "").strip()
    users = await _users_by_id(db, [r.assigned_to_id, r.closed_by_id])
    return {
        "ok": True,
        "order": {
            "id": created.get("id"),
            "name": name,
            "legacy_id": legacy,
            "admin_url": f"https://{domain}/admin/orders/{legacy}" if domain and legacy else None,
        },
        "request": serialize_request(r, users, (await _labels_for(db, [r.id]))[r.id]),
    }
