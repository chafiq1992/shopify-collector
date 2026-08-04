import os


os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from backend.app.inventory_helper_routes import _line_items_from_shopify, _status


def test_inventory_status_waiting_match_and_mismatch():
    assert _status(3, 24, None, None) == "waiting"
    assert _status(3, 24, 3, 24) == "matched"
    assert _status(0, 24, 3, 24) == "matched"
    assert _status(3, 24, 2, 24) == "mismatch"
    assert _status(3, 24, 3, 25) == "mismatch"


def test_shopify_transfer_line_items_become_editable_order_quantities():
    transfer = {
        "lineItems": {
            "nodes": [
                {
                    "id": "gid://shopify/InventoryTransferLineItem/1",
                    "title": "Classic crate",
                    "totalQuantity": 12,
                    "inventoryItem": {
                        "id": "gid://shopify/InventoryItem/3",
                        "sku": "BLUE-M",
                        "variant": {
                            "id": "gid://shopify/ProductVariant/2",
                            "title": "Blue / M",
                            "image": {"url": "https://cdn.example.test/blue.jpg", "altText": "Blue item"},
                            "product": {"title": "Classic crate"},
                        },
                    },
                }
            ]
        }
    }

    items = _line_items_from_shopify(transfer)

    assert items == [
        {
            "id": "gid://shopify/InventoryTransferLineItem/1",
            "variant_id": "gid://shopify/ProductVariant/2",
            "title": "Classic crate",
            "variant_title": "Blue / M",
            "sku": "BLUE-M",
            "image_url": "https://cdn.example.test/blue.jpg",
            "image_alt": "Blue item",
            "shopify_quantity": 12,
            "ordered_quantity": 12,
        }
    ]
