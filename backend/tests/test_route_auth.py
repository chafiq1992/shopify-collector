"""Routes that return order/customer or store data must refuse anonymous callers.

These run the real auth dependency (get_current_user) against a throwaway
SQLite database: a real user row and a real signed token, no overrides.
"""
import asyncio
import uuid

import pytest
from fastapi.testclient import TestClient

from backend.app import main
from backend.app import models
from backend.app.auth_routes import _issue_token
from backend.app.db import engine, SessionLocal


PROTECTED_GETS = [
    "/api/orders?limit=1",
    "/api/print-data?numbers=1001",
    "/api/delivery-config",
    "/api/shopify/stores",
    "/api/shopify/oauth/status?store=irrakids",
]


def _run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


@pytest.fixture(scope="module")
def client():
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(models.Base.metadata.create_all)
        await engine.dispose()  # connections are loop-bound; TestClient runs its own

    _run(_setup())
    # No lifespan: startup hooks would try to reach Shopify / run DDL.
    return TestClient(main.app)


@pytest.fixture(scope="module")
def token():
    async def _mk():
        async with SessionLocal() as db:
            user = models.User(
                email=f"route-auth-{uuid.uuid4().hex[:8]}@example.test",
                name="route auth test",
                password_hash="x",
                role="collector",
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)
            tok = _issue_token(user)
        await engine.dispose()
        return tok

    return _run(_mk())


@pytest.fixture(autouse=True)
def _no_shopify(monkeypatch):
    # /api/orders must never reach Shopify from a test.
    async def _unconfigured(store=None):
        return (None, None, None)

    monkeypatch.setattr(main, "resolve_store_settings_effective", _unconfigured)


@pytest.mark.parametrize("path", PROTECTED_GETS)
def test_anonymous_request_is_refused(client, path):
    r = client.get(path)
    assert r.status_code == 401, (path, r.status_code)


@pytest.mark.parametrize("path", PROTECTED_GETS)
def test_garbage_token_is_refused(client, path):
    r = client.get(path, headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401, (path, r.status_code)


@pytest.mark.parametrize("path", PROTECTED_GETS)
def test_signed_in_user_is_served(client, token, path):
    r = client.get(path, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, (path, r.status_code, r.text[:200])


def test_print_data_empty_numbers_still_needs_auth(client, token):
    assert client.get("/api/print-data").status_code == 401
    r = client.get("/api/print-data", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "orders": []}


@pytest.mark.skipif(getattr(main, "ENABLE_API_DOCS", False), reason="ENABLE_API_DOCS is set in this environment")
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"])
def test_api_docs_are_off_by_default(client, path):
    r = client.get(path)
    assert r.status_code == 404, (path, r.status_code)


def test_print_agent_routes_keep_their_own_auth(client):
    # /pull is authenticated by pc_id + X-PC-Secret, not by a user token; it
    # must keep answering the shop's print agents exactly as before.
    r = client.get("/pull", params={"pc_id": "nope"}, headers={"X-PC-Secret": "wrong"})
    assert r.status_code == 401


# ── Second pass: writes, remaining reads, and the delivery admin proxy ──────

GID = "gid://shopify/Order/1"

PROTECTED_CALLS = [
    ("POST", f"/api/orders/{GID}/add-tag", {"tag": "t"}),
    ("POST", f"/api/orders/{GID}/remove-tag", {"tag": "t"}),
    ("POST", f"/api/orders/{GID}/append-note", {"append": "x"}),
    ("POST", f"/api/orders/{GID}/fulfill", {}),
    ("GET", f"/api/orders/{GID}/fulfillment-orders", None),
    ("GET", "/api/order-tagger/status?store=irrakids", None),
    ("GET", "/api/delivery-rate?date_from=2026-09-01&date_to=2026-09-02", None),
    # The proxy attaches the delivery app's admin token to what it forwards.
    ("GET", "/api/delivery/ext/admin/merchants", None),
    ("POST", "/api/delivery/ext/admin/merchant-notes/create", {}),
    ("PUT", "/api/delivery/admin/orders/1", {}),
    ("DELETE", "/api/delivery/admin/orders/1", None),
]


def _call(client, method, path, body, headers=None):
    return client.request(method, path, json=body, headers=headers or {})


@pytest.mark.parametrize("method,path,body", PROTECTED_CALLS)
def test_anonymous_call_is_refused(client, method, path, body):
    r = _call(client, method, path, body)
    assert r.status_code == 401, (method, path, r.status_code)


@pytest.mark.parametrize("method,path,body", PROTECTED_CALLS)
def test_garbage_token_call_is_refused(client, method, path, body):
    r = _call(client, method, path, body, {"Authorization": "Bearer nope"})
    assert r.status_code == 401, (method, path, r.status_code)


def test_anonymous_delivery_admin_merchants_is_401(client):
    # The exact request that bypassed the delivery app's own admin auth.
    assert client.get("/api/delivery/ext/admin/merchants").status_code == 401


def test_signed_in_user_passes_the_delivery_proxy_gate(client, token, monkeypatch):
    # No backend configured in tests, so a request that clears auth gets the
    # proxy's own 503 rather than a 401 - and never leaves the process.
    monkeypatch.setattr(main, "DELVERY_BACKEND_URL", "")
    r = client.get("/api/delivery/ext/admin/merchants", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 503, r.status_code


def test_signed_in_user_can_read_order_tagger_status(client, token):
    r = client.get("/api/order-tagger/status?store=irrakids", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.status_code
