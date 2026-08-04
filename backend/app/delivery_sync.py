import asyncio
import os
from typing import Any, Awaitable, Callable

import httpx


DEFAULT_MERCHANT_IDS = {
    "irrakids": 7,
    "irranova": 9,
}


def merchant_id_for_store(store_key: str | None) -> int | None:
    key = str(store_key or "").strip().lower()
    if not key:
        return None
    env_name = f"DELIVERY_MERCHANT_ID_{key.upper()}"
    raw = str(os.getenv(env_name) or DEFAULT_MERCHANT_IDS.get(key) or "").strip()
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _intake_completed(payload: dict[str, Any]) -> bool:
    for item in payload.get("results") or []:
        outcome = item.get("outcome") if isinstance(item, dict) else None
        if not isinstance(outcome, dict):
            continue
        if outcome.get("enqueued") is True:
            return True
        if outcome.get("updated") is True or outcome.get("skipped") is True:
            return True
        # Validation-error rows are visible in the merchant queue for correction.
        if outcome.get("error") in {"city", "phone"}:
            return True
    return False


async def sync_fulfilled_order_to_delivery(
    *,
    delivery_url: str,
    admin_token: str,
    store_key: str | None,
    order_number: str | None,
    attempts: int = 3,
    client_factory: Callable[..., Any] | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, Any]:
    """Immediately replay a fulfilled Shopify order into Delivery intake."""
    base_url = str(delivery_url or "").strip().rstrip("/")
    token = str(admin_token or "").strip()
    order = str(order_number or "").strip().lstrip("#")
    merchant_id = merchant_id_for_store(store_key)
    if not base_url or not token or not order or merchant_id is None:
        return {"ok": False, "reason": "not_configured"}

    factory = client_factory or httpx.AsyncClient
    last_result: dict[str, Any] = {"ok": False, "reason": "not_attempted"}
    async with factory(timeout=20.0) as client:
        for attempt in range(1, max(1, attempts) + 1):
            if attempt > 1:
                await sleep(float(attempt - 1))
            try:
                response = await client.post(
                    f"{base_url}/admin/shopify/backfill",
                    headers={"X-Admin-Token": token},
                    json={
                        "merchant_id": merchant_id,
                        "order_names": [order],
                        "limit": 5,
                    },
                )
                if response.status_code >= 400:
                    last_result = {
                        "ok": False,
                        "reason": "delivery_http_error",
                        "status": response.status_code,
                        "attempt": attempt,
                    }
                    if response.status_code < 500:
                        break
                    continue
                payload = response.json() or {}
                if _intake_completed(payload):
                    return {"ok": True, "attempt": attempt, "merchant_id": merchant_id}
                last_result = {
                    "ok": False,
                    "reason": "shopify_not_consistent_yet",
                    "attempt": attempt,
                }
            except Exception as exc:
                last_result = {
                    "ok": False,
                    "reason": "delivery_request_failed",
                    "attempt": attempt,
                    "error_type": type(exc).__name__,
                }
    return last_result
