"""Collector purchase-order indicators and tag edit failure regressions."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.db import Base
from backend.app.models import InventoryReceipt, User
from backend.app import main, inventory_helper_routes as helper
from backend.app.purchase_order_badges import (
    _membership_cache,
    enrich_orders_with_purchase_orders,
    invalidate_purchase_order_membership,
)


@pytest_asyncio.fixture
async def receipt_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        db.add(User(id="collector-test", email="collector@example.test", name="Collector", password_hash="unused", role="admin"))
        await db.commit()
        yield db
    await engine.dispose()
    _membership_cache.clear()


def variant(variant_id="1", inventory_id="1"):
    return main.OrderVariant(
        id=f"gid://shopify/ProductVariant/{variant_id}",
        inventory_item_id=f"gid://shopify/InventoryItem/{inventory_id}",
        qty=1, status="unfulfilled",
    )


def receipt(db, number, *, store="irrakids", status="new", loaded=True, members=None, legacy=False):
    row = InventoryReceipt(
        store_key=store,
        shopify_order_gid=f"gid://shopify/{'Order' if legacy else 'InventoryTransfer'}/{number}",
        order_number=f"Transfer {number}", po_number=f"PO-{number}",
        status=status, shopify_details_loaded=loaded,
        created_by_id="collector-test",
        line_items=members if members is not None else [{
            "variant_id": "gid://shopify/ProductVariant/1",
            "inventory_item_id": "gid://shopify/InventoryItem/1", "ordered_quantity": 2,
        }],
    )
    db.add(row)
    return row


async def enrich(db, variants, graphql=None, store="irrakids"):
    async def no_shopify(*_args, **_kwargs):
        raise AssertionError("Hydrated receipts must not need Shopify queries")
    await enrich_orders_with_purchase_orders(
        [SimpleNamespace(variants=variants)], store=store, db=db,
        graphql=graphql or no_shopify, api_version="2026-07",
    )


@pytest.mark.asyncio
async def test_pending_badges_filter_store_history_legacy_zero_quantities_and_deduplicate(receipt_db):
    db = receipt_db
    active = receipt(db, 1)
    receipt(db, 2, status="pending")
    receipt(db, 3, status="complete")
    receipt(db, 4, status="incomplete")
    receipt(db, 5, store="irranova")
    receipt(db, 6, legacy=True)
    receipt(db, 7, members=[{"variant_id": "gid://shopify/ProductVariant/1", "ordered_quantity": 0}])
    active.line_items = active.line_items * 2
    await db.commit()
    first, fallback, unrelated = variant(), variant(inventory_id="missing"), variant("9", "9")

    await enrich(db, [first, fallback, unrelated])

    assert [ref["number"] for ref in first.pending_purchase_orders] == ["PO-1", "PO-2"]
    assert fallback.pending_purchase_orders == first.pending_purchase_orders
    assert unrelated.pending_purchase_orders == []
    active.status = "complete"
    await db.commit()
    await enrich(db, [first])
    assert [ref["number"] for ref in first.pending_purchase_orders] == ["PO-2"]


@pytest.mark.asyncio
async def test_unopened_receipt_matches_second_product_paginates_and_reuses_cache(receipt_db):
    db = receipt_db
    row = receipt(db, 1, loaded=False)
    await db.commit()
    calls = []

    async def graphql(query, variables, **kwargs):
        calls.append((query, variables, kwargs))
        assert kwargs == {"store": "irrakids", "api_version": "2026-07"}
        item = {"totalQuantity": 4, "inventoryItem": {"id": "gid://shopify/InventoryItem/2", "variant": {"id": "gid://shopify/ProductVariant/2"}}}
        if "after" not in variables:
            return {"nodes": [{"id": row.shopify_order_gid, "lineItems": {"nodes": [], "pageInfo": {"hasNextPage": True, "endCursor": "next"}}}]}
        assert variables["after"] == "next"
        return {"inventoryTransfer": {"lineItems": {"nodes": [item], "pageInfo": {"hasNextPage": False}}}}

    second = variant("2", "2")
    await enrich(db, [second], graphql)
    await enrich(db, [second], graphql)
    assert len(calls) == 2
    assert second.pending_purchase_orders == [{"id": row.id, "number": "PO-1", "status": "new"}]
    # Badge hydration must leave the receiving preview/counting data untouched.
    assert row.shopify_details_loaded is False
    assert len(row.line_items) == 1
    row.status = "complete"
    await db.commit()
    await enrich(db, [second], graphql)
    assert second.pending_purchase_orders == []
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_membership_network_failure_preserves_known_preview_and_orders(receipt_db):
    receipt(receipt_db, 1, loaded=False)
    await receipt_db.commit()
    calls = []

    async def fail(*_args, **_kwargs):
        calls.append(True)
        raise HTTPException(503, "temporary outage")

    first = variant()
    await enrich(receipt_db, [first], fail)
    await enrich(receipt_db, [first], fail)
    assert first.pending_purchase_orders[0]["number"] == "PO-1"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_receipt_completion_clears_indicator_cache_and_notifies_after_commit(monkeypatch):
    events = []
    row = SimpleNamespace(
        id=1, store_key="irrakids", shopify_order_gid="transfer", status="pending", actual_items=2,
        actual_crates=1, reported_items_received=2, ordered_crates=1,
    )
    async def loaded(*_args):
        return row
    async def commit():
        events.append("committed")
    async def broadcast(message):
        events.append(message)
    monkeypatch.setattr(helper, "_loaded_receipt", loaded)
    monkeypatch.setattr(helper, "_serialize", lambda value: {"status": value.status})
    monkeypatch.setattr(main.manager, "broadcast", broadcast)
    main.ORDERS_CACHE["test"] = (0, {})
    _membership_cache[("irrakids", "transfer")] = (1, "", [])
    _membership_cache[("irranova", "transfer")] = (1, "", [])

    result = await helper.complete_receipt(
        1, helper.InventoryFinalizeUpdate(outcome="complete"),
        db=SimpleNamespace(commit=commit), user=SimpleNamespace(id="agent"),
    )

    assert result == {"status": "complete"}
    assert events == ["committed", {"type": "inventory.purchase_orders_changed", "store": "irrakids"}]
    assert main.ORDERS_CACHE == {}
    assert ("irrakids", "transfer") not in _membership_cache
    assert ("irranova", "transfer") in _membership_cache
    invalidate_purchase_order_membership("irranova")


@pytest.mark.asyncio
async def test_replace_tag_preserves_unrelated_tags_and_invalidates_cached_results(monkeypatch):
    tags = {"old", "urgent", "cod 22/10/26"}
    events = []
    async def add(_id, tag, store):
        assert store == "irrakids"
        tags.add(tag)
    async def remove(_id, tag, _store):
        assert "new" in tags
        tags.discard(tag)
    async def audit(*_args, **_kwargs):
        pass
    async def broadcast(event):
        events.append(event)
    async def get_tags(*_args):
        return sorted(tags)
    monkeypatch.setattr(main, "_shopify_get_order_tags", get_tags)
    monkeypatch.setattr(main, "_shopify_add_tag", add)
    monkeypatch.setattr(main, "_shopify_remove_tag", remove)
    monkeypatch.setattr(main, "_maybe_log_agent_tag_action", audit)
    monkeypatch.setattr(main.manager, "broadcast", broadcast)
    main.ORDERS_CACHE["test"] = (0, {})

    result = await main.replace_tag(
        "gid://shopify/Order/1", main.ReplaceTagPayload(old_tag=" old ", new_tag=" new "),
        store="IRRAKIDS", user=SimpleNamespace(id="agent"), session=None,
    )

    assert result["ok"] is True
    assert set(result["tags"]) == tags
    assert tags == {"new", "urgent", "cod 22/10/26"}
    assert main.ORDERS_CACHE == {}
    assert events[0]["type"] == "order.tag_replaced"


@pytest.mark.asyncio
async def test_replace_tag_failed_add_never_removes_original(monkeypatch):
    calls = []
    async def add(*_args):
        calls.append("add")
        raise HTTPException(400, "Shopify rejected tag")
    async def remove(*_args):
        calls.append("remove")
    async def get_tags(*_args):
        return ["old"]
    monkeypatch.setattr(main, "_shopify_get_order_tags", get_tags)
    monkeypatch.setattr(main, "_shopify_add_tag", add)
    monkeypatch.setattr(main, "_shopify_remove_tag", remove)
    with pytest.raises(HTTPException):
        await main.replace_tag("gid", main.ReplaceTagPayload(old_tag="old", new_tag="new"), store="irrakids", user=None, session=None)
    assert calls == ["add"]


@pytest.mark.asyncio
async def test_replace_tag_partial_failure_reports_actual_state(monkeypatch):
    tags = {"old"}
    events = []
    async def add(_id, tag, _store):
        tags.add(tag)
    async def remove(*_args):
        raise HTTPException(503, "temporary outage")
    async def broadcast(event):
        events.append(event)
    async def get_tags(*_args):
        return sorted(tags)
    monkeypatch.setattr(main, "_shopify_get_order_tags", get_tags)
    monkeypatch.setattr(main, "_shopify_add_tag", add)
    monkeypatch.setattr(main, "_shopify_remove_tag", remove)
    monkeypatch.setattr(main.manager, "broadcast", broadcast)
    response = await main.replace_tag("gid", main.ReplaceTagPayload(old_tag="old", new_tag="new"), store="irrakids", user=None, session=None)
    assert response.status_code == 409
    data = json.loads(response.body)
    assert "Both tags remain" in data["detail"]
    assert set(data["tags"]) == tags
    assert data["state_verified"] is True
    assert tags == {"old", "new"}
    assert events[0]["type"] == "order.tag_added"


@pytest.mark.asyncio
@pytest.mark.parametrize("old_tag,new_tag", [("urgent", "URGENT"), ("URGENT", "urgent"), ("Straße", "STRASSE")])
async def test_case_only_tag_replace_is_safe_noop(monkeypatch, old_tag, new_tag):
    calls = []
    async def get_tags(*_args):
        return [old_tag, "other"]
    async def mutation(*_args):
        calls.append(True)
    monkeypatch.setattr(main, "_shopify_get_order_tags", get_tags)
    monkeypatch.setattr(main, "_shopify_add_tag", mutation)
    monkeypatch.setattr(main, "_shopify_remove_tag", mutation)
    result = await main.replace_tag("gid", main.ReplaceTagPayload(old_tag=old_tag, new_tag=new_tag), store="irrakids", user=None, session=None)
    assert result["tags"] == [old_tag, "other"]
    assert result["new_tag"] == old_tag
    assert calls == []


@pytest.mark.asyncio
async def test_existing_replacement_tag_keeps_canonical_spelling_and_only_removes_original(monkeypatch):
    tags = ["Old", "Urgent", "other"]
    calls = []
    async def get_tags(*_args):
        return list(tags)
    async def add(*_args):
        raise AssertionError("Replacement already exists")
    async def remove(_id, tag, _store):
        calls.append(tag)
        tags.remove(tag)
    async def noop(*_args, **_kwargs):
        pass
    monkeypatch.setattr(main, "_shopify_get_order_tags", get_tags)
    monkeypatch.setattr(main, "_shopify_add_tag", add)
    monkeypatch.setattr(main, "_shopify_remove_tag", remove)
    monkeypatch.setattr(main, "_maybe_log_agent_tag_action", noop)
    monkeypatch.setattr(main.manager, "broadcast", noop)
    result = await main.replace_tag("gid", main.ReplaceTagPayload(old_tag="old", new_tag="URGENT"), store="irrakids", user=None, session=None)
    assert calls == ["Old"]
    assert result["new_tag"] == "Urgent"
    assert result["tags"] == ["Urgent", "other"]


@pytest.mark.asyncio
async def test_stale_original_tag_cannot_create_unintended_new_tag(monkeypatch):
    async def get_tags(*_args):
        return ["already changed", "other"]
    async def mutation(*_args):
        raise AssertionError("A stale edit must not mutate tags")
    monkeypatch.setattr(main, "_shopify_get_order_tags", get_tags)
    monkeypatch.setattr(main, "_shopify_add_tag", mutation)
    monkeypatch.setattr(main, "_shopify_remove_tag", mutation)
    response = await main.replace_tag("gid", main.ReplaceTagPayload(old_tag="old", new_tag="new"), store="irrakids", user=None, session=None)
    assert response.status_code == 409
    assert json.loads(response.body)["tags"] == ["already changed", "other"]


def test_order_tag_length_limit_is_40_characters():
    assert main.ReplaceTagPayload(old_tag="old", new_tag="x" * 40).new_tag == "x" * 40
    with pytest.raises(ValueError):
        main.ReplaceTagPayload(old_tag="old", new_tag="x" * 41)


@pytest.mark.asyncio
@pytest.mark.parametrize("read_back_succeeds", [True, False])
async def test_replace_tag_timeout_reconciles_without_claiming_unverified_state(monkeypatch, read_back_succeeds):
    tags = ["old", "other"]
    reads = []
    async def get_tags(*_args):
        reads.append(True)
        if len(reads) > 1 and not read_back_succeeds:
            raise HTTPException(503, "offline")
        return list(tags)
    async def add(_id, tag, _store):
        tags.append(tag)
    async def remove(_id, tag, _store):
        tags.remove(tag)
        raise HTTPException(503, "response lost after removal")
    async def noop(*_args, **_kwargs):
        pass
    monkeypatch.setattr(main, "_shopify_get_order_tags", get_tags)
    monkeypatch.setattr(main, "_shopify_add_tag", add)
    monkeypatch.setattr(main, "_shopify_remove_tag", remove)
    monkeypatch.setattr(main.manager, "broadcast", noop)
    result = await main.replace_tag("gid", main.ReplaceTagPayload(old_tag="old", new_tag="new"), store="irrakids", user=None, session=None)
    if read_back_succeeds:
        assert result["ok"] is True
        assert result["tags"] == ["other", "new"]
    else:
        assert result.status_code == 409
        data = json.loads(result.body)
        assert data["tags"] is None
        assert data["state_verified"] is False
        assert "Both tags remain" not in data["detail"]


@pytest.mark.asyncio
async def test_purchase_order_deadline_preserves_preview_and_expired_cache_without_background_task(receipt_db, monkeypatch):
    row = receipt(receipt_db, 1, loaded=False)
    await receipt_db.commit()
    cached_second = {"inventory_item_id": "gid://shopify/InventoryItem/2", "ordered_quantity": 2}
    _membership_cache[("irrakids", row.shopify_order_gid)] = (0, str(row.updated_at), row.line_items + [cached_second])
    first, second = variant(), variant("2", "2")
    cancelled = []
    network_entered = asyncio.Event()
    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_args):
            return False
        async def execute(self, _statement):
            # Keep this deadline regression independent of SQLite thread-pool
            # scheduling; membership SQL/filtering is exercised above.
            return SimpleNamespace(all=lambda: [row])
    async def slow_graphql(*_args, **_kwargs):
        network_entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)
    async def on_hand(*_args, **_kwargs):
        pass
    monkeypatch.setattr(main, "SessionLocal", Session)
    monkeypatch.setattr(main, "shopify_graphql", slow_graphql)
    monkeypatch.setattr(main, "_enrich_orders_with_on_hand", on_hand)
    monkeypatch.setattr(main, "PENDING_PURCHASE_ORDER_TIMEOUT_SECONDS", 0.05)
    started = time.monotonic()
    await main._enrich_orders_with_inventory([SimpleNamespace(variants=[first, second])], store="irrakids")
    assert time.monotonic() - started < 0.5
    assert network_entered.is_set()
    assert first.pending_purchase_orders[0]["number"] == "PO-1"
    assert second.pending_purchase_orders[0]["number"] == "PO-1"
    assert cancelled == [True]
