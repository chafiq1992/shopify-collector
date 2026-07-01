"""Delivery Rate Calculator API routes.

Provides:
  - GET /api/delivery-rate — for a date range (fulfillment date) and store, computes
    per delivery-company "delivery rate": of the orders fulfilled in that window and
    tagged with a given company, what fraction ended up paid and NOT returned.

This is a live Shopify aggregate (no local DB), following the same fetch-then-aggregate
pattern as backend/app/main.py's ``aggregate_by`` mode on /api/orders, but scanning once
across ALL known company tags instead of once per company.
"""

import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

router = APIRouter()

# Fallback list if the caller doesn't pass ?companies=... explicitly. The frontend
# (frontend/src/lib/deliveryCompanies.js) is the source of truth and always passes its
# own list, so this constant only matters for direct/manual API calls.
_DEFAULT_COMPANIES = ["ibex", "l24", "oscario", "meta", "pal", "12livery", "lx", "k", "fast"]

# Heavier than a single /api/orders page (full pagination over the whole range), so cache
# for longer than the 5s TTL used elsewhere.
_CACHE_TTL_SECONDS = 60
_CACHE_MAX_KEYS = 100
_cache: Dict[str, Any] = {}


def _cache_key(store: Optional[str], date_from: str, date_to: str, companies: List[str]) -> str:
    return "|".join([(store or "").strip().lower(), date_from, date_to, ",".join(sorted(companies))])


def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    entry = _cache.get(key)
    if not entry:
        return None
    ts, val = entry
    if (time.time() - ts) > _CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    return val


def _cache_set(key: str, val: Dict[str, Any]) -> None:
    if len(_cache) >= _CACHE_MAX_KEYS:
        try:
            oldest_key = min(_cache, key=lambda k: _cache[k][0])
            _cache.pop(oldest_key, None)
        except Exception:
            _cache.clear()
    _cache[key] = (time.time(), val)


@router.get("/api/delivery-rate")
async def delivery_rate(
    date_from: str = Query(..., description="Fulfillment date range start, ISO YYYY-MM-DD (inclusive)"),
    date_to: str = Query(..., description="Fulfillment date range end, ISO YYYY-MM-DD (inclusive)"),
    store: Optional[str] = Query(None, description="Select store: 'irrakids' (default) or 'irranova'"),
    companies: Optional[str] = Query(None, description="Comma-separated delivery-company tags to bucket by; defaults to the known list"),
) -> Dict[str, Any]:
    # Lazy import to avoid a circular import at module load time (main.py imports this
    # module's router) — same convention as return_scan_routes.py's in-function import.
    from .main import fetch_fulfilled_orders_in_range

    company_list = [c.strip().lower() for c in (companies or "").split(",") if c.strip()] or list(_DEFAULT_COMPANIES)
    company_set = set(company_list)

    key = _cache_key(store, date_from, date_to, company_list)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    orders = await fetch_fulfilled_orders_in_range(store, date_from, date_to)

    counts: Dict[str, Dict[str, int]] = {
        c: {"fulfilled": 0, "delivered": 0, "returned": 0, "pending_payment": 0} for c in company_list
    }
    unassigned = 0

    for order in orders:
        tag_tokens = {str(t).strip().lower() for t in (order.tags or []) if str(t).strip()}
        matched = tag_tokens & company_set
        if not matched:
            unassigned += 1
            continue
        is_paid = (order.financial_status or "").strip().lower() == "paid"
        is_returned = (order.return_status or "").strip().upper() == "RETURNED"
        for company in matched:
            bucket = counts[company]
            bucket["fulfilled"] += 1
            if is_returned:
                bucket["returned"] += 1
            elif is_paid:
                bucket["delivered"] += 1
            else:
                bucket["pending_payment"] += 1

    company_rows = []
    for company in company_list:
        bucket = counts[company]
        fulfilled = bucket["fulfilled"]
        rate = round(100.0 * bucket["delivered"] / fulfilled, 1) if fulfilled > 0 else None
        company_rows.append({
            "company": company,
            "fulfilled": fulfilled,
            "delivered": bucket["delivered"],
            "returned": bucket["returned"],
            "pending_payment": bucket["pending_payment"],
            "rate": rate,
        })

    total_fulfilled = sum(r["fulfilled"] for r in company_rows)
    total_delivered = sum(r["delivered"] for r in company_rows)
    overall_rate = round(100.0 * total_delivered / total_fulfilled, 1) if total_fulfilled > 0 else None

    resp = {
        "from": date_from,
        "to": date_to,
        "store": store or "",
        "companies": company_rows,
        "unassigned_fulfilled": unassigned,
        "overall": {
            "fulfilled": total_fulfilled,
            "delivered": total_delivered,
            "rate": overall_rate,
        },
    }
    _cache_set(key, resp)
    return resp
