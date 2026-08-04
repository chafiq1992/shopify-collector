import asyncio
import os


os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi import HTTPException
from sqlalchemy import func, select

from backend.app import main
from backend.app.db import SessionLocal, init_db
from backend.app.inventory_helper_routes import _day_bounds, _line_items_from_shopify, _status, sync_shopify_day
from backend.app.models import InventoryReceipt, User


def test_inventory_status_waiting_match_and_mismatch():
    assert _status(3, 24, None, None) == "waiting"
    assert _status(3, 24, 3, 24) == "matched"
    assert _status(0, 24, 3, 24) == "matched"
    assert _status(3, 24, 2, 24) == "mismatch"
    assert _status(3, 24, 3, 25) == "mismatch"


def test_shopify_line_items_become_editable_order_quantities():
    order = {
        "lineItems": {
            "nodes": [
                {
                    "id": "gid://shopify/LineItem/1",
                    "name": "Classic crate - Blue / M",
                    "sku": "BLUE-M",
                    "quantity": 12,
                    "image": {"url": "https://cdn.example.test/blue.jpg", "altText": "Blue item"},
                    "variant": {"id": "gid://shopify/ProductVariant/2", "title": "Blue / M"},
                }
            ]
        }
    }

    items = _line_items_from_shopify(order)

    assert items == [
        {
            "id": "gid://shopify/LineItem/1",
            "variant_id": "gid://shopify/ProductVariant/2",
            "title": "Classic crate - Blue / M",
            "variant_title": "Blue / M",
            "sku": "BLUE-M",
            "image_url": "https://cdn.example.test/blue.jpg",
            "image_alt": "Blue item",
            "shopify_quantity": 12,
            "ordered_quantity": 12,
        }
    ]


def test_day_bounds_builds_an_exclusive_shopify_date_range():
    assert _day_bounds("2026-08-03") == ("2026-08-03", "2026-08-04")


def test_day_bounds_rejects_invalid_dates():
    try:
        _day_bounds("03/08/2026")
    except HTTPException as exc:
        assert exc.status_code == 400
    else:
        raise AssertionError("Expected invalid date to be rejected")


def test_sync_day_imports_shopify_orders_only_once(monkeypatch):
    async def fake_shopify_graphql(query, variables, *, store):
        assert "created_at:>=2026-08-03" in variables["query"]
        return {
            "orders": {
                "nodes": [
                    {
                        "id": "gid://shopify/Order/9001",
                        "name": "#9001",
                        "poNumber": "PO-9001",
                        "createdAt": "2026-08-03T11:20:00Z",
                        "lineItems": {
                            "nodes": [
                                {
                                    "id": "gid://shopify/LineItem/91",
                                    "name": "Blue crate",
                                    "sku": "BLUE",
                                    "quantity": 18,
                                    "image": {"url": "https://cdn.example.test/blue.jpg", "altText": "Blue"},
                                    "variant": {"id": "gid://shopify/ProductVariant/91", "title": "Blue"},
                                }
                            ]
                        },
                    }
                ],
                "pageInfo": {"hasNextPage": False, "endCursor": None},
            }
        }

    monkeypatch.setattr(main, "shopify_graphql", fake_shopify_graphql)

    async def scenario():
        await init_db()
        async with SessionLocal() as db:
            user = User(id="inventory-test-user", email="inventory-test@example.test", password_hash="x", role="agent")
            db.add(user)
            await db.commit()
            first = await sync_shopify_day(date="2026-08-03", store="irrakids", db=db, user=user)
            second = await sync_shopify_day(date="2026-08-03", store="irrakids", db=db, user=user)
            count = await db.scalar(select(func.count()).select_from(InventoryReceipt))
            assert first["imported_count"] == 1
            assert first["receipts"][0]["expected_items"] == 18
            assert second["imported_count"] == 0
            assert count == 1

    asyncio.run(scenario())
