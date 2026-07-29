import unittest
from datetime import datetime, timedelta, timezone

from backend.app.confirmation_routes import _aggregate_intake_cohorts
from backend.app.main import _tag_write_audit_action


class ConfirmationAttributionTests(unittest.TestCase):
    def test_confirmation_agent_add_is_counted(self):
        self.assertEqual(
            _tag_write_audit_action(
                tag="cod 27/07/26",
                op="add",
                source="confirmation",
                user_role="agent",
            ),
            "confirmation_confirmed",
        )
        self.assertEqual(
            _tag_write_audit_action(
                tag="n2",
                op="add",
                source="confirmation",
                user_role="agent",
            ),
            "confirmation_phone_n2",
        )

    def test_collector_cod_tag_is_not_confirmation_credit(self):
        self.assertEqual(
            _tag_write_audit_action(
                tag="cod 27/07/26",
                op="add",
                source="confirmation",
                user_role="collector",
            ),
            "confirmation_tag_add",
        )

    def test_shared_tag_endpoint_without_source_is_not_confirmation_credit(self):
        self.assertEqual(
            _tag_write_audit_action(
                tag="cod 27/07/26",
                op="add",
                source=None,
                user_role="agent",
            ),
            "confirmation_tag_add",
        )

    def test_tag_removal_never_counts_as_contact_attempt(self):
        self.assertEqual(
            _tag_write_audit_action(
                tag="n1",
                op="remove",
                source="confirmation",
                user_role="agent",
            ),
            "confirmation_tag_remove",
        )

    def test_get_more_orders_cohorts_follow_outcomes_and_next_stage(self):
        started = datetime(2026, 7, 20, tzinfo=timezone.utc)
        pulls = [
            {
                "id": 1,
                "user_id": "agent-1",
                "order_gid": "order-1",
                "store_key": "irranova",
                "created_at": started,
                "level": "new",
            },
            {
                "id": 4,
                "user_id": "agent-1",
                "order_gid": "order-2",
                "store_key": "irranova",
                "created_at": started,
                "level": "n1",
            },
            {
                "id": 7,
                "user_id": "agent-1",
                "order_gid": "order-3",
                "store_key": "irranova",
                "created_at": started,
                "level": "n3",
            },
        ]
        followups = [
            {
                "id": 2,
                "user_id": "agent-1",
                "order_gid": "order-1",
                "store_key": "irranova",
                "created_at": started + timedelta(minutes=1),
                "action": "confirmation_phone_n1",
            },
            {
                "id": 3,
                "user_id": "agent-1",
                "order_gid": "order-1",
                "store_key": "irranova",
                "created_at": started + timedelta(minutes=2),
                "action": "confirmation_confirmed",
            },
            {
                "id": 5,
                "user_id": "agent-1",
                "order_gid": "order-2",
                "store_key": "irranova",
                "created_at": started + timedelta(minutes=1),
                "action": "confirmation_phone_n2",
            },
            {
                "id": 6,
                "user_id": "agent-1",
                "order_gid": "order-2",
                "store_key": "irranova",
                "created_at": started + timedelta(minutes=2),
                "action": "confirmation_cancelled",
            },
            {
                "id": 8,
                "user_id": "agent-1",
                "order_gid": "order-3",
                "store_key": "irranova",
                "created_at": started + timedelta(minutes=1),
                "action": "confirmation_phone_n4",
            },
        ]

        by_user, summary = _aggregate_intake_cohorts(
            pulls, followups, ["agent-1"]
        )

        self.assertEqual(summary["total_taken"], 3)
        self.assertEqual(summary["confirmed"], 1)
        self.assertEqual(summary["cancelled"], 1)
        self.assertEqual(summary["open"], 1)
        self.assertEqual(by_user["agent-1"]["cohorts"]["new"]["advanced"], 1)
        self.assertEqual(by_user["agent-1"]["cohorts"]["new"]["confirmed"], 1)
        self.assertEqual(by_user["agent-1"]["cohorts"]["n1"]["advanced"], 1)
        self.assertEqual(by_user["agent-1"]["cohorts"]["n1"]["cancelled"], 1)
        self.assertEqual(by_user["agent-1"]["cohorts"]["n3"]["advanced"], 1)

    def test_repull_moves_later_outcome_to_latest_intake_owner(self):
        started = datetime(2026, 7, 20, tzinfo=timezone.utc)
        pulls = [
            {
                "id": 1,
                "user_id": "agent-1",
                "order_gid": "order-1",
                "store_key": "irranova",
                "created_at": started,
                "level": "new",
            },
            {
                "id": 3,
                "user_id": "agent-2",
                "order_gid": "order-1",
                "store_key": "irranova",
                "created_at": started + timedelta(minutes=2),
                "level": "n1",
            },
        ]
        followups = [
            {
                "id": 2,
                "user_id": "agent-1",
                "order_gid": "order-1",
                "store_key": "irranova",
                "created_at": started + timedelta(minutes=1),
                "action": "confirmation_phone_n1",
            },
            {
                "id": 4,
                "user_id": "agent-1",
                "order_gid": "order-1",
                "store_key": "irranova",
                "created_at": started + timedelta(minutes=3),
                "action": "confirmation_confirmed",
            },
        ]

        by_user, _summary = _aggregate_intake_cohorts(
            pulls, followups, ["agent-1", "agent-2"]
        )

        self.assertEqual(by_user["agent-1"]["cohorts"]["new"]["advanced"], 1)
        self.assertEqual(by_user["agent-1"]["cohorts"]["new"]["confirmed"], 0)
        self.assertEqual(by_user["agent-2"]["cohorts"]["n1"]["confirmed"], 1)


if __name__ == "__main__":
    unittest.main()
