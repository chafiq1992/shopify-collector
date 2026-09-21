"""A pulled order ends up owned by exactly one agent: the one who pulled it.

Covers the two halves of that rule — the search pool ("new" can optionally reach
into other agents' queues) and the execute step (every other agent's tag comes
off, including tags belonging to agents who are no longer active).
"""
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.confirmation_routes import (
    PullExecuteBody,
    build_pull_query,
    pull_execute,
)
from backend.app.db import Base
from backend.app.models import User


def _order(gid, tags):
    return {"cursor": gid, "node": {"id": gid, "tags": tags}}


class PullReassignmentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            self.me = User(
                id="agent-fz", email="fz@example.com", name="FZ",
                password_hash="unused", role="agent", is_active=True,
                agent_tags=["fz"],
            )
            session.add_all([
                self.me,
                User(
                    id="agent-zineb", email="zineb@example.com", name="Zineb",
                    password_hash="unused", role="agent", is_active=True,
                    agent_tags=["zineb"],
                ),
                # Left the team — their tag is still sitting on old orders.
                User(
                    id="agent-laila", email="laila@example.com", name="Laila",
                    password_hash="unused", role="agent", is_active=False,
                    agent_tags=["laila"],
                ),
            ])
            await session.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_new_pool_excludes_other_agents_by_default(self):
        async with self.sessions() as session:
            q, default_tag, other_active, strip_tags = await build_pull_query(
                session, self.me, level="new",
            )
        self.assertIn('-tag:"zineb"', q)
        self.assertIn('-tag:"fz"', q)          # never re-claim my own
        self.assertEqual(default_tag, "fz")
        self.assertEqual(other_active, ["zineb"])

    async def test_include_assigned_opens_the_pool_to_other_agents(self):
        async with self.sessions() as session:
            q, _tag, _other, _strip = await build_pull_query(
                session, self.me, level="new", include_assigned=True,
            )
        self.assertNotIn('-tag:"zineb"', q)
        self.assertIn('-tag:"fz"', q)          # still not my own orders
        self.assertIn("status:open", q)

    async def test_include_assigned_still_honours_explicit_exclusions(self):
        async with self.sessions() as session:
            q, _tag, _other, _strip = await build_pull_query(
                session, self.me, level="new",
                exclude_tags=["zineb"], include_assigned=True,
            )
        self.assertIn('-tag:"zineb"', q)

    async def test_strip_list_covers_deactivated_agents(self):
        """A stale tag from someone who left would otherwise survive the pull."""
        async with self.sessions() as session:
            _q, _tag, other_active, strip_tags = await build_pull_query(
                session, self.me, level="new",
            )
        self.assertNotIn("laila", other_active)   # doesn't define "unassigned"
        self.assertIn("laila", strip_tags)        # but does get removed
        self.assertIn("zineb", strip_tags)
        self.assertNotIn("fz", strip_tags)        # never strip the puller's own

    async def _run_execute(self, orders, body, remove_side_effect=None):
        page = {"orders": {"edges": orders, "pageInfo": {"hasNextPage": False}}}
        add_tag = AsyncMock()
        remove_tag = AsyncMock(side_effect=remove_side_effect)
        with patch("backend.app.main.shopify_graphql", AsyncMock(return_value=page)), \
             patch("backend.app.main._shopify_add_tag", add_tag), \
             patch("backend.app.main._shopify_remove_tag", remove_tag), \
             patch("backend.app.main._record_user_action", AsyncMock()), \
             patch("backend.app.main._already_logged_today", AsyncMock(return_value=False)):
            async with self.sessions() as session:
                result = await pull_execute(body, user=self.me, db=session)
        return result, add_tag, remove_tag

    async def test_execute_strips_every_other_agent_tag(self):
        orders = [
            _order("gid://shopify/Order/1", ["n2", "zineb"]),
            _order("gid://shopify/Order/2", ["n2", "laila"]),
            _order("gid://shopify/Order/3", ["n2"]),
        ]
        body = PullExecuteBody(
            store="irranova", level="new", limit=10,
            agent_tag="fz", include_assigned=True,
        )
        result, add_tag, remove_tag = await self._run_execute(orders, body)

        self.assertEqual(result["pulled"], 3)
        self.assertEqual(result["reassigned"], 2)
        self.assertEqual(result["reassign_failed"], 0)
        self.assertEqual(
            {c.args[0] for c in add_tag.await_args_list},
            {f"gid://shopify/Order/{n}" for n in (1, 2, 3)},
        )
        self.assertEqual({c.args[0] for c in add_tag.await_args_list if c.args[1] == "fz"},
                         {f"gid://shopify/Order/{n}" for n in (1, 2, 3)})
        # Both the active agent's tag and the departed agent's tag come off.
        self.assertEqual(
            {(c.args[0], c.args[1]) for c in remove_tag.await_args_list},
            {("gid://shopify/Order/1", "zineb"), ("gid://shopify/Order/2", "laila")},
        )

    async def test_execute_never_strips_the_pullers_own_tag(self):
        orders = [_order("gid://shopify/Order/9", ["fz", "n1"])]
        body = PullExecuteBody(
            store="irranova", level="n1", limit=10, agent_tag="fz",
        )
        _result, _add_tag, remove_tag = await self._run_execute(orders, body)
        self.assertEqual(remove_tag.await_args_list, [])

    async def test_failed_removal_is_reported_not_swallowed(self):
        orders = [_order("gid://shopify/Order/5", ["zineb"])]
        body = PullExecuteBody(
            store="irranova", level="new", limit=10,
            agent_tag="fz", include_assigned=True,
        )
        result, _add_tag, _remove_tag = await self._run_execute(
            orders, body, remove_side_effect=RuntimeError("shopify said no"),
        )
        self.assertEqual(result["pulled"], 1)
        self.assertEqual(result["reassigned"], 0)
        self.assertEqual(result["reassign_failed"], 1)


if __name__ == "__main__":
    unittest.main()
