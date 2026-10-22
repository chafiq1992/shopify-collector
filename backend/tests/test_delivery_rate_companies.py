import asyncio
from types import SimpleNamespace

import pytest

from backend.app import delivery_rate_routes, main


@pytest.mark.parametrize("companies", [None, "ibex,casa"])
def test_casa_orders_are_included_in_report_and_overall(monkeypatch, companies):
    async def orders(store, start, end):
        assert (store, start, end) == ("irranova", "2026-10-16", "2026-10-22")
        return [
            SimpleNamespace(tags=["casa"], financial_status="PAID", return_status=None),
            SimpleNamespace(tags=[" Casa "], financial_status="PENDING", return_status=None),
            SimpleNamespace(tags=["CASA"], financial_status="PAID", return_status="RETURNED"),
            SimpleNamespace(tags=["ibex"], financial_status="PAID", return_status=None),
            SimpleNamespace(tags=["casablanca"], financial_status="PAID", return_status=None),
        ]

    monkeypatch.setattr(main, "fetch_fulfilled_orders_in_range", orders)
    monkeypatch.setattr(delivery_rate_routes, "_cache", {})
    report = asyncio.run(delivery_rate_routes.delivery_rate(
        date_from="2026-10-16", date_to="2026-10-22", store="irranova", companies=companies,
    ))
    casa = next(row for row in report["companies"] if row["company"] == "casa")
    assert casa == {
        "company": "casa", "fulfilled": 3, "delivered": 1,
        "returned": 1, "pending_payment": 1, "rate": 33.3,
    }
    assert report["unassigned_fulfilled"] == 1
    assert report["overall"] == {"fulfilled": 4, "delivered": 2, "rate": 50.0}


def test_casa_still_appears_when_date_range_has_no_orders(monkeypatch):
    async def orders(*_args):
        return []

    monkeypatch.setattr(main, "fetch_fulfilled_orders_in_range", orders)
    monkeypatch.setattr(delivery_rate_routes, "_cache", {})
    report = asyncio.run(delivery_rate_routes.delivery_rate(
        date_from="2026-10-16", date_to="2026-10-22", store="irranova", companies=None,
    ))
    casa = next(row for row in report["companies"] if row["company"] == "casa")
    assert casa["fulfilled"] == 0
    assert casa["rate"] is None
