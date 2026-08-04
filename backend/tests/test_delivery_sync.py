import unittest

from backend.app.delivery_sync import merchant_id_for_store, sync_fulfilled_order_to_delivery


class _Response:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class _Client:
    def __init__(self, responses, calls, **_kwargs):
        self.responses = responses
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


class DeliverySyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_until_delivery_enqueues_order(self):
        calls = []
        responses = [
            _Response({"fetched": 1, "results": [{"outcome": {"ignored": True}}]}),
            _Response({"fetched": 1, "results": [{"outcome": {"enqueued": True}}]}),
        ]
        sleeps = []

        result = await sync_fulfilled_order_to_delivery(
            delivery_url="https://delivery.example",
            admin_token="test-token",
            store_key="irranova",
            order_number="#81338",
            client_factory=lambda **kwargs: _Client(responses, calls, **kwargs),
            sleep=lambda delay: _record_sleep(sleeps, delay),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["attempt"], 2)
        self.assertEqual(sleeps, [1.0])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0], "https://delivery.example/admin/shopify/backfill")
        self.assertEqual(calls[0][1]["headers"], {"X-Admin-Token": "test-token"})
        self.assertEqual(calls[0][1]["json"]["merchant_id"], 9)
        self.assertEqual(calls[0][1]["json"]["order_names"], ["81338"])

    async def test_skips_when_delivery_is_not_configured(self):
        result = await sync_fulfilled_order_to_delivery(
            delivery_url="",
            admin_token="",
            store_key="irranova",
            order_number="81338",
        )
        self.assertEqual(result, {"ok": False, "reason": "not_configured"})

    def test_store_mapping(self):
        self.assertEqual(merchant_id_for_store("irrakids"), 7)
        self.assertEqual(merchant_id_for_store("irranova"), 9)
        self.assertIsNone(merchant_id_for_store("unknown"))


async def _record_sleep(sleeps, delay):
    sleeps.append(delay)


if __name__ == "__main__":
    unittest.main()
