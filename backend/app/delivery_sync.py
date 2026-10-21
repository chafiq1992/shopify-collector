import asyncio
import datetime as dt
import os
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import httpx


DEFAULT_MERCHANT_IDS = {
    "irrakids": 7,
    "irranova": 9,
}

# Delivery's names for "no company yet". Mirrors frontend/src/lib/directEnvoyPrint.js.
UNASSIGNED_COMPANY_KEYS = {"", "unassigned", "unas", "none", "no company"}


def delivery_store_keys() -> list[str]:
    """Stores whose fulfilled orders land in a Delivery merchant queue."""
    return [key for key in DEFAULT_MERCHANT_IDS if merchant_id_for_store(key) is not None]


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


def _company_assigned(name: Any, short: Any = None) -> bool:
    return any(str(value or "").strip().lower() not in UNASSIGNED_COMPANY_KEYS for value in (name, short))


def _not_ready(status: int, reason: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"ok": False, "status": status, "reason": reason, "message": message, **extra}


async def check_label_readiness(
    *,
    delivery_url: str,
    admin_token: str,
    delivery_order_id: Any,
    envoy_code: str | None = None,
    client_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Decide whether a delivery label may be printed.

    A label is printable only once the order has landed in its envoy company:
    it sits in a company's envoy note (never Unassigned) and, when that company
    has a connected partner API, the partner accepted the parcel. A company
    without one (in-house drivers, carriers handed parcels at the counter) has
    nothing to accept it, so its envoy note is enough. Labels used to be printed
    for parcels no carrier had accepted, which is how parcels reached the wrong
    company while Delivery still showed the first one.

    ``status`` is 409 when the order is not ready and 503 when Delivery could
    not be read, so callers can tell "fix the order" from "try again".
    """
    base_url = str(delivery_url or "").strip().rstrip("/")
    token = str(admin_token or "").strip()
    order_id = str(delivery_order_id or "").strip()
    if not base_url or not token:
        return _not_ready(503, "not_configured", "Delivery is not configured, so the envoy cannot be confirmed.")
    if not order_id.isdigit():
        return _not_ready(400, "invalid_order", "Unknown delivery order.")

    headers = {"X-Admin-Token": token}
    factory = client_factory or httpx.AsyncClient
    try:
        async with factory(timeout=15.0) as client:
            current = await client.get(f"{base_url}/ext/admin/envoy-notes/for-order/{order_id}", headers=headers)
            if current.status_code == 404:
                return _not_ready(409, "no_envoy", "This order is not in an envoy note yet. Assign its company first.")
            if current.status_code >= 400:
                return _not_ready(503, "delivery_http_error", f"Delivery could not confirm the envoy (HTTP {current.status_code}). Try again.")
            envoy = current.json() or {}
            code = str(envoy.get("code") or "").strip()
            company = str(envoy.get("company") or "").strip()
            if not code:
                return _not_ready(409, "no_envoy", "This order is not in an envoy note yet. Assign its company first.")
            requested = str(envoy_code or "").strip()
            if requested and requested != code:
                return _not_ready(
                    409, "envoy_moved",
                    f"This order moved to {company or 'another company'} ({code}). Reopen it before printing.",
                    envoyCode=code, company=company,
                )
            if not _company_assigned(company, envoy.get("companyShort")):
                return _not_ready(409, "unassigned", "This order is still Unassigned. Choose its envoy company before printing.")

            detail = await client.get(f"{base_url}/admin/envoy-notes/{quote(code, safe='')}", headers=headers)
            if detail.status_code >= 400:
                return _not_ready(503, "delivery_http_error", f"Delivery could not read envoy {code} (HTTP {detail.status_code}). Try again.")
            note = detail.json() or {}
            item = next(
                (
                    row for row in (note.get("items") or [])
                    if isinstance(row, dict) and str(row.get("orderId") or row.get("order_id") or "") == order_id
                ),
                None,
            )
            if item is None:
                return _not_ready(409, "not_in_note", f"Envoy {code} no longer contains this order. Reopen it before printing.")
            partner_api = bool(note.get("partnerId"))
            if partner_api and item.get("sentOk") is not True:
                reason = str(item.get("sentMsg") or "").strip()[:200]
                return _not_ready(
                    409, "not_accepted",
                    f"{company} has not accepted this order yet{': ' + reason if reason else ''}. "
                    f"Send it to {company} before printing.",
                    envoyCode=code, company=company,
                )
            return {"ok": True, "envoyCode": code, "company": company, "partnerApi": partner_api}
    except Exception as exc:
        return _not_ready(
            503, "delivery_request_failed",
            "Delivery could not be reached to confirm the envoy. Try again.",
            error_type=type(exc).__name__,
        )


async def list_unsent_queue_rows(
    *,
    delivery_url: str,
    admin_token: str,
    store_keys: list[str],
    client_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Every order still waiting in a store's Delivery merchant queue.

    Delivery keeps NEW and ERROR rows until they become a delivery order, so
    this is the durable list of fulfilled orders nobody has sent yet, the same
    after a reload or on another device. A queue that cannot be read is
    reported in ``errors``; it is never shown as an empty list.
    """
    base_url = str(delivery_url or "").strip().rstrip("/")
    token = str(admin_token or "").strip()
    items: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    if not base_url or not token:
        return {"items": items, "errors": [{"store": None, "message": "Delivery is not configured"}]}
    factory = client_factory or httpx.AsyncClient
    async with factory(timeout=20.0) as client:
        for store_key in store_keys:
            merchant_id = merchant_id_for_store(store_key)
            if merchant_id is None:
                continue
            try:
                response = await client.get(
                    f"{base_url}/ext/admin/merchant-queue/{merchant_id}",
                    params={"limit": 1000},
                    headers={"X-Admin-Token": token},
                )
            except Exception as exc:
                errors.append({"store": store_key, "message": f"Delivery queue unreachable ({type(exc).__name__})"})
                continue
            if response.status_code >= 400:
                errors.append({"store": store_key, "message": f"Delivery queue returned HTTP {response.status_code}"})
                continue
            for row in (response.json() or {}).get("items") or []:
                if not isinstance(row, dict):
                    continue
                number = _normalize_order_name(row.get("orderName") or row.get("order_name"))
                if not number:
                    continue
                has_error = _queue_row_has_error(row)
                status = str(row.get("status") or "").strip()
                items.append({
                    "kind": "queue_error" if has_error else "queue_new",
                    "store": store_key,
                    "merchantId": merchant_id,
                    "queueRowId": row.get("id"),
                    "orderNumber": number,
                    "status": status or ("ERROR" if has_error else "NEW"),
                    "hasError": has_error,
                    "errorType": str(row.get("errorType") or "").strip() or ("city" if has_error and not row.get("cityId") else None),
                    "city": row.get("city"),
                    "cityRaw": row.get("cityRaw"),
                    "customerName": row.get("customerName"),
                    "createdAt": row.get("createdAt"),
                })
    return {"items": items, "errors": errors}


async def find_delivery_order(
    *,
    delivery_url: str,
    admin_token: str,
    store_key: str | None,
    order_number: str | None,
    client_factory: Callable[..., Any] | None = None,
    today: dt.date | None = None,
) -> dict[str, Any]:
    """Whether Delivery already has an order with this Shopify number."""
    base_url = str(delivery_url or "").strip().rstrip("/")
    token = str(admin_token or "").strip()
    order = _normalize_order_name(order_number)
    merchant_id = merchant_id_for_store(store_key)
    if not base_url or not token or not order or merchant_id is None:
        return {"ok": False, "reason": "not_configured"}
    end = today or dt.date.today()
    factory = client_factory or httpx.AsyncClient
    try:
        async with factory(timeout=15.0) as client:
            response = await client.get(
                f"{base_url}/admin/orders",
                params={
                    "merchant_id": merchant_id,
                    "q": order,
                    "start": (end - dt.timedelta(days=45)).isoformat(),
                    "end": end.isoformat(),
                    "limit": 10,
                },
                headers={"X-Admin-Token": token},
            )
            if response.status_code >= 400:
                return {"ok": False, "reason": "delivery_http_error", "status": response.status_code}
            rows = (response.json() or {}).get("rows") or []
            found = any(_normalize_order_name(row.get("orderName")) == order for row in rows if isinstance(row, dict))
            return {"ok": True, "found": found}
    except Exception as exc:
        return {"ok": False, "reason": "delivery_request_failed", "error_type": type(exc).__name__}
