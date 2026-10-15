"""Authenticated Shopify draft browsing/editing and unpaid COD completion.

Operations target 2026-01. Sparse updates preserve Shopify-owned fields. Native
draftOrderComplete is never automatically retried after an uncertain response.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Literal, Optional
from uuid import uuid4
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, EmailStr, Field, StrictInt, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .auth_routes import get_current_user
from .confirmation_routes import (
    CONFIRMATION_API_VERSION, _ORDER_NODE_FIELDS, _escape_tag, _flatten_order,
    _lock_client_action, _normalize_tags, _tz, invalidate_all_breakdown_caches,
    note_recent_tag_add,
)
from .db import get_session
from .models import OrderEvent, User

router = APIRouter(prefix="/api/agent/draft-orders", tags=["confirmation drafts"])
SORT_KEYS = {"CUSTOMER_NAME", "ID", "NUMBER", "RELEVANCE", "STATUS", "TOTAL_PRICE", "UPDATED_AT"}
STATUSES = {"OPEN", "INVOICE_SENT", "COMPLETED"}
ADDRESS_FIELDS = {
    "first_name": "firstName", "last_name": "lastName", "company": "company",
    "phone": "phone", "address1": "address1", "address2": "address2", "city": "city",
    "province": "province", "country": "country", "zip": "zip",
}
MONEY_FIELDS = "presentmentMoney { amount currencyCode } shopMoney { amount currencyCode }"
ADDRESS_SELECTION = "firstName lastName company phone address1 address2 city province country zip"
DISCOUNT_SELECTION = f"title description value valueType amountSet {{ {MONEY_FIELDS} }}"
LINE_SELECTION = f"""
id uuid title variantTitle sku quantity custom requiresShipping taxable
image {{ url }} variant {{ id }} customAttributes {{ key value }}
weight {{ value unit }} priceOverride {{ amount currencyCode }}
originalUnitPriceWithCurrency {{ amount currencyCode }}
originalUnitPriceSet {{ {MONEY_FIELDS} }} discountedTotalSet {{ {MONEY_FIELDS} }}
appliedDiscount {{ {DISCOUNT_SELECTION} }}
components {{ uuid quantity variant {{ id }} }}
"""
SUMMARY_SELECTION = f"""
id name poNumber status createdAt updatedAt completedAt invoiceUrl
currencyCode presentmentCurrencyCode note2 email phone tags ready
customer {{ id displayName email phone numberOfOrders }}
subtotalPriceSet {{ {MONEY_FIELDS} }} totalTaxSet {{ {MONEY_FIELDS} }}
totalShippingPriceSet {{ {MONEY_FIELDS} }} totalDiscountsSet {{ {MONEY_FIELDS} }}
totalPriceSet {{ {MONEY_FIELDS} }}
"""
DETAIL_SELECTION = f"""
{SUMMARY_SELECTION}
shippingAddress {{ {ADDRESS_SELECTION} }} billingAddress {{ {ADDRESS_SELECTION} }}
shippingLine {{ title originalPriceSet {{ {MONEY_FIELDS} }} }}
appliedDiscount {{ {DISCOUNT_SELECTION} }}
taxExempt taxesIncluded transformerFingerprint
lineItems(first: 25) {{ nodes {{ {LINE_SELECTION} }} pageInfo {{ hasNextPage endCursor }} }}
order {{ {_ORDER_NODE_FIELDS} }}
"""
DRAFT_LIST_GQL = f"""
query ConfirmationDrafts($first: Int, $last: Int, $after: String, $before: String,
                         $query: String, $sortKey: DraftOrderSortKeys!, $reverse: Boolean!) {{
  shop {{ currencyCode }}
  draftOrders(first: $first, last: $last, after: $after, before: $before,
              query: $query, sortKey: $sortKey, reverse: $reverse) {{
    nodes {{ {SUMMARY_SELECTION} }}
    pageInfo {{ hasNextPage hasPreviousPage startCursor endCursor }}
  }}
}}
"""
DRAFT_DETAIL_GQL = f"""
query ConfirmationDraftDetail($id: ID!) {{ draftOrder(id: $id) {{ {DETAIL_SELECTION} }} }}
"""
DRAFT_LINES_GQL = f"""
query ConfirmationDraftLines($id: ID!, $after: String!) {{
  draftOrder(id: $id) {{
    id updatedAt
    lineItems(first: 25, after: $after) {{ nodes {{ {LINE_SELECTION} }} pageInfo {{ hasNextPage endCursor }} }}
  }}
}}
"""
DRAFT_UPDATE_GQL = """
mutation ConfirmationDraftUpdate($id: ID!, $input: DraftOrderInput!) {
  draftOrderUpdate(id: $id, input: $input) {
    draftOrder { id updatedAt } userErrors { field message }
  }
}
"""
DRAFT_COMPLETE_GQL = """
mutation ConfirmationDraftComplete($id: ID!) {
  draftOrderComplete(id: $id, paymentPending: true) {
    draftOrder { id updatedAt order { id } } userErrors { field message }
  }
}
"""
DRAFT_TAGS_GQL = """
mutation ConfirmationDraftAssign($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}
"""
DRAFT_STOCK_GQL = """
query ConfirmationDraftStock($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant { id inventoryQuantity inventoryItem { tracked } }
  }
}
"""


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DraftAddress(StrictBody):
    first_name: Optional[str] = Field(default=None, max_length=255)
    last_name: Optional[str] = Field(default=None, max_length=255)
    company: Optional[str] = Field(default=None, max_length=255)
    phone: Optional[str] = Field(default=None, max_length=255)
    address1: Optional[str] = Field(default=None, max_length=255)
    address2: Optional[str] = Field(default=None, max_length=255)
    city: Optional[str] = Field(default=None, max_length=255)
    province: Optional[str] = Field(default=None, max_length=255)
    country: Optional[str] = Field(default=None, max_length=255)
    zip: Optional[str] = Field(default=None, max_length=255)


class DraftLineChange(StrictBody):
    id: Optional[str] = Field(default=None, max_length=128)
    variant_id: Optional[str] = Field(default=None, max_length=128)
    title: Optional[str] = Field(default=None, max_length=255)
    unit_price: Optional[str] = Field(default=None, max_length=32)
    quantity: StrictInt = Field(ge=1, le=999)


class DraftDiscount(StrictBody):
    title: str = Field(default="Discount", max_length=255)
    value: str = Field(max_length=32)
    value_type: Literal["FIXED_AMOUNT", "PERCENTAGE"]


class DraftShippingLine(StrictBody):
    title: str = Field(default="Shipping", max_length=255)
    price: str = Field(max_length=32)


class DraftChanges(StrictBody):
    line_items: Optional[List[DraftLineChange]] = Field(default=None, min_length=1, max_length=499)
    shipping_address: Optional[DraftAddress] = None
    billing_address: Optional[DraftAddress] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=255)
    note: Optional[str] = Field(default=None, max_length=5000)
    tags: Optional[List[str]] = Field(default=None, max_length=250)
    shipping_line: Optional[DraftShippingLine] = None
    applied_discount: Optional[DraftDiscount] = None
    po_number: Optional[str] = Field(default=None, max_length=255)

    @field_validator("email", mode="before")
    @classmethod
    def empty_email(cls, value):
        return None if isinstance(value, str) and not value.strip() else value


class DraftUpdateBody(StrictBody):
    store: str = Field(min_length=1, max_length=255)
    draft_id: str = Field(pattern=r"^gid://shopify/DraftOrder/\d+$")
    expected_updated_at: str = Field(min_length=1, max_length=64)
    changes: DraftChanges


class DraftCompleteBody(StrictBody):
    store: str = Field(min_length=1, max_length=255)
    draft_id: str = Field(pattern=r"^gid://shopify/DraftOrder/\d+$")
    expected_updated_at: str = Field(min_length=1, max_length=64)
    client_action_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{8,128}$")


def _store(value: str) -> str:
    from .main import _normalize_store
    if not str(value or "").strip():
        raise HTTPException(422, "Store is required")
    return _normalize_store(value.strip())


def _draft_id(value: str) -> str:
    if not re.fullmatch(r"gid://shopify/DraftOrder/\d+", value or ""):
        raise HTTPException(422, "Choose a valid Shopify draft order")
    return value


async def _graphql(query, variables, *, store, write=False):
    from .main import shopify_graphql
    try:
        return await shopify_graphql(query, variables, store=store,
                                     api_version=CONFIRMATION_API_VERSION,
                                     retry_safe=not write)
    except HTTPException as exc:
        detail = str(exc.detail).lower()
        if exc.status_code in {401, 403} or "access_denied" in detail or "access denied" in detail:
            # A nested customer denial does not imply missing draft-order scopes.
            scope = "read_customers" if "customer" in detail else ("write_draft_orders" if write else "read_draft_orders")
            raise HTTPException(403, f"The selected store lacks required {scope} access for this draft operation. An administrator must configure that scope and reconnect the store.") from exc
        raise


def _payload(data, name):
    result = (data or {}).get(name) or {}
    errors = result.get("userErrors") or []
    if errors:
        messages = []
        for error in errors:
            field = ".".join(str(v) for v in error.get("field") or [])
            messages.append((field + ": " if field else "") + str(error.get("message") or "Shopify rejected this change"))
        raise HTTPException(422, "; ".join(messages))
    return result


def _money(bag):
    return ((bag or {}).get("presentmentMoney") or (bag or {}).get("shopMoney") or {})


def _amount(bag):
    return str(_money(bag).get("amount") or "0")


def _discount(value):
    if not value:
        return None
    return {"title": value.get("title") or "Discount", "value": str(value.get("value") or "0"),
            "value_type": value.get("valueType") or "FIXED_AMOUNT"}


def normalize_draft(node):
    customer = node.get("customer") or {}
    line_items = []
    for line in (node.get("lineItems") or {}).get("nodes") or []:
        line_items.append({
            "id": line.get("id"), "variant_id": (line.get("variant") or {}).get("id"),
            "title": line.get("title") or "", "variant_title": line.get("variantTitle") or "",
            "sku": line.get("sku") or "", "image": (line.get("image") or {}).get("url"),
            "quantity": line.get("quantity") or 0, "unit_price": _amount(line.get("originalUnitPriceSet")),
            "line_total": _amount(line.get("discountedTotalSet")), "custom": bool(line.get("custom")),
            "applied_discount": _discount(line.get("appliedDiscount")),
        })
    shipping = node.get("shippingLine") or {}
    return {
        "id": node.get("id"), "name": node.get("name") or "", "po_number": node.get("poNumber") or "",
        "status": node.get("status") or "OPEN", "created_at": node.get("createdAt"),
        "updated_at": node.get("updatedAt"), "completed_at": node.get("completedAt"),
        "invoice_url": node.get("invoiceUrl"), "currency": node.get("presentmentCurrencyCode") or node.get("currencyCode") or "",
        "subtotal_price": _amount(node.get("subtotalPriceSet")), "total_tax": _amount(node.get("totalTaxSet")),
        "total_shipping": _amount(node.get("totalShippingPriceSet")), "total_discount": _amount(node.get("totalDiscountsSet")),
        "total_price": _amount(node.get("totalPriceSet")), "note": node.get("note2") or "",
        "tags": list(node.get("tags") or []), "email": node.get("email") or "", "phone": node.get("phone") or "",
        "customer": {"id": customer.get("id"), "name": customer.get("displayName") or "",
                     "email": customer.get("email") or "", "phone": customer.get("phone") or "",
                     "orders_count": int(customer.get("numberOfOrders") or 0)},
        "shipping_address": {key: (node.get("shippingAddress") or {}).get(field) or "" for key, field in ADDRESS_FIELDS.items()},
        "billing_address": {key: (node.get("billingAddress") or {}).get(field) or "" for key, field in ADDRESS_FIELDS.items()},
        "line_items": line_items, "applied_discount": _discount(node.get("appliedDiscount")),
        "shipping_line": {"title": shipping.get("title") or "Shipping", "price": _amount(shipping.get("originalPriceSet"))},
        "order": _flatten_order(node["order"]) if node.get("order") else None,
        "ready": node.get("ready", True), "payment_terms": node.get("paymentTerms"),
    }


async def _fetch_draft(store, draft_id):
    data = await _graphql(DRAFT_DETAIL_GQL, {"id": _draft_id(draft_id)}, store=store)
    node = deepcopy((data or {}).get("draftOrder"))
    if not node:
        raise HTTPException(404, "Draft order was not found in the selected store")
    connection = node.get("lineItems") or {}
    lines = list(connection.get("nodes") or [])
    seen = set()
    while (connection.get("pageInfo") or {}).get("hasNextPage"):
        cursor = (connection.get("pageInfo") or {}).get("endCursor")
        if not cursor or cursor in seen:
            raise HTTPException(502, "Shopify did not return every draft line item; reload before editing")
        seen.add(cursor)
        page = await _graphql(DRAFT_LINES_GQL, {"id": draft_id, "after": cursor}, store=store)
        page_node = (page or {}).get("draftOrder") or {}
        if page_node.get("updatedAt") != node.get("updatedAt"):
            raise HTTPException(409, "This draft changed while it was loading. Reload it before editing.")
        connection = page_node.get("lineItems")
        if connection is None:
            raise HTTPException(502, "Shopify did not return every draft line item; reload before editing")
        lines.extend(connection.get("nodes") or [])
    node["lineItems"] = {"nodes": lines}
    return node


async def _detail_response(node, store):
    draft = normalize_draft(node)
    lines = draft["line_items"]
    ids = list(dict.fromkeys(line["variant_id"] for line in lines if line.get("variant_id")))
    stock = {}
    warnings = []
    try:
        for offset in range(0, len(ids), 50):
            data = await _graphql(DRAFT_STOCK_GQL, {"ids": ids[offset:offset + 50]}, store=store)
            stock.update({v["id"]: v for v in data.get("nodes") or [] if v and v.get("id")})
    except Exception:
        # Optional inventory access must never make a draft inaccessible.
        warnings.append("Some product inventory counts are unavailable")
    for line in lines:
        item = stock.get(line.get("variant_id")) or {}
        tracked = (item.get("inventoryItem") or {}).get("tracked")
        line["inventory_tracked"] = tracked
        line["inventory_quantity"] = item.get("inventoryQuantity")
        line["available_quantity"] = item.get("inventoryQuantity") if tracked is True else None
    draft["stock_warnings"] = warnings
    return {"ok": True, "draft": draft}


def _check_version(node, expected):
    try:
        actual_date = datetime.fromisoformat(str(node.get("updatedAt") or "").replace("Z", "+00:00"))
        expected_date = datetime.fromisoformat(expected.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, "A valid expected_updated_at timestamp is required")
    if actual_date != expected_date:
        raise HTTPException(409, {"code": "draft_changed", "message": "This draft was changed by someone else. Reload it before saving or completing.", "safe_to_edit": True})


def _decimal(value, label, max_value=Decimal("99999999.99")):
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount < 0 or amount > max_value or amount.as_tuple().exponent < -2:
            raise ValueError()
        return amount
    except (ValueError, InvalidOperation):
        raise HTTPException(422, f"{label} must be a non-negative amount with at most 2 decimals")


def _existing_line_input(line, quantity):
    result = {"quantity": quantity, "uuid": line.get("uuid") or str(uuid4())}
    variant = (line.get("variant") or {}).get("id")
    if variant and not line.get("custom"):
        result["variantId"] = variant
    elif line.get("custom"):
        result.update({"title": line.get("title") or "Custom item", "sku": line.get("sku") or "",
                       "requiresShipping": bool(line.get("requiresShipping")), "taxable": bool(line.get("taxable")),
                       "originalUnitPriceWithCurrency": line.get("originalUnitPriceWithCurrency") or _money(line.get("originalUnitPriceSet"))})
        if line.get("weight"):
            result["weight"] = deepcopy(line["weight"])
    else:
        raise HTTPException(422, "A draft product was deleted. Remove that line or choose a replacement product before saving.")
    if line.get("customAttributes"):
        result["customAttributes"] = deepcopy(line["customAttributes"])
    if line.get("priceOverride"):
        result["priceOverride"] = deepcopy(line["priceOverride"])
    discount = line.get("appliedDiscount")
    if discount:
        result["appliedDiscount"] = {key: discount[key] for key in ("title", "description", "value", "valueType") if discount.get(key) is not None}
        # amountSet is a calculated discount total, which can include quantity.
        # Preserve the original value/type and let Shopify recalculate that total.
    if line.get("components"):
        result["components"] = [{"uuid": c["uuid"], "quantity": c["quantity"], "variantId": (c.get("variant") or {}).get("id")} for c in line["components"]]
    return result


def build_draft_update(node, changes):
    """Only changed top-level fields; serialize retained lines from live Shopify data."""
    result = {}
    fields = changes.model_fields_set
    currency = node.get("presentmentCurrencyCode") or node.get("currencyCode")
    for key, field in {"email": "email", "phone": "phone", "note": "note", "po_number": "poNumber"}.items():
        if key in fields:
            value = str(getattr(changes, key) or "").strip()
            result[field] = (value or None) if key == "email" else value
    for key, field in {"shipping_address": "shippingAddress", "billing_address": "billingAddress"}.items():
        if key not in fields:
            continue
        address = getattr(changes, key)
        if address is None:
            result[field] = None
        else:
            result[field] = {v: (node.get(field) or {}).get(v) or "" for v in ADDRESS_FIELDS.values()}
            result[field].update({ADDRESS_FIELDS[k]: str(getattr(address, k) or "").strip() for k in address.model_fields_set})
    if "tags" in fields:
        tags = changes.tags or []
        if any(not tag.strip() or len(tag) > 255 for tag in tags):
            raise HTTPException(422, "Tags must contain 1 to 255 characters")
        seen_tags = set()
        result["tags"] = []
        for tag in tags:
            tag = tag.strip()
            if tag.casefold() not in seen_tags:
                seen_tags.add(tag.casefold())
                result["tags"].append(tag)
    if "shipping_line" in fields:
        shipping = changes.shipping_line
        result["shippingLine"] = None if shipping is None else {
            "title": shipping.title.strip() or "Shipping", "shippingRateHandle": None,
            "priceWithCurrency": {"amount": format(_decimal(shipping.price, "Shipping price"), ".2f"), "currencyCode": currency},
        }
    if "applied_discount" in fields:
        discount = changes.applied_discount
        result["appliedDiscount"] = None
        if discount:
            value = _decimal(discount.value, "Discount", Decimal("100") if discount.value_type == "PERCENTAGE" else Decimal("99999999.99"))
            result["appliedDiscount"] = {"title": discount.title.strip() or "Discount", "value": float(value), "valueType": discount.value_type}
            if discount.value_type == "FIXED_AMOUNT":
                result["appliedDiscount"]["amountWithCurrency"] = {"amount": format(value, ".2f"), "currencyCode": currency}
    if "line_items" in fields:
        if not changes.line_items:
            raise HTTPException(422, "A draft needs at least one line item")
        existing = {line.get("id"): line for line in (node.get("lineItems") or {}).get("nodes") or []}
        seen = set()
        lines = []
        for line in changes.line_items:
            if line.id:
                if line.id not in existing or line.id in seen:
                    raise HTTPException(422, "A line item is missing, duplicated, or belongs to a different draft. Reload the draft.")
                if line.model_fields_set - {"id", "quantity"}:
                    raise HTTPException(422, "Existing line edits accept only id and quantity; add a replacement for a different item")
                seen.add(line.id)
                lines.append(_existing_line_input(existing[line.id], line.quantity))
            elif line.variant_id:
                if not re.fullmatch(r"gid://shopify/ProductVariant/\d+", line.variant_id):
                    raise HTTPException(422, "Choose a valid Shopify product variant")
                lines.append({"variantId": line.variant_id, "quantity": line.quantity, "uuid": str(uuid4())})
            elif line.title and line.title.strip() and line.unit_price is not None:
                lines.append({"title": line.title.strip(), "quantity": line.quantity, "uuid": str(uuid4()),
                              "originalUnitPriceWithCurrency": {"amount": format(_decimal(line.unit_price, "Item price"), ".2f"), "currencyCode": currency},
                              "requiresShipping": True, "taxable": True})
            else:
                raise HTTPException(422, "New items need a product variant, or a custom title and price")
        result["lineItems"] = lines
        if node.get("transformerFingerprint"):
            result["transformerFingerprint"] = node["transformerFingerprint"]
    return result


def build_draft_query(q="", status="", date_from="", date_to="", tag=""):
    parts = []
    if q.strip():
        parts.append(f"({q.strip()})")
    status = status.strip().upper()
    if status and status != "ALL":
        if status not in STATUSES:
            raise HTTPException(422, "Choose OPEN, INVOICE_SENT, COMPLETED or ALL")
        parts.append(f"status:{status}")
    dates = {}
    for key, value in (("from", date_from), ("to", date_to)):
        if value:
            try:
                dates[key] = date.fromisoformat(value)
            except ValueError:
                raise HTTPException(422, "Draft date filters must use YYYY-MM-DD")
    if "from" in dates and "to" in dates and dates["from"] > dates["to"]:
        raise HTTPException(422, "The end date must be on or after the start date")
    for key, op in (("from", ">="), ("to", "<")):
        if key in dates:
            day = dates[key] + (timedelta(days=1) if key == "to" else timedelta())
            timestamp = datetime.combine(day, datetime.min.time(), tzinfo=_tz()).isoformat()
            parts.append(f"created_at:{op}{_escape_tag(timestamp)}")
    if tag.strip():
        parts.append(f"tag:{_escape_tag(tag.strip())}")
    return " AND ".join(parts)


@router.get("")
async def list_confirmation_drafts(
    store: str, q: str = "", status: str = "", sort_key: str = "UPDATED_AT", reverse: bool = True,
    after: Optional[str] = None, before: Optional[str] = None, first: int = Query(25, ge=1, le=50),
    date_from: str = "", date_to: str = "", tag: str = "", _: User = Depends(get_current_user),
):
    store = _store(store)
    if after and before:
        raise HTTPException(422, "Use either after or before, not both")
    key = sort_key.strip().upper()
    if key not in SORT_KEYS or (key == "RELEVANCE" and not q.strip()):
        raise HTTPException(422, "Choose a supported draft sort; relevance requires a search query")
    query = build_draft_query(q, status, date_from, date_to, tag)
    page_size = first if isinstance(first, int) else 25
    data = await _graphql(DRAFT_LIST_GQL, {"first": None if before else page_size, "last": page_size if before else None,
                          "after": after, "before": before, "query": query or None, "sortKey": key, "reverse": reverse}, store=store)
    connection = (data or {}).get("draftOrders") or {}
    info = connection.get("pageInfo") or {}
    return {"ok": True, "drafts": [normalize_draft(n) for n in connection.get("nodes") or []],
            "page_info": {"has_next_page": bool(info.get("hasNextPage")), "has_previous_page": bool(info.get("hasPreviousPage")),
                          "start_cursor": info.get("startCursor"), "end_cursor": info.get("endCursor")},
            "currency": ((data or {}).get("shop") or {}).get("currencyCode") or ""}


@router.get("/detail")
async def get_confirmation_draft(store: str, draft_id: str, _: User = Depends(get_current_user)):
    store = _store(store)
    return await _detail_response(await _fetch_draft(store, draft_id), store)


async def _pending_completion(db, store, draft_id):
    return await db.scalar(select(OrderEvent).where(OrderEvent.store_key == store, OrderEvent.order_gid == draft_id,
                                                   OrderEvent.action == "draft_complete_pending"))


async def _guard_pending_update(db, store, draft_id, node):
    events = (await db.scalars(select(OrderEvent).where(
        OrderEvent.store_key == store, OrderEvent.order_gid == draft_id,
        OrderEvent.action == "draft_update", OrderEvent.event_metadata["state"].as_string().in_(["pending", "uncertain"]),
    ))).all()
    for event in events:
        metadata = event.event_metadata or {}
        if metadata.get("expected_updated_at") == node.get("updatedAt"):
            raise HTTPException(409, {"code": "draft_save_pending", "message": "Another save is still processing for this draft. Reload it before saving or completing.", "safe_to_edit": True})
        # A crashed/lost client cannot keep a successful, versioned save locked
        # indefinitely. Shopify has advanced beyond that one-shot mutation.
        event.event_metadata = {**metadata, "state": "recovered"}


@router.post("/update")
async def update_confirmation_draft(body: DraftUpdateBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    store = _store(body.store)
    await _lock_client_action(db, f"draft:{store}:{body.draft_id}")
    if await _pending_completion(db, store, body.draft_id):
        raise HTTPException(409, "This draft has a completion in progress. Reload its status before editing.")
    node = await _fetch_draft(store, body.draft_id)
    await _guard_pending_update(db, store, body.draft_id, node)
    if node.get("status") == "COMPLETED" or node.get("order"):
        raise HTTPException(409, {"code": "draft_completed", "message": "This draft is completed. Open its order to make further changes.", "safe_to_edit": True})
    _check_version(node, body.expected_updated_at)
    change_input = build_draft_update(node, body.changes)
    if not change_input:
        return {"ok": True, "draft": normalize_draft(node)}
    event = OrderEvent(user_id=user.id, order_gid=body.draft_id, order_number=node.get("name") or "",
                       store_key=store, action="draft_update", event_metadata={"source": "confirmation", "confirmation_actor": True,
                       "role": user.role, "draft_id": body.draft_id, "state": "pending", "expected_updated_at": node.get("updatedAt"), "changed_fields": sorted(change_input)})
    db.add(event)
    # Record actor/store before the external write; uncertain writes remain visible.
    await db.commit()
    try:
        data = await _graphql(DRAFT_UPDATE_GQL, {"id": body.draft_id, "input": change_input}, store=store, write=True)
        result = _payload(data, "draftOrderUpdate")
        if not (result.get("draftOrder") or {}).get("id"):
            raise HTTPException(502, "Shopify returned no updated draft")
    except HTTPException as exc:
        event.event_metadata = {**event.event_metadata, "state": "rejected" if exc.status_code in {401, 403, 422, 429} else "uncertain"}
        await db.commit()
        if exc.status_code in {401, 403, 422, 429}:
            raise
        raise HTTPException(409, "The save response was lost. Reload this draft to check its saved state before making another change.") from exc
    except Exception as exc:
        event.event_metadata = {**event.event_metadata, "state": "uncertain"}
        await db.commit()
        raise HTTPException(409, "The save response was lost. Reload this draft to check its saved state before making another change.") from exc
    event.event_metadata = {**event.event_metadata, "state": "complete"}
    await db.commit()
    # Shopify's recalculated totals and the complete line collection are authoritative.
    return await _detail_response(await _fetch_draft(store, body.draft_id), store)


async def _finish_completion(db, event, node, store, deduped):
    order = node.get("order") or {}
    if not order.get("id"):
        raise HTTPException(409, "Completion status is uncertain. Reload this draft; do not create a replacement order.")
    event.action = "draft_complete"
    event.order_gid = order["id"]
    event.order_number = str(order.get("name") or "").lstrip("#")
    event.event_metadata = {**(event.event_metadata or {}), "state": "complete"}
    await db.commit()
    note_recent_tag_add(store, order["id"], order.get("tags") or node.get("tags") or [])
    invalidate_all_breakdown_caches()
    return {"ok": True, "draft": normalize_draft(node), "order": _flatten_order(order), "deduped": deduped}


@router.post("/complete")
async def complete_confirmation_draft(body: DraftCompleteBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    store = _store(body.store)
    await _lock_client_action(db, f"draft:{store}:{body.draft_id}")
    event = await db.scalar(select(OrderEvent).where(OrderEvent.client_action_id == body.client_action_id))
    if event is not None and (event.user_id != user.id or event.store_key != store or
                              (event.event_metadata or {}).get("draft_id") != body.draft_id):
        raise HTTPException(409, "This completion request belongs to a different agent, store or draft")
    node = await _fetch_draft(store, body.draft_id)
    if node.get("order"):
        if event is None:
            event = OrderEvent(user_id=user.id, order_gid=body.draft_id, order_number=node.get("name") or "", store_key=store,
                               action="draft_complete_pending", client_action_id=body.client_action_id,
                               event_metadata={"source": "confirmation", "confirmation_actor": True, "role": user.role,
                                               "draft_id": body.draft_id, "existing_completed": True})
            db.add(event)
        return await _finish_completion(db, event, node, store, True)
    if event is not None or await _pending_completion(db, store, body.draft_id):
        raise HTTPException(409, {"code": "completion_uncertain", "message": "Completion status is uncertain or still processing. Reload this draft and retry the same request to recover its order.", "safe_to_edit": False})
    if node.get("status") == "COMPLETED":
        raise HTTPException(409, "Shopify reports this draft completed but has not returned its order yet. Reload its status.")
    _check_version(node, body.expected_updated_at)
    await _guard_pending_update(db, store, body.draft_id, node)
    if node.get("ready") is False:
        raise HTTPException(409, {"code": "draft_not_ready", "message": "Shopify is still calculating this draft. Reload it before completing.", "safe_to_edit": True})
    event = OrderEvent(user_id=user.id, order_gid=body.draft_id, order_number=node.get("name") or "", store_key=store,
                       action="draft_complete_pending", client_action_id=body.client_action_id,
                       event_metadata={"source": "confirmation", "confirmation_actor": True, "role": user.role,
                                       "draft_id": body.draft_id, "state": "pending", "payment_pending": True})
    db.add(event)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "This completion request is already processing. Retry it to check its status.")
    try:
        # Native tagsAdd preserves every existing draft tag. It adds assignment
        # tags only, never a COD confirmation tag or payment notification.
        tags = _normalize_tags(user.agent_tags or [])
        if tags:
            data = await _graphql(DRAFT_TAGS_GQL, {"id": body.draft_id, "tags": tags}, store=store, write=True)
            _payload(data, "tagsAdd")
        data = await _graphql(DRAFT_COMPLETE_GQL, {"id": body.draft_id}, store=store, write=True)
        result = _payload(data, "draftOrderComplete")
        if not ((result.get("draftOrder") or {}).get("order") or {}).get("id"):
            raise HTTPException(502, "Shopify returned no completed order")
    except HTTPException as exc:
        if exc.status_code in {401, 403, 422, 429}:
            await db.delete(event)
            await db.commit()
            raise
        raise HTTPException(409, {"code": "completion_uncertain", "message": "Completion status is uncertain. Retry the same request to recover it; do not create another order.", "safe_to_edit": False}) from exc
    except Exception as exc:
        raise HTTPException(409, {"code": "completion_uncertain", "message": "Completion status is uncertain. Retry the same request to recover it; do not create another order.", "safe_to_edit": False}) from exc
    # Keep the durable pending event if this read/commit fails. A replay reads
    # the linked order instead of executing another completion mutation.
    completed = await _fetch_draft(store, body.draft_id)
    return await _finish_completion(db, event, completed, store, False)
