"""Order discounts in the confirmation edit modal, and keeping them on a variant change."""
import os
import unittest
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from backend.app.confirmation_routes import (
    ORDER_EDIT_ADD_LINE_DISCOUNT_GQL, ORDER_EDIT_ADD_VARIANT_GQL, ORDER_EDIT_BEGIN_GQL,
    ORDER_EDIT_COMMIT_GQL, ORDER_EDIT_SET_QUANTITY_GQL, ORDER_PRICING_GQL,
    OrderItemsEditBody, _carried_discount_percent, _order_pricing, edit_order_items,
)
from backend.app.models import User


def money(amount):
    return {"shopMoney": {"amount": amount, "currencyCode": "MAD"}}


def line(line_id, original, discounted, allocations, quantity=1, current=None):
    return {
        "id": line_id, "quantity": quantity, "currentQuantity": quantity if current is None else current,
        "originalUnitPriceSet": money(original),
        "discountedUnitPriceAfterAllDiscountsSet": money(discounted),
        "discountAllocations": [
            {"allocatedAmountSet": money(amount), "discountApplication": {"index": index}}
            for index, amount in allocations
        ],
    }


# Shaped like order #103671: three free sneakers and one with 10.99 off,
# plus an order-wide code spread over the last line to cover both kinds.
ORDER = {
    "id": "gid://shopify/Order/1",
    "discountCodes": ["WELCOME"],
    "currentSubtotalPriceSet": money("219.00"),
    "currentTotalDiscountsSet": money("770.96"),
    "currentShippingPriceSet": money("25.00"),
    "currentTotalPriceSet": money("244.00"),
    "discountApplications": {"nodes": [
        {"allocationMethod": "EACH", "targetSelection": "EXPLICIT", "targetType": "LINE_ITEM",
         "value": {"amount": "249.99"}, "title": "Item discount"},
        {"allocationMethod": "EACH", "targetSelection": "EXPLICIT", "targetType": "LINE_ITEM",
         "value": {"amount": "10.99"}, "title": "Item discount"},
        {"allocationMethod": "ACROSS", "targetSelection": "ALL", "targetType": "LINE_ITEM",
         "value": {"amount": "10.00"}, "code": "WELCOME"},
    ]},
    "lineItems": {"nodes": [
        line("gid://shopify/LineItem/11", "249.99", "0.0", [(0, "249.99")]),
        line("gid://shopify/LineItem/12", "239.99", "219.0", [(1, "10.99"), (2, "10.00")]),
        line("gid://shopify/LineItem/13", "100.00", "100.0", [], current=0),
    ]},
}


class OrderPricingTests(unittest.TestCase):
    def test_summarises_order_and_item_discounts(self):
        pricing = _order_pricing(ORDER)
        self.assertEqual(pricing["subtotal_before_discounts"], "489.98")
        self.assertEqual((pricing["total_discounts"], pricing["shipping"], pricing["total"]), ("770.96", "25.00", "244.00"))
        self.assertEqual([d["applies_to"] for d in pricing["discounts"]], ["item", "item", "order"])
        self.assertEqual(pricing["discounts"][2]["label"], "WELCOME")
        self.assertTrue(pricing["discounts"][2]["is_code"])
        free = pricing["line_items"]["gid://shopify/LineItem/11"]
        self.assertEqual((free["original_unit_price"], free["discounted_unit_price"], free["unit_discount"]), ("249.99", "0.00", "249.99"))

    def test_only_the_items_own_discount_is_carried(self):
        mixed = _order_pricing(ORDER)["line_items"]["gid://shopify/LineItem/12"]
        self.assertEqual(mixed["unit_discount"], "20.99")
        self.assertEqual(mixed["item_unit_discount"], "10.99")
        self.assertEqual([d["label"] for d in mixed["discounts"]], ["Item discount", "WELCOME"])

    def test_removed_lines_are_left_out(self):
        self.assertNotIn("gid://shopify/LineItem/13", _order_pricing(ORDER)["line_items"])

    def test_multi_unit_allocations_are_per_unit(self):
        node = {**ORDER, "lineItems": {"nodes": [line("gid://shopify/LineItem/21", "100.00", "90.0", [(0, "20.00")], quantity=2)]}}
        self.assertEqual(_order_pricing(node)["line_items"]["gid://shopify/LineItem/21"]["item_unit_discount"], "10.00")

    def test_carried_discount_percent(self):
        self.assertEqual(_carried_discount_percent(Decimal("249.99"), Decimal("249.99")), 100.0)
        self.assertEqual(_carried_discount_percent(Decimal("300"), Decimal("249.99")), 100.0)
        self.assertEqual(_carried_discount_percent(Decimal("0"), Decimal("249.99")), 0.0)
        percent = _carried_discount_percent(Decimal("10.99"), Decimal("239.99"))
        self.assertEqual(round(Decimal("239.99") * Decimal(str(percent)) / 100, 2), Decimal("10.99"))


class ReplacementKeepsDiscountTests(unittest.IsolatedAsyncioTestCase):
    def shopify(self):
        calls = []

        async def respond(query, variables, **kwargs):
            calls.append((query, variables))
            if query == ORDER_PRICING_GQL:
                return {"order": ORDER}
            if query == ORDER_EDIT_BEGIN_GQL:
                return {"orderEditBegin": {"calculatedOrder": {"id": "calc-1", "lineItems": {"nodes": [
                    {"id": "gid://shopify/CalculatedLineItem/11", "quantity": 1, "editableQuantity": 1},
                    {"id": "gid://shopify/CalculatedLineItem/12", "quantity": 1, "editableQuantity": 1},
                ]}}, "userErrors": []}}
            if query == ORDER_EDIT_SET_QUANTITY_GQL:
                return {"orderEditSetQuantity": {"calculatedLineItem": {}, "userErrors": []}}
            if query == ORDER_EDIT_ADD_VARIANT_GQL:
                return {"orderEditAddVariant": {"calculatedLineItem": {
                    "id": f"new-{variables['variantId']}", "quantity": variables["quantity"],
                    "originalUnitPriceSet": money("249.99")}, "userErrors": []}}
            if query == ORDER_EDIT_ADD_LINE_DISCOUNT_GQL:
                return {"orderEditAddLineItemDiscount": {"addedDiscountStagedChange": {"id": "d"}, "userErrors": []}}
            if query == ORDER_EDIT_COMMIT_GQL:
                return {"orderEditCommit": {"order": {"id": "gid://shopify/Order/1", "lineItems": {"edges": []}}, "userErrors": []}}
            raise AssertionError(f"unexpected query {query[:60]}")

        return calls, AsyncMock(side_effect=respond)

    async def edit(self, additions):
        calls, graphql = self.shopify()
        body = OrderItemsEditBody(
            store="irranova", order_id="gid://shopify/Order/1",
            items=[{"line_item_id": "gid://shopify/LineItem/11", "quantity": 0}], additions=additions,
        )
        with patch("backend.app.main.shopify_graphql", graphql):
            await edit_order_items(body, user=User(email="agent@example.test"), db=MagicMock(commit=AsyncMock(), rollback=AsyncMock(), flush=AsyncMock()))
        return calls

    async def test_free_item_stays_free_on_the_new_variant(self):
        calls = await self.edit([{"variant_id": "gid://shopify/ProductVariant/9", "quantity": 1,
                                  "replaces_line_item_id": "gid://shopify/LineItem/11"}])
        discounts = [v for q, v in calls if q == ORDER_EDIT_ADD_LINE_DISCOUNT_GQL]
        self.assertEqual(len(discounts), 1)
        self.assertEqual(discounts[0]["lineItemId"], "new-gid://shopify/ProductVariant/9")
        self.assertEqual(discounts[0]["discount"]["percentValue"], 100.0)
        self.assertEqual(calls[-1][0], ORDER_EDIT_COMMIT_GQL)

    async def test_agent_can_drop_the_discount(self):
        calls = await self.edit([{"variant_id": "gid://shopify/ProductVariant/9", "quantity": 1,
                                  "replaces_line_item_id": "gid://shopify/LineItem/11", "keep_discount": False}])
        queries = [q for q, _v in calls]
        self.assertNotIn(ORDER_PRICING_GQL, queries)
        self.assertNotIn(ORDER_EDIT_ADD_LINE_DISCOUNT_GQL, queries)
        self.assertIn(ORDER_EDIT_ADD_VARIANT_GQL, queries)

    async def test_plain_additions_get_no_discount(self):
        calls = await self.edit([{"variant_id": "gid://shopify/ProductVariant/9", "quantity": 1}])
        self.assertNotIn(ORDER_EDIT_ADD_LINE_DISCOUNT_GQL, [q for q, _v in calls])


if __name__ == "__main__":
    unittest.main()
