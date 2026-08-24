import os


os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from datetime import date

import pytest

from backend.app.inventory_helper_routes import (
    InventoryCountLineItemInput,
    InventoryFinalizeUpdate,
    _adjust_inventory_quantities,
    _build_inventory_sync_plan,
    _date_range_search_query,
    _date_search_query,
    _final_receipt_status,
    _line_items_from_shopify,
    _ordered_crates_from_tags,
    _shopify_transfer_payload,
    _shopify_transfer_by_id,
    _shopify_transfers_for_period,
    _stored_receipt_date_prefixes,
    _stored_receipt_range_prefixes,
    _status,
)


def test_inventory_status_waiting_match_and_mismatch():
    assert _status(3, 24, None, None) == "waiting"
    assert _status(3, 24, 3, 24) == "matched"
    assert _status(0, 24, 3, 24) == "mismatch"
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
                            "selectedOptions": [
                                {"name": "Color", "value": "Blue"},
                                {"name": "Size", "value": "M"},
                            ],
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
            "variant_color": "Blue",
            "variant_size": "M",
            "selected_options": [
                {"name": "Color", "value": "Blue"},
                {"name": "Size", "value": "M"},
            ],
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


def test_date_range_query_includes_the_full_end_day():
    query = _date_range_search_query(date(2026, 8, 16), date(2026, 8, 18))
    assert "created_at:>=2026-08-15T23:00:00Z" in query
    assert "created_at:<2026-08-18T23:00:00Z" in query


def test_numeric_shopify_tag_becomes_ordered_crate_count():
    assert _ordered_crates_from_tags(["summer", "2", "warehouse"]) == 2
    assert _ordered_crates_from_tags(["Crates: 4"]) == 4
    assert _ordered_crates_from_tags(["no crate plan"]) == 0


def test_final_status_is_incomplete_only_when_crate_count_differs():
    assert _final_receipt_status(2, 2) == "complete"
    assert _final_receipt_status(2, 1) == "incomplete"
    assert _final_receipt_status(2, 3) == "incomplete"


def test_agent_can_choose_either_final_receiving_outcome():
    assert InventoryFinalizeUpdate(outcome="complete").outcome == "complete"
    assert InventoryFinalizeUpdate(outcome="incomplete").outcome == "incomplete"

    with pytest.raises(ValueError):
        InventoryFinalizeUpdate(outcome="pending")


@pytest.mark.asyncio
async def test_period_sync_uses_lightweight_card_query(monkeypatch):
    calls = []

    async def fake_graphql(query, variables, **_kwargs):
        calls.append((query, variables))
        return {
            "inventoryTransfers": {
                "nodes": [],
                "pageInfo": {"hasNextPage": False, "endCursor": None},
            }
        }

    from backend.app import main

    monkeypatch.setattr(main, "shopify_graphql", fake_graphql)
    assert await _shopify_transfers_for_period(
        "irranova",
        date(2026, 8, 16),
        date(2026, 8, 18),
    ) == []
    assert "lineItems(first: 1)" in calls[0][0]
    assert "lineItems(first: 250)" not in calls[0][0]


def test_graphql_backoff_uses_shopify_cost_bucket(monkeypatch):
    from backend.app import main

    monkeypatch.setattr(main.random, "uniform", lambda *_args: 0)
    delay = main._shopify_graphql_retry_delay(
        {
            "extensions": {
                "cost": {
                    "requestedQueryCost": 500,
                    "throttleStatus": {"currentlyAvailable": 100, "restoreRate": 50},
                }
            }
        },
        attempt=0,
    )
    assert delay == 8.25


@pytest.mark.asyncio
async def test_transfer_details_paginate_variants_in_cost_safe_pages(monkeypatch):
    calls = []

    async def fake_graphql(query, variables, **_kwargs):
        calls.append((query, variables))
        if len(calls) == 1:
            return {
                "inventoryTransfer": {
                    "id": variables["id"],
                    "lineItems": {
                        "nodes": [{"id": "line-1"}],
                        "pageInfo": {"hasNextPage": True, "endCursor": "cursor-1"},
                    },
                }
            }
        return {
            "inventoryTransfer": {
                "lineItems": {
                    "nodes": [{"id": "line-2"}],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            }
        }

    from backend.app import main

    monkeypatch.setattr(main, "shopify_graphql", fake_graphql)
    transfer = await _shopify_transfer_by_id(
        "irranova",
        "gid://shopify/InventoryTransfer/1",
        detailed=False,
    )
    assert [item["id"] for item in transfer["lineItems"]["nodes"]] == ["line-1", "line-2"]
    assert "lineItems(first: 100" in calls[0][0]
    assert calls[1][1]["after"] == "cursor-1"


def test_saved_receipt_date_filter_supports_iso_and_shopify_formats():
    assert _stored_receipt_date_prefixes(date(2026, 8, 16)) == (
        "2026-08-16",
        "08/16/2026",
    )


def test_saved_receipt_period_expands_every_day_in_both_formats():
    assert _stored_receipt_range_prefixes(date(2026, 8, 16), date(2026, 8, 18)) == [
        "2026-08-16",
        "08/16/2026",
        "2026-08-17",
        "08/17/2026",
        "2026-08-18",
        "08/18/2026",
    ]


def test_manual_total_must_match_variant_sum_for_a_matching_count():
    assert _status(1, 2, 1, 2, [{"ordered_quantity": 2, "actual_quantity": 2}], 2) == "matched"
    assert _status(1, 2, 1, 2, [{"ordered_quantity": 2, "actual_quantity": 2}], 1) == "mismatch"


def test_date_card_uses_transfer_total_when_only_preview_line_is_loaded():
    transfer = {
        "id": "gid://shopify/InventoryTransfer/1",
        "name": "ST0001",
        "tags": ["3"],
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
    assert payload["shopify_tags"] == ["3"]
    assert payload["ordered_crates"] == 3
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


def test_sync_plan_removes_two_previously_received_units_when_agent_counts_zero():
    transfer = {
        "destination": {"location": {"id": "gid://shopify/Location/8"}},
        "lineItems": {
            "nodes": [
                {
                    "id": "line-red-21",
                    "title": "Kids shoe",
                    "totalQuantity": 2,
                    "inventoryItem": {
                        "id": "inventory-red-21",
                        "variant": {
                            "id": "variant-red-21",
                            "title": "Red / 21",
                            "selectedOptions": [
                                {"name": "Color", "value": "Red"},
                                {"name": "Size", "value": "21"},
                            ],
                            "product": {"title": "Kids shoe"},
                        },
                    },
                }
            ]
        },
        "shipments": {
            "nodes": [
                {
                    "id": "shipment-1",
                    "status": "RECEIVED",
                    "lineItems": {
                        "nodes": [
                            {
                                "id": "shipment-line-1",
                                "acceptedQuantity": 2,
                                "unreceivedQuantity": 0,
                                "inventoryItem": {"id": "inventory-red-21"},
                            }
                        ]
                    },
                }
            ]
        },
    }
    stored = _line_items_from_shopify(transfer)
    stored[0].update(
        {
            "actual_quantity": 2,
            "shopify_received_quantity": 2,
            "inventory_applied_quantity": 2,
        }
    )

    merged, receives, adjustments = _build_inventory_sync_plan(
        stored,
        [InventoryCountLineItemInput(id="line-red-21", actual_quantity=0)],
        transfer,
    )

    assert receives == {}
    assert merged[0]["actual_quantity"] == 0
    assert merged[0]["inventory_applied_quantity"] == 0
    assert adjustments == [
        {
            "inventory_item_id": "inventory-red-21",
            "location_id": "gid://shopify/Location/8",
            "delta": -2,
            "title": "Kids shoe",
        }
    ]


@pytest.mark.asyncio
async def test_inventory_adjustment_reports_shopify_before_and_after(monkeypatch):
    calls = []

    async def fake_graphql(query, variables, **_kwargs):
        calls.append((query, variables))
        if "InventoryHelperAdjust" in query:
            return {"inventoryAdjustQuantities": {"userErrors": []}}
        available = 3 if len(calls) == 1 else 1
        return {
            "nodes": [
                {
                    "id": "inventory-red-21",
                    "inventoryLevel": {
                        "quantities": [{"name": "available", "quantity": available}]
                    },
                }
            ]
        }

    from backend.app import main

    monkeypatch.setattr(main, "shopify_graphql", fake_graphql)
    result = await _adjust_inventory_quantities(
        "irrakids",
        689,
        [
            {
                "inventory_item_id": "inventory-red-21",
                "location_id": "gid://shopify/Location/8",
                "delta": -2,
                "title": "Kids shoe",
            }
        ],
        "transition-key",
    )

    mutation_variables = calls[1][1]
    assert mutation_variables["input"]["changes"] == [
        {
            "inventoryItemId": "inventory-red-21",
            "locationId": "gid://shopify/Location/8",
            "delta": -2,
            "changeFromQuantity": 3,
        }
    ]
    assert result == [
        {
            "type": "inventory_adjustment",
            "inventory_item_id": "inventory-red-21",
            "title": "Kids shoe",
            "delta": -2,
            "before_quantity": 3,
            "expected_after_quantity": 1,
            "after_quantity": 1,
        }
    ]
