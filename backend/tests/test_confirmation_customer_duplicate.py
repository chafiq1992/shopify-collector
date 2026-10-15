"""Existing-customer association and read-only duplicate templates; no live writes."""
import hashlib
import json
import os
import unittest
from copy import deepcopy
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app import confirmation_routes as c
from backend.app.db import Base
from backend.app.models import OrderEvent, User

ORDER = "gid://shopify/Order/111"
CUSTOMER = "gid://shopify/Customer/222"
VARIANT = "gid://shopify/ProductVariant/333"
UPDATED = "2026-10-15T10:00:00Z"


def address(**changes):
    return {"firstName": "Test", "lastName": "Customer", "company": "Company", "phone": "0612345678",
            "address1": "Street", "address2": "Flat 1", "city": "Rabat", "province": "Rabat", "zip": "10000", "country": "Morocco", **changes}


def customer(**changes):
    return {"id": CUSTOMER, "displayName": "Test Customer", "firstName": "Test", "lastName": "Customer",
            "numberOfOrders": "5", "defaultEmailAddress": {"emailAddress": "customer@example.com"},
            "defaultPhoneNumber": {"phoneNumber": "+212612345678"}, "defaultAddress": address(), **changes}


def line(index=1, **changes):
    return {"id": f"gid://shopify/LineItem/{index}", "title": "Original hoodie", "variantTitle": "Original blue",
            "sku": "OLD-SKU", "quantity": 2, "currentQuantity": 2, "customAttributes": [],
            "originalUnitPriceSet": {"shopMoney": {"amount": "40.00", "currencyCode": "MAD"}},
            "image": {"url": "https://example.com/original.jpg"},
            "variant": {"id": VARIANT, "title": "Blue / 4", "sku": "SKU1", "price": "99.50", "inventoryQuantity": 100,
                        "selectedOptions": [{"name": "Color", "value": "Blue"}], "image": {"url": "https://example.com/current.jpg"},
                        "product": {"id": "gid://shopify/Product/444", "title": "Current hoodie", "status": "ACTIVE"}}, **changes}


def source_order(**changes):
    return {"id": ORDER, "name": "#1001", "updatedAt": UPDATED, "email": "order@example.com", "phone": "0612345678",
            "shippingAddress": address(), "customer": customer(),
            "totalShippingPriceSet": {"shopMoney": {"amount": "25.00", "currencyCode": "MAD"}},
            "lineItems": {"nodes": [line()], "pageInfo": {"hasNextPage": False}},
            "note": "Do not copy old note", "tags": ["cod old", "paid", "another-agent"], "displayFinancialStatus": "PAID", **changes}


def create_body(**changes):
    return c.AgentOrderCreateBody(**{"store": "irranova", "client_action_id": "new-customer-order-123",
        "shipping_address": {"first_name": "Test", "last_name": "Customer", "company": "Company", "phone": "0612345678",
                             "address1": "Edited order address", "city": "Rabat", "country": "Morocco"},
        "additions": [{"variant_id": VARIANT, "quantity": 2}], "shipping_price": "25.00", **changes})


def created_order():
    return {"id": "gid://shopify/Order/999", "name": "#1999", "tags": ["agent-1"],
            "displayFinancialStatus": "PENDING", "lineItems": {"edges": []}, "customer": {"id": CUSTOMER}}


class CustomerDuplicateInputTests(unittest.TestCase):
    def test_lookup_and_template_require_authentication(self):
        from backend.app.main import app
        client = TestClient(app)
        for path in ["/api/agent/customers/search?store=irranova&q=0612345678",
                     "/api/agent/orders/duplicate-template?store=irranova&order_id=" + ORDER]:
            with self.subTest(path=path):
                self.assertEqual(client.get(path).status_code, 401)

    def test_customer_selection_requires_customer_gid(self):
        for value in ["123", "gid://shopify/Order/222", "gid://shopify/Customer/not-a-number", ""]:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                create_body(customer_id=value)

    def test_absent_customer_preserves_exact_legacy_fingerprint_input(self):
        expected = {"shippingAddress": {"firstName": "Test", "lastName": "Customer", "company": "Company", "phone": "0612345678",
                      "address1": "Edited order address", "address2": "", "city": "Rabat", "province": "", "zip": "", "country": "Morocco"},
                    "phone": "0612345678", "financialStatus": "PENDING", "lineItems": [{"variantId": VARIANT, "quantity": 2}],
                    "email": None, "note": "", "_shipping_price": "25.00"}
        for body in [create_body(), create_body(customer_id=None)]:
            result = c._new_confirmation_order_input(body)
            self.assertEqual(result, expected)
            self.assertNotIn("customer", result)
            self.assertEqual(json.dumps(result, sort_keys=True, ensure_ascii=False).encode(), json.dumps(expected, sort_keys=True, ensure_ascii=False).encode())

    def test_selected_customer_adds_association_only_not_upsert(self):
        result = c._new_confirmation_order_input(create_body(customer_id=CUSTOMER))
        self.assertEqual(result["customer"], {"toAssociate": {"id": CUSTOMER}})
        self.assertNotIn("toUpsert", result["customer"])

    def test_customer_fallback_chooses_one_address_and_preserves_complete_fields(self):
        fallback = address(firstName="Fallback", address1="Last order street", address2="Last flat", city="Casa", province="Casa", company="Last company")
        result = c._confirmation_customer_details(customer(defaultAddress=None, lastOrder={"email": "latest@example.com", "phone": "0611111111", "shippingAddress": fallback}))
        self.assertEqual(result["address"]["address1"], "Last order street")
        self.assertEqual(result["address"]["company"], "Last company")
        self.assertEqual(result["address"]["province"], "Casa")
        self.assertEqual(result["orders_count"], 5)
        partial = customer(defaultAddress={"city": "Wrong city", "address2": "Wrong flat"}, lastOrder={"shippingAddress": fallback})
        self.assertEqual(c._confirmation_customer_details(partial)["address"]["city"], "Casa")
        self.assertEqual(c._confirmation_customer_details(partial)["address"]["address2"], "Last flat")

    def test_customer_without_defaults_uses_last_order_contact_and_never_guesses_address(self):
        node = customer(firstName=None, lastName=None, displayName=None, defaultAddress=None,
                        defaultEmailAddress=None, defaultPhoneNumber=None,
                        lastOrder={"email": "last@example.com", "phone": "0611111111", "shippingAddress": address(firstName="Last", lastName="Name", phone="")})
        result = c._confirmation_customer_details(node)
        self.assertEqual(result["name"], "Last Name")
        self.assertEqual(result["email"], "last@example.com")
        self.assertEqual(result["address"]["phone"], "0611111111")
        empty = c._confirmation_customer_details({"id": CUSTOMER})
        self.assertEqual(empty["address"]["address1"], "")
        self.assertEqual(empty["address"]["country"], "")


class CustomerLookupTests(unittest.IsolatedAsyncioTestCase):
    async def test_moroccan_phone_formats_use_exact_supported_filters_and_one_store(self):
        for phone in ["0612345678", "+212 612345678", "00212 612345678", "612345678", "06/12/34/56/78"]:
            with self.subTest(phone=phone):
                graphql = AsyncMock(return_value={"customers": {"nodes": [customer()]}})
                with patch("backend.app.main.shopify_graphql", graphql):
                    result = await c.search_confirmation_customers(store="irrakids", q=phone)
                query, variables = graphql.await_args.args
                self.assertEqual(query, c.CONFIRMATION_CUSTOMER_LOOKUP_GQL)
                self.assertEqual(graphql.await_args.kwargs["store"], "irrakids")
                self.assertEqual(graphql.await_args.kwargs["api_version"], "2026-01")
                self.assertIn('phone:"+212612345678"', variables["query"])
                self.assertIn('phone:"0612345678"', variables["query"])
                self.assertNotIn("*", variables["query"])
                self.assertNotIn("lineItems", query)
                self.assertNotIn("orders(", query)
                self.assertEqual(result["customers"][0]["id"], CUSTOMER)

    async def test_empty_partial_or_non_phone_search_does_not_query_shopify(self):
        graphql = AsyncMock()
        with patch("backend.app.main.shopify_graphql", graphql):
            for phone in ["", "061", "name", "phone:0612345678 OR *", "123456789012345678901"]:
                self.assertEqual((await c.search_confirmation_customers(store="irranova", q=phone))["customers"], [])
        graphql.assert_not_awaited()

    async def test_customer_permission_error_is_actionable_and_scoped(self):
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=HTTPException(502, "Access denied for customers field"))):
            with self.assertRaises(HTTPException) as error:
                await c.search_confirmation_customers(store="irranova", q="0612345678")
        self.assertEqual(error.exception.status_code, 403)
        self.assertIn("read_customers", error.exception.detail)


class DuplicateTemplateTests(unittest.IsolatedAsyncioTestCase):
    async def load(self, node=None, *, pages=None, store="irranova"):
        source = node if node is not None else source_order()
        responses = [{"shop": {"currencyCode": "MAD"}, "order": source}, *(pages or [])]
        graphql = AsyncMock(side_effect=responses)
        with patch("backend.app.main.shopify_graphql", graphql):
            result = await c.confirmation_order_duplicate_template(store=store, order_id=ORDER)
        return result, graphql

    async def test_current_catalog_price_and_editable_customer_shipping_without_source_mutation(self):
        node = source_order()
        original = deepcopy(node)
        result, graphql = await self.load(node, store="irrakids")
        template = result["template"]
        self.assertEqual(template["items"][0]["price"], "99.50")
        self.assertEqual(template["items"][0]["source_price"], "40.00")
        self.assertEqual(template["items"][0]["quantity"], 2)
        self.assertEqual(template["items"][0]["row_key"], "gid://shopify/LineItem/1")
        self.assertEqual(template["customer_id"], CUSTOMER)
        self.assertEqual(template["shipping_address"]["company"], "Company")
        self.assertEqual(template["shipping_price"], "25.00")
        self.assertEqual(template["email"], "order@example.com")
        self.assertEqual(node, original)
        self.assertNotIn("note", template)
        self.assertNotIn("tags", template)
        self.assertNotIn("financial_status", template)
        self.assertTrue(template["warnings"])
        self.assertEqual(graphql.await_args.kwargs["store"], "irrakids")
        self.assertTrue(all(call.args[0].lstrip().startswith("query") for call in graphql.await_args_list))

    async def test_pagination_loads_all_35_lines_instead_of_history_first_20(self):
        node = source_order(lineItems={"nodes": [line(i) for i in range(25)], "pageInfo": {"hasNextPage": True, "endCursor": "page2"}})
        page = {"order": {"id": ORDER, "updatedAt": UPDATED, "lineItems": {"nodes": [line(i) for i in range(25, 35)], "pageInfo": {"hasNextPage": False}}}}
        result, graphql = await self.load(node, pages=[page])
        self.assertEqual(len(result["template"]["items"]), 35)
        self.assertEqual(graphql.await_args_list[1].args[0], c.CONFIRMATION_DUPLICATE_LINES_GQL)
        self.assertEqual(graphql.await_args_list[1].args[1], {"id": ORDER, "after": "page2"})
        self.assertEqual(graphql.await_args_list[1].kwargs["store"], "irranova")

    async def test_custom_deleted_archived_personalized_and_refunded_rows_are_retained_blocked(self):
        archived = line(2)
        archived["variant"]["product"]["status"] = "ARCHIVED"
        lines = [line(1, variant=None), archived, line(3, customAttributes=[{"key": "Engraving", "value": "Name"}]),
                 line(4, currentQuantity=0), line(5, currentQuantity=1)]
        result, _ = await self.load(source_order(lineItems={"nodes": lines, "pageInfo": {"hasNextPage": False}}))
        items = result["template"]["items"]
        self.assertEqual(len(items), 5)
        self.assertIsNone(items[0]["id"])
        self.assertIsNone(items[0]["price"])
        self.assertEqual(items[0]["quantity"], 2)
        self.assertTrue(all(row["unavailable"] and row["requires_review"] and row["needs_review"] and row["unavailable_reason"] for row in items))
        self.assertEqual(len({row["row_key"] for row in items}), 5)

    async def test_no_customer_or_shipping_keeps_editable_blank_contact(self):
        result, _ = await self.load(source_order(customer=None, shippingAddress=None, phone=None, email=None))
        template = result["template"]
        self.assertIsNone(template["customer_id"])
        self.assertEqual(template["shipping_address"]["address1"], "")
        self.assertEqual(template["email"], "")

    async def test_quantity_limits_are_explicit_errors_without_clamping_or_truncating(self):
        for lines in [[line(quantity=1000, currentQuantity=1000)], [line(quantity=600, currentQuantity=600), line(2, quantity=600, currentQuantity=600)]]:
            with self.subTest(lines=lines), self.assertRaises(HTTPException) as error:
                await self.load(source_order(lineItems={"nodes": lines, "pageInfo": {"hasNextPage": False}}))
            self.assertEqual(error.exception.status_code, 422)
        node = source_order(lineItems={"nodes": [line(i) for i in range(25)], "pageInfo": {"hasNextPage": True, "endCursor": "page2"}})
        page = {"order": {"id": ORDER, "updatedAt": UPDATED, "lineItems": {"nodes": [line(i) for i in range(25, 51)], "pageInfo": {"hasNextPage": False}}}}
        with self.assertRaises(HTTPException) as error:
            await self.load(node, pages=[page])
        self.assertEqual(error.exception.status_code, 422)
        self.assertIn("50", error.exception.detail)

    async def test_bad_cursor_repeated_lines_or_changed_order_never_returns_partial_template(self):
        for page in [{"order": {"updatedAt": "changed", "lineItems": {"nodes": []}}},
                     {"order": {"updatedAt": UPDATED}},
                     {"order": {"updatedAt": UPDATED, "lineItems": {"nodes": [line()], "pageInfo": {"hasNextPage": False}}}},
                     {"order": {"updatedAt": UPDATED, "lineItems": {"nodes": [line(2)], "pageInfo": {"hasNextPage": True, "endCursor": "page2"}}}}]:
            node = source_order(lineItems={"nodes": [line()], "pageInfo": {"hasNextPage": True, "endCursor": "page2"}})
            with self.subTest(page=page), self.assertRaises(HTTPException):
                await self.load(node, pages=[page])

    async def test_missing_order_selected_store_only_and_invalid_id(self):
        graphql = AsyncMock(return_value={"order": None})
        with patch("backend.app.main.shopify_graphql", graphql):
            with self.assertRaises(HTTPException) as error:
                await c.confirmation_order_duplicate_template(store="irrakids", order_id=ORDER)
            self.assertEqual(error.exception.status_code, 404)
            self.assertEqual(graphql.await_args.kwargs["store"], "irrakids")
            with self.assertRaises(HTTPException):
                await c.confirmation_order_duplicate_template(store="irrakids", order_id=CUSTOMER)
        graphql.assert_awaited_once()


class ExistingCustomerCreateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.user = User(id="customer-agent", email="agent@example.com", password_hash="unused", role="agent", is_active=True, agent_tags=["agent-1"])
        async with self.sessions() as db:
            db.add(self.user)
            await db.commit()
        self.calls = []
        self.graphql = AsyncMock(side_effect=self.respond)
        self.graphql_patch = patch("backend.app.main.shopify_graphql", self.graphql)
        self.graphql_patch.start()
        self.addCleanup(self.graphql_patch.stop)
        self.overlay_patch = patch("backend.app.confirmation_routes._RECENT_TAG_ADDS", {})
        self.overlay_patch.start()
        self.addCleanup(self.overlay_patch.stop)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def respond(self, query, variables, **kwargs):
        self.calls.append((query, variables, kwargs))
        if query == c.CONFIRMATION_CUSTOMER_ASSOCIATION_GQL:
            return {"customer": {"id": CUSTOMER}}
        if query == c.CONFIRMATION_CURRENCY_GQL:
            return {"shop": {"currencyCode": "MAD"}}
        if query == c.ORDER_CREATE_GQL:
            return {"orderCreate": {"order": created_order(), "userErrors": []}}
        if query == c.ORDER_CREATE_LOOKUP_GQL:
            return {"order": created_order()}
        if query == c.SEARCH_ORDERS_GQL:
            return {"orders": {"edges": [{"node": created_order()}]}}
        raise AssertionError("Unexpected GraphQL call")

    async def test_selection_links_same_customer_and_replay_does_not_revalidate_or_mutate_profile(self):
        body = create_body(customer_id=CUSTOMER, email="order-only@example.com")
        async with self.sessions() as db:
            result = await c.create_confirmation_order(body, user=self.user, db=db)
        async with self.sessions() as db:
            replay = await c.create_confirmation_order(body, user=self.user, db=db)
        create_call = next(call for call in self.calls if call[0] == c.ORDER_CREATE_GQL)
        order_input = create_call[1]["order"]
        self.assertEqual(order_input["customer"], {"toAssociate": {"id": CUSTOMER}})
        self.assertEqual(order_input["email"], "order-only@example.com")
        self.assertEqual(order_input["shippingAddress"]["address1"], "Edited order address")
        self.assertEqual(order_input["financialStatus"], "PENDING")
        self.assertEqual(create_call[1]["options"], {"inventoryBehaviour": "DECREMENT_OBEYING_POLICY", "sendReceipt": False, "sendFulfillmentReceipt": False})
        self.assertFalse(create_call[2]["retry_safe"])
        self.assertEqual(sum(call[0] == c.ORDER_CREATE_GQL for call in self.calls), 1)
        self.assertEqual(sum(call[0] == c.CONFIRMATION_CUSTOMER_ASSOCIATION_GQL for call in self.calls), 1)
        self.assertTrue(all(call[2]["store"] == "irranova" for call in self.calls))
        self.assertEqual(result["order"]["customer_id"], CUSTOMER)
        self.assertTrue(replay["deduped"])
        self.assertNotIn("customerUpdate", "".join(call[0] for call in self.calls))
        async with self.sessions() as db:
            event = await db.scalar(select(OrderEvent))
        expected = hashlib.sha256(json.dumps(c._new_confirmation_order_input(body), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(event.event_metadata["fingerprint"], expected)

    async def test_missing_selected_customer_in_store_refuses_before_intent_or_order_write(self):
        self.graphql.side_effect = None
        self.graphql.return_value = {"customer": None}
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await c.create_confirmation_order(create_body(customer_id=CUSTOMER), user=self.user, db=db)
            self.assertEqual(error.exception.status_code, 422)
            self.assertIsNone(await db.scalar(select(OrderEvent)))
        self.assertEqual(self.graphql.await_count, 1)
        self.assertEqual(self.graphql.await_args.args[0], c.CONFIRMATION_CUSTOMER_ASSOCIATION_GQL)

    async def test_changed_customer_cannot_reuse_existing_action(self):
        async with self.sessions() as db:
            await c.create_confirmation_order(create_body(customer_id=CUSTOMER), user=self.user, db=db)
        count = len(self.calls)
        for customer_id in [None, "gid://shopify/Customer/223"]:
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await c.create_confirmation_order(create_body(customer_id=customer_id), user=self.user, db=db)
                self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(len(self.calls), count)

    async def test_lost_response_customer_order_recovers_without_second_mutation_or_profile_read(self):
        original = self.respond
        async def respond(query, variables, **kwargs):
            if query == c.ORDER_CREATE_GQL:
                self.calls.append((query, variables, kwargs))
                raise HTTPException(502, "Response lost")
            return await original(query, variables, **kwargs)
        self.graphql.side_effect = respond
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await c.create_confirmation_order(create_body(customer_id=CUSTOMER), user=self.user, db=db)
            self.assertEqual(error.exception.status_code, 409)
        async with self.sessions() as db:
            result = await c.create_confirmation_order(create_body(customer_id=CUSTOMER), user=self.user, db=db)
        self.assertTrue(result["deduped"])
        self.assertEqual(sum(call[0] == c.ORDER_CREATE_GQL for call in self.calls), 1)
        self.assertEqual(sum(call[0] == c.CONFIRMATION_CUSTOMER_ASSOCIATION_GQL for call in self.calls), 1)


if __name__ == "__main__":
    unittest.main()
