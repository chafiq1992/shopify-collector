import os


os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from datetime import date

from backend.app.inventory_helper_routes import (
    InventoryCountLineItemInput,
    _build_inventory_sync_plan,
    _date_search_query,
    _line_items_from_shopify,
    _shopify_transfer_payload,
    _status,
)


def test_inventory_status_waiting_match_and_mismatch():
    assert _status(3, 24, None, None) == "waiting"
    assert _status(3, 24, 3, 24) == "matched"
    assert _status(0, 24, 3, 24) == "matched"
    assert _status(3, 24, 2, 24) == "mismatch"
    assert _status(3, 24, 3, 25) == "mismatch"
    assert _status(
        3,
        24,
        3,
        24,
        [
            {"ordered_quantity": 12, "actual_quantity": 11},
            {"ordered_quantity": 12, "actual_quantity": 13},
        ],
    ) == "mismatch"


def test_shopify_transfer_line_items_become_editable_order_quantities():
    transfer = {
        "destination": {
            "name": "Warehouse",
            "location": {"id": "gid://shopify/Location/8", "name": "Warehouse"},
        },
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
                            "product": {"title": "Classic crate", "featuredMedia": None},
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
            "inventory_item_id": "gid://shopify/InventoryItem/3",
            "destination_location_id": "gid://shopify/Location/8",
            "destination_name": "Warehouse",
            "shopify_quantity": 12,
            "ordered_quantity": 12,
            "actual_quantity": None,
            "shopify_received_quantity": 0,
            "inventory_applied_quantity": 0,
            "inventory_synced_at": None,
        }
    ]


def test_date_query_uses_casablanca_day_boundaries():
    query = _date_search_query(date(2026, 8, 18))
    assert "created_at:>=2026-08-17T23:00:00Z" in query
    assert "created_at:<2026-08-18T23:00:00Z" in query


def test_date_card_uses_transfer_total_when_only_preview_line_is_loaded():
    transfer = {
        "id": "gid://shopify/InventoryTransfer/1",
        "name": "ST0001",
        "totalQuantity": 24,
        "lineItems": {
            "nodes": [
                {
                    "id": "line-1",
                    "title": "Preview item",
                    "totalQuantity": 2,
                    "inventoryItem": {"id": "inventory-1", "variant": None},
                }
            ]
        },
    }

    payload = _shopify_transfer_payload(transfer, "irranova")

    assert payload["expected_items"] == 24
    assert len(payload["line_items"]) == 1


def test_sync_plan_receives_available_units_and_adjusts_only_remainder():
    transfer = {
        "destination": {
            "location": {"id": "gid://shopify/Location/8", "name": "Warehouse"}
        },
        "lineItems": {
            "nodes": [
                {
                    "id": "gid://shopify/InventoryTransferLineItem/1",
                    "title": "Classic crate",
                    "totalQuantity": 2,
                    "inventoryItem": {
                        "id": "gid://shopify/InventoryItem/3",
                        "sku": "BLUE-M",
                        "variant": {
                            "id": "gid://shopify/ProductVariant/2",
                            "title": "Blue / M",
                            "image": None,
                            "product": {
                                "title": "Classic crate",
                                "featuredMedia": {
                                    "preview": {
                                        "image": {
                                            "url": "https://cdn.example.test/fallback.jpg",
                                            "altText": "Fallback product",
                                        }
                                    }
                                },
                            },
                        },
                    },
                }
            ]
        },
        "shipments": {
            "nodes": [
                {
                    "id": "gid://shopify/InventoryShipment/7",
                    "status": "DRAFT",
                    "lineItems": {
                        "nodes": [
                            {
                                "id": "gid://shopify/InventoryShipmentLineItem/9",
                                "quantity": 2,
                                "acceptedQuantity": 0,
                                "rejectedQuantity": 0,
                                "unreceivedQuantity": 2,
                                "inventoryItem": {"id": "gid://shopify/InventoryItem/3"},
                            }
                        ]
                    },
                }
            ]
        },
    }
    stored = _line_items_from_shopify(transfer)
    merged, receives, adjustments = _build_inventory_sync_plan(
        stored,
        [
            InventoryCountLineItemInput(
                id="gid://shopify/InventoryTransferLineItem/1",
                actual_quantity=1,
            )
        ],
        transfer,
    )

    assert merged[0]["image_url"] == "https://cdn.example.test/fallback.jpg"
    assert merged[0]["actual_quantity"] == 1
    assert receives["gid://shopify/InventoryShipment/7"]["line_items"][0]["quantity"] == 1
    assert adjustments == []


def test_sync_plan_corrects_previous_inventory_by_delta():
    transfer = {
        "destination": {"location": {"id": "gid://shopify/Location/8"}},
        "lineItems": {
            "nodes": [
                {
                    "id": "line-1",
                    "title": "Item",
                    "totalQuantity": 2,
                    "inventoryItem": {
                        "id": "inventory-1",
                        "variant": {"id": "variant-1", "title": "M", "product": {"title": "Item"}},
                    },
                }
            ]
        },
        "shipments": {"nodes": []},
    }
    stored = _line_items_from_shopify(transfer)
    stored[0].update(
        {
            "actual_quantity": 2,
            "inventory_applied_quantity": 2,
            "shopify_received_quantity": 2,
            "inventory_synced_at": "2026-08-18T10:00:00+00:00",
        }
    )
    _, receives, adjustments = _build_inventory_sync_plan(
        stored,
        [InventoryCountLineItemInput(id="line-1", actual_quantity=1)],
        transfer,
    )

    assert receives == {}
    assert adjustments == [
        {
            "inventory_item_id": "inventory-1",
            "location_id": "gid://shopify/Location/8",
            "delta": -1,
            "title": "Item",
        }
    ]
