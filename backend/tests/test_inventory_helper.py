import os


os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from backend.app.inventory_helper_routes import _line_items_from_shopify, _status


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
