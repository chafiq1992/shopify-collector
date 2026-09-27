"""Counts and queues follow the live tags, not Shopify's lagging search index.

Shopify re-indexes an order seconds to minutes after a tag write, so a search
still returns an order that was just pulled away (and misses one that was just
assigned). These tests pin the fix: every hit is re-checked against its live
tags, and just-assigned orders are merged in by ID. They also cover moving one
agent's orders to another (source/target on the pull endpoints).
"""
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app import confirmation_routes as cr
from backend.app.confirmation_routes import (
    PULL_SOURCE_UNASSIGNED,
    LiveTagFilter,
    PullExecuteBody,
    PullPreviewBody,
    _matches_level,
    agent_queue,
    pull_execute,
    pull_preview,
)
from backend.app.db import Base
from backend.app.models import User


def _edge(gid, tags):
    return {"cursor": gid, "node": {"id": gid, "tags": tags}}


def _page(edges):
    return {"orders": {"edges": edges, "pageInfo": {"hasNextPage": False}}}


def _full_node(gid, tags, created="2026-09-01T10:00:00Z"):
    return {
        "id": gid, "legacyResourceId": gid.rsplit("/", 1)[-1], "name": "#" + gid.rsplit("/", 1)[-1],
        "createdAt": created, "cancelledAt": None, "closed": False, "tags": tags,
        "displayFulfillmentStatus": "UNFULFILLED", "displayFinancialStatus": "PENDING",
        "currentTotalPriceSet": {"shopMoney": {"amount": "100", "currencyCode": "MAD"}},
        "lineItems": {"edges": []},
    }


class LiveTagFilterTests(unittest.TestCase):
    def test_require_and_forbid(self):
        f = LiveTagFilter(require=(frozenset({"fz"}),), forbid=frozenset({"zineb"}))
        self.assertTrue(f.matches(["FZ", "n1"]))
        self.assertFalse(f.matches(["n1"]))
        self.assertFalse(f.matches(["fz", "Zineb"]))

    def test_level_mirror(self):
        self.assertTrue(_matches_level(["n2"], "n2"))
        self.assertFalse(_matches_level(["n1"], "n2"))
        self.assertTrue(_matches_level(["nowtp3"], "nowtp"))
        self.assertTrue(_matches_level(["enatt1"], "enatt"))
        self.assertTrue(_matches_level(["fz"], "new"))
        self.assertFalse(_matches_level(["fz", "n1"], "new"))
        self.assertTrue(_matches_level(["n1"], None))


class _DbCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        cr._RECENT_TAG_ADDS.clear()
        cr.invalidate_all_breakdown_caches()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.me = User(
            id="agent-fz", email="fz@example.com", name="FZ",
            password_hash="unused", role="agent", is_active=True, agent_tags=["fz"],
        )
        self.zineb = User(
            id="agent-zineb", email="zineb@example.com", name="Zineb",
            password_hash="unused", role="agent", is_active=True, agent_tags=["zineb"],
        )
        self.sara = User(
            id="agent-sara", email="sara@example.com", name="Sara",
            password_hash="unused", role="agent", is_active=True, agent_tags=["sara"],
        )
        self.admin = User(
            id="admin-1", email="boss@example.com", name="Boss",
            password_hash="unused", role="admin", is_active=True, agent_tags=[],
        )
        async with self.sessions() as session:
            session.add_all([self.me, self.zineb, self.sara, self.admin])
            await session.commit()

    async def asyncTearDown(self):
        cr._RECENT_TAG_ADDS.clear()
        cr.invalidate_all_breakdown_caches()
        await self.engine.dispose()


class PullPreviewTests(_DbCase):
    async def _preview(self, body, pages, user=None):
        with patch("backend.app.main.shopify_graphql", AsyncMock(return_value=_page(pages))):
            async with self.sessions() as session:
                return await pull_preview(body, user=user or self.me, db=session)

    async def test_unassigned_count_drops_orders_the_index_has_not_caught_up_with(self):
        # The index still lists order 2 as unassigned, but its live tags show
        # it was just pulled by Zineb — it must not be counted.
        pages = [
            _edge("gid://shopify/Order/1", []),
            _edge("gid://shopify/Order/2", ["zineb"]),
            _edge("gid://shopify/Order/3", ["fz"]),   # already mine
        ]
        js = await self._preview(PullPreviewBody(store="irrakids", level="new"), pages)
        self.assertEqual(js["available"], 1)

    async def test_pool_is_split_by_current_owner(self):
        pages = [
            _edge("gid://shopify/Order/1", ["zineb", "n1"]),
            _edge("gid://shopify/Order/2", ["zineb"]),
            _edge("gid://shopify/Order/3", ["sara"]),
            _edge("gid://shopify/Order/4", []),
        ]
        js = await self._preview(
            PullPreviewBody(store="irrakids", level="new", include_assigned=True), pages,
        )
        self.assertEqual(js["available"], 4)
        self.assertEqual(js["assigned_available"], 3)
        self.assertEqual(js["unassigned_available"], 1)
        self.assertEqual(
            [(a["id"], a["count"]) for a in js["by_agent"]],
            [("agent-zineb", 2), ("agent-sara", 1)],
        )

    async def test_selected_source_agent_sets_the_available_count(self):
        pages = [
            _edge("gid://shopify/Order/1", ["zineb"]),
            _edge("gid://shopify/Order/2", ["zineb"]),
            _edge("gid://shopify/Order/3", ["sara"]),
            _edge("gid://shopify/Order/4", []),
        ]
        js = await self._preview(
            PullPreviewBody(store="irrakids", level="new", source_agent_id="agent-zineb"), pages,
        )
        self.assertEqual(js["available"], 2)
        self.assertEqual(js["assigned_available"], 2)
        self.assertEqual(len(js["by_agent"]), 2)   # other chips keep their counts
        js = await self._preview(
            PullPreviewBody(store="irrakids", level="new", source_agent_id=PULL_SOURCE_UNASSIGNED),
            pages,
        )
        self.assertEqual(js["available"], 1)
        self.assertEqual(js["assigned_available"], 0)

    async def test_only_admins_can_target_another_agent(self):
        with self.assertRaises(HTTPException) as ctx:
            await self._preview(
                PullPreviewBody(store="irrakids", level="new", target_agent_id="agent-sara"), [],
            )
        self.assertEqual(ctx.exception.status_code, 403)


class PullExecuteMoveTests(_DbCase):
    async def _execute(self, body, pages, user=None):
        graphql = AsyncMock(return_value=_page(pages))
        add_tag, remove_tag, record = AsyncMock(), AsyncMock(), AsyncMock()
        with patch("backend.app.main.shopify_graphql", graphql), \
             patch("backend.app.main._shopify_add_tag", add_tag), \
             patch("backend.app.main._shopify_remove_tag", remove_tag), \
             patch("backend.app.main._record_user_action", record), \
             patch("backend.app.main._already_logged_today", AsyncMock(return_value=False)):
            async with self.sessions() as session:
                result = await pull_execute(body, user=user or self.me, db=session)
        return result, graphql, add_tag, remove_tag, record

    async def test_source_agent_narrows_the_query_and_the_live_check(self):
        pages = [
            _edge("gid://shopify/Order/1", ["zineb"]),
            _edge("gid://shopify/Order/2", ["sara"]),   # stale hit: not Zineb's
        ]
        body = PullExecuteBody(
            store="irrakids", level="new", limit=10, agent_tag="fz",
            source_agent_id="agent-zineb",
        )
        result, graphql, add_tag, remove_tag, _record = await self._execute(body, pages)
        query = graphql.await_args.args[1]["q"]
        self.assertIn('(tag:"zineb")', query)
        self.assertEqual(result["pulled"], 1)
        self.assertEqual(result["order_ids"], ["gid://shopify/Order/1"])
        self.assertEqual([c.args[:2] for c in add_tag.await_args_list],
                         [("gid://shopify/Order/1", "fz")])
        self.assertEqual([c.args[:2] for c in remove_tag.await_args_list],
                         [("gid://shopify/Order/1", "zineb")])
        # The move is remembered so the new owner sees it before Shopify re-indexes.
        self.assertEqual(cr.recent_orders_tagged_with("irrakids", ["fz"]), ["gid://shopify/Order/1"])

    async def test_admin_moves_orders_from_one_agent_to_another(self):
        pages = [_edge("gid://shopify/Order/7", ["zineb", "n2"])]
        body = PullExecuteBody(
            store="irrakids", level="new", limit=10,
            source_agent_id="agent-zineb", target_agent_id="agent-sara",
        )
        result, _graphql, add_tag, remove_tag, record = await self._execute(body, pages, user=self.admin)
        self.assertEqual(result["target_agent_id"], "agent-sara")
        self.assertEqual([c.args[:2] for c in add_tag.await_args_list],
                         [("gid://shopify/Order/7", "sara")])
        self.assertEqual([c.args[:2] for c in remove_tag.await_args_list],
                         [("gid://shopify/Order/7", "zineb")])
        # Intake is credited to the new owner; the admin is recorded as the assigner.
        kwargs = record.await_args.kwargs
        self.assertEqual(kwargs["user_id"], "agent-sara")
        self.assertEqual(kwargs["metadata"]["assigned_by"], "admin-1")

    async def test_target_tag_must_belong_to_the_target(self):
        body = PullExecuteBody(
            store="irrakids", level="new", limit=10, agent_tag="zineb",
            target_agent_id="agent-sara",
        )
        with self.assertRaises(HTTPException) as ctx:
            await self._execute(body, [], user=self.admin)
        self.assertEqual(ctx.exception.status_code, 400)


class AgentQueueLiveTests(_DbCase):
    async def test_queue_drops_moved_orders_and_shows_just_assigned_ones(self):
        search_page = {
            "orders": {
                "edges": [
                    # Still indexed under "fz" but already moved to Zineb.
                    {"cursor": "c1", "node": _full_node("gid://shopify/Order/1", ["zineb"])},
                    {"cursor": "c2", "node": _full_node("gid://shopify/Order/2", ["fz", "n1"])},
                ],
                "pageInfo": {"hasNextPage": False},
            },
            "ordersCount": {"count": 2},
        }
        breakdown_page = _page([
            _edge("gid://shopify/Order/1", ["zineb"]),
            _edge("gid://shopify/Order/2", ["fz", "n1"]),
        ])
        # Order 3 was just pulled into FZ's queue; Shopify search doesn't know yet.
        cr.note_recent_tag_add("irrakids", "gid://shopify/Order/3", ["fz"])
        recent = {"nodes": [_full_node("gid://shopify/Order/3", ["fz"], created="2026-09-02T10:00:00Z")]}

        async def fake_graphql(query, variables, store=None):
            if "nodes(ids" in query:
                return recent
            if "AgentQueue" in query:
                return search_page
            return breakdown_page

        with patch("backend.app.main.shopify_graphql", AsyncMock(side_effect=fake_graphql)), \
             patch("backend.app.main.resolve_store_settings_effective",
                   AsyncMock(return_value=("irrakids.myshopify.com", "t", None))):
            async with self.sessions() as session:
                js = await agent_queue(store="irrakids", user=self.me, db=session)

        self.assertEqual([o["id"] for o in js["orders"]],
                         ["gid://shopify/Order/3", "gid://shopify/Order/2"])
        self.assertEqual(js["level_counts"]["total"], 2)
        self.assertEqual(js["level_counts"]["n1"], 1)
        self.assertEqual(js["level_counts"]["new"], 1)


if __name__ == "__main__":
    unittest.main()
