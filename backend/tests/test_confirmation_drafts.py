"""Draft regressions use mocked Shopify responses and isolated SQLite; no store writes."""
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

from backend.app import confirmation_draft_routes as d
from backend.app.db import Base
from backend.app.models import OrderEvent, User

DRAFT = "gid://shopify/DraftOrder/101"
LINE = "gid://shopify/DraftOrderLineItem/201"
VARIANT = "gid://shopify/ProductVariant/301"
UPDATED = "2026-10-15T10:00:00Z"
NEXT = "2026-10-15T10:01:00Z"


def money(amount):
    return {"presentmentMoney": {"amount": str(amount), "currencyCode": "MAD"},
            "shopMoney": {"amount": str(amount), "currencyCode": "MAD"}}


def line_node(**changes):
    return {"id": LINE, "uuid": "stable-line-uuid", "quantity": 2, "custom": False,
            "variant": {"id": VARIANT}, "title": "Hoodie", "variantTitle": "Blue / 4",
            "sku": "SKU1", "image": {"url": "https://example.com/image.jpg"},
            "originalUnitPriceSet": money("100"), "discountedTotalSet": money("180"),
            "priceOverride": {"amount": "100", "currencyCode": "MAD"},
            "customAttributes": [{"key": "engraving", "value": "Keep me"}],
            "appliedDiscount": {"title": "Special", "description": "Keep discount", "value": 10,
                                "valueType": "PERCENTAGE", "amountSet": money("20")},
            "components": [], **changes}


def order_node():
    return {"id": "gid://shopify/Order/901", "name": "#1901", "tags": ["original", "agent-1"],
            "displayFinancialStatus": "PENDING", "lineItems": {"edges": []}, "currentTotalPriceSet": money("200")}


def draft_node(**changes):
    return {"id": DRAFT, "name": "#D101", "status": "OPEN", "createdAt": UPDATED,
            "updatedAt": UPDATED, "completedAt": None, "currencyCode": "MAD", "presentmentCurrencyCode": "MAD",
            "ready": True, "poNumber": "PO1", "note2": "Existing note", "email": "test@example.com",
            "phone": "0612345678", "tags": ["original", "cod 10/14"],
            "customer": {"id": "customer-1", "displayName": "Test Customer", "numberOfOrders": "4"},
            "shippingAddress": {"firstName": "Test", "lastName": "Customer", "phone": "0612345678",
                                "address1": "Street", "address2": "Flat 1", "city": "Rabat", "country": "Morocco"},
            "billingAddress": {"address1": "Different billing address"},
            "shippingLine": {"title": "Delivery", "originalPriceSet": money("20")},
            "subtotalPriceSet": money("180"), "totalShippingPriceSet": money("20"),
            "totalTaxSet": money("0"), "totalDiscountsSet": money("20"), "totalPriceSet": money("200"),
            "lineItems": {"nodes": [line_node()], "pageInfo": {"hasNextPage": False}},
            "appliedDiscount": None, "taxExempt": True, "taxesIncluded": True,
            "transformerFingerprint": "fingerprint", "order": None, **changes}


def update_body(changes, **overrides):
    return d.DraftUpdateBody(store="irranova", draft_id=DRAFT, expected_updated_at=UPDATED,
                             changes=changes, **overrides)


def complete_body(**overrides):
    return d.DraftCompleteBody(**{"store": "irranova", "draft_id": DRAFT, "expected_updated_at": UPDATED,
                                "client_action_id": "draft-complete-action-123", **overrides})


class DraftInputTests(unittest.TestCase):
    def test_all_routes_require_authentication(self):
        from backend.app.main import app
        client = TestClient(app)
        cases = [("get", "/api/agent/draft-orders?store=irranova", None),
                 ("get", "/api/agent/draft-orders/detail?store=irranova&draft_id=" + DRAFT, None),
                 ("post", "/api/agent/draft-orders/update", update_body({"note": "changed"}).model_dump(mode="json")),
                 ("post", "/api/agent/draft-orders/complete", complete_body().model_dump(mode="json"))]
        for method, url, body in cases:
            with self.subTest(url=url):
                response = getattr(client, method)(url, **({"json": body} if body else {}))
                self.assertEqual(response.status_code, 401)

    def test_sparse_contact_update_preserves_unmentioned_fields_and_clears_email(self):
        changes = d.DraftChanges(email="", shipping_address={"city": "Casa"})
        result = d.build_draft_update(draft_node(), changes)
        self.assertIsNone(result["email"])
        self.assertEqual(result["shippingAddress"]["city"], "Casa")
        self.assertEqual(result["shippingAddress"]["address2"], "Flat 1")
        for untouched in ["billingAddress", "paymentTerms", "taxExempt", "lineItems", "discountCodes", "shippingLine"]:
            self.assertNotIn(untouched, result)

    def test_retained_variant_preserves_discount_override_custom_fields_and_uuid(self):
        changes = d.DraftChanges(line_items=[{"id": LINE, "quantity": 3}])
        result = d.build_draft_update(draft_node(), changes)
        line = result["lineItems"][0]
        self.assertEqual(line["quantity"], 3)
        self.assertEqual(line["uuid"], "stable-line-uuid")
        self.assertEqual(line["customAttributes"], [{"key": "engraving", "value": "Keep me"}])
        self.assertEqual(line["appliedDiscount"]["value"], 10)
        self.assertEqual(line["appliedDiscount"]["description"], "Keep discount")
        self.assertEqual(line["priceOverride"], {"amount": "100", "currencyCode": "MAD"})
        self.assertEqual(result["transformerFingerprint"], "fingerprint")

    def test_retained_custom_item_preserves_price_shipping_tax_weight_and_fixed_discount(self):
        custom = line_node(custom=True, variant=None, requiresShipping=False, taxable=False,
                           originalUnitPriceWithCurrency={"amount": "100", "currencyCode": "MAD"},
                           weight={"value": 2, "unit": "KILOGRAMS"},
                           appliedDiscount={"title": "Gift", "value": 5, "valueType": "FIXED_AMOUNT", "amountSet": money("10")})
        result = d.build_draft_update(draft_node(lineItems={"nodes": [custom]}), d.DraftChanges(line_items=[{"id": LINE, "quantity": 1}]))
        line = result["lineItems"][0]
        self.assertEqual(line["originalUnitPriceWithCurrency"], {"amount": "100", "currencyCode": "MAD"})
        self.assertFalse(line["taxable"])
        self.assertFalse(line["requiresShipping"])
        self.assertEqual(line["weight"], {"value": 2, "unit": "KILOGRAMS"})
        self.assertEqual(line["appliedDiscount"]["value"], 5)
        self.assertNotIn("amountWithCurrency", line["appliedDiscount"])

    def test_remove_add_variant_and_custom_in_one_full_replacement(self):
        result = d.build_draft_update(draft_node(), d.DraftChanges(line_items=[
            {"variant_id": VARIANT, "quantity": 1}, {"title": "Custom item", "unit_price": "12.50", "quantity": 2}]))
        self.assertEqual(len(result["lineItems"]), 2)
        self.assertNotIn("appliedDiscount", result["lineItems"][0])
        self.assertEqual(result["lineItems"][1]["originalUnitPriceWithCurrency"], {"amount": "12.50", "currencyCode": "MAD"})

    def test_rejects_invalid_discounts_prices_lines_and_fields(self):
        cases = [{"applied_discount": {"title": "Bad", "value": "101", "value_type": "PERCENTAGE"}},
                 {"shipping_line": {"title": "Ship", "price": "NaN"}},
                 {"line_items": [{"id": "other-draft-line", "quantity": 1}]},
                 {"line_items": [{"id": LINE, "quantity": 1}, {"id": LINE, "quantity": 2}]},
                 {"line_items": [{"id": LINE, "quantity": 1, "title": "Unexpected"}]},
                 {"line_items": [{"variant_id": "not-a-variant", "quantity": 1}]},
                 {"line_items": [{"title": "Custom", "unit_price": "-1", "quantity": 1}]}]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(HTTPException):
                d.build_draft_update(draft_node(), d.DraftChanges(**case))
        for case in [{"line_items": []}, {"line_items": [{"id": LINE, "quantity": True}]}, {"status": "COMPLETED"}]:
            with self.subTest(case=case), self.assertRaises(ValidationError):
                d.DraftChanges(**case)

    def test_explicit_order_discount_removal_and_shipping_use_draft_currency(self):
        result = d.build_draft_update(draft_node(), d.DraftChanges(applied_discount=None, shipping_line={"title": "Express", "price": "35"}))
        self.assertIsNone(result["appliedDiscount"])
        self.assertEqual(result["shippingLine"], {"title": "Express", "shippingRateHandle": None,
                                                 "priceWithCurrency": {"amount": "35.00", "currencyCode": "MAD"}})

    def test_tag_edits_preserve_original_case_and_trim_duplicates(self):
        result = d.build_draft_update(draft_node(), d.DraftChanges(tags=["VIP Customer", "AgentOne", " vip customer ", "New Tag"]))
        self.assertEqual(result["tags"], ["VIP Customer", "AgentOne", "New Tag"])

    def test_normalization_uses_presentment_totals_and_order_shape(self):
        node = draft_node(order=order_node())
        node["totalPriceSet"]["shopMoney"]["amount"] = "999"
        result = d.normalize_draft(node)
        self.assertEqual(result["total_price"], "200")
        self.assertEqual(result["line_items"][0]["applied_discount"]["value_type"], "PERCENTAGE")
        self.assertEqual(result["customer"]["orders_count"], 4)
        self.assertEqual(result["order"]["financial_status"], "PENDING")

    def test_date_status_and_tag_filters_are_server_side_and_dates_inclusive(self):
        query = d.build_draft_query("Hoodie OR customer_id:123", "INVOICE_SENT", "2026-10-01", "2026-10-15", "agent tag")
        self.assertIn("(Hoodie OR customer_id:123) AND status:INVOICE_SENT", query)
        self.assertIn("2026-10-16T00:00:00", query)
        self.assertIn('tag:"agent tag"', query)
        for args in [("", "PAID", "", "", ""), ("", "", "bad", "", ""), ("", "", "2026-10-16", "2026-10-15", "")]:
            with self.assertRaises(HTTPException):
                d.build_draft_query(*args)


class DraftApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.user = User(id="draft-agent", email="draft@example.com", password_hash="unused", role="agent", is_active=True, agent_tags=["agent-1"])
        async with self.sessions() as db:
            db.add(self.user)
            await db.commit()
        self.node = draft_node()
        self.calls = []
        self.graphql = AsyncMock(side_effect=self.respond)
        self.shopify_patch = patch("backend.app.main.shopify_graphql", self.graphql)
        self.shopify_patch.start()
        self.addCleanup(self.shopify_patch.stop)
        self.overlay_patch = patch("backend.app.confirmation_routes._RECENT_TAG_ADDS", {})
        self.overlay_patch.start()
        self.addCleanup(self.overlay_patch.stop)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def respond(self, query, variables, **kwargs):
        self.calls.append((query, variables, kwargs))
        if query == d.DRAFT_DETAIL_GQL:
            return {"draftOrder": deepcopy(self.node)}
        if query == d.DRAFT_STOCK_GQL:
            return {"nodes": [{"id": VARIANT, "inventoryQuantity": 0, "inventoryItem": {"tracked": True}}]}
        if query == d.DRAFT_UPDATE_GQL:
            self.node["updatedAt"] = NEXT
            self.node["note2"] = variables["input"].get("note", self.node["note2"])
            self.node["totalPriceSet"] = money("333")
            return {"draftOrderUpdate": {"draftOrder": {"id": DRAFT, "updatedAt": NEXT}, "userErrors": []}}
        if query == d.DRAFT_TAGS_GQL:
            self.node["tags"] += variables["tags"]
            return {"tagsAdd": {"node": {"id": DRAFT}, "userErrors": []}}
        if query == d.DRAFT_COMPLETE_GQL:
            self.node.update(status="COMPLETED", updatedAt=NEXT, order=order_node())
            return {"draftOrderComplete": {"draftOrder": {"id": DRAFT, "order": {"id": order_node()["id"]}}, "userErrors": []}}
        raise AssertionError("Unexpected query")

    async def events(self):
        async with self.sessions() as db:
            return (await db.scalars(select(OrderEvent))).all()

    async def test_list_supports_actual_global_sorts_and_backward_cursors(self):
        self.graphql.side_effect = None
        self.graphql.return_value = {"shop": {"currencyCode": "MAD"}, "draftOrders": {"nodes": [draft_node()],
            "pageInfo": {"hasNextPage": True, "hasPreviousPage": True, "startCursor": "start", "endCursor": "end"}}}
        result = await d.list_confirmation_drafts(store="irranova", q="hoodie", status="OPEN", sort_key="CUSTOMER_NAME", before="previous", first=20)
        variables = self.graphql.await_args.args[1]
        self.assertEqual(variables["last"], 20)
        self.assertIsNone(variables["first"])
        self.assertEqual(variables["sortKey"], "CUSTOMER_NAME")
        self.assertEqual(result["page_info"], {"has_next_page": True, "has_previous_page": True, "start_cursor": "start", "end_cursor": "end"})
        for sort in ["PO_NUMBER", "CREATED_AT", "RELEVANCE"]:
            with self.assertRaises(HTTPException):
                await d.list_confirmation_drafts(store="irranova", sort_key=sort)
        with self.assertRaises(HTTPException):
            await d.list_confirmation_drafts(store="irranova", after="a", before="b")

    async def test_detail_loads_all_line_pages_and_inventory_is_optional(self):
        self.node["lineItems"]["pageInfo"] = {"hasNextPage": True, "endCursor": "next-lines"}
        original = self.respond
        async def respond(query, variables, **kwargs):
            if query == d.DRAFT_LINES_GQL:
                return {"draftOrder": {"id": DRAFT, "updatedAt": UPDATED, "lineItems": {
                    "nodes": [line_node(id="last-line")], "pageInfo": {"hasNextPage": False}}}}
            if query == d.DRAFT_STOCK_GQL:
                raise HTTPException(502, "Access denied for inventoryItem field. read_inventory")
            return await original(query, variables, **kwargs)
        self.graphql.side_effect = respond
        result = await d.get_confirmation_draft(store="irranova", draft_id=DRAFT)
        self.assertEqual(len(result["draft"]["line_items"]), 2)
        self.assertIsNone(result["draft"]["line_items"][0]["available_quantity"])
        self.assertTrue(result["draft"]["stock_warnings"])

    async def test_detail_has_known_zero_stock_without_false_zero_unknowns(self):
        result = await d.get_confirmation_draft(store="irranova", draft_id=DRAFT)
        self.assertTrue(result["draft"]["line_items"][0]["inventory_tracked"])
        self.assertEqual(result["draft"]["line_items"][0]["available_quantity"], 0)

    async def test_changed_or_incomplete_line_pagination_refuses_edit(self):
        self.node["lineItems"]["pageInfo"] = {"hasNextPage": True, "endCursor": "next-lines"}
        for result in [{"draftOrder": {"updatedAt": NEXT, "lineItems": {"nodes": []}}},
                       {"draftOrder": {"updatedAt": UPDATED}}]:
            self.graphql.side_effect = [ {"draftOrder": deepcopy(self.node)}, result ]
            with self.assertRaises(HTTPException):
                await d._fetch_draft("irranova", DRAFT)

    async def test_sparse_update_audits_actor_store_returns_shopify_totals_and_disables_retries(self):
        async with self.sessions() as db:
            result = await d.update_confirmation_draft(update_body({"note": "Saved"}), user=self.user, db=db)
        write = next(c for c in self.calls if c[0] == d.DRAFT_UPDATE_GQL)
        self.assertEqual(write[1]["input"], {"note": "Saved"})
        self.assertFalse(write[2]["retry_safe"])
        self.assertEqual(write[2]["api_version"], "2026-01")
        self.assertEqual(result["draft"]["total_price"], "333")
        events = await self.events()
        self.assertEqual(events[0].user_id, self.user.id)
        self.assertEqual(events[0].store_key, "irranova")
        self.assertEqual(events[0].event_metadata["state"], "complete")

    async def test_stale_update_and_complete_have_definite_preflight_error_without_write(self):
        self.node["updatedAt"] = NEXT
        for op, body in [(d.update_confirmation_draft, update_body({"note": "Lost change"})), (d.complete_confirmation_draft, complete_body())]:
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await op(body, user=self.user, db=db)
                self.assertEqual(error.exception.status_code, 409)
                self.assertEqual(error.exception.detail["code"], "draft_changed")
                self.assertTrue(error.exception.detail["safe_to_edit"])
        self.assertFalse(await self.events())
        self.assertTrue(all(c[0] == d.DRAFT_DETAIL_GQL for c in self.calls))

    async def test_not_ready_completion_has_definite_preflight_error(self):
        self.node["ready"] = False
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await d.complete_confirmation_draft(complete_body(), user=self.user, db=db)
        self.assertTrue(error.exception.detail["safe_to_edit"])
        self.assertFalse(await self.events())

    async def test_native_complete_is_pending_assigns_additively_and_replays_without_mutation(self):
        async with self.sessions() as db:
            first = await d.complete_confirmation_draft(complete_body(), user=self.user, db=db)
        async with self.sessions() as db:
            replay = await d.complete_confirmation_draft(complete_body(), user=self.user, db=db)
        self.assertFalse(first["deduped"])
        self.assertTrue(replay["deduped"])
        self.assertEqual(first["order"]["financial_status"], "PENDING")
        tags = next(c for c in self.calls if c[0] == d.DRAFT_TAGS_GQL)
        self.assertEqual(tags[1]["tags"], ["agent-1"])
        self.assertEqual(self.node["tags"], ["original", "cod 10/14", "agent-1"])
        writes = [c for c in self.calls if c[0] == d.DRAFT_COMPLETE_GQL]
        self.assertEqual(len(writes), 1)
        self.assertFalse(writes[0][2]["retry_safe"])
        self.assertIn("paymentPending: true", writes[0][0])
        self.assertNotIn("draftOrderInvoiceSend", "".join(c[0] for c in self.calls))
        events = await self.events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].action, "draft_complete")
        self.assertEqual(events[0].order_gid, order_node()["id"])

    async def test_already_completed_draft_returns_order_even_with_stale_version(self):
        self.node.update(order=order_node(), status="COMPLETED", updatedAt=NEXT)
        async with self.sessions() as db:
            result = await d.complete_confirmation_draft(complete_body(), user=self.user, db=db)
        self.assertTrue(result["deduped"])
        self.assertTrue(all(c[0] == d.DRAFT_DETAIL_GQL for c in self.calls))

    async def test_timeout_is_never_recompleted_and_later_linked_order_recovers(self):
        original = self.respond
        async def respond(query, variables, **kwargs):
            if query == d.DRAFT_COMPLETE_GQL:
                self.calls.append((query, variables, kwargs))
                raise HTTPException(502, "ReadTimeout")
            return await original(query, variables, **kwargs)
        self.graphql.side_effect = respond
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await d.complete_confirmation_draft(complete_body(), user=self.user, db=db)
        self.assertEqual(error.exception.detail["code"], "completion_uncertain")
        for body in [complete_body(), complete_body(client_action_id="another-complete-action")]:
            async with self.sessions() as db:
                with self.assertRaises(HTTPException):
                    await d.complete_confirmation_draft(body, user=self.user, db=db)
        self.node.update(order=order_node(), status="COMPLETED", updatedAt=NEXT)
        async with self.sessions() as db:
            result = await d.complete_confirmation_draft(complete_body(), user=self.user, db=db)
        self.assertTrue(result["deduped"])
        self.assertEqual(sum(c[0] == d.DRAFT_COMPLETE_GQL for c in self.calls), 1)

    async def test_other_actor_or_store_cannot_reuse_completion_action(self):
        async with self.sessions() as db:
            await d.complete_confirmation_draft(complete_body(), user=self.user, db=db)
        for body, user in [(complete_body(), User(id="another", role="agent")), (complete_body(store="irrakids"), self.user)]:
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await d.complete_confirmation_draft(body, user=user, db=db)
                self.assertEqual(error.exception.status_code, 409)

    async def test_validation_rejection_clears_completion_intent(self):
        original = self.respond
        async def respond(query, variables, **kwargs):
            if query == d.DRAFT_COMPLETE_GQL:
                return {"draftOrderComplete": {"userErrors": [{"field": ["id"], "message": "No stock"}]}}
            return await original(query, variables, **kwargs)
        self.graphql.side_effect = respond
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await d.complete_confirmation_draft(complete_body(), user=self.user, db=db)
        self.assertEqual(error.exception.status_code, 422)
        self.assertFalse(await self.events())

    async def test_pending_or_uncertain_save_blocks_both_update_and_completion(self):
        for state in ["pending", "uncertain"]:
            async with self.sessions() as db:
                event = OrderEvent(user_id=self.user.id, order_gid=DRAFT, order_number="#D101", store_key="irranova",
                                   action="draft_update", event_metadata={"state": state, "expected_updated_at": UPDATED})
                db.add(event)
                await db.commit()
            for op, body in [(d.update_confirmation_draft, update_body({"note": "New"})), (d.complete_confirmation_draft, complete_body())]:
                async with self.sessions() as db:
                    with self.assertRaises(HTTPException) as error:
                        await op(body, user=self.user, db=db)
                    self.assertEqual(error.exception.detail["code"], "draft_save_pending")
            async with self.sessions() as db:
                await db.delete(await db.get(OrderEvent, event.id))
                await db.commit()
        self.assertTrue(all(c[0] == d.DRAFT_DETAIL_GQL for c in self.calls))

    async def test_missing_scope_error_is_read_or_write_specific(self):
        for write, scope in [(False, "read_draft_orders"), (True, "write_draft_orders")]:
            self.graphql.side_effect = HTTPException(502, "Access denied for draftOrder field")
            with self.assertRaises(HTTPException) as error:
                await d._graphql(d.DRAFT_DETAIL_GQL, {"id": DRAFT}, store="irranova", write=write)
            self.assertEqual(error.exception.status_code, 403)
            self.assertIn(scope, error.exception.detail)


if __name__ == "__main__":
    unittest.main()
