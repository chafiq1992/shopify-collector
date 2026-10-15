"""Confirmation creation, inventory and global lookup regressions; no live writes."""
import os
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.confirmation_routes import (
    AgentOrderCreateBody, CONFIRMATION_CURRENCY_GQL, INVENTORY_LEVELS_PAGE_GQL,
    ORDER_CREATE_GQL, ORDER_CREATE_LOOKUP_GQL, PRODUCT_VARIANTS_SEARCH_GQL,
    PRODUCT_VARIANT_STOCK_GQL, SEARCH_CUSTOMERS_GQL, SEARCH_ORDERS_GQL,
    _new_confirmation_order_input, agent_search, create_confirmation_order,
    recent_orders_tagged_with, search_product_variants,
)
from backend.app.db import Base
from backend.app.models import OrderEvent, User


def order_body(**changes):
    return AgentOrderCreateBody(**{
        "store": "irranova", "client_action_id": "new-order-action-1234",
        "shipping_address": {"first_name": "Test", "phone": "0612345678",
                             "address1": "10 Test Street", "city": "Rabat", "country": "Morocco"},
        "additions": [{"variant_id": "gid://shopify/ProductVariant/101", "quantity": 2}],
        "shipping_price": "25.00", **changes,
    })


def order_node(**changes):
    return {"id": "gid://shopify/Order/99", "name": "#1099", "tags": [],
            "displayFinancialStatus": "PENDING", "lineItems": {"edges": []}, **changes}


class NewOrderValidationTests(unittest.TestCase):
    def test_creation_route_requires_authentication(self):
        from backend.app.main import app
        client = TestClient(app)
        response = client.post("/api/agent/orders/create", json=order_body().model_dump(mode="json"))
        self.assertEqual(response.status_code, 401)

    def test_rejects_missing_contact_address_and_invalid_amounts(self):
        for changes in [
            {"shipping_address": {"first_name": "Test"}},
            {"shipping_price": "NaN"}, {"shipping_price": "-0.01"},
            {"shipping_price": "1.001"},
            {"additions": [{"variant_id": "gid://shopify/Order/101", "quantity": 1}]},
        ]:
            with self.subTest(changes=changes), self.assertRaises(HTTPException) as error:
                _new_confirmation_order_input(order_body(**changes))
            self.assertEqual(error.exception.status_code, 422)

    def test_rejects_fractional_boolean_zero_and_empty_quantities(self):
        for additions in [[], [{"variant_id": "gid://shopify/ProductVariant/101", "quantity": 0}],
                          [{"variant_id": "gid://shopify/ProductVariant/101", "quantity": 1.5}],
                          [{"variant_id": "gid://shopify/ProductVariant/101", "quantity": True}]]:
            with self.subTest(additions=additions), self.assertRaises(ValidationError):
                order_body(additions=additions)


class ConfirmationCreateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.recent_tags = patch("backend.app.confirmation_routes._RECENT_TAG_ADDS", {})
        self.recent_tags.start()
        self.addCleanup(self.recent_tags.stop)
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.user = User(id="agent-create", email="agent@example.com", password_hash="unused",
                         role="agent", is_active=True, agent_tags=["agent-1"])
        async with self.sessions() as db:
            db.add(self.user)
            await db.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_creates_pending_order_without_notifications_assigns_and_audits_once(self):
        body = order_body()
        async def respond(query, variables, **kwargs):
            if query == CONFIRMATION_CURRENCY_GQL:
                return {"shop": {"currencyCode": "MAD"}}
            if query == ORDER_CREATE_LOOKUP_GQL:
                return {"order": order_node()}
            self.assertEqual(query, ORDER_CREATE_GQL)
            self.assertFalse(kwargs["retry_safe"])
            self.assertEqual(kwargs["api_version"], "2026-01")
            self.assertEqual(variables["order"]["financialStatus"], "PENDING")
            self.assertNotIn("transactions", variables["order"])
            self.assertIn("agent-1", variables["order"]["tags"])
            self.assertTrue(any(t.startswith("confirmation-create-") for t in variables["order"]["tags"]))
            self.assertEqual(variables["order"]["shippingLines"][0]["priceSet"]["shopMoney"], {"amount": "25.00", "currencyCode": "MAD"})
            self.assertEqual(variables["options"], {"inventoryBehaviour": "DECREMENT_OBEYING_POLICY", "sendReceipt": False, "sendFulfillmentReceipt": False})
            return {"orderCreate": {"order": order_node(), "userErrors": []}}
        graphql = AsyncMock(side_effect=respond)
        with patch("backend.app.main.shopify_graphql", graphql):
            async with self.sessions() as db:
                first = await create_confirmation_order(body, user=self.user, db=db)
            async with self.sessions() as db:
                replay = await create_confirmation_order(body, user=self.user, db=db)
        self.assertFalse(first["deduped"])
        self.assertTrue(replay["deduped"])
        self.assertEqual(first["order"]["financial_status"], "PENDING")
        self.assertIn("gid://shopify/Order/99", recent_orders_tagged_with("irranova", ["agent-1"]))
        self.assertEqual(sum(c.args[0] == ORDER_CREATE_GQL for c in graphql.await_args_list), 1)
        async with self.sessions() as db:
            events = (await db.scalars(select(OrderEvent))).all()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].action, "order_create")
        self.assertEqual(events[0].event_metadata["state"], "complete")

    async def test_lost_response_recovers_by_unique_tag_without_another_create(self):
        async def respond(query, variables, **kwargs):
            if query == CONFIRMATION_CURRENCY_GQL:
                return {"shop": {"currencyCode": "MAD"}}
            if query == ORDER_CREATE_GQL:
                raise HTTPException(502, "connection lost")
            self.assertEqual(query, SEARCH_ORDERS_GQL)
            self.assertIn("tag:", variables["query"])
            return {"orders": {"edges": [{"node": order_node()}]}}
        graphql = AsyncMock(side_effect=respond)
        with patch("backend.app.main.shopify_graphql", graphql):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await create_confirmation_order(order_body(), user=self.user, db=db)
                self.assertEqual(error.exception.status_code, 409)
            async with self.sessions() as db:
                result = await create_confirmation_order(order_body(), user=self.user, db=db)
        self.assertTrue(result["deduped"])
        self.assertIn("gid://shopify/Order/99", recent_orders_tagged_with("irranova", ["agent-1"]))
        self.assertEqual(sum(c.args[0] == ORDER_CREATE_GQL for c in graphql.await_args_list), 1)

    async def test_uncertain_missing_order_stays_blocked_and_changed_payload_conflicts(self):
        graphql = AsyncMock(side_effect=[{"shop": {"currencyCode": "MAD"}}, HTTPException(502, "lost"), {"orders": {"edges": []}}])
        with patch("backend.app.main.shopify_graphql", graphql):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException):
                    await create_confirmation_order(order_body(), user=self.user, db=db)
            for body in [order_body(), order_body(note="different")]:
                async with self.sessions() as db:
                    with self.assertRaises(HTTPException) as error:
                        await create_confirmation_order(body, user=self.user, db=db)
                    self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(graphql.await_count, 3)

    async def test_shopify_validation_error_clears_intent_and_allows_corrected_submission(self):
        graphql = AsyncMock(side_effect=[{"shop": {"currencyCode": "MAD"}}, {"orderCreate": {"userErrors": [{"field": ["order", "lineItems"], "message": "Not enough stock"}]}}])
        with patch("backend.app.main.shopify_graphql", graphql):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await create_confirmation_order(order_body(), user=self.user, db=db)
                self.assertEqual(error.exception.status_code, 422)
            async with self.sessions() as db:
                self.assertIsNone(await db.scalar(select(OrderEvent)))

    async def test_other_agent_cannot_replay_existing_submission(self):
        graphql = AsyncMock(side_effect=[{"shop": {"currencyCode": "MAD"}}, {"orderCreate": {"order": order_node(), "userErrors": []}}])
        with patch("backend.app.main.shopify_graphql", graphql):
            async with self.sessions() as db:
                await create_confirmation_order(order_body(), user=self.user, db=db)
            other = User(id="other-agent", email="other@example.com", role="agent")
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await create_confirmation_order(order_body(), user=other, db=db)
                self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(graphql.await_count, 2)

    async def test_missing_creation_scope_clears_intent_and_returns_actionable_error(self):
        graphql = AsyncMock(side_effect=[{"shop": {"currencyCode": "MAD"}}, HTTPException(502, "Access denied for orderCreate field. Required access: write_orders")])
        with patch("backend.app.main.shopify_graphql", graphql):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await create_confirmation_order(order_body(), user=self.user, db=db)
                self.assertEqual(error.exception.status_code, 403)
            async with self.sessions() as db:
                self.assertIsNone(await db.scalar(select(OrderEvent)))

    async def test_nested_response_access_denial_retains_uncertain_intent(self):
        graphql = AsyncMock(side_effect=[{"shop": {"currencyCode": "MAD"}}, HTTPException(502, "ACCESS_DENIED Access denied for customer field. read_customers")])
        with patch("backend.app.main.shopify_graphql", graphql):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await create_confirmation_order(order_body(), user=self.user, db=db)
                self.assertEqual(error.exception.status_code, 409)
            async with self.sessions() as db:
                self.assertIsNotNone(await db.scalar(select(OrderEvent)))

    async def test_definite_throttle_allows_safe_resubmission(self):
        graphql = AsyncMock(side_effect=[
            {"shop": {"currencyCode": "MAD"}}, HTTPException(429, "Shopify is busy"),
            {"shop": {"currencyCode": "MAD"}}, {"orderCreate": {"order": order_node(), "userErrors": []}},
        ])
        with patch("backend.app.main.shopify_graphql", graphql):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await create_confirmation_order(order_body(), user=self.user, db=db)
                self.assertEqual(error.exception.status_code, 429)
            async with self.sessions() as db:
                self.assertIsNone(await db.scalar(select(OrderEvent)))
                result = await create_confirmation_order(order_body(), user=self.user, db=db)
        self.assertTrue(result["ok"])
        self.assertFalse(result["deduped"])


class ConfirmationCatalogSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_location_pages_sum_available_and_on_hand_separately(self):
        catalog = {"shop": {"currencyCode": "MAD"}, "productVariants": {"nodes": [{"id": "variant-1", "inventoryQuantity": 100}]}}
        initial = {"nodes": [{"id": "variant-1", "inventoryItem": {"id": "inventory-1", "tracked": True,
                   "inventoryLevels": {"nodes": [{"quantities": [{"name": "on_hand", "quantity": 7}, {"name": "available", "quantity": 4}]}], "pageInfo": {"hasNextPage": True, "endCursor": "page2"}}}}]}
        page = {"inventoryItem": {"inventoryLevels": {"nodes": [{"quantities": [{"name": "on_hand", "quantity": 3}, {"name": "available", "quantity": -1}]}], "pageInfo": {"hasNextPage": False}}}}
        graphql = AsyncMock(side_effect=[catalog, initial, page])
        with patch("backend.app.main.shopify_graphql", graphql):
            result = await search_product_variants(store="irranova", q="shirt", first=20)
        variant = result["variants"][0]
        self.assertEqual(variant["on_hand_quantity"], 10)
        self.assertEqual(variant["available_quantity"], 3)
        self.assertEqual(result["currency"], "MAD")
        self.assertEqual(graphql.await_args_list[2].args[0], INVENTORY_LEVELS_PAGE_GQL)

    async def test_inventory_permission_denial_keeps_products_with_unknown_counts(self):
        graphql = AsyncMock(side_effect=[{"productVariants": {"nodes": [{"id": "variant-1", "inventoryQuantity": 100}]}}, HTTPException(502, "ACCESS_DENIED read_inventory")])
        with patch("backend.app.main.shopify_graphql", graphql):
            result = await search_product_variants(store="irranova", q="shirt", first=20)
        self.assertEqual(len(result["variants"]), 1)
        for field in ["inventory_tracked", "on_hand_quantity", "available_quantity"]:
            self.assertIsNone(result["variants"][0][field])

    async def test_phone_finds_order_without_customer_record_or_queue_restrictions(self):
        async def respond(query, variables, **kwargs):
            if query == SEARCH_CUSTOMERS_GQL:
                return {"customers": {"edges": []}}
            self.assertEqual(query, SEARCH_ORDERS_GQL)
            self.assertNotIn("status:open", variables["query"])
            self.assertNotIn("phone:", variables["query"])
            self.assertIn("0612345678", variables["query"])
            return {"orders": {"edges": [{"node": order_node(cancelledAt="2026-01-01")} ]}}
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)), patch("backend.app.main.resolve_store_settings_effective", AsyncMock(return_value=("test.myshopify.com", "unused", "unused"))):
            result = await agent_search(store="irranova", q="0612345678", user=User())
        self.assertEqual(result["orders"][0]["id"], "gid://shopify/Order/99")


class NonIdempotentShopifyTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_unsafe_mutation_never_retries_timeout_http_throttle_or_graphql_throttle(self):
        from backend.app.main import shopify_graphql
        for failure in [
            TimeoutError("response lost"),
            SimpleNamespace(status_code=429, headers={}),
            SimpleNamespace(status_code=503, headers={}),
            SimpleNamespace(status_code=401, headers={}),
            SimpleNamespace(status_code=403, headers={}),
            SimpleNamespace(status_code=200, headers={}, raise_for_status=lambda: None,
                            json=lambda: {"errors": [{"extensions": {"code": "THROTTLED"}}]}),
        ]:
            with self.subTest(failure=failure):
                client = SimpleNamespace(post=AsyncMock(side_effect=failure) if isinstance(failure, Exception)
                                         else AsyncMock(return_value=failure))
                @asynccontextmanager
                async def fake_client():
                    yield client
                with patch("backend.app.main.resolve_store_settings_effective", AsyncMock(return_value=("test.myshopify.com", "unused-token", "unused-key"))), patch("backend.app.main._shared_shopify_http_client", fake_client), patch("backend.app.main.asyncio.sleep", AsyncMock()) as sleep:
                    with self.assertRaises(HTTPException):
                        await shopify_graphql(ORDER_CREATE_GQL, {}, store="irranova", retry_safe=False)
                    client.post.assert_awaited_once()
                    sleep.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
