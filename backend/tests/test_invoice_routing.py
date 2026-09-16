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


@pytest.mark.asyncio
async def test_invoice_only_merchant_does_not_lookup_or_block_connected_rows(monkeypatch):
    async def stores(): return ["irrakids", "irranova"]
    async def rules(): return []
    async def ready(store): return True
    calls = []
    async def find(number, *, store):
        calls.append((number, store))
        return {"id": f"gid://{number}", "total_price": 250}
    monkeypatch.setattr(main, "known_store_labels", stores)
    monkeypatch.setattr(main, "_invoice_prefix_rules", rules)
    monkeypatch.setattr(main, "_invoice_store_ready", ready)
    monkeypatch.setattr(main, "_shopify_find_order_by_number", find)
    result = await main.invoice_lookup_orders(main.InvoiceLookupRequest(items=[
        main.InvoiceLookupItem(order_number="136", send_code="17-136"),
        main.InvoiceLookupItem(order_number="162127", send_code="7-162127"),
        main.InvoiceLookupItem(order_number="91531", send_code="9-91531"),
    ]), admin=main.User(id="test"))
    assert calls == [("162127", "irrakids"), ("91531", "irranova")]
    assert result["rows"][0]["invoice_only"] is True
    assert result["rows"][0]["skipped"] is True
    assert not result["rows"][0].get("ambiguous")
    assert all(row["found"] for row in result["rows"][1:])


@pytest.mark.parametrize("code,store", [("7-123456", "irrakids"), ("9-123456", "irranova")])
def test_default_prefix_identity_cannot_be_overridden(code, store):
    route = resolve_row_store(company="Casa", invoice_client="irrakids", send_code=code,
        rules=[{"match_type": "code_prefix", "value": code.split("-")[0], "store": "wrong", "carrier": "Casa"},
               {"match_type": "invoice_client", "value": "irrakids", "store": "wrong"}],
        known_stores=["irrakids", "irranova"])
    assert route["store"] == store


@pytest.mark.asyncio
async def test_retry_recomputes_prefix_instead_of_trusting_browser_store(monkeypatch):
    async def stores(): return ["irrakids", "irranova"]
    async def rules(): return []
    async def ready(store): return True
    calls = []
    async def find(number, *, store):
        calls.append(store)
        return {"id": "gid://correct", "total_price": 200}
    monkeypatch.setattr(main, "known_store_labels", stores)
    monkeypatch.setattr(main, "_invoice_prefix_rules", rules)
    monkeypatch.setattr(main, "_invoice_store_ready", ready)
    monkeypatch.setattr(main, "_shopify_find_order_by_number", find)
    body = main.InvoiceLookupRequest(items=[main.InvoiceLookupItem(
        order_number="91941", send_code="9-91941", store="irrakids", company="Casa")])
    result = await main.invoice_lookup_orders(body, admin=main.User(id="test"))
    assert calls == ["irranova"]
    assert result["rows"][0]["store"] == "irranova"


@pytest.mark.asyncio
@pytest.mark.parametrize("send_code", ["9-91941", None, "17-125"])
async def test_payment_rejects_wrong_store_or_missing_identity_before_mutation(monkeypatch, send_code):
    async def stores(): return ["irrakids", "irranova"]
    async def rules(): return []
    async def mutate(*args, **kwargs): raise AssertionError("Must not mark paid")
    monkeypatch.setattr(main, "known_store_labels", stores)
    monkeypatch.setattr(main, "_invoice_prefix_rules", rules)
    monkeypatch.setattr(main, "shopify_graphql", mutate)
    body = main.InvoiceMarkPaidRequest(orders=[main.InvoiceMarkPaidOrder(
        order_gid="gid://wrong", store="irrakids", send_code=send_code)])
    with pytest.raises(main.HTTPException) as exc:
        await main.invoice_mark_paid(body, admin=main.User(id="test"))
    assert exc.value.status_code == 400


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


def test_invoice_client_cannot_route_unknown_merchant():
    route = resolve_row_store(
        company="YFD",
        invoice_client="Easy Gros SARL - 8821",
        send_code="55-10042",
        rules=[{"match_type": "invoice_client", "value": "Easy Gros SARL - 8821", "store": "easygros"}],
        known_stores=["irrakids", "easygros"],
    )
    assert route["store"] is None
    assert route["source"] == "unmapped_prefix"


def test_merchant_prefix_overrides_invoice_client():
    route = resolve_row_store(
        company="Casa",
        invoice_client="5716-irrakids",
        send_code="9-88547",
        rules=[],
        known_stores=["irrakids", "irranova", "beitii", "easygros"],
    )
    assert route == {"store": "irranova", "source": "merchant_prefix", "rule": None}


def test_unprefixed_order_requires_review_despite_invoice_account_name():
    route = resolve_row_store(company="12Livery", invoice_client="Irrakids - (IRRAKI-34)",
        send_code="90164", rules=[], known_stores=["irrakids", "irranova"])
    assert route["store"] is None


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
            {"match_type": "code_prefix", "value": "31", "store": "irrakids"},
            {"match_type": "code_prefix", "value": "31", "store": "irranova"},
        ]
    )
    route = resolve_row_store(
        company="Casa",
        invoice_client="",
        send_code="31-160885",
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
async def test_incomplete_store_search_is_not_a_confirmed_match(monkeypatch):
    async def fake_find(order_number, *, store):
        if store == "irranova":
            raise TimeoutError("store unavailable")
        return {"id": "gid://1", "total_price": 188, "financial_status": "PENDING"}

    monkeypatch.setattr(main, "_shopify_find_order_by_number", fake_find)
    result = await main._lookup_invoice_row(
        lookup_key="test", order_number="125", invoice_crbt=188, is_refused=False,
        preferred_store=None, routing_source=None, route_error=None,
        all_store_keys=["irrakids", "irranova"], store_ready={"irrakids": True, "irranova": True},
        sem=asyncio.Semaphore(2),
    )
    assert result["found"] is False
    assert "retry" in result["error"]


@pytest.mark.asyncio
async def test_parse_without_lookup_preserves_validation_and_routing(monkeypatch):
    import io
    from starlette.datastructures import UploadFile

    async def stores():
        return ["irrakids"]

    async def ready(store):
        return True

    async def unexpected_lookup(**kwargs):
        raise AssertionError("parse-only request must not contact Shopify")

    monkeypatch.setattr(main, "known_store_labels", stores)
    monkeypatch.setattr(main, "_invoice_store_ready", ready)
    monkeypatch.setattr(main, "_lookup_invoice_row", unexpected_lookup)
    monkeypatch.setattr(main, "HAVE_AUTH_DB", False)
    monkeypatch.setattr(main, "extract_pages_text", lambda raw: [(1,
        "12Livery Colis: 1 1 7-123456 2026-08-18 Livré Casablanca 200 DH 25 DH 175 DH "
        "Total Brut 200 DH Frais 25 DH Total Net 175 DH")])
    response = await main.invoice_parse_pdf(
        files=[UploadFile(filename="sample.pdf", file=io.BytesIO(b"%PDF-test"))],
        include_lookup=False, admin=main.User(id="test"),
    )
    assert response["lookup"] == {}
    assert response["docs"][0]["validation"]["complete"] is True
    assert response["docs"][0]["rows"][0]["lookupKey"] == "0:0:123456"


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
    async def prefix_rules():
        return [{"match_type": "code_prefix", "value": "31", "store": "beitii"},
                {"match_type": "code_prefix", "value": "55", "store": "easygros"}]
    monkeypatch.setattr(main, "_invoice_prefix_rules", prefix_rules)
    monkeypatch.setattr(main, "shopify_graphql", fake_graphql)
    body = main.InvoiceMarkPaidRequest(
        orders=[
            main.InvoiceMarkPaidOrder(order_gid="gid://beitii/1", store="beitii", send_code="31-10042"),
            main.InvoiceMarkPaidOrder(order_gid="gid://easygros/2", store="easygros", send_code="55-10042"),
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
