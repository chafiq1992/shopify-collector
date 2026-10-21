import unittest

from backend.app.delivery_sync import (
    check_label_readiness,
    delivery_store_keys,
    find_delivery_order,
    list_unsent_queue_rows,
    merchant_id_for_store,
    prepare_delivery_label,
    sync_fulfilled_order_to_delivery,
)


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


class _RoutedClient:
    """Answers by (method, path suffix); records every call."""

    def __init__(self, routes, calls, **_kwargs):
        self.routes = routes
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def _answer(self, method, url, kwargs):
        self.calls.append((method, url, kwargs))
        for (m, suffix), responses in self.routes.items():
            if m == method and url.endswith(suffix):
                return responses.pop(0) if isinstance(responses, list) else responses
        raise AssertionError(f"unexpected {method} {url}")

    async def get(self, url, **kwargs):
        return self._answer("GET", url, kwargs)

    async def post(self, url, **kwargs):
        return self._answer("POST", url, kwargs)


def _label_routes(queue_items, assign=None):
    return {
        ("GET", "/ext/admin/merchant-queue/7"): _Response({"items": queue_items}),
        ("POST", "/ext/admin/merchant-notes/create"): _Response({"id": 900}),
        ("POST", "/ext/admin/merchant-notes/900/items"): _Response(
            {"results": [{"queueRowId": 55, "status": "added", "orderId": 4242}]}
        ),
        ("POST", "/ext/admin/envoy-notes/assign-order/4242"): assign
        or _Response({"orderId": 4242, "code": "ENV-1", "company": "Speedaf", "companyShort": "SPD"}),
    }


class PrepareDeliveryLabelTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, routes, calls, order="#167979"):
        return await prepare_delivery_label(
            delivery_url="https://delivery.example/",
            admin_token="test-token",
            store_key="irrakids",
            order_number=order,
            client_factory=lambda **kwargs: _RoutedClient(routes, calls, **kwargs),
            sleep=lambda delay: _record_sleep([], delay),
        )

    async def test_creates_order_and_assigns_envoy(self):
        calls = []
        row = {"id": 55, "orderName": "#167979", "status": "NEW (shopify)", "city": "Casablanca", "cityId": 1}
        other = {"id": 54, "orderName": "#167978", "status": "NEW (shopify)", "city": "Rabat", "cityId": 2}
        result = await self._run(_label_routes([other, row]), calls)

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["deliveryOrderId"], 4242)
        self.assertEqual(result["envoyCode"], "ENV-1")
        self.assertEqual(result["company"], "Speedaf")
        self.assertEqual(result["merchantId"], 7)
        self.assertEqual(result["queueRow"], row)
        self.assertEqual(calls[1][2]["params"], {"merchant_id": 7, "force_new": "true"})
        self.assertEqual(calls[2][2]["json"], {"ids": [55]})
        self.assertTrue(all(c[2]["headers"] == {"X-Admin-Token": "test-token"} for c in calls))

    async def test_leaves_error_rows_to_the_browser(self):
        calls = []
        rows = [{"id": 55, "orderName": "#167979", "status": "ERROR (city)", "hasError": True, "errorType": "city"}]
        result = await self._run(_label_routes(rows), calls)
        self.assertEqual(result, {"ok": False, "reason": "queue_row_error", "queueRowId": 55})
        self.assertEqual(len(calls), 1)

    async def test_unresolved_city_id_is_an_error_row(self):
        calls = []
        rows = [{"id": 55, "orderName": "167979", "status": "NEW", "city": "Casa", "cityId": None}]
        result = await self._run(_label_routes(rows), calls)
        self.assertEqual(result["reason"], "queue_row_error")

    async def test_missing_row_creates_nothing(self):
        calls = []
        result = await self._run(_label_routes([]), calls)
        self.assertEqual(result, {"ok": False, "reason": "not_in_queue"})
        self.assertEqual(len(calls), 1)

    async def test_envoy_not_ready_reports_the_created_order(self):
        calls = []
        rows = [{"id": 55, "orderName": "#167979", "status": "NEW", "city": "Casablanca", "cityId": 1}]
        routes = _label_routes(rows, assign=[_Response({}, 404), _Response({}, 404), _Response({}, 404)])
        result = await self._run(routes, calls)
        self.assertEqual(result, {"ok": False, "reason": "envoy_not_ready", "deliveryOrderId": 4242})


def _envoy_routes(envoy, note=None):
    routes = {("GET", "/ext/admin/envoy-notes/for-order/4242"): envoy}
    if note is not None:
        routes[("GET", "/admin/envoy-notes/EN-1")] = note
    return routes


def _note(company, partner_id, sent_ok, sent_msg=None, order_id=4242):
    return _Response({
        "code": "EN-1",
        "company": company,
        "partnerId": partner_id,
        "items": [{"orderId": order_id, "sentOk": sent_ok, "sentMsg": sent_msg}],
    })


class LabelReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def _check(self, routes, envoy_code="EN-1"):
        return await check_label_readiness(
            delivery_url="https://delivery.example",
            admin_token="test-token",
            delivery_order_id="4242",
            envoy_code=envoy_code,
            client_factory=lambda **kwargs: _RoutedClient(routes, [], **kwargs),
        )

    async def test_partner_company_must_accept_the_order(self):
        envoy = _Response({"code": "EN-1", "company": "glog", "companyShort": "GLOG"})
        accepted = await self._check(_envoy_routes(envoy, _note("glog", 24, True)))
        self.assertEqual(accepted, {"ok": True, "envoyCode": "EN-1", "company": "glog", "partnerApi": True})

        # A failed or never-attempted send is never printable, whatever the reason.
        refused = await self._check(_envoy_routes(envoy, _note("glog", 24, False, "City 'Ifrane' is not mapped")))
        self.assertEqual((refused["ok"], refused["status"], refused["reason"]), (False, 409, "not_accepted"))
        self.assertIn("City 'Ifrane' is not mapped", refused["message"])
        unsent = await self._check(_envoy_routes(envoy, _note("glog", 24, None)))
        self.assertEqual(unsent["reason"], "not_accepted")

    async def test_company_without_partner_api_needs_only_its_envoy(self):
        envoy = _Response({"code": "EN-1", "company": "Kech", "companyShort": "KECH"})
        result = await self._check(_envoy_routes(envoy, _note("Kech", None, False, "Partner not connected for this company")))
        self.assertEqual(result, {"ok": True, "envoyCode": "EN-1", "company": "Kech", "partnerApi": False})

    async def test_unassigned_missing_or_moved_envoy_is_refused(self):
        unassigned = await self._check(_envoy_routes(_Response({"code": "EN-1", "company": "Unassigned", "companyShort": "UNAS"})))
        self.assertEqual(unassigned["reason"], "unassigned")
        missing = await self._check(_envoy_routes(_Response({"detail": "Order not assigned"}, 404)))
        self.assertEqual((missing["status"], missing["reason"]), (409, "no_envoy"))
        moved = await self._check(_envoy_routes(_Response({"code": "EN-9", "company": "oscario"})), envoy_code="EN-1")
        self.assertEqual((moved["reason"], moved["envoyCode"], moved["company"]), ("envoy_moved", "EN-9", "oscario"))
        gone = await self._check(_envoy_routes(_Response({"code": "EN-1", "company": "glog"}), _note("glog", 24, True, order_id=1)))
        self.assertEqual(gone["reason"], "not_in_note")

    async def test_delivery_outage_is_retryable_not_a_refusal(self):
        down = await self._check(_envoy_routes(_Response({}, 502)))
        self.assertEqual((down["status"], down["reason"]), (503, "delivery_http_error"))

        class _Broken(_RoutedClient):
            async def get(self, url, **kwargs):
                raise ConnectionError("refused")

        broken = await check_label_readiness(
            delivery_url="https://delivery.example", admin_token="t", delivery_order_id="4242",
            client_factory=lambda **kwargs: _Broken({}, [], **kwargs),
        )
        self.assertEqual((broken["status"], broken["reason"]), (503, "delivery_request_failed"))
        unconfigured = await check_label_readiness(delivery_url="", admin_token="", delivery_order_id="4242")
        self.assertEqual(unconfigured["status"], 503)


class UnsentListTests(unittest.IsolatedAsyncioTestCase):
    async def test_lists_every_unsent_row_and_reports_unreadable_queues(self):
        calls = []
        routes = {
            ("GET", "/ext/admin/merchant-queue/7"): _Response({"items": [
                {"id": 73764, "orderName": "#173396", "status": "ERROR (city)", "errorType": "city",
                 "city": "Résidence Zineb, Ifrane", "cityRaw": "Résidence Zineb, Ifrane", "cityId": None,
                 "createdAt": "2026-10-13T16:34:03"},
                {"id": 73671, "orderName": "#82706", "status": "NEW (shopify)", "city": "Casablanca", "cityId": 35},
            ]}),
            ("GET", "/ext/admin/merchant-queue/9"): _Response({"detail": "boom"}, 500),
        }
        result = await list_unsent_queue_rows(
            delivery_url="https://delivery.example",
            admin_token="test-token",
            store_keys=delivery_store_keys(),
            client_factory=lambda **kwargs: _RoutedClient(routes, calls, **kwargs),
        )
        self.assertEqual(
            [(i["store"], i["orderNumber"], i["kind"], i["errorType"]) for i in result["items"]],
            [("irrakids", "173396", "queue_error", "city"), ("irrakids", "82706", "queue_new", None)],
        )
        self.assertEqual(result["errors"], [{"store": "irranova", "message": "Delivery queue returned HTTP 500"}])
        self.assertEqual(calls[0][2]["params"], {"limit": 1000})

    async def test_find_delivery_order_matches_the_exact_number(self):
        calls = []
        routes = {("GET", "/admin/orders"): _Response({"rows": [{"orderName": "#1733961"}, {"orderName": "#173396"}]})}
        result = await find_delivery_order(
            delivery_url="https://delivery.example", admin_token="t", store_key="irrakids", order_number="173396",
            client_factory=lambda **kwargs: _RoutedClient(routes, calls, **kwargs),
        )
        self.assertEqual(result, {"ok": True, "found": True})
        self.assertEqual(calls[0][2]["params"]["merchant_id"], 7)
        none = await find_delivery_order(
            delivery_url="https://delivery.example", admin_token="t", store_key="irrakids", order_number="17339",
            client_factory=lambda **kwargs: _RoutedClient(routes, [], **kwargs),
        )
        self.assertEqual(none, {"ok": True, "found": False})


async def _record_sleep(sleeps, delay):
    sleeps.append(delay)


if __name__ == "__main__":
    unittest.main()
