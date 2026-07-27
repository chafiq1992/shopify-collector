import unittest

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


if __name__ == "__main__":
    unittest.main()
