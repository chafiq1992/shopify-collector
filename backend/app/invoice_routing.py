"""Pure helpers for routing delivery-invoice rows to Shopify stores."""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, Iterable, List, Optional


RULE_TYPES = {"code_prefix", "invoice_client"}


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
    """Resolve a row using explicit rules, then an exact client/store identity."""
    company_key = normalize_match_value(company)
    client_key = normalize_match_value(invoice_client)
    prefix_key = merchant_code_prefix(send_code)
    stores = {str(store or "").strip().lower() for store in known_stores or [] if str(store or "").strip()}

    candidates: List[Dict[str, Any]] = []
    for rule in sanitize_rules(rules):
        carrier_key = normalize_match_value(rule.get("carrier"))
        if carrier_key and carrier_key != company_key:
            continue
        value_key = normalize_match_value(rule.get("value"))
        actual = prefix_key if rule["match_type"] == "code_prefix" else client_key
        if actual != value_key:
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

    # Common carrier labels include account IDs, e.g. "5716-irrakids".
    # Treat a known store token as an implicit exact identity, but do not use
    # fuzzy substring matching ("kids" must not match "irrakids").
    client_tokens = set(client_key.split())
    implicit = sorted(store for store in stores if normalize_match_value(store) in client_tokens)
    if len(implicit) == 1:
        return {"store": implicit[0], "source": "invoice_client_store_key", "rule": None}
    return {"store": None, "source": None, "rule": None}


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
