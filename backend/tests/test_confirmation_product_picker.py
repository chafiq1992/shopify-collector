"""Complete, fair product search traversal and chat option pagination; no live writes."""
import os
import unittest
from copy import deepcopy
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import HTTPException
from fastapi.testclient import TestClient
from backend.app import confirmation_routes as c
from backend.app import chat_order_routes as chat


def variant(pid, index, **changes):
    return {"id": f"gid://shopify/ProductVariant/{pid * 1000 + index}", "title": f"Blue / {index}",
            "sku": f"SKU-{pid}-{index}", "barcode": f"999{pid}{index}", "price": "99.50", "inventoryQuantity": 8,
            "inventoryPolicy": "DENY", "availableForSale": True,
            "selectedOptions": [{"name": "Size", "value": str(index)}], "image": {"url": "https://example.com/image.jpg"}, **changes}


class Catalog:
    def __init__(self, counts=(75, 1, 5, 3, 13, 2, 51, 3, 4, 2, 1, 7, 20)):
        self.products = [{"id": f"gid://shopify/Product/{pid}", "title": f"Shirt product {pid}",
                          "featuredImage": {"url": "https://example.com/product.jpg"},
                          "all_variants": [variant(pid, index) for index in range(1, count + 1)]}
                         for pid, count in enumerate(counts, 1)]
        self.calls, self.boost = [], []
        self.direct_variant = None

    def page(self, product, first, after=None):
        offset = int((after or "v:0").split(":")[1])
        rows = product["all_variants"][offset:offset + first]
        end = offset + len(rows)
        return {**{k: deepcopy(v) for k, v in product.items() if k != "all_variants"},
                "variants": {"nodes": deepcopy(rows), "pageInfo": {"hasNextPage": end < len(product["all_variants"]), "endCursor": f"v:{end}"}}}

    async def __call__(self, gql, values, **kw):
        self.calls.append((gql, deepcopy(values), kw))
        shop = {"currencyCode": "MAD"}
        if gql == c.PRODUCTS_PICKER_SEARCH_GQL:
            offset = int((values.get("after") or "p:0").split(":")[1])
            products = self.products[offset:offset + values["first"]]
            end = offset + len(products)
            return {"shop": shop, "products": {"nodes": [self.page(p, values["preview"]) for p in products],
                    "pageInfo": {"hasNextPage": end < len(self.products), "endCursor": f"p:{end}"}},
                    "identifierVariants": {"nodes": deepcopy(self.boost[:values["identifierFirst"]])}}
        if gql == c.PRODUCT_PICKER_VARIANTS_GQL:
            product = next((p for p in self.products if p["id"] == values["id"]), None)
            return {"shop": shop, "product": self.page(product, values["first"], values.get("after")) if product else None}
        if gql == c.PRODUCT_PICKER_RESOURCE_GQL:
            nodes = []
            for gid in values["ids"]:
                product = next((p for p in self.products if p["id"] == gid), None)
                found = next((v for p in self.products for v in p["all_variants"] if v["id"] == gid), None)
                if self.direct_variant and self.direct_variant["id"] == gid:
                    found = self.direct_variant
                if product:
                    nodes.append(self.page(product, values["first"]))
                elif found:
                    parent = next((p for p in self.products if found in p["all_variants"]), self.products[-1])
                    nodes.append({**deepcopy(found), "product": {k: parent[k] for k in ("id", "title", "featuredImage")}})
                else:
                    nodes.append(None)
            return {"shop": shop, "nodes": nodes}
        if gql == c.PRODUCT_VARIANT_STOCK_GQL:
            return {"nodes": [{"id": gid, "inventoryItem": {"id": "inventory-" + gid.rsplit("/", 1)[-1], "tracked": True,
                    "inventoryLevels": {"nodes": [{"quantities": [{"name": "on_hand", "quantity": 10}, {"name": "available", "quantity": 8}]}],
                                        "pageInfo": {"hasNextPage": False}}}} for gid in values["ids"]]}
        raise AssertionError("Unexpected GraphQL operation")


class ProductPickerHelpers(unittest.TestCase):
    def test_search_requires_authentication(self):
        from backend.app.main import app
        client = TestClient(app)
        self.assertEqual(client.get("/api/agent/product-variants/search?store=irranova&q=shirt").status_code, 401)

    def test_reordered_prefixes_accents_and_related_tokens_are_field_scoped(self):
        query, identifier = c._picker_query("ÉTÉ chem")
        self.assertIn("title:ete*", query)
        self.assertIn("title:été*", query)
        self.assertIn("title:chem*", query)
        self.assertIn(" AND ", query)
        self.assertIn(" OR ", query)
        self.assertIn("sku:", identifier)
        self.assertIn("barcode:", identifier)
        node = {"product": {"title": "Chemise été enfant"}}
        self.assertEqual(c._picker_match(node, "été chem"), "prefix")
        self.assertEqual(c._picker_match(node, "été wrong"), "related")
        self.assertIsNone(c._picker_query("---"))

    def test_single_character_segment_skus_still_search_identifiers(self):
        for sku in ["X-1", "A/B", "Q.T"]:
            with self.subTest(sku=sku):
                query = c._picker_query(sku)
                self.assertIsNotNone(query)
                self.assertIn(f"sku:{sku}*", query[0])
                self.assertIn(f"barcode:{sku}*", query[0])

    def test_opaque_cursor_is_signed_and_bound_to_query_store_and_page_size(self):
        state = {"v": 1, "scope": c._picker_cursor_scope("irranova", "shirt", 40), "phase": "products", "after": "p:2"}
        token = c._picker_encode_cursor(state)
        self.assertEqual(c._picker_decode_cursor(token, state["scope"]), state)
        for invalid, scope in [(token + "x", state["scope"]), ("bad.token", state["scope"]),
                                (token, c._picker_cursor_scope("irrakids", "shirt", 40)),
                                (token, c._picker_cursor_scope("irranova", "different", 40)),
                                (token, c._picker_cursor_scope("irranova", "shirt", 20))]:
            with self.subTest(invalid=invalid), self.assertRaises(HTTPException):
                c._picker_decode_cursor(invalid, scope)


class ProductPickerTraversal(unittest.IsolatedAsyncioTestCase):
    async def traverse(self, catalog, q="shirt", first=40):
        seen, pages, after = [], [], None
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=catalog.__call__)):
            for _ in range(200):
                page = await c.search_product_variants(store="irranova", q=q, first=first, after=after)
                pages.append(page)
                seen.extend(page["variants"])
                info = page["page_info"]
                if not info["has_next_page"]:
                    self.assertIsNone(info["end_cursor"])
                    return seen, pages
                self.assertTrue(info["end_cursor"])
                self.assertNotEqual(after, info["end_cursor"])
                self.assertLess(len(info["end_cursor"]), 16384)
                after = info["end_cursor"]
        self.fail("Product search did not finish")

    async def test_many_variants_do_not_hide_other_products_and_full_traversal_has_no_loss(self):
        catalog = Catalog()
        rows, pages = await self.traverse(catalog)
        self.assertEqual(len({row["product_id"] for row in pages[0]["variants"]}), 10)
        self.assertEqual(len({row["product_id"] for page in pages[:2] for row in page["variants"]}), len(catalog.products))
        expected = {v["id"] for product in catalog.products for v in product["all_variants"]}
        self.assertEqual({row["id"] for row in rows}, expected)
        self.assertEqual(len(rows), len(expected))
        self.assertEqual([row["product_id"] for row in pages[0]["variants"][:3]], [p["id"] for p in catalog.products[:3]])
        self.assertTrue(all(row["available_quantity"] == 8 and row["on_hand_quantity"] == 10 for row in rows))
        self.assertTrue(all(row["available"] is True and row["inventory_policy"] == "DENY" for row in rows))

    async def test_cursor_state_size_is_bounded_for_broad_results(self):
        catalog = Catalog([3] * 53)
        rows, pages = await self.traverse(catalog)
        self.assertEqual(len(rows), 159)
        for page in pages:
            token = page["page_info"]["end_cursor"]
            if token:
                state = c._picker_decode_cursor(token, c._picker_cursor_scope("irranova", "shirt", 40))
                self.assertLessEqual(len(state.get("pending") or []), 10)

    async def test_exact_sku_deep_in_product_is_boosted_then_not_duplicated_later(self):
        catalog = Catalog([75, 4])
        target = catalog.products[0]["all_variants"][60]
        target["sku"] = "X-1"
        catalog.boost = [{**target, "product": {k: catalog.products[0][k] for k in ("id", "title", "featuredImage")}}]
        rows, pages = await self.traverse(catalog, q="X-1")
        self.assertEqual(pages[0]["variants"][0]["id"], target["id"])
        self.assertEqual(pages[0]["variants"][0]["match_kind"], "identifier")
        self.assertEqual(sum(row["id"] == target["id"] for row in rows), 1)
        self.assertEqual(len(rows), 79)

    async def test_explicit_product_gid_paginates_every_variant_and_variant_gid_is_exact(self):
        catalog = Catalog([105])
        rows, _ = await self.traverse(catalog, q=catalog.products[0]["id"], first=20)
        self.assertEqual(len(rows), 105)
        self.assertTrue(all(row["match_kind"] == "id" for row in rows))
        target = catalog.products[0]["all_variants"][-1]
        rows, pages = await self.traverse(catalog, q=target["id"])
        self.assertEqual([row["id"] for row in rows], [target["id"]])
        self.assertEqual(len(pages), 1)

    async def test_numeric_id_resolves_both_resource_types_without_dropping_one(self):
        catalog = Catalog([45, 1])
        catalog.direct_variant = variant(99, 1, id="gid://shopify/ProductVariant/1")
        # The UI starts at two characters; use an ID present in both namespaces.
        catalog.products[0]["id"] = "gid://shopify/Product/12"
        catalog.direct_variant["id"] = "gid://shopify/ProductVariant/12"
        rows, _ = await self.traverse(catalog, q="12", first=20)
        self.assertEqual(len(rows), 46)
        self.assertIn("gid://shopify/ProductVariant/12", {row["id"] for row in rows})
        self.assertIn("gid://shopify/Product/12", {row["product_id"] for row in rows})

    async def test_numeric_barcode_falls_back_to_catalog_when_not_resource_id(self):
        catalog = Catalog([2])
        rows, _ = await self.traverse(catalog, q="123456789000")
        self.assertEqual(len(rows), 2)
        self.assertTrue(any(gql == c.PRODUCTS_PICKER_SEARCH_GQL for gql, _, _ in catalog.calls))

    async def test_permission_denial_keeps_products_with_truthfully_unknown_stock(self):
        catalog = Catalog([2, 1])
        async def respond(gql, values, **kw):
            if gql == c.PRODUCT_VARIANT_STOCK_GQL:
                raise HTTPException(502, "ACCESS_DENIED read_inventory")
            return await catalog(gql, values, **kw)
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)):
            page = await c.search_product_variants(store="irranova", q="shirt", first=40)
        self.assertEqual(len(page["variants"]), 3)
        self.assertTrue(page["warnings"])
        self.assertTrue(all(row["available_quantity"] is None and row["on_hand_quantity"] is None for row in page["variants"]))

    async def test_malformed_product_or_variant_pagination_is_not_silently_partial(self):
        catalog = Catalog([4])
        async def bad(gql, values, **kw):
            data = await catalog(gql, values, **kw)
            if gql == c.PRODUCT_PICKER_VARIANTS_GQL:
                data["product"]["variants"]["pageInfo"] = {"hasNextPage": True, "endCursor": values["after"]}
            return data
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=bad)):
            page = await c.search_product_variants(store="irranova", q="shirt", first=40)
            with self.assertRaises(HTTPException) as error:
                await c.search_product_variants(store="irranova", q="shirt", first=40, after=page["page_info"]["end_cursor"])
            self.assertEqual(error.exception.status_code, 502)

    async def test_repeated_inventory_cursor_falls_back_to_unknown_counts_without_loop(self):
        catalog = Catalog([1])
        inventory_calls = []
        async def respond(gql, values, **kw):
            if gql == c.PRODUCT_VARIANT_STOCK_GQL:
                return {"nodes": [{"id": values["ids"][0], "inventoryItem": {"id": "inventory-1", "tracked": True,
                    "inventoryLevels": {"nodes": [{"quantities": [{"name": "on_hand", "quantity": 10}, {"name": "available", "quantity": 8}]}],
                                        "pageInfo": {"hasNextPage": True, "endCursor": "repeat"}}}}]}
            if gql == c.INVENTORY_LEVELS_PAGE_GQL:
                inventory_calls.append(values)
                return {"inventoryItem": {"inventoryLevels": {"nodes": [{"quantities": []}], "pageInfo": {"hasNextPage": True, "endCursor": "repeat"}}}}
            return await catalog(gql, values, **kw)
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)):
            page = await c.search_product_variants(store="irranova", q="shirt", first=40)
        self.assertEqual(len(inventory_calls), 1)
        self.assertTrue(page["warnings"])
        self.assertIsNone(page["variants"][0]["available_quantity"])
        self.assertIsNone(page["variants"][0]["on_hand_quantity"])

    async def test_empty_search_and_failed_page_do_not_claim_successful_catalog(self):
        graphql = AsyncMock(side_effect=HTTPException(502, "Shopify unavailable"))
        with patch("backend.app.main.shopify_graphql", graphql):
            self.assertFalse((await c.search_product_variants(store="irranova", q=" "))["page_info"]["has_next_page"])
            with self.assertRaises(HTTPException):
                await c.search_product_variants(store="irranova", q="shirt")


class ChatVariantPagination(unittest.IsolatedAsyncioTestCase):
    async def test_variant_101_and_all_later_options_remain_selectable(self):
        catalog = Catalog([205])
        product = catalog.products[0]
        async def respond(gql, values, **kw):
            self.assertEqual(kw["api_version"], "2026-01")
            if gql == chat.PRODUCT_BY_ID_GQL:
                return {"product": catalog.page(product, 100)}
            self.assertEqual(gql, chat.PRODUCT_VARIANTS_PAGE_GQL)
            return {"product": catalog.page(product, 100, values["after"])}
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)):
            result = await chat.chat_product_options(store="irranova", product_id=product["id"], variant_title="Blue / 205")
        self.assertEqual(len(result["product"]["variants"]), 205)
        self.assertEqual(result["matched_variant_id"], product["all_variants"][-1]["id"])
        self.assertTrue(result["product"]["variants"][-1]["available"])

    async def test_chat_refuses_repeated_or_missing_variant_cursor(self):
        catalog = Catalog([105])
        product = catalog.products[0]
        for broken in [{"hasNextPage": True, "endCursor": None}, {"hasNextPage": True, "endCursor": "v:100"}]:
            async def respond(gql, values, **kw):
                if gql == chat.PRODUCT_BY_ID_GQL:
                    return {"product": catalog.page(product, 100)}
                page = catalog.page(product, 100, "v:100")
                page["variants"]["pageInfo"] = broken
                return {"product": page}
            with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)):
                with self.assertRaises(HTTPException):
                    await chat.chat_product_options(store="irranova", product_id=product["id"])


if __name__ == "__main__":
    unittest.main()
