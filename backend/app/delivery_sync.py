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


def _normalize_order_name(value: Any) -> str:
    return str(value or "").strip().lstrip("#")


def _queue_row_has_error(row: dict[str, Any]) -> bool:
    """Mirror of the browser's normalizeDeliveryQueueRow error rules."""
    if row.get("hasError") or row.get("has_error"):
        return True
    if str(row.get("errorType") or row.get("error_type") or "").strip():
        return True
    if str(row.get("status") or "").upper().startswith("ERROR"):
        return True
    city = str(row.get("city") or "").strip()
    if city and ("cityId" in row or "city_id" in row):
        city_id = row.get("cityId", row.get("city_id"))
        if city_id is None or str(city_id).strip() in {"", "0"}:
            return True
    return False


def _created_order_id(payload: Any, queue_row_id: int) -> int | None:
    for item in (payload or {}).get("results") or []:
        if not isinstance(item, dict):
            continue
        try:
            row_id = int(item.get("queueRowId") or item.get("queue_row_id") or item.get("id") or 0)
            order_id = int(item.get("orderId") or item.get("order_id") or item.get("existingOrderId") or 0)
        except (TypeError, ValueError):
            continue
        if row_id == queue_row_id and order_id > 0:
            return order_id
    return None


async def prepare_delivery_label(
    *,
    delivery_url: str,
    admin_token: str,
    store_key: str | None,
    order_number: str | None,
    client_factory: Callable[..., Any] | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, Any]:
    """Turn a freshly-intaken queue row into a delivery order with an envoy note.

    These are the same Delivery calls the Order Lookup side panel used to make
    one by one from the browser (queue search, note create, add item, assign
    envoy), done here over one pooled connection right after intake. Anything
    other than the clean path returns ok=False and the browser falls back to
    its own flow, which already handles queue errors and recovery.
    """
    base_url = str(delivery_url or "").strip().rstrip("/")
    token = str(admin_token or "").strip()
    order = _normalize_order_name(order_number)
    merchant_id = merchant_id_for_store(store_key)
    if not base_url or not token or not order or merchant_id is None:
        return {"ok": False, "reason": "not_configured"}

    headers = {"X-Admin-Token": token}
    factory = client_factory or httpx.AsyncClient
    try:
        async with factory(timeout=20.0) as client:
            queue = await client.get(
                f"{base_url}/ext/admin/merchant-queue/{merchant_id}",
                params={"limit": 500},
                headers=headers,
            )
            if queue.status_code >= 400:
                return {"ok": False, "reason": "queue_http_error", "status": queue.status_code}
            row = next(
                (
                    item for item in ((queue.json() or {}).get("items") or [])
                    if isinstance(item, dict) and _normalize_order_name(item.get("orderName") or item.get("order_name")) == order
                ),
                None,
            )
            if row is None:
                return {"ok": False, "reason": "not_in_queue"}
            if _queue_row_has_error(row):
                return {"ok": False, "reason": "queue_row_error", "queueRowId": row.get("id")}
            row_id = int(row.get("id") or 0)

            note = await client.post(
                f"{base_url}/ext/admin/merchant-notes/create",
                params={"merchant_id": merchant_id, "force_new": "true"},
                headers=headers,
            )
            if note.status_code >= 400:
                return {"ok": False, "reason": "note_http_error", "status": note.status_code}
            note_id = int((note.json() or {}).get("id") or 0)

            added = await client.post(
                f"{base_url}/ext/admin/merchant-notes/{note_id}/items",
                params={"merchant_id": merchant_id},
                headers=headers,
                json={"ids": [row_id]},
            )
            if added.status_code >= 400:
                return {"ok": False, "reason": "items_http_error", "status": added.status_code}
            delivery_order_id = _created_order_id(added.json(), row_id)
            if not delivery_order_id:
                return {"ok": False, "reason": "not_created"}

            envoy: dict[str, Any] = {}
            for attempt in range(3):
                if attempt:
                    await sleep(0.3 * attempt)
                assigned = await client.post(
                    f"{base_url}/ext/admin/envoy-notes/assign-order/{delivery_order_id}",
                    headers=headers,
                )
                if assigned.status_code == 404:
                    continue
                if assigned.status_code < 400:
                    envoy = assigned.json() or {}
                break
            if not envoy.get("code"):
                # The delivery order exists; the browser's recovery path finds
                # it by order name and attaches the envoy note itself.
                return {"ok": False, "reason": "envoy_not_ready", "deliveryOrderId": delivery_order_id}

            return {
                "ok": True,
                "merchantId": merchant_id,
                "deliveryOrderId": delivery_order_id,
                "envoyCode": envoy.get("code"),
                "company": envoy.get("company"),
                "companyShort": envoy.get("companyShort"),
                "queueRow": row,
            }
    except Exception as exc:
        return {"ok": False, "reason": "delivery_request_failed", "error_type": type(exc).__name__}
