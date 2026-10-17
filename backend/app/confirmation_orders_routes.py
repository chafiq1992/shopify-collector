"""Shopify-style orders list and order-tag suggestions for the confirmation app.

The list reads one page of orders with a lean selection (50 rows stay well
under Shopify's single-query cost ceiling). Filters become a Shopify search
query; every value is validated or quoted so typed text cannot change it.
"""
import asyncio
import logging
import re
import time
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from .auth_routes import get_current_user
from .confirmation_product_routes import _title_terms
from .confirmation_routes import CONFIRMATION_API_VERSION, _classify_confirmation_search, _escape_tag, _tz
from .models import User

logger = logging.getLogger(__name__)
router = APIRouter()

FULFILLMENT_FILTERS = {
    "unfulfilled": "fulfillment_status:unshipped",
    "partial": "fulfillment_status:partial",
    "fulfilled": "fulfillment_status:shipped",
}
PAYMENT_FILTERS = {
    key: f"financial_status:{key}"
    for key in ("pending", "authorized", "paid", "partially_paid", "partially_refunded", "refunded", "voided")
}
STATUS_FILTERS = {"open": "status:open", "closed": "status:closed", "cancelled": "status:cancelled"}
SORT_KEYS = {"CREATED_AT", "ORDER_NUMBER", "TOTAL_PRICE", "CUSTOMER_NAME", "UPDATED_AT"}
MAX_FILTER_VALUES = 20
PRODUCT_TITLE_MATCHES = 20
TAG_CACHE_SECONDS = 300
_TAG_CACHE: Dict[str, Tuple[float, List[str]]] = {}

ORDERS_LIST_GQL = """
query ConfirmationOrdersList($first: Int, $last: Int, $after: String, $before: String,
                             $query: String, $sortKey: OrderSortKeys!, $reverse: Boolean!) {
  orders(first: $first, last: $last, after: $after, before: $before,
         query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes {
      id legacyResourceId name createdAt closed cancelledAt tags
      displayFinancialStatus displayFulfillmentStatus currentSubtotalLineItemsQuantity
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customer { displayName }
      shippingAddress { name city province countryCodeV2 }
      lineItems(first: 3) { nodes { title variantTitle currentQuantity image { url } } }
    }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
  ordersCount(query: $query) { count precision }
}
"""

PRODUCT_TITLE_IDS_GQL = """
query ConfirmationOrderProductFilter($query: String!, $first: Int!) {
  products(first: $first, query: $query, sortKey: RELEVANCE) { nodes { id } }
}
"""

SHOP_ORDER_TAGS_GQL = """
query ConfirmationShopOrderTags {
  shop { orderTags(first: 250, sort: POPULAR) { edges { node } } }
}
"""

RECENT_ORDER_TAGS_GQL = """
query ConfirmationRecentOrderTags {
  orders(first: 250, sortKey: CREATED_AT, reverse: true) { nodes { tags } }
}
"""


async def _read(query: str, variables: Dict[str, Any], store: str) -> Dict[str, Any]:
    from .main import shopify_graphql  # type: ignore
    return await shopify_graphql(query, variables, store=store, api_version=CONFIRMATION_API_VERSION) or {}


def _store(value: str) -> str:
    from .main import _normalize_store  # type: ignore
    if not str(value or "").strip():
        raise HTTPException(422, "Store is required")
    return _normalize_store(value.strip())


def _choices(values: List[str], allowed: Dict[str, str], label: str) -> List[str]:
    picked = []
    for value in values or []:
        key = str(value or "").strip().lower()
        if not key:
            continue
        if key not in allowed:
            raise HTTPException(422, f"Unknown {label} filter: {key}")
        if allowed[key] not in picked:
            picked.append(allowed[key])
    return picked


def _any_of(terms: List[str]) -> Optional[str]:
    if not terms:
        return None
    return terms[0] if len(terms) == 1 else "(" + " OR ".join(terms) + ")"


def _clean_tags(values: List[str]) -> List[str]:
    tags: List[str] = []
    for value in values or []:
        tag = re.sub(r"\s+", " ", str(value or "")).strip()
        if tag and tag.lower() not in {t.lower() for t in tags}:
            if len(tag) > 255:
                raise HTTPException(422, "A tag filter must be at most 255 characters")
            tags.append(tag)
    if len(tags) > MAX_FILTER_VALUES:
        raise HTTPException(422, f"Filter by at most {MAX_FILTER_VALUES} tags at a time")
    return tags


def _product_number(value: str) -> str:
    match = re.fullmatch(r"(?:gid://shopify/Product/)?(\d+)", str(value or "").strip())
    if not match:
        raise HTTPException(422, "Product filters must be Shopify product IDs")
    return match.group(1)


def _date_terms(date_from: str, date_to: str) -> List[str]:
    dates = {}
    for key, value in (("from", date_from), ("to", date_to)):
        if value:
            try:
                dates[key] = date.fromisoformat(value)
            except ValueError:
                raise HTTPException(422, "Date filters must use YYYY-MM-DD")
    if "from" in dates and "to" in dates and dates["from"] > dates["to"]:
        raise HTTPException(422, "The end date must be on or after the start date")
    terms = []
    for key, op in (("from", ">="), ("to", "<")):
        if key in dates:
            # Whole days in the store's time zone; "to" includes that entire day.
            day = dates[key] + (timedelta(days=1) if key == "to" else timedelta())
            stamp = datetime.combine(day, datetime.min.time(), tzinfo=_tz()).isoformat()
            terms.append(f"created_at:{op}{_escape_tag(stamp)}")
    return terms


def build_orders_query(
    *, q: str = "", fulfillment: List[str] = (), payment: List[str] = (), status: List[str] = (),
    tags: List[str] = (), tag_mode: str = "any", exclude_tags: List[str] = (),
    product_ids: List[str] = (), date_from: str = "", date_to: str = "",
) -> str:
    parts: List[str] = []
    text = (q or "").strip()
    if len(text) > 255:
        raise HTTPException(422, "Use a search of at most 255 characters")
    if text:
        parts.append(f"({_classify_confirmation_search(text)['order_query']})")
    for group in (_choices(status, STATUS_FILTERS, "status"),
                  _choices(fulfillment, FULFILLMENT_FILTERS, "fulfillment"),
                  _choices(payment, PAYMENT_FILTERS, "payment")):
        term = _any_of(group)
        if term:
            parts.append(term)
    tagged = [f"tag:{_escape_tag(tag)}" for tag in _clean_tags(list(tags))]
    if tag_mode not in {"any", "all"}:
        raise HTTPException(422, "Tag matching must be any or all")
    if tag_mode == "all":
        parts.extend(tagged)
    elif tagged:
        parts.append(_any_of(tagged))
    parts.extend(f"-tag:{_escape_tag(tag)}" for tag in _clean_tags(list(exclude_tags)))
    numbers = list(dict.fromkeys(_product_number(value) for value in product_ids or [] if str(value or "").strip()))
    if len(numbers) > PRODUCT_TITLE_MATCHES:
        raise HTTPException(422, f"Filter by at most {PRODUCT_TITLE_MATCHES} products at a time")
    product_term = _any_of([f"line_item.product_id:{number}" for number in numbers])
    if product_term:
        parts.append(product_term)
    parts.extend(_date_terms(date_from, date_to))
    # Space-separated terms are an implicit AND, the form the queue query uses.
    return " ".join(parts)


def _list_row(node: Dict[str, Any]) -> Dict[str, Any]:
    money = ((node.get("currentTotalPriceSet") or {}).get("shopMoney")) or {}
    shipping = node.get("shippingAddress") or {}
    items = []
    for line in ((node.get("lineItems") or {}).get("nodes")) or []:
        quantity = int(line.get("currentQuantity") or 0)
        if quantity > 0:
            items.append({"title": line.get("title") or "", "variant_title": line.get("variantTitle") or "",
                          "quantity": quantity, "image": (line.get("image") or {}).get("url")})
    return {
        "id": node.get("id"),
        "legacy_id": str(node.get("legacyResourceId") or ""),
        "name": node.get("name") or "",
        "created_at": node.get("createdAt"),
        "closed": bool(node.get("closed")),
        "cancelled_at": node.get("cancelledAt"),
        "tags": list(node.get("tags") or []),
        "financial_status": node.get("displayFinancialStatus") or "",
        "fulfillment_status": node.get("displayFulfillmentStatus") or "",
        "items_count": int(node.get("currentSubtotalLineItemsQuantity") or 0),
        "total_price": str(money.get("amount") or "0"),
        "currency": money.get("currencyCode") or "",
        "customer_name": ((node.get("customer") or {}).get("displayName") or shipping.get("name") or "").strip(),
        "destination": ", ".join(v for v in (shipping.get("city"), shipping.get("countryCodeV2")) if v),
        "line_items": items,
    }


async def _product_ids_for_title(store: str, title: str) -> List[str]:
    _tokens, terms = _title_terms(title)
    if not terms:
        raise HTTPException(422, "Type at least two letters of the product title")
    data = await _read(PRODUCT_TITLE_IDS_GQL, {"query": " AND ".join(terms), "first": PRODUCT_TITLE_MATCHES}, store)
    return [node["id"] for node in ((data.get("products") or {}).get("nodes") or []) if node.get("id")]


async def _shop_domain(store: str) -> str:
    try:
        from .main import resolve_store_settings_effective  # type: ignore
        domain, _token, _api = await resolve_store_settings_effective(store)
        return (domain or "").strip()
    except Exception:
        return ""


@router.get("/api/agent/orders/list")
async def list_confirmation_orders(
    store: str,
    q: str = "",
    fulfillment: List[str] = Query(default=[]),
    payment: List[str] = Query(default=[]),
    status: List[str] = Query(default=[]),
    tag: List[str] = Query(default=[]),
    tag_mode: str = "any",
    exclude_tag: List[str] = Query(default=[]),
    product_id: List[str] = Query(default=[]),
    product_title: str = "",
    date_from: str = "",
    date_to: str = "",
    sort_key: str = "CREATED_AT",
    reverse: bool = True,
    after: Optional[str] = None,
    before: Optional[str] = None,
    first: int = Query(50, ge=1, le=50),
    _: User = Depends(get_current_user),
):
    store = _store(store)
    if after and before:
        raise HTTPException(422, "Use either after or before, not both")
    key = sort_key.strip().upper()
    if key not in SORT_KEYS:
        raise HTTPException(422, "Choose a supported order sort")
    product_ids = list(product_id)
    title = product_title.strip()
    title_matches = None
    if title:
        if len(title) > 255:
            raise HTTPException(422, "Use a product title of at most 255 characters")
        title_matches = await _product_ids_for_title(store, title)
        if not title_matches:
            return {"ok": True, "orders": [], "count": 0, "count_precision": "EXACT", "query": "",
                    "product_title_matches": 0, "shop_domain": await _shop_domain(store),
                    "page_info": {"has_next_page": False, "has_previous_page": False, "start_cursor": None, "end_cursor": None}}
        product_ids = [*product_ids, *title_matches][:PRODUCT_TITLE_MATCHES]
    query = build_orders_query(q=q, fulfillment=fulfillment, payment=payment, status=status, tags=tag,
                               tag_mode=tag_mode, exclude_tags=exclude_tag, product_ids=product_ids,
                               date_from=date_from, date_to=date_to)
    domain_task = asyncio.create_task(_shop_domain(store))
    data = await _read(ORDERS_LIST_GQL, {"first": None if before else first, "last": first if before else None,
                                         "after": after, "before": before, "query": query or None,
                                         "sortKey": key, "reverse": reverse}, store)
    connection = data.get("orders") or {}
    info = connection.get("pageInfo") or {}
    count = data.get("ordersCount") or {}
    return {
        "ok": True,
        "orders": [_list_row(node) for node in connection.get("nodes") or []],
        "count": count.get("count"),
        "count_precision": count.get("precision") or "EXACT",
        "query": query,
        "product_title_matches": len(title_matches) if title_matches is not None else None,
        "shop_domain": await domain_task,
        "page_info": {"has_next_page": bool(info.get("hasNextPage")), "has_previous_page": bool(info.get("hasPreviousPage")),
                      "start_cursor": info.get("startCursor"), "end_cursor": info.get("endCursor")},
    }


async def store_order_tags(store: str) -> Tuple[List[str], List[str]]:
    """Tags used on this store's orders, most used first. Cached for five minutes."""
    cached = _TAG_CACHE.get(store)
    if cached and cached[0] > time.monotonic():
        return cached[1], []
    recent, popular = await asyncio.gather(_read(RECENT_ORDER_TAGS_GQL, {}, store), _read(SHOP_ORDER_TAGS_GQL, {}, store),
                                           return_exceptions=True)
    counts: Counter = Counter()
    spelling: Dict[str, str] = {}
    warnings = []
    if isinstance(recent, Exception):
        logger.warning("recent order tags unavailable (store=%s): %s", store, recent)
    else:
        for node in ((recent.get("orders") or {}).get("nodes")) or []:
            for tag in node.get("tags") or []:
                key = str(tag).strip().lower()
                if key:
                    counts[key] += 1
                    spelling.setdefault(key, str(tag).strip())
    ordered = [spelling[key] for key, _n in counts.most_common()]
    if isinstance(popular, Exception):
        logger.info("shop order tags unavailable (store=%s): %s", store, popular)
    else:
        for edge in (((popular.get("shop") or {}).get("orderTags") or {}).get("edges")) or []:
            tag = str(edge.get("node") or "").strip()
            if tag and tag.lower() not in spelling:
                spelling[tag.lower()] = tag
                ordered.append(tag)
    if isinstance(recent, Exception) and isinstance(popular, Exception):
        warnings.append("Tag suggestions are unavailable right now. You can still type a tag.")
        return [], warnings
    _TAG_CACHE[store] = (time.monotonic() + TAG_CACHE_SECONDS, ordered)
    return ordered, warnings


@router.get("/api/agent/order-tags")
async def confirmation_order_tags(store: str, _: User = Depends(get_current_user)):
    tags, warnings = await store_order_tags(_store(store))
    return {"ok": True, "tags": tags, "warnings": warnings}
