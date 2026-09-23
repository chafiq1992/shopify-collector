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


# ── Print routes: /api/overrides and /api/delivery-label ─────────────────────
# Accepted: a user bearer, pc_id + X-PC-Secret (as /pull), and for the label a
# short-lived signed URL. PRINT_ROUTES_ENFORCE decides what happens to the rest.

PC_ID, PC_SECRET = "pc-test", "pc-test-secret"
LABEL = "/api/delivery-label/4242"


@pytest.fixture
def print_env(monkeypatch):
    monkeypatch.setattr(main, "PCS", {PC_ID: PC_SECRET})
    monkeypatch.setenv("JWT_SECRET", "unit-test-signing-secret-0123456789")
    # No delivery backend in tests: a label request that clears the gate gets
    # the proxy's own 503 and never leaves the process.
    monkeypatch.setattr(main, "DELVERY_BACKEND_URL", "")
    return monkeypatch


def _enforce(monkeypatch, on: bool):
    monkeypatch.setattr(main, "PRINT_ROUTES_ENFORCE", on)


def _pc():
    return {"params": {"pc_id": PC_ID}, "headers": {"X-PC-Secret": PC_SECRET}}


@pytest.mark.parametrize("enforce", [False, True])
def test_overrides_accepts_user_bearer(client, token, print_env, enforce):
    _enforce(print_env, enforce)
    r = client.get("/api/overrides?orders=1001", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


@pytest.mark.parametrize("enforce", [False, True])
def test_overrides_accepts_pc_credentials(client, print_env, enforce):
    _enforce(print_env, enforce)
    r = client.get("/api/overrides", params={"orders": "1001", "pc_id": PC_ID}, headers={"X-PC-Secret": PC_SECRET})
    assert r.status_code == 200


def test_overrides_anonymous_is_served_and_logged_while_not_enforced(client, print_env, capsys):
    _enforce(print_env, False)
    r = client.get("/api/overrides?orders=77777", headers={"User-Agent": "python-requests/2.31.0"})
    assert r.status_code == 200
    out = capsys.readouterr().out
    line = next(l for l in out.splitlines() if l.startswith("print_route_unauthenticated"))
    assert "route=overrides" in line and "ua=python-requests/2.31.0" in line and "enforce=0" in line
    assert "77777" not in out  # never the order numbers


@pytest.mark.parametrize("secret", [None, "wrong"])
def test_overrides_refused_when_enforced_without_valid_credentials(client, print_env, secret):
    _enforce(print_env, True)
    headers = {"X-PC-Secret": secret} if secret else {}
    r = client.get("/api/overrides", params={"orders": "1001", "pc_id": PC_ID}, headers=headers)
    assert r.status_code == 401


def test_overrides_secret_in_query_is_not_accepted(client, print_env):
    # Only the header counts: secrets in URLs end up in access logs.
    _enforce(print_env, True)
    r = client.get("/api/overrides", params={"orders": "1001", "pc_id": PC_ID, "secret": PC_SECRET})
    assert r.status_code == 401


@pytest.mark.parametrize("enforce", [False, True])
def test_label_accepts_pc_credentials(client, print_env, enforce):
    _enforce(print_env, enforce)
    assert client.get(LABEL, **_pc()).status_code == 503


@pytest.mark.parametrize("enforce", [False, True])
def test_label_accepts_user_bearer(client, token, print_env, enforce):
    _enforce(print_env, enforce)
    assert client.get(LABEL, headers={"Authorization": f"Bearer {token}"}).status_code == 503


def test_label_anonymous_served_while_not_enforced_refused_when_enforced(client, print_env, capsys):
    _enforce(print_env, False)
    assert client.get(LABEL).status_code == 503
    assert "print_route_unauthenticated route=delivery-label" in capsys.readouterr().out
    _enforce(print_env, True)
    assert client.get(LABEL).status_code == 401


def test_signed_label_url_round_trip(client, token, print_env):
    _enforce(print_env, True)
    assert client.get("/api/delivery-label-url/4242?envoy_code=EN-1").status_code == 401
    r = client.get("/api/delivery-label-url/4242?envoy_code=EN-1", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    url = r.json()["url"]
    assert url.startswith("/api/delivery-label/4242?") and "sig=" in url and "EN-1" in url
    # No header at all, as window.open() sends it: passes the gate.
    assert client.get(url).status_code == 503


def test_signed_label_url_rejects_tampering_and_expiry(client, print_env):
    _enforce(print_env, True)
    now = int(main._time_mod.time())
    good = main.sign_delivery_label_url("4242", "EN-1")
    assert client.get(good).status_code == 503
    # Different order, same signature.
    assert client.get(good.replace("/4242?", "/4243?")).status_code == 401
    # Different envoy code, same signature.
    assert client.get(good.replace("EN-1", "EN-2")).status_code == 401
    # Expired.
    old = main.sign_delivery_label_url("4242", "EN-1", now=now - main.LABEL_URL_TTL_SECONDS - 60)
    assert client.get(old).status_code == 401
    # A lifetime longer than the server ever issues.
    key = main._label_signing_key()
    far = now + 3600
    sig = main._label_signature(key, "4242", "EN-1", far)
    assert client.get(f"{LABEL}?envoy_code=EN-1&exp={far}&sig={sig}").status_code == 401


def test_label_signing_refuses_the_default_secret(print_env):
    print_env.setenv("JWT_SECRET", "CHANGE_ME_SECRET")
    assert main.sign_delivery_label_url("4242", None) is None
    assert main._label_signature_valid("4242", None, "9999999999", "00") is False
