"""Product-first catalog search for the confirmation order forms.

Search returns products, not variants, ranked by how many of the typed words
the product title covers. Typing a full or partial title therefore puts that
product first and leaves out products that share only a word or two with it.
An agent expands a product to load its variants and their stock counts.
"""
import base64
import hashlib
import hmac
import json
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException

from .auth_routes import get_current_user
from .confirmation_routes import (
    CONFIRMATION_API_VERSION, PRODUCT_PICKER_VARIANTS_GQL, _picker_connection_info,
    _picker_enrich_stock, _picker_fold, _picker_product_nodes, _picker_tokens,
)
from .models import User

router = APIRouter()

STRICT_PAGE = 25
LOOSE_PAGE = 40
LOOSE_PAGES_PER_REQUEST = 3
MAX_VARIANT_PAGES = 3
# A product stays in the results when its title covers at least this much less
# of the typed words than the best title does: with a full match, 3 of 4 words.
COVERAGE_SLACK = 0.25

PRODUCT_SUMMARY_FIELDS = """
id title status totalInventory tracksInventory hasOnlyDefaultVariant
featuredImage { url } variantsCount { count }
priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
"""

# One request reads the products that contain every typed word (strict), the
# products that contain any of them (loose, ranked here before display) and
# the variants whose SKU or barcode starts with the query.
PRODUCT_SEARCH_GQL = f"""
query ConfirmationProductSearch(
  $withStrict: Boolean!, $strictFirst: Int!, $strictAfter: String, $strictQuery: String!,
  $withLoose: Boolean!, $looseFirst: Int!, $looseAfter: String, $looseQuery: String!,
  $withIdentifiers: Boolean!, $identifierQuery: String!
) {{
  shop {{ currencyCode }}
  strict: products(first: $strictFirst, after: $strictAfter, query: $strictQuery, sortKey: RELEVANCE) @include(if: $withStrict) {{
    nodes {{ {PRODUCT_SUMMARY_FIELDS} }}
    pageInfo {{ hasNextPage endCursor }}
  }}
  loose: products(first: $looseFirst, after: $looseAfter, query: $looseQuery, sortKey: RELEVANCE) @include(if: $withLoose) {{
    nodes {{ {PRODUCT_SUMMARY_FIELDS} }}
    pageInfo {{ hasNextPage endCursor }}
  }}
  identifiers: productVariants(first: 10, query: $identifierQuery) @include(if: $withIdentifiers) {{
    nodes {{ id product {{ {PRODUCT_SUMMARY_FIELDS} }} }}
  }}
}}
"""

PRODUCT_LOOKUP_GQL = f"""
query ConfirmationProductLookup($ids: [ID!]!) {{
  shop {{ currencyCode }}
  nodes(ids: $ids) {{
    ... on Product {{ {PRODUCT_SUMMARY_FIELDS} }}
    ... on ProductVariant {{ id product {{ {PRODUCT_SUMMARY_FIELDS} }} }}
  }}
}}
"""


async def _read(query: str, variables: Dict[str, Any], store: str) -> Dict[str, Any]:
    from .main import shopify_graphql  # type: ignore
    return await shopify_graphql(query, variables, store=store, api_version=CONFIRMATION_API_VERSION) or {}


def _words(value: Any) -> List[str]:
    return re.findall(r"[^\W_]+", _picker_fold(value), flags=re.UNICODE)


def _stem(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def _token_in(token: str, words: List[str]) -> bool:
    stem = _stem(token)
    return any(word.startswith(token) or _stem(word) == stem for word in words)


def _contains_run(haystack: List[str], needle: List[str]) -> bool:
    size = len(needle)
    return any(haystack[index:index + size] == needle for index in range(len(haystack) - size + 1))


def title_relevance(title: str, tokens: List[str]) -> Tuple[float, float]:
    """Return (coverage, score) of a product title for the typed tokens.

    Coverage is the share of typed words found at the start of a title word
    (singular and plural both count). The score adds bonuses for an exact title,
    a title that starts with the typed words, or contains them in order, and a
    small penalty per extra title word so a concise exact match ranks first.
    """
    if not tokens:
        return 0.0, 0.0
    words = _words(title)
    matched = sum(1 for token in tokens if _token_in(token, words))
    coverage = matched / len(tokens)
    title_tokens = _picker_tokens(title)
    score = coverage * 100
    if title_tokens == tokens:
        score += 40
    elif title_tokens[:len(tokens)] == tokens:
        score += 20
    elif len(tokens) > 1 and _contains_run(title_tokens, tokens):
        score += 10
    score -= min(10.0, 0.5 * max(0, len(title_tokens) - matched))
    return coverage, score


def _title_terms(raw: str) -> Tuple[List[str], List[str]]:
    tokens = _picker_tokens(raw)
    raw_tokens = re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", raw.casefold()), flags=re.UNICODE)
    terms = []
    for word in tokens:
        # The accented spelling the agent typed is searched alongside its folded form.
        alternatives = list(dict.fromkeys([word, *(token for token in raw_tokens if _picker_fold(token) == word)]))
        terms.append("(" + " OR ".join(f"title:{token}*" for token in alternatives) + ")")
    return tokens, terms


def _identifier_query(raw: str) -> Optional[str]:
    if re.search(r"\s", raw):
        return None
    if re.fullmatch(r"\w[\w.\-/]*", raw, flags=re.UNICODE):
        literal = raw.replace("\\", "\\\\") + "*"
    else:
        literal = '"' + raw.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return f"(sku:{literal}) OR (barcode:{literal})"


def _money(bag: Optional[Dict[str, Any]]) -> Tuple[Optional[str], str]:
    bag = bag or {}
    return (str(bag["amount"]) if bag.get("amount") is not None else None), bag.get("currencyCode") or ""


def product_summary(node: Dict[str, Any], currency: str = "") -> Dict[str, Any]:
    prices = node.get("priceRangeV2") or {}
    low, low_currency = _money(prices.get("minVariantPrice"))
    high, _ = _money(prices.get("maxVariantPrice"))
    tracked = node.get("tracksInventory")
    return {
        "id": node.get("id") or "",
        "title": node.get("title") or "",
        "status": node.get("status") or "",
        "image": (node.get("featuredImage") or {}).get("url"),
        "variants_count": (node.get("variantsCount") or {}).get("count"),
        "has_only_default_variant": bool(node.get("hasOnlyDefaultVariant")),
        "tracks_inventory": tracked,
        "total_inventory": node.get("totalInventory") if tracked else None,
        "price_min": low,
        "price_max": high,
        "currency": low_currency or currency,
        "matched_variant_ids": [],
    }


def _scope(store: str, raw: str) -> str:
    return hashlib.sha256(json.dumps(["products", store, raw], ensure_ascii=False).encode()).hexdigest()


def _sign(payload: bytes) -> bytes:
    from .auth_routes import JWT_SECRET
    return hmac.new(JWT_SECRET.encode(), b"confirmation-products\0" + payload, hashlib.sha256).digest()


def encode_cursor(state: Dict[str, Any]) -> str:
    payload = json.dumps(state, separators=(",", ":"), ensure_ascii=False).encode()
    return ".".join(base64.urlsafe_b64encode(value).decode().rstrip("=") for value in (payload, _sign(payload)))


def decode_cursor(token: str, scope: str) -> Dict[str, Any]:
    try:
        if len(token) > 8192:
            raise ValueError()
        parts = token.split(".")
        if len(parts) != 2:
            raise ValueError()
        payload, signature = [base64.b64decode(v + "=" * (-len(v) % 4), altchars=b"-_", validate=True) for v in parts]
        if not hmac.compare_digest(signature, _sign(payload)):
            raise ValueError()
        state = json.loads(payload)
        floor = state.get("floor")
        if state.get("v") != 1 or state.get("scope") != scope or not isinstance(floor, (int, float)) or not 0 <= floor <= 1:
            raise ValueError()
        if not (state.get("strict_after") or state.get("loose_after")):
            raise ValueError()
        return state
    except (ValueError, TypeError, AttributeError, UnicodeDecodeError):
        raise HTTPException(422, "This product-search page belongs to a different search. Search again.")


def _ranked(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    kind_rank = {"id": 0, "identifier": 1}
    entries.sort(key=lambda entry: (kind_rank.get(entry["match_kind"], 2), -entry["_score"], entry["title"].casefold()))
    for entry in entries:
        entry.pop("_score", None)
    return entries


def _title_entry(node: Dict[str, Any], tokens: List[str], currency: str) -> Dict[str, Any]:
    coverage, score = title_relevance(node.get("title") or "", tokens)
    entry = product_summary(node, currency)
    entry.update(_score=score, coverage=round(coverage, 3),
                 match_kind="exact" if score >= 140 else "title" if coverage >= 1 else "partial")
    return entry


async def _id_lookup(store: str, raw: str) -> Optional[Tuple[List[Dict[str, Any]], str]]:
    explicit = re.fullmatch(r"gid://shopify/(Product|ProductVariant)/(\d+)", raw)
    if not (explicit or raw.isdigit()):
        return None
    ids = [raw] if explicit else [f"gid://shopify/Product/{raw}", f"gid://shopify/ProductVariant/{raw}"]
    data = await _read(PRODUCT_LOOKUP_GQL, {"ids": ids}, store)
    currency = (data.get("shop") or {}).get("currencyCode") or ""
    found: Dict[str, Dict[str, Any]] = {}
    for node in [n for n in data.get("nodes") or [] if n]:
        is_variant = str(node.get("id") or "").startswith("gid://shopify/ProductVariant/")
        product = node.get("product") if is_variant else node
        if not product or not product.get("id"):
            continue
        entry = found.setdefault(product["id"], {**product_summary(product, currency), "match_kind": "id", "_score": 0})
        if is_variant:
            entry["matched_variant_ids"].append(node["id"])
    if not found and explicit:
        return [], currency
    return (_ranked(list(found.values())), currency) if found else None


async def search_products_page(store: str, raw: str, state: Optional[Dict[str, Any]]):
    """Return (products, currency, next_state) for one page of a product search."""
    tokens, terms = _title_terms(raw)
    first_page = state is None
    if first_page:
        direct = await _id_lookup(store, raw)
        if direct is not None:
            products, currency = direct
            return products, currency, None
    identifier_query = _identifier_query(raw) if first_page else None
    if not terms and not identifier_query:
        return [], "", None

    strict_after = None if first_page else state.get("strict_after")
    loose_after = None if first_page else state.get("loose_after")
    floor = 0.0 if first_page else float(state["floor"])
    with_strict = bool(terms) and (first_page or bool(strict_after))
    # The loose query only adds candidates when there is more than one word.
    with_loose = len(terms) > 1 and (first_page or (not strict_after and bool(loose_after)))
    variables = {
        "withStrict": with_strict, "strictFirst": STRICT_PAGE, "strictAfter": strict_after,
        "strictQuery": " AND ".join(terms) or "-", "withLoose": with_loose, "looseFirst": LOOSE_PAGE,
        "looseAfter": loose_after, "looseQuery": " OR ".join(terms) or "-",
        "withIdentifiers": bool(identifier_query), "identifierQuery": identifier_query or "-",
    }
    entries: Dict[str, Dict[str, Any]] = {}
    currency = ""
    loose_more = False
    for attempt in range(LOOSE_PAGES_PER_REQUEST if with_loose and not with_strict else 1):
        data = await _read(PRODUCT_SEARCH_GQL, variables, store)
        currency = currency or (data.get("shop") or {}).get("currencyCode") or ""
        for variant in ((data.get("identifiers") or {}).get("nodes") or []):
            product = variant.get("product") or {}
            if not product.get("id"):
                continue
            entry = entries.setdefault(product["id"], {**product_summary(product, currency), "match_kind": "identifier", "_score": 0})
            entry["match_kind"] = "identifier"
            entry["matched_variant_ids"].append(variant["id"])
        strict = data.get("strict") or {}
        for node in strict.get("nodes") or []:
            if node.get("id") and node["id"] not in entries:
                # Shopify matched every word here; keep it even if local folding differs.
                entries[node["id"]] = _title_entry(node, tokens, currency)
        loose = data.get("loose") or {}
        loose_entries = [_title_entry(node, tokens, currency) for node in loose.get("nodes") or [] if node.get("id")]
        if first_page:
            titled = [e for e in entries.values() if "coverage" in e] + loose_entries
            best = max((e["coverage"] for e in titled), default=0.0)
            if strict.get("nodes"):
                best = 1.0
            floor = max(0.0, round(best - COVERAGE_SLACK, 3))
        for entry in loose_entries:
            if entry["id"] not in entries and entry["coverage"] > 0 and entry["coverage"] >= floor:
                entries[entry["id"]] = entry
        if with_strict:
            more, end = _picker_connection_info(strict, strict_after)
            strict_after = end if more else None
        if with_loose:
            loose_more, end = _picker_connection_info(loose, loose_after)
            loose_after = end if loose_more else None
        if with_strict or entries or not loose_after:
            break
        variables = {**variables, "looseAfter": loose_after}
    following = None
    if strict_after or loose_after:
        following = {"v": 1, "scope": _scope(store, raw), "floor": floor,
                     "strict_after": strict_after, "loose_after": loose_after}
    return _ranked(list(entries.values())), currency, following


@router.get("/api/agent/products/search")
async def search_confirmation_products(store: str, q: str, after: Optional[str] = None, _: User = Depends(get_current_user)):
    from .main import _normalize_store  # type: ignore
    query = (q or "").strip()
    if not (store or "").strip():
        raise HTTPException(422, "Store is required")
    if len(query) > 255:
        raise HTTPException(422, "Use a product search of at most 255 characters")
    empty = {"has_next_page": False, "end_cursor": None}
    if len(query) < 2:
        return {"ok": True, "products": [], "query": query, "currency": "", "warnings": [], "page_info": empty}
    store = _normalize_store(store.strip())
    state = decode_cursor(after, _scope(store, query)) if after else None
    products, currency, following = await search_products_page(store, query, state)
    cursor = encode_cursor(following) if following else None
    return {"ok": True, "products": products, "query": query, "currency": currency, "warnings": [],
            "page_info": {"has_next_page": bool(cursor), "end_cursor": cursor}}


@router.get("/api/agent/products/variants")
async def confirmation_product_variants(store: str, product_id: str, _: User = Depends(get_current_user)):
    from .main import _normalize_store  # type: ignore
    if not (store or "").strip():
        raise HTTPException(422, "Store is required")
    product_gid = (product_id or "").strip()
    if product_gid.isdigit():
        product_gid = f"gid://shopify/Product/{product_gid}"
    if not re.fullmatch(r"gid://shopify/Product/\d+", product_gid):
        raise HTTPException(422, "Choose a valid Shopify product")
    store = _normalize_store(store.strip())
    nodes: List[Dict[str, Any]] = []
    currency = ""
    product: Dict[str, Any] = {}
    after = None
    warnings: List[str] = []
    for page in range(MAX_VARIANT_PAGES):
        data = await _read(PRODUCT_PICKER_VARIANTS_GQL, {"id": product_gid, "first": 100, "after": after}, store)
        product = data.get("product") or {}
        if not product:
            raise HTTPException(404, "This product is no longer available. Search again.")
        currency = currency or (data.get("shop") or {}).get("currencyCode") or ""
        nodes.extend(_picker_product_nodes(product))
        more, after = _picker_connection_info(product.get("variants"), after)
        if not more:
            break
        if page == MAX_VARIANT_PAGES - 1:
            warnings.append(f"Only the first {len(nodes)} variants are shown. Search the SKU to find another variant.")
    variants, stock_warnings = await _picker_enrich_stock(nodes, currency, store)
    return {"ok": True, "currency": currency, "warnings": [*warnings, *stock_warnings], "variants": variants,
            "product": {"id": product.get("id"), "title": product.get("title") or "",
                        "image": (product.get("featuredImage") or {}).get("url")}}
