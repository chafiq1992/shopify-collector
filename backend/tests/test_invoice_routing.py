import asyncio

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app import main
from backend.app.models import Base
from backend.app.invoice_routing import (
    choose_shopify_candidate,
    merchant_code_prefix,
    resolve_row_store,
    sanitize_rules,
)
from backend.app.settings_store import (
    get_invoice_routing_rules,
    list_registered_shopify_store_labels,
    register_shopify_store_label,
    set_invoice_routing_rules,
)


def test_code_prefix_rule_routes_beitii_and_overrides_invoice_client():
    route = resolve_row_store(
        company="Casa",
        invoice_client="irrakids",
        send_code="31-10042",
        rules=[{"match_type": "code_prefix", "value": "31", "store": "beitii", "carrier": "Casa"}],
        known_stores=["irrakids", "irranova", "beitii", "easygros"],
    )
    assert merchant_code_prefix("31-10042") == "31"
    assert route["store"] == "beitii"
    assert route["source"] == "code_prefix"


def test_invoice_client_alias_can_route_easygros():
    route = resolve_row_store(
        company="YFD",
        invoice_client="Easy Gros SARL - 8821",
        send_code="55-10042",
        rules=[{"match_type": "invoice_client", "value": "Easy Gros SARL - 8821", "store": "easygros"}],
        known_stores=["irrakids", "easygros"],
    )
    assert route["store"] == "easygros"
    assert route["source"] == "invoice_client"


def test_known_store_token_in_invoice_client_routes_implicitly():
    route = resolve_row_store(
        company="Casa",
        invoice_client="5716-irrakids",
        send_code="9-88547",
        rules=[],
        known_stores=["irrakids", "irranova", "beitii", "easygros"],
    )
    assert route == {"store": "irrakids", "source": "invoice_client_store_key", "rule": None}


def test_duplicate_order_number_uses_unique_invoice_amount_match():
    result = choose_shopify_candidate(
        [
            {"store": "irrakids", "total_price": 150, "order_gid": "gid://kids"},
            {"store": "easygros", "total_price": 188, "order_gid": "gid://easy"},
        ],
        invoice_crbt=188,
    )
    assert result["found"] is True
    assert result["store"] == "easygros"
    assert result["routing_source"] == "unique_amount_match"


def test_duplicate_order_number_stays_ambiguous_when_amount_cannot_decide():
    result = choose_shopify_candidate(
        [
            {"store": "irrakids", "total_price": 188, "order_gid": "gid://kids"},
            {"store": "irranova", "total_price": 188, "order_gid": "gid://nova"},
        ],
        invoice_crbt=188,
    )
    assert result["found"] is False
    assert result["ambiguous"] is True
    assert result["candidate_stores"] == ["irrakids", "irranova"]


def test_conflicting_rules_are_not_silently_resolved():
    rules = sanitize_rules(
        [
            {"match_type": "code_prefix", "value": "7", "store": "irrakids"},
            {"match_type": "code_prefix", "value": "7", "store": "irranova"},
        ]
    )
    route = resolve_row_store(
        company="Casa",
        invoice_client="",
        send_code="7-160885",
        rules=rules,
        known_stores=["irrakids", "irranova"],
    )
    assert route["store"] is None
    assert route["source"] == "conflicting_rules"


@pytest.mark.asyncio
async def test_lookup_checks_all_connected_stores_and_uses_amount(monkeypatch):
    async def fake_find(order_number, *, store):
        totals = {"irrakids": 150, "irranova": 170, "beitii": 188, "easygros": 220}
        return {"id": f"gid://{store}/{order_number}", "total_price": totals[store], "financial_status": "PENDING"}

    monkeypatch.setattr(main, "_shopify_find_order_by_number", fake_find)
    result = await main._lookup_invoice_row(
        lookup_key="0:0:10042",
        order_number="10042",
        invoice_crbt=188,
        is_refused=False,
        preferred_store=None,
        routing_source=None,
        route_error=None,
        all_store_keys=["irrakids", "irranova", "beitii", "easygros"],
        store_ready={"irrakids": True, "irranova": True, "beitii": True, "easygros": True},
        sem=asyncio.Semaphore(8),
    )
    assert result["found"] is True
    assert result["store"] == "beitii"
    assert result["routing_source"] == "unique_amount_match"


@pytest.mark.asyncio
async def test_mark_paid_supports_connected_dynamic_stores(monkeypatch):
    async def fake_known_stores():
        return ["irrakids", "irranova", "beitii", "easygros"]

    async def fake_ready(store):
        return store in {"beitii", "easygros"}

    async def fake_graphql(query, variables, *, store):
        return {
            "orderMarkAsPaid": {
                "order": {"id": variables["input"]["id"], "displayFinancialStatus": "PAID"},
                "userErrors": [],
            }
        }

    monkeypatch.setattr(main, "known_store_labels", fake_known_stores)
    monkeypatch.setattr(main, "_invoice_store_ready", fake_ready)
    monkeypatch.setattr(main, "shopify_graphql", fake_graphql)
    body = main.InvoiceMarkPaidRequest(
        orders=[
            main.InvoiceMarkPaidOrder(order_gid="gid://beitii/1", store="beitii"),
            main.InvoiceMarkPaidOrder(order_gid="gid://easygros/2", store="easygros"),
        ]
    )
    result = await main.invoice_mark_paid(body, admin=main.User(id="admin"))
    assert result["updated"] == 2
    assert {item["store"] for item in result["results"]} == {"beitii", "easygros"}


@pytest.mark.asyncio
async def test_shopify_lookup_rejects_partial_name_and_selects_exact_order(monkeypatch):
    async def fake_graphql(query, variables, *, store):
        assert variables["first"] == 5
        return {
            "orders": {
                "edges": [
                    {"node": {"id": "wrong", "name": "#100421", "currentTotalPriceSet": {"shopMoney": {"amount": "999"}}}},
                    {"node": {"id": "exact", "name": "#10042", "currentTotalPriceSet": {"shopMoney": {"amount": "188"}}, "displayFinancialStatus": "PENDING"}},
                ]
            }
        }

    monkeypatch.setattr(main, "shopify_graphql", fake_graphql)
    result = await main._shopify_find_order_by_number("10042", store="beitii")
    assert result["id"] == "exact"
    assert result["total_price"] == 188


@pytest.mark.asyncio
async def test_invoice_settings_persist_dynamic_store_and_merchant_rule():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        await register_shopify_store_label(session, "beitii")
        await set_invoice_routing_rules(
            session,
            [{"match_type": "code_prefix", "value": "31", "store": "beitii", "carrier": "Casa"}],
        )
        assert await list_registered_shopify_store_labels(session) == ["beitii"]
        assert await get_invoice_routing_rules(session) == [
            {"match_type": "code_prefix", "value": "31", "store": "beitii", "carrier": "Casa"}
        ]
    await engine.dispose()
