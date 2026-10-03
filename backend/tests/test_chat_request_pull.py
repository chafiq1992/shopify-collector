import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app import chat_request_routes as routes
from backend.app.chat_request_routes import (
    PULL_SOURCE_UNASSIGNED,
    PULL_TARGET_UNASSIGNED,
    ChatPullExecuteBody,
    ChatPullPreviewBody,
    ChatRequestIntakeBody,
    create_chat_request,
    pull_chat_requests_execute,
    pull_chat_requests_preview,
)
from backend.app.db import Base
from backend.app.models import ChatRequest, ChatRequestEvent, User


class _FakeRequest:
    headers = {"x-forwarded-for": "203.0.113.9"}
    client = None


async def _known(*_args, **_kwargs):
    return ["irrakids", "irranova"]


class ChatRequestPullTests(unittest.IsolatedAsyncioTestCase):
    """"Get more requests" / "Move requests": the chat version of the orders pull."""

    async def asyncSetUp(self):
        routes._INTAKE_HITS.clear()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            self.me = User(id="agent-1", email="a1@example.com", name="Agent One",
                           password_hash="x", role="agent", is_active=True, agent_tags=[])
            self.other = User(id="agent-2", email="a2@example.com", name="Agent Two",
                              password_hash="x", role="agent", is_active=True, agent_tags=[])
            self.admin = User(id="admin-1", email="boss@example.com", name="Boss",
                              password_hash="x", role="admin", is_active=True, agent_tags=[])
            session.add_all([self.me, self.other, self.admin])
            await session.commit()
        self._known_patch = patch.object(routes, "_known_stores", _known)
        self._known_patch.start()

    async def asyncTearDown(self):
        self._known_patch.stop()
        await self.engine.dispose()

    async def _seed(self, n, *, owner=None, status="new", attempts=0, store="irrakids", start=0):
        ids = []
        async with self.sessions() as session:
            for i in range(n):
                r = ChatRequest(store_key=store, phone=f"+21261100{start + i:04d}", status=status,
                                attempts=attempts, enatt=0, request_count=1, assigned_to_id=owner)
                session.add(r)
                await session.flush()
                ids.append(r.id)
            await session.commit()
        return ids

    async def _owners(self):
        async with self.sessions() as session:
            rows = (await session.execute(select(ChatRequest.id, ChatRequest.assigned_to_id))).all()
        return dict(rows)

    async def _preview(self, user, **kw):
        async with self.sessions() as session:
            return await pull_chat_requests_preview(body=ChatPullPreviewBody(store="irrakids", **kw), db=session, user=user)

    async def _execute(self, user, **kw):
        async with self.sessions() as session:
            return await pull_chat_requests_execute(body=ChatPullExecuteBody(store="irrakids", **kw), db=session, user=user)

    async def test_new_requests_pull_only_takes_unassigned(self):
        free = await self._seed(3)
        held = await self._seed(2, owner=self.other.id, start=10)
        await self._seed(4, store="irranova", start=20)

        preview = await self._preview(self.me, level="new")
        self.assertEqual(preview["available"], 3)
        self.assertEqual(preview["by_agent"], [])

        res = await self._execute(self.me, level="new", limit=2)
        self.assertEqual((res["pulled"], res["reassigned"]), (2, 0))
        owners = await self._owners()
        self.assertEqual(sum(owners[i] == self.me.id for i in free), 2)
        self.assertTrue(all(owners[i] == self.other.id for i in held))

    async def test_take_from_a_specific_agent(self):
        await self._seed(2)
        held = await self._seed(3, owner=self.other.id, start=10)

        preview = await self._preview(self.me, level="new", include_assigned=True)
        self.assertEqual(preview["pool_total"], 5)
        self.assertEqual(preview["unassigned_available"], 2)
        self.assertEqual(preview["assigned_available"], 3)
        self.assertEqual([(a["id"], a["count"]) for a in preview["by_agent"]], [(self.other.id, 3)])

        only_other = await self._preview(self.me, level="new", include_assigned=True, source_agent_id=self.other.id)
        self.assertEqual((only_other["available"], only_other["assigned_available"]), (3, 3))
        only_free = await self._preview(self.me, level="new", include_assigned=True, source_agent_id=PULL_SOURCE_UNASSIGNED)
        self.assertEqual((only_free["available"], only_free["assigned_available"]), (2, 0))

        res = await self._execute(self.me, level="new", include_assigned=True, source_agent_id=self.other.id, limit=0)
        self.assertEqual((res["pulled"], res["reassigned"]), (3, 3))
        owners = await self._owners()
        self.assertTrue(all(owners[i] == self.me.id for i in held))

    async def test_call_levels_include_other_agents_requests(self):
        n2 = await self._seed(2, owner=self.other.id, status="calling", attempts=2)
        await self._seed(1, owner=self.other.id, status="calling", attempts=1, start=10)
        preview = await self._preview(self.me, level="n2")
        self.assertEqual(preview["available"], 2)
        res = await self._execute(self.me, level="n2", limit=10)
        self.assertEqual(res["pulled"], 2)
        owners = await self._owners()
        self.assertTrue(all(owners[i] == self.me.id for i in n2))

    async def test_own_requests_are_not_available_to_yourself(self):
        await self._seed(2, owner=self.me.id)
        preview = await self._preview(self.me, level="all", include_assigned=True)
        self.assertEqual(preview["available"], 0)

    async def test_admin_moves_between_agents(self):
        held = await self._seed(3, owner=self.other.id)
        res = await self._execute(self.admin, level="all", include_assigned=True,
                                  source_agent_id=self.other.id, target_agent_id=self.me.id, limit=2)
        self.assertEqual((res["pulled"], res["target_agent_id"]), (2, self.me.id))
        owners = await self._owners()
        self.assertEqual(sum(owners[i] == self.me.id for i in held), 2)
        async with self.sessions() as session:
            events = (await session.execute(select(ChatRequestEvent).where(ChatRequestEvent.action == "assign"))).scalars().all()
        self.assertEqual(len(events), 2)
        self.assertTrue(all(e.user_id == self.admin.id and e.detail["previous_agent_id"] == self.other.id for e in events))

    async def test_admin_removes_requests_from_an_agent(self):
        held = await self._seed(3, owner=self.other.id)
        await self._seed(2, start=10)
        preview = await self._preview(self.admin, level="all", source_agent_id=self.other.id,
                                      target_agent_id=PULL_TARGET_UNASSIGNED)
        self.assertEqual(preview["available"], 3)
        self.assertEqual(preview["unassigned_available"], 0)

        res = await self._execute(self.admin, level="all", source_agent_id=self.other.id,
                                  target_agent_id=PULL_TARGET_UNASSIGNED, limit=0)
        self.assertEqual((res["pulled"], res["unassigned"]), (3, True))
        owners = await self._owners()
        self.assertTrue(all(owners[i] is None for i in held))

    async def test_agents_cannot_move_for_others_or_remove(self):
        await self._seed(2, owner=self.other.id)
        for target in (self.other.id, PULL_TARGET_UNASSIGNED):
            with self.assertRaises(HTTPException) as ctx:
                await self._preview(self.me, level="all", target_agent_id=target)
            self.assertEqual(ctx.exception.status_code, 403)
            with self.assertRaises(HTTPException) as ctx:
                await self._execute(self.me, level="all", target_agent_id=target)
            self.assertEqual(ctx.exception.status_code, 403)

    async def test_closed_requests_are_never_pulled(self):
        await self._seed(2, owner=self.other.id, status="ordered")
        await self._seed(1, status="not_interested", start=10)
        preview = await self._preview(self.admin, level="all", include_assigned=True)
        self.assertEqual(preview["available"], 0)

    async def test_pulled_requests_come_from_real_intake(self):
        async with self.sessions() as session:
            created = await create_chat_request(
                body=ChatRequestIntakeBody(store="irrakids", phone="0612345678"), request=_FakeRequest(), db=session,
            )
        res = await self._execute(self.me, level="new", limit=10)
        self.assertEqual(res["pulled"], 1)
        self.assertEqual((await self._owners())[created["id"]], self.me.id)


if __name__ == "__main__":
    unittest.main()
