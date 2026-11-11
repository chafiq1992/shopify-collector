"""Confirmation editor detail updates and delivery fee regression tests; no live calls."""
import copy
import os
import unittest
from contextlib import ExitStack
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
from backend.app import confirmation_routes as c
from backend.app.models import User

OID = "gid://shopify/Order/1"
CID = "gid://shopify/Customer/2"


def money(value):
    return {"shopMoney": {"amount": value, "currencyCode": "MAD"}}


def order():
    return {"id": OID, "email": "old@example.com", "note": "Existing note", "tags": ["agent", "old", "concurrent"],
            "customer": {"id": CID}, "lineItems": {"edges": []}}


def shipping_line(value="25.00"):
    return {"id": "gid://shopify/ShippingLine/1", "title": "Express delivery", "isRemoved": False,
            "originalPriceSet": money(value), "discountedPriceSet": money(value)}


def pricing():
    return {"id": OID, "currentShippingPriceSet": money("25.00"), "currentTotalPriceSet": money("125.00"),
            "discountApplications": {"nodes": []}, "shippingLines": {"nodes": [shipping_line()], "pageInfo": {"hasNextPage": False}}}


class DetailsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.node = order()
        self.calls = []
        self.user = User(id="qa", email="qa@example.com")
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(c, "_attach_line_item_stock", AsyncMock()))
        self.stack.enter_context(patch.object(c, "_audit_confirmation_order_change", AsyncMock()))
        self.stack.enter_context(patch.object(c, "invalidate_all_breakdown_caches"))
        self.read = self.stack.enter_context(patch.object(c, "_confirmation_read_graphql", AsyncMock(side_effect=self.read_response)))
        self.graphql = self.stack.enter_context(patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=self.response)))

    async def read_response(self, query, variables, **kwargs):
        self.assertEqual(kwargs["store"], "irranova")
        if query == c.CONFIRMATION_CUSTOMER_ASSOCIATION_GQL:
            return {"customer": {"id": variables["id"]}}
        return {"order": copy.deepcopy(self.node)}

    async def response(self, query, variables, **kwargs):
        self.calls.append((query, variables, kwargs))
        self.assertEqual(kwargs["store"], "irranova")
        self.assertEqual(kwargs["api_version"], "2026-01")
        if query == c.ORDER_SHIPPING_UPDATE_GQL:
            self.node.update({k: v for k, v in variables["input"].items() if k != "shippingAddress"})
            return {"orderUpdate": {"order": copy.deepcopy(self.node), "userErrors": []}}
        if query == c.ORDER_DETAILS_TAG_REMOVE_GQL:
            removed = {t.lower() for t in variables["tags"]}
            self.node["tags"] = [t for t in self.node["tags"] if t.lower() not in removed]
            return {"tagsRemove": {"node": {"id": OID}, "userErrors": []}}
        if query == c.ORDER_DETAILS_TAG_ADD_GQL:
            self.node["tags"] = c._normalize_tags(self.node["tags"] + variables["tags"])
            return {"tagsAdd": {"node": {"id": OID}, "userErrors": []}}
        if query == c.ORDER_CUSTOMER_SET_GQL:
            self.node["customer"] = {"id": variables["customerId"]}
            return {"orderCustomerSet": {"order": {"id": OID}, "userErrors": []}}
        raise AssertionError(query)

    async def update(self, **fields):
        return await c.update_order_details(c.OrderDetailsEditBody(store="irranova", order_id=OID, **fields), user=self.user, db=MagicMock())

    async def test_get_details_uses_order_email_and_store(self):
        self.node["customer"]["email"] = "profile@example.com"
        result = await c.order_details("irranova", OID, _=self.user)
        self.assertEqual(result["order"]["email"], "old@example.com")
        self.assertEqual(result["order"]["customer_email"], "profile@example.com")

    async def test_clear_note_and_email(self):
        result = await self.update(note="", original_note="Existing note", email=None)
        self.assertEqual(result["order"]["note"], "")
        self.assertEqual(result["order"]["email"], "")
        self.assertEqual(self.calls[0][1]["input"], {"id": OID, "email": None, "note": ""})
        self.assertFalse(self.calls[0][2]["retry_safe"])

    async def test_tags_preserve_concurrent_tags_and_do_not_replace_array(self):
        result = await self.update(tags_added=[" urgent ", "URGENT"], tags_removed=["old"])
        self.assertEqual(result["order"]["tags"], ["agent", "concurrent", "urgent"])
        self.assertFalse(any("tags" in v.get("input", {}) for _, v, _ in self.calls))
        self.assertEqual([q for q, _, _ in self.calls], [c.ORDER_DETAILS_TAG_REMOVE_GQL, c.ORDER_DETAILS_TAG_ADD_GQL])

    async def test_unedited_note_and_email_are_not_sent(self):
        await self.update(tags_added=["new"])
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn("input", self.calls[0][1])

    async def test_note_conflict_prevents_all_mutations(self):
        self.node["note"] += "\nAnother agent added this"
        with self.assertRaises(HTTPException) as raised:
            await self.update(note="my revision", original_note="Existing note", tags_added=["new"])
        self.assertEqual(raised.exception.status_code, 409)
        self.graphql.assert_not_awaited()

    async def test_retry_already_saved_note_is_safe(self):
        self.node["note"] = "my revision"
        result = await self.update(note="my revision", original_note="Existing note", tags_added=["new"])
        self.assertEqual(result["order"]["note"], "my revision")
        self.assertEqual(len(self.calls), 1)

    async def test_note_requires_loaded_baseline(self):
        with self.assertRaises(HTTPException) as raised:
            await self.update(note="change")
        self.assertEqual(raised.exception.status_code, 422)
        self.graphql.assert_not_awaited()

    async def test_reject_invalid_tags_before_read_or_mutation(self):
        for tag in ["x" * 41, "a,b"]:
            with self.subTest(tag=tag), self.assertRaises(HTTPException):
                await self.update(tags_added=[tag])
        self.graphql.assert_not_awaited()
        self.read.assert_not_awaited()

    async def test_legacy_long_tag_can_be_removed(self):
        tag = "x" * 60
        self.node["tags"].append(tag)
        result = await self.update(tags_removed=[tag])
        self.assertNotIn(tag, result["order"]["tags"])

    async def test_invalid_shipping_never_mutates(self):
        with self.assertRaises(HTTPException):
            await self.update(shipping_address={"first_name": "QA", "address1": "Street", "city": "Rabat", "country": "Morocco"})
        self.graphql.assert_not_awaited()

    async def test_missing_store_customer_never_mutates(self):
        async def missing(query, variables, **kwargs):
            return {"customer": None} if query == c.CONFIRMATION_CUSTOMER_ASSOCIATION_GQL else {"order": self.node}
        self.read.side_effect = missing
        with self.assertRaises(HTTPException) as raised:
            await self.update(customer_id="gid://shopify/Customer/999")
        self.assertEqual(raised.exception.status_code, 422)
        self.graphql.assert_not_awaited()

    async def test_customer_reassignment_uses_store_checked_customer(self):
        result = await self.update(customer_id="gid://shopify/Customer/3")
        self.assertEqual(result["order"]["customer_id"], "gid://shopify/Customer/3")
        self.assertEqual(self.calls[0][0], c.ORDER_CUSTOMER_SET_GQL)

    async def test_upstream_usererror_is_reported(self):
        self.graphql.side_effect = None
        self.graphql.return_value = {"orderUpdate": {"userErrors": [{"field": ["email"], "message": "rejected"}]}}
        with self.assertRaises(HTTPException) as raised:
            await self.update(email="new@example.com")
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("rejected", raised.exception.detail)

    async def test_partial_failure_reports_saved_fields(self):
        original = self.response
        async def response(query, variables, **kwargs):
            if query == c.ORDER_DETAILS_TAG_ADD_GQL:
                raise HTTPException(503, "Tag service unavailable")
            return await original(query, variables, **kwargs)
        self.graphql.side_effect = response
        with self.assertRaises(HTTPException) as raised:
            await self.update(note="changed", original_note="Existing note", tags_added=["new"])
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("Some order details were saved", raised.exception.detail)
        self.assertEqual(self.node["note"], "changed")

    async def test_empty_upstream_payload_is_not_success(self):
        self.graphql.side_effect = None
        self.graphql.return_value = {}
        with self.assertRaises(HTTPException) as raised:
            await self.update(tags_added=["new"])
        self.assertEqual(raised.exception.status_code, 502)

    async def test_auth_is_required_on_detail_routes(self):
        for path in ["/api/agent/order-details", "/api/agent/order-details/update"]:
            route = next(route for route in c.router.routes if route.path == path)
            self.assertIn(c.get_current_user, [dependency.call for dependency in route.dependant.dependencies])

    def test_invalid_email_and_id_are_rejected(self):
        for fields in [{"email": "bad-email"}, {"order_id": "wrong"}, {"customer_id": "gid://shopify/Customer/wrong"}]:
            with self.subTest(fields=fields), self.assertRaises(ValidationError):
                c.OrderDetailsEditBody(**{"store": "irranova", "order_id": OID, **fields})


class ShippingFeeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.node = pricing()
        self.calls = []
        self.active = [{"id": "gid://shopify/CalculatedShippingLine/1", "title": "Express delivery", "stagedStatus": "NONE", "price": money("25.00")}]
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(c, "_attach_line_item_stock", AsyncMock()))
        self.stack.enter_context(patch.object(c, "_audit_confirmation_order_change", AsyncMock()))
        self.graphql = self.stack.enter_context(patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=self.response)))

    async def response(self, query, variables, **kwargs):
        self.calls.append((query, variables, kwargs))
        self.assertEqual(kwargs["store"], "irranova")
        if query == c.ORDER_PRICING_GQL:
            return {"order": self.node}
        if query == c.ORDER_EDIT_BEGIN_GQL:
            return {"orderEditBegin": {"calculatedOrder": {"id": "calc", "shippingLines": self.active, "lineItems": {"nodes": []}}, "userErrors": []}}
        if query in [c.ORDER_EDIT_REMOVE_SHIPPING_GQL, c.ORDER_EDIT_ADD_SHIPPING_GQL]:
            key = "orderEditRemoveShippingLine" if query == c.ORDER_EDIT_REMOVE_SHIPPING_GQL else "orderEditAddShippingLine"
            return {key: {"calculatedOrder": {"id": "calc"}, "userErrors": []}}
        if query == c.ORDER_EDIT_COMMIT_GQL:
            return {"orderEditCommit": {"order": order(), "userErrors": []}}
        raise AssertionError(query)

    async def edit(self, price="0.00", original="25.00"):
        return await c.edit_order_items(c.OrderItemsEditBody(store="irranova", order_id=OID, items=[],
                                                            shipping_price=price, original_shipping_price=original),
                                        user=User(email="qa@example.com"), db=MagicMock())

    async def test_fee_only_can_be_zero_and_commits_once(self):
        await self.edit()
        self.assertEqual([q for q, _, _ in self.calls], [c.ORDER_PRICING_GQL, c.ORDER_EDIT_BEGIN_GQL, c.ORDER_EDIT_REMOVE_SHIPPING_GQL, c.ORDER_EDIT_ADD_SHIPPING_GQL, c.ORDER_EDIT_COMMIT_GQL])
        variables = self.calls[3][1]
        self.assertFalse(self.calls[3][2]["retry_safe"])
        self.assertEqual(variables["shippingLine"], {"title": "Express delivery", "price": {"amount": "0.00", "currencyCode": "MAD"}})

    async def test_order_without_shipping_line_can_add_fee(self):
        self.node["shippingLines"]["nodes"] = []
        self.node["currentShippingPriceSet"] = money("0.00")
        self.active = []
        await self.edit("30.00", "0.00")
        self.assertNotIn(c.ORDER_EDIT_REMOVE_SHIPPING_GQL, [q for q, _, _ in self.calls])
        self.assertIn(c.ORDER_EDIT_ADD_SHIPPING_GQL, [q for q, _, _ in self.calls])

    async def test_multiple_or_incomplete_shipping_lines_cannot_edit(self):
        for connection in [{"nodes": [shipping_line(), shipping_line()], "pageInfo": {"hasNextPage": False}},
                           {"nodes": [shipping_line()], "pageInfo": {"hasNextPage": True}}, None]:
            self.node["shippingLines"] = connection
            with self.subTest(connection=connection), self.assertRaises(HTTPException) as raised:
                await self.edit()
            self.assertEqual(raised.exception.status_code, 409)
        self.assertNotIn(c.ORDER_EDIT_BEGIN_GQL, [q for q, _, _ in self.calls])

    async def test_shipping_discount_is_preserved_by_blocking_fee_change(self):
        self.node["shippingLines"]["nodes"][0]["discountedPriceSet"] = money("20.00")
        with self.assertRaises(HTTPException) as raised:
            await self.edit()
        self.assertEqual(raised.exception.status_code, 409)
        self.assertNotIn(c.ORDER_EDIT_BEGIN_GQL, [q for q, _, _ in self.calls])

    async def test_shipping_discount_application_is_preserved_even_if_zero(self):
        self.node["discountApplications"]["nodes"] = [{"targetType": "SHIPPING_LINE", "value": {"percentage": 0}}]
        with self.assertRaises(HTTPException):
            await self.edit()
        self.assertNotIn(c.ORDER_EDIT_BEGIN_GQL, [q for q, _, _ in self.calls])

    async def test_stale_fee_is_refused_before_beginning(self):
        with self.assertRaises(HTTPException) as raised:
            await self.edit(original="20.00")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertNotIn(c.ORDER_EDIT_BEGIN_GQL, [q for q, _, _ in self.calls])

    async def test_changed_staged_fee_never_commits(self):
        self.active[0]["price"] = money("22.00")
        with self.assertRaises(HTTPException):
            await self.edit()
        self.assertNotIn(c.ORDER_EDIT_COMMIT_GQL, [q for q, _, _ in self.calls])

    async def test_read_failure_never_begins_or_commits(self):
        self.graphql.side_effect = HTTPException(503, "Read unavailable")
        with self.assertRaises(HTTPException):
            await self.edit()
        self.assertEqual(self.graphql.await_count, 1)

    async def test_invalid_fee_is_refused_before_any_network(self):
        for value in ["-1", "1.001", "NaN", "Infinity", "1000000", ""]:
            with self.subTest(value=value), self.assertRaises(HTTPException):
                await self.edit(value)
        self.graphql.assert_not_awaited()

    async def test_shipping_stage_rejection_never_commits(self):
        original = self.response
        async def response(query, variables, **kwargs):
            if query == c.ORDER_EDIT_ADD_SHIPPING_GQL:
                self.calls.append((query, variables, kwargs))
                return {"orderEditAddShippingLine": {"userErrors": [{"message": "Fee rejected"}]}}
            return await original(query, variables, **kwargs)
        self.graphql.side_effect = response
        with self.assertRaises(HTTPException) as raised:
            await self.edit()
        self.assertEqual(raised.exception.status_code, 422)
        self.assertNotIn(c.ORDER_EDIT_COMMIT_GQL, [q for q, _, _ in self.calls])


if __name__ == "__main__":
    unittest.main()
