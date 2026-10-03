import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app import main
from backend.app.chat_order_routes import (
    ChatCreateOrderBody,
    _customer_payload,
    _customer_query,
    _product_payload,
    chat_create_order,
    chat_product_options,
    clean_tags,
    handle_from_url,
    match_variant,
)
from backend.app.db import Base
from backend.app.models import ChatRequest, ChatRequestEvent, User

V1 = "gid://shopify/ProductVariant/111"
V2 = "gid://shopify/ProductVariant/222"


class FakeShopify:
    """Stands in for main.shopify_graphql and records every call."""

    def __init__(self, create_result=None, create_error=None, variant_ids=(V1, V2)):
        self.calls = []
        self.create_result = create_result or {
            "orderCreate": {"order": {"id": "gid://shopify/Order/9", "name": "#1001", "legacyResourceId": "9"}, "userErrors": []}
        }
        self.create_error = create_error
        self.variant_ids = variant_ids

    async def __call__(self, query, variables, *, store, api_version=None, retry_transient=True):
        self.calls.append({"query": query, "variables": variables, "store": store, "retry_transient": retry_transient})
        if "ChatOrderVariants" in query:
            prices = {V1: "299.99", V2: "150.00"}
            return {
                "shop": {"currencyCode": "MAD"},
                "nodes": [
                    {"id": vid, "title": "Brown / 12-18 months", "price": prices[vid], "product": {"title": "Puffer"}}
                    if vid in self.variant_ids else None
                    for vid in variables["ids"]
                ],
            }
        if "ChatOrderCreate" in query:
            if self.create_error:
                raise self.create_error
            return self.create_result
        raise AssertionError(f"unexpected query {query[:40]}")

    @property
    def creates(self):
        return [c for c in self.calls if "ChatOrderCreate" in c["query"]]


async def _no_domain(store):
    return ""


class ChatOrderCreateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            self.agent = User(id="agent-1", email="a1@example.com", name="Agent One",
                              password_hash="x", role="agent", is_active=True, agent_tags=[])
            session.add(self.agent)
            req = ChatRequest(store_key="irrakids", phone="+212648831323", status="calling",
                              attempts=1, enatt=0, request_count=1)
            session.add(req)
            await session.commit()
            self.rid = req.id
        self._domain = patch("backend.app.chat_order_routes._shop_domain", _no_domain)
        self._domain.start()

    async def asyncTearDown(self):
        self._domain.stop()
        await self.engine.dispose()

    def body(self, **kw):
        base = dict(
            first_name="Rabi3a", last_name="Ben Ali", phone="0648831323",
            address1="Hay Mohammadi, rue 12", city="Casablanca",
            lines=[{"variant_id": V1, "quantity": 1}], tags=["cod 03/10/26", "chat"],
            note="Call before delivery", client_action_id="click-1",
        )
        base.update(kw)
        return ChatCreateOrderBody(**base)

    async def create(self, fake, **kw):
        with patch.object(main, "shopify_graphql", fake):
            async with self.sessions() as session:
                return await chat_create_order(request_id=self.rid, body=self.body(**kw), db=session, user=self.agent)

    async def request_row(self):
        async with self.sessions() as session:
            return await session.get(ChatRequest, self.rid)

    async def events(self):
        async with self.sessions() as session:
            rows = await session.execute(
                select(ChatRequestEvent).where(ChatRequestEvent.request_id == self.rid).order_by(ChatRequestEvent.id)
            )
            return rows.scalars().all()

    async def test_creates_a_cash_on_delivery_order_and_closes_the_request(self):
        fake = FakeShopify()
        res = await self.create(
            fake,
            lines=[{"variant_id": V1, "quantity": 1}, {"variant_id": V2, "quantity": 2}, {"variant_id": V1, "quantity": 1}],
            shipping_price="30", tags=["cod 03/10/26", "COD 03/10/26", "vip, gold"],
        )
        self.assertEqual(res["order"]["name"], "#1001")
        self.assertEqual(res["request"]["status"], "ordered")
        self.assertEqual(res["request"]["order_ref"], "#1001")

        (call,) = fake.creates
        self.assertFalse(call["retry_transient"], "orderCreate must never be retried automatically")
        order = call["variables"]["order"]
        self.assertEqual(order["financialStatus"], "PENDING")
        self.assertEqual(order["currency"], "MAD")
        self.assertEqual(order["phone"], "+212648831323")
        # The same variant twice becomes one line with the quantities added up.
        self.assertEqual(
            [(li["variantId"], li["quantity"], li["priceSet"]["shopMoney"]["amount"]) for li in order["lineItems"]],
            [(V1, 2, "299.99"), (V2, 2, "150.00")],
        )
        self.assertEqual(order["shippingAddress"]["city"], "Casablanca")
        self.assertEqual(order["shippingAddress"]["countryCode"], "MA")
        self.assertEqual(order["tags"], ["cod 03/10/26", "vip gold"])
        self.assertEqual(order["note"], "Call before delivery")
        self.assertEqual(order["shippingLines"][0]["priceSet"]["shopMoney"]["amount"], "30.00")
        self.assertEqual(order["customer"], {"toUpsert": {"firstName": "Rabi3a", "lastName": "Ben Ali", "phone": "+212648831323"}})
        self.assertEqual(call["variables"]["options"]["inventoryBehaviour"], "DECREMENT_OBEYING_POLICY")

        ordered = [e for e in await self.events() if e.action == "ordered"]
        self.assertEqual(len(ordered), 1)
        self.assertTrue(ordered[0].detail["created"])
        self.assertEqual(ordered[0].detail["total"], "929.98")

    async def test_existing_customer_is_associated_and_free_shipping_has_no_line(self):
        fake = FakeShopify()
        await self.create(fake, customer_id="gid://shopify/Customer/77")
        order = fake.creates[0]["variables"]["order"]
        self.assertEqual(order["customer"], {"toAssociate": {"id": "gid://shopify/Customer/77"}})
        self.assertNotIn("shippingLines", order)

    async def test_a_second_create_is_refused_once_ordered(self):
        await self.create(FakeShopify())
        with self.assertRaises(HTTPException) as ctx:
            await self.create(FakeShopify())
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("#1001", ctx.exception.detail)

    async def test_closed_request_must_be_reopened(self):
        async with self.sessions() as session:
            r = await session.get(ChatRequest, self.rid)
            r.status = "not_interested"
            await session.commit()
        with self.assertRaises(HTTPException) as ctx:
            await self.create(FakeShopify())
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_required_fields_and_products_are_checked_before_shopify(self):
        fake = FakeShopify()
        cases = [
            dict(city=" "),
            dict(address1=""),
            dict(phone="12"),
            dict(lines=[]),
            dict(lines=[{"variant_id": "", "quantity": 1}]),
            dict(lines=[{"variant_id": V1, "quantity": 0}]),
            dict(shipping_price="abc"),
            dict(email="not-an-email"),
        ]
        for kw in cases:
            with self.subTest(kw=kw):
                with self.assertRaises(HTTPException) as ctx:
                    await self.create(fake, **kw)
                self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(fake.calls, [])

    async def test_deleted_variant_is_reported(self):
        with self.assertRaises(HTTPException) as ctx:
            await self.create(FakeShopify(variant_ids=(V2,)))
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual((await self.request_row()).status, "calling")

    async def test_shopify_refusal_keeps_the_request_open(self):
        fake = FakeShopify(create_result={"orderCreate": {"order": None, "userErrors": [
            {"field": ["lineItems"], "message": "Not enough stock for Brown / 12-18 months"},
        ]}})
        with self.assertRaises(HTTPException) as ctx:
            await self.create(fake)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("Not enough stock", ctx.exception.detail)
        self.assertEqual((await self.request_row()).status, "calling")
        # A clear refusal does not block the next attempt.
        await self.create(FakeShopify())
        self.assertEqual((await self.request_row()).status, "ordered")

    async def test_unclear_outcome_asks_before_creating_again(self):
        timeout = FakeShopify(create_error=HTTPException(status_code=502, detail="Shopify request failed: ReadTimeout"))
        with self.assertRaises(HTTPException) as ctx:
            await self.create(timeout)
        # Never a 502: Cloudflare would replace the message with its own error page.
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail["code"], "maybe_created")
        self.assertIn("may still have been created", ctx.exception.detail["message"])
        self.assertEqual((await self.request_row()).status, "calling")

        retry = FakeShopify()
        with self.assertRaises(HTTPException) as ctx:
            await self.create(retry)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail["code"], "maybe_created")
        self.assertEqual(retry.creates, [])

        await self.create(retry, confirm_possible_duplicate=True)
        self.assertEqual(len(retry.creates), 1)
        self.assertEqual((await self.request_row()).status, "ordered")

    async def test_graphql_validation_error_is_not_treated_as_unclear(self):
        bad = FakeShopify(create_error=HTTPException(status_code=502, detail="Shopify GraphQL errors: [{'message': 'bad field'}]"))
        with self.assertRaises(HTTPException) as ctx:
            await self.create(bad)
        # Shopify's own words reach the agent, with a status Cloudflare passes through.
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("bad field", ctx.exception.detail)
        failed = [e for e in await self.events() if e.action == "order_create_failed"]
        self.assertIn("bad field", failed[0].detail["error"])
        await self.create(FakeShopify())
        self.assertEqual((await self.request_row()).status, "ordered")

    async def test_shopify_4xx_is_a_clear_refusal(self):
        denied = FakeShopify(create_error=HTTPException(
            status_code=502, detail="Shopify request failed: Client error '403 Forbidden' for url 'https://x'"))
        with self.assertRaises(HTTPException) as ctx:
            await self.create(denied)
        self.assertEqual(ctx.exception.status_code, 422)
        await self.create(FakeShopify())
        self.assertEqual((await self.request_row()).status, "ordered")

    async def test_failing_variant_lookup_is_readable(self):
        class Broken(FakeShopify):
            async def __call__(self, query, variables, **kw):
                if "ChatOrderVariants" in query:
                    raise HTTPException(status_code=502, detail="Shopify GraphQL errors: [{'message': 'Throttled?'}]")
                return await super().__call__(query, variables, **kw)

        with self.assertRaises(HTTPException) as ctx:
            await self.create(Broken())
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("Throttled?", ctx.exception.detail)

    async def test_customer_refusal_retries_once_without_the_customer(self):
        class NoCustomers(FakeShopify):
            async def __call__(self, query, variables, **kw):
                if "ChatOrderCreate" in query and "customer" in variables["order"]:
                    self.calls.append({"query": query, "variables": variables, "retry_transient": kw.get("retry_transient")})
                    raise HTTPException(status_code=502, detail="Shopify GraphQL errors: [{'message': 'Access denied for customer field. Required access: write_customers'}]")
                return await super().__call__(query, variables, **kw)

        fake = NoCustomers()
        res = await self.create(fake)
        self.assertEqual(res["order"]["name"], "#1001")
        self.assertEqual(len(fake.creates), 2)
        self.assertIn("customer", fake.creates[0]["variables"]["order"])
        self.assertNotIn("customer", fake.creates[1]["variables"]["order"])
        self.assertTrue(all(c["retry_transient"] is False for c in fake.creates))

    async def test_linked_customer_refusal_is_not_retried(self):
        refused = FakeShopify(create_result={"orderCreate": {"order": None, "userErrors": [{"message": "Customer is blocked"}]}})
        with self.assertRaises(HTTPException):
            await self.create(refused, customer_id="gid://shopify/Customer/77")
        self.assertEqual(len(refused.creates), 1)

    async def test_percentage_and_amount_discounts(self):
        fake = FakeShopify()
        await self.create(fake, discount_type="percentage", discount_value="10", discount_code="")
        order = fake.creates[0]["variables"]["order"]
        self.assertEqual(order["discountCode"], {"itemPercentageDiscountCode": {"code": "REMISE", "percentage": 10.0}})
        ordered = [e for e in await self.events() if e.action == "ordered"][0]
        self.assertEqual((ordered.detail["discount"], ordered.detail["total"]), ("30.00", "269.99"))

        async with self.sessions() as session:
            r = await session.get(ChatRequest, self.rid)
            r.status, r.order_ref = "calling", None
            await session.commit()
        fake = FakeShopify()
        await self.create(fake, discount_type="amount", discount_value="50", discount_code="FIDELITE")
        self.assertEqual(
            fake.creates[0]["variables"]["order"]["discountCode"],
            {"itemFixedDiscountCode": {"code": "FIDELITE", "amountSet": {"shopMoney": {"amount": "50.00", "currencyCode": "MAD"}}}},
        )

    async def test_discount_limits(self):
        fake = FakeShopify()
        for kw in (dict(discount_type="percentage", discount_value="150"),
                   dict(discount_type="amount", discount_value="500"),
                   dict(discount_type="coupon", discount_value="5")):
            with self.subTest(kw=kw):
                with self.assertRaises(HTTPException) as ctx:
                    await self.create(fake, **kw)
                self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(fake.creates, [])
        # A zero discount is simply no discount.
        await self.create(fake, discount_type="amount", discount_value="0")
        self.assertNotIn("discountCode", fake.creates[0]["variables"]["order"])


class ChatOrderHelperTests(unittest.IsolatedAsyncioTestCase):
    def test_customer_query(self):
        self.assertIn("(phone:+212648831323)", _customer_query("06 48 83 13 23"))
        self.assertEqual(_customer_query('Rabi3a "B"'), '"Rabi3a \\"B\\""')
        self.assertIsNone(_customer_query("a"))

    def test_customer_address_falls_back_to_the_latest_order(self):
        node = {
            "id": "gid://shopify/Customer/1", "displayName": "Rabi3a", "firstName": "Rabi3a", "lastName": "",
            "phone": "+212648831323", "numberOfOrders": "2", "defaultAddress": None,
            "orders": {"edges": [{"node": {
                "id": "gid://shopify/Order/5", "name": "#1000", "tags": [],
                "shippingAddress": {"firstName": "Rabi3a", "lastName": "B", "address1": "Rue 1", "city": "Rabat"},
                "lineItems": {"edges": []},
            }}]},
        }
        out = _customer_payload(node)
        self.assertEqual(out["address"]["city"], "Rabat")
        self.assertEqual(out["address"]["address1"], "Rue 1")
        self.assertEqual(out["orders_count"], 2)
        self.assertEqual(out["orders"][0]["name"], "#1000")

    def test_clean_tags(self):
        self.assertEqual(clean_tags(["a", " A ", "", "x,y", "b" * 60]), ["a", "x y", "b" * 40])

    def test_handle_from_url(self):
        self.assertEqual(handle_from_url("https://ar.irrakids.com/products/puffer-set?fbclid=x"), "puffer-set")
        self.assertEqual(handle_from_url("https://x.com/collections/k/products/%D8%A8%D9%86%D8%AA"), "بنت")
        self.assertIsNone(handle_from_url("https://x.com/pages/contact"))

    def test_variant_matching_by_title_or_options(self):
        product = _product_payload({"id": "p", "title": "Puffer", "variants": {"nodes": [
            {"id": V1, "title": "Brown / 12-18 months", "selectedOptions": [{"name": "Color", "value": "Brown"}, {"name": "Size", "value": "12-18 months"}]},
            {"id": V2, "title": "Black / 2 years", "selectedOptions": [{"name": "Color", "value": "Black"}, {"name": "Size", "value": "2 years"}]},
        ]}})
        self.assertEqual(product["option_names"], ["Color", "Size"])
        self.assertEqual(match_variant(product, "brown / 12-18 Months"), V1)
        self.assertEqual(match_variant(product, "2 years / Black"), V2)
        self.assertIsNone(match_variant(product, "Red / 3 years"))
        self.assertIsNone(match_variant(product, None))

    def test_default_title_product_has_no_options(self):
        product = _product_payload({"id": "p", "title": "Bag", "variants": {"nodes": [
            {"id": V1, "title": "Default Title", "selectedOptions": [{"name": "Title", "value": "Default Title"}]},
        ]}})
        self.assertEqual(product["option_names"], [])

    async def test_product_options_falls_back_from_handle_to_title(self):
        queries = []

        async def fake(query, variables, *, store, **_):
            queries.append(variables["query"])
            if variables["query"].startswith("handle:"):
                return {"products": {"nodes": []}}
            return {"products": {"nodes": [{"id": "p1", "title": "Puffer Jacket", "handle": "puffer", "variants": {"nodes": [
                {"id": V1, "title": "Brown / 1", "selectedOptions": [{"name": "Color", "value": "Brown"}, {"name": "Size", "value": "1"}]},
            ]}}]}}

        with patch.object(main, "shopify_graphql", fake):
            res = await chat_product_options(
                store="irrakids", product_id=None, product_url="https://x.com/products/ph?fbclid=1",
                title="Puffer Jacket", variant_title="Brown / 1", _=None,
            )
        self.assertEqual(queries, ["handle:'ph'", 'title:"Puffer Jacket"'])
        self.assertEqual(res["product"]["id"], "p1")
        self.assertEqual(res["matched_variant_id"], V1)


class ShopifyGraphqlRetryTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, retry_transient):
        calls = {"n": 0}

        class FakeClient:
            async def post(self, *a, **kw):
                calls["n"] += 1
                raise httpx.ReadTimeout("slow")

        @asynccontextmanager
        async def fake_client():
            yield FakeClient()

        async def creds(store):
            return ("shop.myshopify.com", "token", "")

        async def no_sleep(_):
            return None

        with patch.object(main, "_shared_shopify_http_client", fake_client), \
                patch.object(main, "resolve_store_settings_effective", creds), \
                patch.object(main.asyncio, "sleep", no_sleep):
            with self.assertRaises(HTTPException):
                await main.shopify_graphql("mutation{x}", {}, store="irrakids", retry_transient=retry_transient)
        return calls["n"]

    async def test_one_shot_mutations_are_sent_once(self):
        self.assertEqual(await self._run(False), 1)

    async def test_reads_still_retry_network_errors(self):
        self.assertGreater(await self._run(True), 1)


if __name__ == "__main__":
    unittest.main()
