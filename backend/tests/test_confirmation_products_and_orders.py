"""Product-first search, the orders list query and order-tag suggestions; no live Shopify calls."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi import HTTPException

from backend.app import confirmation_orders_routes as orders_routes
from backend.app.confirmation_orders_routes import (
    ORDERS_LIST_GQL, PRODUCT_TITLE_IDS_GQL, RECENT_ORDER_TAGS_GQL, SHOP_ORDER_TAGS_GQL,
    build_orders_query, confirmation_order_tags, list_confirmation_orders,
)
from backend.app.confirmation_product_routes import (
    PRODUCT_LOOKUP_GQL, PRODUCT_SEARCH_GQL, _scope, confirmation_product_variants, decode_cursor,
    encode_cursor, search_confirmation_products, title_relevance,
)
from backend.app.confirmation_routes import PRODUCT_PICKER_VARIANTS_GQL, PRODUCT_VARIANT_STOCK_GQL
from backend.app.models import User

LONG_TITLE = ("Kids' Classic High-Top Lace-Up Sneakers in Black and White with Star Patch Details, "
              "Contrast Trim, and Timeless Everyday Style for Boys and Girls")


def product(pid, title, **extra):
    return {"id": f"gid://shopify/Product/{pid}", "title": title, "status": "ACTIVE", "tracksInventory": True,
            "totalInventory": 4, "variantsCount": {"count": 3}, "featuredImage": {"url": f"https://img/{pid}.jpg"},
            "priceRangeV2": {"minVariantPrice": {"amount": "219.99", "currencyCode": "MAD"},
                             "maxVariantPrice": {"amount": "219.99", "currencyCode": "MAD"}}, **extra}


def connection(nodes, more=False, end=None):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": more, "endCursor": end}}


class TitleRelevanceTests(unittest.TestCase):
    def test_exact_title_beats_prefix_beats_partial_and_plurals_match(self):
        tokens = ["black", "sneakers"]
        exact = title_relevance("Black Sneakers", tokens)
        longer = title_relevance("Black sneakers for kids with laces", tokens)
        singular = title_relevance("Kids black sneaker", tokens)
        partial = title_relevance("Black boots", tokens)
        self.assertEqual(exact[0], 1.0)
        self.assertEqual(singular[0], 1.0)
        self.assertEqual(partial[0], 0.5)
        self.assertGreater(exact[1], longer[1])
        self.assertGreater(longer[1], partial[1])


class ProductSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_title_keeps_the_product_and_close_matches_but_drops_unrelated_ones(self):
        exact = product(1, LONG_TITLE)
        sibling = product(2, LONG_TITLE.replace("Black and White", "Pink and White"))
        unrelated = product(3, "Classic Solid Casual Vintage Boots")
        coat = product(4, "High quality puffer padded Stylish Coat")
        seen = {}

        async def respond(query, variables, **kwargs):
            self.assertEqual(query, PRODUCT_SEARCH_GQL)
            seen.update(variables)
            return {"shop": {"currencyCode": "MAD"}, "strict": connection([exact]),
                    "loose": connection([unrelated, coat, sibling, exact], more=True, end="loose-2")}
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)):
            result = await search_confirmation_products(store="irrakids", q=LONG_TITLE, after=None, _=User())
        ids = [p["id"] for p in result["products"]]
        self.assertEqual(ids, [exact["id"], sibling["id"]])
        self.assertEqual(result["products"][0]["match_kind"], "exact")
        self.assertEqual(result["products"][0]["price_min"], "219.99")
        self.assertTrue(seen["withStrict"] and seen["withLoose"])
        self.assertFalse(seen["withIdentifiers"], "a multi-word title is not a SKU")
        self.assertIn(" AND ", seen["strictQuery"])
        self.assertIn(" OR ", seen["looseQuery"])
        self.assertTrue(result["page_info"]["has_next_page"])
        state = decode_cursor(result["page_info"]["end_cursor"], _scope("irrakids", LONG_TITLE))
        self.assertEqual(state["loose_after"], "loose-2")
        self.assertEqual(state["floor"], 0.75)

    async def test_next_page_keeps_the_first_page_floor_and_reads_only_loose_results(self):
        query = "black sneakers kids"
        cursor = encode_cursor({"v": 1, "scope": _scope("irrakids", query), "floor": 0.75, "strict_after": None, "loose_after": "loose-2"})
        graphql = AsyncMock(return_value={"shop": {"currencyCode": "MAD"}, "loose": connection([
            product(5, "Kids black sneakers with lights"), product(6, "Black hat"), product(7, "Kids sneakers black and red")])})
        with patch("backend.app.main.shopify_graphql", graphql):
            result = await search_confirmation_products(store="irrakids", q=query, after=cursor, _=User())
        variables = graphql.await_args.args[1]
        self.assertFalse(variables["withStrict"])
        self.assertTrue(variables["withLoose"])
        self.assertEqual(variables["looseAfter"], "loose-2")
        self.assertEqual([p["title"] for p in result["products"]], ["Kids black sneakers with lights", "Kids sneakers black and red"])
        self.assertFalse(result["page_info"]["has_next_page"])

    async def test_cursor_from_another_search_or_tampered_is_rejected(self):
        cursor = encode_cursor({"v": 1, "scope": _scope("irrakids", "boots"), "floor": 0.5, "strict_after": "s", "loose_after": None})
        for value in [cursor, cursor[:-2] + "AA"]:
            with self.subTest(value=value[-6:]), self.assertRaises(HTTPException) as error:
                await search_confirmation_products(store="irrakids", q="sneakers", after=value, _=User())
            self.assertEqual(error.exception.status_code, 422)

    async def test_sku_match_ranks_its_product_first_and_marks_the_variant(self):
        variant_id = "gid://shopify/ProductVariant/41384825946169"
        graphql = AsyncMock(return_value={"shop": {"currencyCode": "MAD"},
                                          "identifiers": {"nodes": [{"id": variant_id, "product": product(8, "Super hero shoes")}]},
                                          "strict": connection([product(9, "IRS1807 poster")])})
        with patch("backend.app.main.shopify_graphql", graphql):
            result = await search_confirmation_products(store="irrakids", q="irs1807", after=None, _=User())
        self.assertTrue(graphql.await_args.args[1]["withIdentifiers"])
        self.assertFalse(graphql.await_args.args[1]["withLoose"])
        self.assertEqual(result["products"][0]["match_kind"], "identifier")
        self.assertEqual(result["products"][0]["matched_variant_ids"], [variant_id])

    async def test_numeric_id_finds_the_product_through_its_variant(self):
        graphql = AsyncMock(return_value={"shop": {"currencyCode": "MAD"}, "nodes": [None, {"id": "gid://shopify/ProductVariant/55", "product": product(10, "Boots")}]})
        with patch("backend.app.main.shopify_graphql", graphql):
            result = await search_confirmation_products(store="irrakids", q="55", after=None, _=User())
        self.assertEqual(graphql.await_args.args[0], PRODUCT_LOOKUP_GQL)
        self.assertEqual(result["products"][0]["match_kind"], "id")
        self.assertEqual(result["products"][0]["matched_variant_ids"], ["gid://shopify/ProductVariant/55"])

    async def test_variants_load_every_page_with_stock(self):
        def page(ids, more, end):
            return {"shop": {"currencyCode": "MAD"}, "product": {"id": "gid://shopify/Product/1", "title": "Boots", "featuredImage": None,
                    "variants": connection([{"id": f"gid://shopify/ProductVariant/{i}", "title": f"Size {i}", "price": "99.00"} for i in ids], more, end)}}

        async def respond(query, variables, **kwargs):
            if query == PRODUCT_PICKER_VARIANTS_GQL:
                return page([1, 2], True, "next") if not variables["after"] else page([3], False, None)
            self.assertEqual(query, PRODUCT_VARIANT_STOCK_GQL)
            return {"nodes": [{"id": vid, "inventoryItem": {"tracked": True, "inventoryLevels": {"nodes": [
                {"quantities": [{"name": "on_hand", "quantity": 2}, {"name": "available", "quantity": 1}]}], "pageInfo": {"hasNextPage": False}}}} for vid in variables["ids"]]}
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)):
            result = await confirmation_product_variants(store="irrakids", product_id="1", _=User())
        self.assertEqual([v["variant_title"] for v in result["variants"]], ["Size 1", "Size 2", "Size 3"])
        self.assertEqual({v["available_quantity"] for v in result["variants"]}, {1})
        self.assertEqual(result["variants"][0]["product_id"], "gid://shopify/Product/1")

    async def test_variants_reject_a_non_product_id(self):
        with self.assertRaises(HTTPException) as error:
            await confirmation_product_variants(store="irrakids", product_id="gid://shopify/Order/1", _=User())
        self.assertEqual(error.exception.status_code, 422)


class OrdersQueryTests(unittest.TestCase):
    def test_filters_become_one_shopify_query(self):
        query = build_orders_query(
            fulfillment=["unfulfilled", "partial"], payment=["pending"], status=["open"],
            tags=["fz", 'say "hi"'], tag_mode="any", exclude_tags=["cod 19/10/26"],
            product_ids=["gid://shopify/Product/12", "34"], date_from="2026-10-01", date_to="2026-10-17",
        )
        self.assertIn("status:open", query)
        self.assertIn("(fulfillment_status:unshipped OR fulfillment_status:partial)", query)
        self.assertIn("financial_status:pending", query)
        self.assertIn('(tag:"fz" OR tag:"say \\"hi\\"")', query)
        self.assertIn('-tag:"cod 19/10/26"', query)
        self.assertIn("(line_item.product_id:12 OR line_item.product_id:34)", query)
        self.assertIn('created_at:>="2026-10-01T00:00:00', query)
        self.assertIn('created_at:<"2026-10-18T00:00:00', query)

    def test_all_tags_mode_requires_each_tag(self):
        self.assertEqual(build_orders_query(tags=["a", "b"], tag_mode="all"), 'tag:"a" tag:"b"')

    def test_search_text_uses_the_order_number_and_phone_paths(self):
        self.assertIn("name:#174163", build_orders_query(q="#174163"))
        self.assertIn("+212612345678", build_orders_query(q="0612345678"))
        self.assertIn('"imane el"', build_orders_query(q="imane el"))

    def test_unknown_or_malformed_values_are_rejected(self):
        for kwargs in [{"payment": ["free"]}, {"status": ["archived; drop"]}, {"tag_mode": "some"},
                       {"product_ids": ["title:shoes"]}, {"date_from": "17/10/2026"},
                       {"date_from": "2026-10-10", "date_to": "2026-10-01"}, {"tags": [str(i) for i in range(21)]}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(HTTPException) as error:
                build_orders_query(**kwargs)
            self.assertEqual(error.exception.status_code, 422)


def list_args(**changes):
    args = dict(store="irrakids", q="", fulfillment=[], payment=[], status=[], tag=[], tag_mode="any", exclude_tag=[],
                product_id=[], product_title="", date_from="", date_to="", sort_key="CREATED_AT", reverse=True,
                after=None, before=None, first=50, _=User())
    args.update(changes)
    return args


class OrdersListTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        domain = patch("backend.app.main.resolve_store_settings_effective", AsyncMock(return_value=("irrakids.myshopify.com", "t", "k")))
        domain.start()
        self.addCleanup(domain.stop)

    async def test_lists_lean_rows_with_count_and_paging(self):
        node = {"id": "gid://shopify/Order/1", "legacyResourceId": "1", "name": "#174163", "createdAt": "2026-10-17T15:27:00Z",
                "closed": False, "cancelledAt": None, "tags": ["fast"], "displayFinancialStatus": "PENDING",
                "displayFulfillmentStatus": "UNFULFILLED", "currentSubtotalLineItemsQuantity": 2,
                "currentTotalPriceSet": {"shopMoney": {"amount": "179.99", "currencyCode": "MAD"}},
                "customer": {"displayName": "Imane"}, "shippingAddress": {"name": "Imane", "city": "Temara", "countryCodeV2": "MA"},
                "lineItems": {"nodes": [{"title": "Boots", "variantTitle": "Black / 21", "currentQuantity": 2, "image": None},
                                        {"title": "Removed", "variantTitle": "", "currentQuantity": 0, "image": None}]}}
        graphql = AsyncMock(return_value={"orders": {"nodes": [node], "pageInfo": {"hasNextPage": True, "hasPreviousPage": False, "startCursor": "s", "endCursor": "e"}},
                                          "ordersCount": {"count": 1234, "precision": "EXACT"}})
        with patch("backend.app.main.shopify_graphql", graphql):
            result = await list_confirmation_orders(**list_args(payment=["pending"], before="b"))
        query, variables = graphql.await_args.args[0], graphql.await_args.args[1]
        self.assertEqual(query, ORDERS_LIST_GQL)
        self.assertEqual((variables["first"], variables["last"], variables["before"]), (None, 50, "b"))
        self.assertEqual(variables["query"], "financial_status:pending")
        row = result["orders"][0]
        self.assertEqual(row["destination"], "Temara, MA")
        self.assertEqual(row["items_count"], 2)
        self.assertEqual([item["title"] for item in row["line_items"]], ["Boots"])
        self.assertEqual(result["count"], 1234)
        self.assertEqual(result["shop_domain"], "irrakids.myshopify.com")
        self.assertTrue(result["page_info"]["has_next_page"])

    async def test_product_title_filters_by_matching_product_ids(self):
        async def respond(query, variables, **kwargs):
            if query == PRODUCT_TITLE_IDS_GQL:
                self.assertIn("title:sneakers*", variables["query"])
                return {"products": {"nodes": [{"id": "gid://shopify/Product/7"}, {"id": "gid://shopify/Product/8"}]}}
            self.assertIn("(line_item.product_id:7 OR line_item.product_id:8)", variables["query"])
            return {"orders": {"nodes": [], "pageInfo": {}}, "ordersCount": {"count": 0}}
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)):
            result = await list_confirmation_orders(**list_args(product_title="sneakers"))
        self.assertEqual(result["product_title_matches"], 2)

    async def test_product_title_without_matching_products_returns_no_orders(self):
        graphql = AsyncMock(return_value={"products": {"nodes": []}})
        with patch("backend.app.main.shopify_graphql", graphql):
            result = await list_confirmation_orders(**list_args(product_title="nothing like this"))
        self.assertEqual(result["orders"], [])
        self.assertEqual(result["product_title_matches"], 0)
        self.assertEqual(graphql.await_count, 1)


class OrderTagSuggestionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        orders_routes._TAG_CACHE.clear()

    async def test_recent_tags_by_use_then_store_popular_tags_and_cache(self):
        async def respond(query, variables, **kwargs):
            if query == RECENT_ORDER_TAGS_GQL:
                return {"orders": {"nodes": [{"tags": ["fz", "cod 19/10/26"]}, {"tags": ["FZ", "meta"]}]}}
            self.assertEqual(query, SHOP_ORDER_TAGS_GQL)
            return {"shop": {"orderTags": {"edges": [{"node": "meta"}, {"node": "pal"}]}}}
        graphql = AsyncMock(side_effect=respond)
        with patch("backend.app.main.shopify_graphql", graphql):
            first = await confirmation_order_tags(store="irrakids", _=User())
            second = await confirmation_order_tags(store="irrakids", _=User())
        self.assertEqual(first["tags"], ["fz", "cod 19/10/26", "meta", "pal"])
        self.assertEqual(second["tags"], first["tags"])
        self.assertEqual(graphql.await_count, 2)

    async def test_shop_tag_field_failure_still_returns_recent_tags(self):
        async def respond(query, variables, **kwargs):
            if query == SHOP_ORDER_TAGS_GQL:
                raise HTTPException(502, "Field 'orderTags' doesn't exist")
            return {"orders": {"nodes": [{"tags": ["fz"]}]}}
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=respond)):
            result = await confirmation_order_tags(store="irrakids", _=User())
        self.assertEqual(result["tags"], ["fz"])
        self.assertEqual(result["warnings"], [])

    async def test_both_sources_failing_reports_and_does_not_cache(self):
        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=HTTPException(502, "down"))):
            result = await confirmation_order_tags(store="irrakids", _=User())
        self.assertEqual(result["tags"], [])
        self.assertTrue(result["warnings"])
        self.assertNotIn("irrakids", orders_routes._TAG_CACHE)


if __name__ == "__main__":
    unittest.main()
