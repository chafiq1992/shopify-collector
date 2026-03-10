import requests
from urllib.parse import quote, urlparse


def _normalize_shop_domain(shop: str) -> str:
    s = (shop or "").strip()
    # allow full URLs, keep only hostname
    if "://" in s:
        s = urlparse(s).hostname or s
    s = s.strip().strip("/")  # remove trailing slashes/spaces
    return s.lower()

def _headers(token: str):
    return {"X-Shopify-Access-Token": token, "Accept": "application/json"}

def fetch_order_by_number(shop: str, api_version: str, token: str, order_number: str):
    shop = _normalize_shop_domain(shop)
    name = f"%23{quote(str(order_number))}"
    url = f"https://{shop}/admin/api/{api_version}/orders.json?name={name}&status=any"
    r = requests.get(url, headers=_headers(token), timeout=60)
    r.raise_for_status()
    js = r.json()
    items = js.get("orders", [])
    if not items:
        raise RuntimeError(f"Order not found: #{order_number}")
    oid = items[0]["id"]
    url = f"https://{shop}/admin/api/{api_version}/orders/{oid}.json"
    r = requests.get(url, headers=_headers(token), timeout=60)
    r.raise_for_status()
    return r.json()["order"]

def hydrate_order_for_template(order: dict, currency_suffix: str = "") -> dict:
    order = dict(order)
    order["line_items_subtotal_price"] = order.get("current_subtotal_price") or order.get("subtotal_price") or "0"
    # Prefer current_total_price when present so labels reflect edits/removals
    order["total_price"] = order.get("current_total_price") or order.get("total_price") or "0"
    shp = order.get("total_shipping_price_set", {}).get("shop_money", {}).get("amount", "0")
    order["shipping_price"] = shp
    order["tax_price"] = str(order.get("total_tax") or "0")
    order["currency_suffix"] = currency_suffix
    order["tags"] = order.get("tags") or ""
    for li in order.get("line_items", []):
        qty_total = float(li.get("quantity") or 0)
        qty_unfulfilled = float(li.get("fulfillable_quantity") or 0)
        price_per_unit = float(li.get("price") or 0)
        total_discount = float(li.get("total_discount") or 0)

        # Compute per-unit discount to apportion over remaining quantity
        per_unit_discount = (total_discount / qty_total) if qty_total > 0 else 0.0
        effective_unit_price = max(price_per_unit - per_unit_discount, 0.0)

        # Price for remaining unfulfilled quantity
        final_unfulfilled = max(effective_unit_price * qty_unfulfilled, 0.0)

        # Expose both names to match the Liquid template expectations
        li["_final_line_price"] = f"{final_unfulfilled:.2f}"
        li["final_line_price"] = f"{final_unfulfilled:.2f}"

        # Hydrate a minimal variant object expected by the template
        variant_title = li.get("variant_title") or li.get("title") or ""
        # Prefer the image attached to the line item payload if present
        img = None
        try:
            img = (li.get("image") or {}).get("src")
        except Exception:
            img = None
        li["variant"] = {
            "title": variant_title,
            "featured_image": img or "",
        }
    return order

# ---------------- image hydration helpers ----------------
def _get_variant(shop: str, api_version: str, token: str, variant_id: int | str) -> dict | None:
    try:
        url = f"https://{_normalize_shop_domain(shop)}/admin/api/{api_version}/variants/{variant_id}.json"
        r = requests.get(url, headers=_headers(token), timeout=60)
        r.raise_for_status()
        return r.json().get("variant")
    except Exception:
        return None

def _get_product(shop: str, api_version: str, token: str, product_id: int | str) -> dict | None:
    try:
        url = f"https://{_normalize_shop_domain(shop)}/admin/api/{api_version}/products/{product_id}.json"
        r = requests.get(url, headers=_headers(token), timeout=60)
        r.raise_for_status()
        return r.json().get("product")
    except Exception:
        return None

def ensure_variant_images(order: dict, shop: str, api_version: str, token: str) -> dict:
    """
    Best-effort hydration of line_item.variant.featured_image when missing.
    Makes minimal REST calls per unique variant_id, falling back to product image.
    """
    if not order:
        return order

    cache: dict[str, str] = {}
    for li in order.get("line_items", []):
        # If already present, keep it
        featured = (li.get("variant") or {}).get("featured_image")
        if featured:
            continue
        vid = li.get("variant_id")
        if not vid:
            continue
        key = str(vid)
        if key in cache:
            li.setdefault("variant", {}).update({"featured_image": cache[key]})
            continue

        src = ""
        v = _get_variant(shop, api_version, token, vid) or {}
        product_id = v.get("product_id")
        image_id = v.get("image_id")
        if product_id:
            p = _get_product(shop, api_version, token, product_id) or {}
            images = p.get("images") or []
            if image_id:
                for im in images:
                    if str(im.get("id")) == str(image_id):
                        src = im.get("src") or ""
                        break
            # Fallback to product featured image
            if not src:
                src = (p.get("image") or {}).get("src") or ""

        cache[key] = src
        li.setdefault("variant", {}).update({"featured_image": src})

    return order
