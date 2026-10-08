import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import HTTPException
from backend.app.confirmation_routes import customer_orders


class CustomerHistoryPaginationTests(unittest.IsolatedAsyncioTestCase):
    async def request_page(self, connection, **kwargs):
        shopify = AsyncMock(return_value={
            "customer": {
                "id": "gid://shopify/Customer/101",
                "displayName": "Sample customer",
                "numberOfOrders": "66",
                "orders": connection,
            },
        })
        main = SimpleNamespace(
            shopify_graphql=shopify,
            resolve_store_settings_effective=AsyncMock(return_value=("sample.myshopify.com", "unused", "unused")),
        )
        with patch.dict("sys.modules", {"backend.app.main": main}):
            result = await customer_orders(store="sample", customer_id="101", user=None, **kwargs)
        return result, shopify

    async def test_initial_page_preserves_total_and_exposes_next_cursor(self):
        result, shopify = await self.request_page({
            "edges": [{"node": {"id": "gid://shopify/Order/42", "name": "#42"}}],
            "pageInfo": {"hasNextPage": True, "endCursor": "next-page"},
        })
        self.assertEqual(result["total_orders"], 66)
        self.assertEqual(result["orders"][0]["name"], "#42")
        self.assertEqual(result["page_info"], {"has_next_page": True, "end_cursor": "next-page"})
        self.assertEqual(shopify.await_args.args[1], {"id": "gid://shopify/Customer/101", "first": 20, "after": None})

    async def test_older_page_uses_cursor_and_caps_page_size(self):
        result, shopify = await self.request_page({
            "edges": [{"node": {"id": "gid://shopify/Order/21", "name": "#21"}}],
            "pageInfo": {"hasNextPage": False, "endCursor": "last-page"},
        }, first=100, after="next-page")
        self.assertEqual(result["orders"][0]["name"], "#21")
        self.assertFalse(result["page_info"]["has_next_page"])
        self.assertEqual(shopify.await_args.args[1]["after"], "next-page")
        self.assertEqual(shopify.await_args.args[1]["first"], 50)

    async def test_empty_history_has_no_next_page(self):
        result, _ = await self.request_page({"edges": []})
        self.assertEqual(result["orders"], [])
        self.assertEqual(result["page_info"], {"has_next_page": False, "end_cursor": None})

    async def test_missing_customer_id_is_rejected_before_shopify(self):
        with self.assertRaises(HTTPException) as error:
            await customer_orders(store="sample", customer_id=" ", user=None)
        self.assertEqual(error.exception.status_code, 400)
