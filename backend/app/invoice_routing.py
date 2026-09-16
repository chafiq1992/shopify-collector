"""Pure helpers for routing delivery-invoice rows to Shopify stores."""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, Iterable, List, Optional


RULE_TYPES = {"code_prefix", "invoice_client"}
MERCHANT_STORES = {"7": "irrakids", "9": "irranova"}


def normalize_match_value(value: Any) -> str:
    raw = str(value or "").strip().lower()
    raw = raw.replace("Ã©", "e").replace("Ã¨", "e").replace("Ãª", "e")
    raw = "".join(
        char
        for char in unicodedata.normalize("NFKD", raw)
        if not unicodedata.combining(char)
    )
    return re.sub(r"[^a-z0-9]+", " ", raw).strip()


def merchant_code_prefix(send_code: Any) -> str:
    raw = str(send_code or "").strip().lstrip("#")
    if "-" not in raw:
        return ""
    return normalize_match_value(raw.split("-", 1)[0])


def sanitize_rules(rules: Iterable[Any]) -> List[Dict[str, str]]:
    cleaned: List[Dict[str, str]] = []
    seen = set()
    for item in rules or []:
        if not isinstance(item, dict):
            continue
        match_type = str(item.get("match_type") or "").strip().lower()
        value = str(item.get("value") or "").strip()
        store = str(item.get("store") or "").strip().lower()
        carrier = str(item.get("carrier") or "").strip()
        normalized_value = normalize_match_value(value)
        normalized_carrier = normalize_match_value(carrier)
        if match_type not in RULE_TYPES or not normalized_value or not store:
            continue
        dedupe_key = (match_type, normalized_value, store, normalized_carrier)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        cleaned.append(
            {
                "match_type": match_type,
                "value": value,
                "store": store,
                "carrier": carrier,
            }
        )
    return cleaned


def resolve_row_store(
    *,
    company: Any,
    invoice_client: Any,
    send_code: Any,
    rules: Iterable[Any],
    known_stores: Iterable[str],
) -> Dict[str, Any]:
    """Route by shipment merchant identity, never by the invoice account name."""
    company_key = normalize_match_value(company)
    prefix_key = merchant_code_prefix(send_code)
    if prefix_key in MERCHANT_STORES:
        return {"store": MERCHANT_STORES[prefix_key], "source": "merchant_prefix", "rule": None}
    if not prefix_key:
        return {"store": None, "source": "missing_prefix",
                "error": "Order reference has no merchant prefix; store identity requires review"}

    candidates: List[Dict[str, Any]] = []
    for rule in sanitize_rules(rules):
        if rule["match_type"] != "code_prefix":
            continue
        carrier_key = normalize_match_value(rule.get("carrier"))
        if carrier_key and carrier_key != company_key:
            continue
        value_key = normalize_match_value(rule.get("value"))
        if prefix_key != value_key:
            continue
        candidates.append(
            {
                "store": rule["store"],
                "source": rule["match_type"],
                "rule": rule,
                "specificity": 1 if carrier_key else 0,
            }
        )

    if candidates:
        candidates.sort(key=lambda item: item["specificity"], reverse=True)
        best_specificity = candidates[0]["specificity"]
        best = [item for item in candidates if item["specificity"] == best_specificity]
        stores_found = {item["store"] for item in best}
        if len(stores_found) == 1:
            return best[0]
        return {
            "store": None,
            "source": "conflicting_rules",
            "error": "Multiple merchant-routing rules match this invoice row",
            "candidate_stores": sorted(stores_found),
        }

    return {"store": None, "source": "unmapped_prefix",
            "error": f"Merchant prefix {prefix_key} has no store mapping; add a code-prefix rule in Merchant & store settings"}


def choose_shopify_candidate(
    candidates: Iterable[Dict[str, Any]],
    *,
    invoice_crbt: Optional[float],
    is_refused: bool = False,
    tolerance: float = 3.0,
) -> Dict[str, Any]:
    matches = [dict(item) for item in candidates or [] if isinstance(item, dict)]
    if not matches:
        return {"found": False, "error": "Order not found in any connected Shopify store"}
    if len(matches) == 1:
        return {**matches[0], "found": True, "routing_source": "unique_store_match"}

    amount_matches: List[Dict[str, Any]] = []
    if invoice_crbt is not None and not is_refused:
        for item in matches:
            try:
                if abs(float(item.get("total_price") or 0) - float(invoice_crbt)) < float(tolerance):
                    amount_matches.append(item)
            except (TypeError, ValueError):
                continue
    if len(amount_matches) == 1:
        return {**amount_matches[0], "found": True, "routing_source": "unique_amount_match"}

    return {
        "found": False,
        "ambiguous": True,
        "error": "Order number exists in multiple Shopify stores; add a merchant-routing rule",
        "candidate_stores": sorted({str(item.get("store") or "") for item in matches if item.get("store")}),
        "candidates": matches,
    }
