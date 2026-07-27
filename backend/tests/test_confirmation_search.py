import os
import unittest
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from backend.app.confirmation_routes import (
    SEARCH_CUSTOMERS_GQL,
    _classify_confirmation_search,
    _confirmation_phone_variants,
    _same_client_action,
)


class ConfirmationSearchTests(unittest.TestCase):
    def test_moroccan_phone_formats_share_one_canonical_number(self):
        values = [
            "+212 614 162-654",
            "00212 614162654",
            "0614162654",
            "614162654",
            "06/14/16/26/54",
        ]
        details = [_confirmation_phone_variants(value) for value in values]

        self.assertEqual(
            {item["normalized_phone"] for item in details},
            {"+212614162654"},
        )
        for item in details:
            self.assertIn("+212614162654", item["variants"])
            self.assertIn("0614162654", item["variants"])

    def test_short_numeric_input_takes_direct_order_path(self):
        result = _classify_confirmation_search("71779")

        self.assertEqual(result["kind"], "order")
        self.assertIn("name:71779", result["order_query"])
        self.assertNotIn("phone:", result["order_query"])

    def test_hash_prefix_forces_order_number_lookup(self):
        result = _classify_confirmation_search("#71779")

        self.assertEqual(result["kind"], "order")
        self.assertEqual(result["digits"], "71779")

    def test_phone_search_uses_exact_supported_customer_filters(self):
        result = _classify_confirmation_search("+212 614 162-654")

        self.assertEqual(result["kind"], "phone")
        self.assertEqual(result["normalized_phone"], "+212614162654")
        self.assertIn("phone:+212614162654", result["customer_query"])
        self.assertNotIn("*", result["customer_query"])

    def test_customer_search_fetches_order_history_in_same_query(self):
        self.assertIn("orders(first: $ordersFirst", SEARCH_CUSTOMERS_GQL)
        self.assertIn("sortKey: CREATED_AT", SEARCH_CUSTOMERS_GQL)


class ConfirmationActionIdempotencyTests(unittest.TestCase):
    def test_same_client_action_must_match_actor_and_payload(self):
        event = SimpleNamespace(
            user_id="agent-1",
            order_gid="gid://shopify/Order/42",
            store_key="irranova",
            event_metadata={"tag": "N1", "op": "add"},
        )

        self.assertTrue(
            _same_client_action(
                event,
                user_id="agent-1",
                order_id="gid://shopify/Order/42",
                store_key="irranova",
                tag="n1",
                op="add",
            )
        )
        self.assertFalse(
            _same_client_action(
                event,
                user_id="agent-2",
                order_id="gid://shopify/Order/42",
                store_key="irranova",
                tag="n1",
                op="add",
            )
        )


if __name__ == "__main__":
    unittest.main()
