"""/api/overrides must never hand one store's customer to another store's order.

Order numbers repeat across stores: irranova #103794 and irrakids #103794 are
different customers. The overrides cache used to be keyed by number alone, so
the print agent printed irrakids' address on irranova's label.
"""
import asyncio

import pytest
from fastapi.testclient import TestClient

from backend.app import main
from backend.app import models
from backend.app.db import engine


def _ov(store, name, city):
    return {
        "store": store,
        "customer": {"displayName": name, "email": None, "phone": "+212600000000"},
        "shippingAddress": {"name": name, "address1": "street", "city": city, "phone": "+212600000000"},
        "email": None,
        "phone": "+212600000000",
    }


@pytest.fixture(scope="module")
def client():
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(models.Base.metadata.create_all)
        await engine.dispose()

    asyncio.get_event_loop_policy().new_event_loop().run_until_complete(_setup())
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    async def _unconfigured(store=None):
        return (None, None, None)

    async def _stores():
        return ["irrakids", "irranova"]

    monkeypatch.setattr(main, "resolve_store_settings_effective", _unconfigured)
    monkeypatch.setattr(main, "known_store_labels", _stores)
    monkeypatch.setattr(main, "ORDER_OVERRIDES", {})


def _get(client, **params):
    r = client.get("/api/overrides", params=params)
    assert r.status_code == 200
    return r.json()["overrides"]


def test_other_store_override_is_not_used(client):
    main.ORDER_OVERRIDES[main._override_cache_key("irrakids", "103794")] = _ov("irrakids", "Amras Amras", "Casablanca")
    assert _get(client, orders="103794", store="irranova") == {}
    assert _get(client, orders="103794", store="irrakids")["103794"]["shippingAddress"]["name"] == "Amras Amras"


def test_each_store_gets_its_own_customer(client):
    main.ORDER_OVERRIDES[main._override_cache_key("irrakids", "103794")] = _ov("irrakids", "Amras Amras", "Casablanca")
    main.ORDER_OVERRIDES[main._override_cache_key("irranova", "103794")] = _ov("irranova", "mr mr", "AGADIR")
    assert _get(client, orders="#103794", store="IrraNova")["103794"]["shippingAddress"]["city"] == "AGADIR"


def test_no_store_and_number_in_two_stores_is_left_out(client):
    main.ORDER_OVERRIDES[main._override_cache_key("irrakids", "103794")] = _ov("irrakids", "Amras Amras", "Casablanca")
    main.ORDER_OVERRIDES[main._override_cache_key("irranova", "103794")] = _ov("irranova", "mr mr", "AGADIR")
    main.ORDER_OVERRIDES[main._override_cache_key("irranova", "103795")] = _ov("irranova", "Only Nova", "Rabat")
    got = _get(client, orders="103794,103795")
    assert "103794" not in got
    assert got["103795"]["shippingAddress"]["name"] == "Only Nova"
