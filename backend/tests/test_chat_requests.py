import unittest
import os
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app import chat_request_routes as routes
from backend.app.chat_request_routes import (
    ChatActionBody,
    ChatPullBody,
    ChatRequestIntakeBody,
    chat_request_action,
    chat_request_history,
    chat_team_stats,
    create_chat_request,
    list_chat_requests,
    normalize_phone,
    pull_chat_requests,
)
from backend.app.db import Base
from backend.app.models import ChatRequest, ChatRequestEvent, User


class _FakeClient:
    host = "203.0.113.7"


class _FakeRequest:
    def __init__(self, ip="203.0.113.7"):
        self.headers = {"x-forwarded-for": ip}
        self.client = _FakeClient()


async def _known(*_args, **_kwargs):
    return ["irrakids", "irranova"]


class ChatRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        routes._INTAKE_HITS.clear()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            self.agent = User(id="agent-1", email="a1@example.com", name="Agent One",
                              password_hash="x", role="agent", is_active=True, agent_tags=[])
            self.other = User(id="agent-2", email="a2@example.com", name="Agent Two",
                              password_hash="x", role="agent", is_active=True, agent_tags=[])
            self.admin = User(id="admin-1", email="boss@example.com", name="Boss",
                              password_hash="x", role="admin", is_active=True, agent_tags=[])
            session.add_all([self.agent, self.other, self.admin])
            await session.commit()
        self._known_patch = patch.object(routes, "_known_stores", _known)
        self._known_patch.start()

    async def asyncTearDown(self):
        self._known_patch.stop()
        await self.engine.dispose()

    async def _intake(self, **kw):
        payload = {"store": "irrakids", "phone": "0612345678", **kw}
        async with self.sessions() as session:
            return await create_chat_request(
                body=ChatRequestIntakeBody(**payload), request=_FakeRequest(kw.pop("ip", "203.0.113.7")), db=session,
            )

    async def _act(self, rid, action, user=None, **kw):
        async with self.sessions() as session:
            return await chat_request_action(
                request_id=rid, body=ChatActionBody(action=action, **kw), db=session, user=user or self.agent,
            )

    async def test_signed_intake_preserves_history_and_retry_is_idempotent(self):
        request = _FakeRequest()
        request.headers['x-chat-intake-key'] = 'shared-test-key'
        body = ChatRequestIntakeBody(store='irrakids', phone='0612345678', message='Customer: details\n' * 1000, source_id='storefront:session:2', order_ref='12345')
        with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key'}):
            async with self.sessions() as db:
                first = await routes.integration_chat_request(body, request, db)
            async with self.sessions() as db:
                second = await routes.integration_chat_request(body, request, db)
                saved = await db.get(ChatRequest, first['id'])
                self.assertEqual(saved.message, body.message.strip())
                self.assertEqual(saved.order_ref, '12345')
                self.assertEqual(saved.request_count, 1)
                self.assertEqual(second['id'], first['id'])
            # An HTTP retry after an agent closes a request must not recreate it.
            await self._act(first['id'], 'wrong_number')
            async with self.sessions() as db:
                retry = await routes.integration_chat_request(body, request, db)
                self.assertEqual(retry['id'], first['id'])

    async def test_signed_intake_requires_key_and_bypasses_public_ip_limit(self):
        body = ChatRequestIntakeBody(store='irranova', phone='0612345678', source_id='storefront:session:1')
        request = _FakeRequest()
        with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key'}):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as exc:
                    await routes.integration_chat_request(body, request, db)
                self.assertEqual(exc.exception.status_code, 401)
            for _ in range(8):
                routes._intake_allowed('203.0.113.7')
            request.headers['x-chat-intake-key'] = 'shared-test-key'
            async with self.sessions() as db:
                result = await routes.integration_chat_request(body, request, db)
                self.assertTrue(result['ok'])

    async def test_completed_order_closes_only_its_source_chat(self):
        request = _FakeRequest()
        request.headers['x-chat-intake-key'] = 'shared-test-key'
        sid = 'a' * 32
        with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key'}):
            async with self.sessions() as db:
                lead = await routes.integration_chat_request(ChatRequestIntakeBody(store='irrakids', phone='0612345678', source_id='storefront:' + sid + ':1'), request, db)
            async with self.sessions() as db:
                wrong = await routes.integration_chat_complete(routes.ChatRequestCompleteBody(store='irrakids', phone='0612345678', session_id='b'*32, order_ref='98765'), request, db)
                self.assertFalse(wrong['closed'])
            async with self.sessions() as db:
                completed = await routes.integration_chat_complete(routes.ChatRequestCompleteBody(store='irrakids', phone='0612345678', session_id=sid, order_ref='98765'), request, db)
                self.assertTrue(completed['closed'])
                saved = await db.get(ChatRequest, lead['id'])
                self.assertEqual(saved.status, 'ordered')
                self.assertEqual(saved.order_ref, '98765')

    async def _list(self, user=None, **kw):
        async with self.sessions() as session:
            params = {"store": "irrakids", "scope": "all", "level": None, "q": None, "limit": 50, "offset": 0, **kw}
            return await list_chat_requests(**params, db=session, user=user or self.agent)

    def test_phone_normalization(self):
        self.assertEqual(normalize_phone("06 12 34 56 78"), "+212612345678")
        self.assertEqual(normalize_phone("+212 6-12-34-56-78"), "+212612345678")
        self.assertEqual(normalize_phone("00212612345678"), "+212612345678")
        self.assertIsNone(normalize_phone("12345"))
        self.assertIsNone(normalize_phone("hello"))

    async def test_intake_creates_request_with_product(self):
        res = await self._intake(name="Sara", message="Is size 4 available?",
                                 product_title="Pyjama", product_url="https://irrakids.com/products/pyjama",
                                 product_image="javascript:alert(1)")
        self.assertTrue(res["ok"])
        self.assertFalse(res["repeat"])
        async with self.sessions() as session:
            row = await session.get(ChatRequest, res["id"])
        self.assertEqual(row.phone, "+212612345678")
        self.assertEqual(row.status, "new")
        self.assertEqual(row.product_title, "Pyjama")
        # Only http(s) URLs are kept.
        self.assertIsNone(row.product_image)

    async def test_repeat_request_from_same_phone_is_merged(self):
        first = await self._intake(message="first")
        second = await self._intake(phone="+212612345678", message="second")
        self.assertTrue(second["repeat"])
        self.assertEqual(first["id"], second["id"])
        async with self.sessions() as session:
            row = await session.get(ChatRequest, first["id"])
        self.assertEqual(row.request_count, 2)
        self.assertEqual(row.message, "second")

    async def test_closed_request_does_not_swallow_a_new_one(self):
        first = await self._intake()
        await self._act(first["id"], "not_interested")
        again = await self._intake()
        self.assertFalse(again["repeat"])
        self.assertNotEqual(first["id"], again["id"])

    async def test_intake_rejects_bad_input(self):
        with self.assertRaises(HTTPException) as ctx:
            await self._intake(phone="123")
        self.assertEqual(ctx.exception.status_code, 422)
        with self.assertRaises(HTTPException) as ctx:
            await self._intake(store="someone-else")
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_honeypot_is_silently_dropped(self):
        res = await self._intake(website="http://spam.example")
        self.assertEqual(res, {"ok": True})
        async with self.sessions() as session:
            rows = (await session.execute(select(ChatRequest))).scalars().all()
        self.assertEqual(rows, [])

    async def test_intake_is_rate_limited_per_ip(self):
        for i in range(routes._INTAKE_MAX_PER_WINDOW):
            await self._intake(phone=f"06123456{i:02d}")
        with self.assertRaises(HTTPException) as ctx:
            await self._intake(phone="0699999999")
        self.assertEqual(ctx.exception.status_code, 429)

    async def test_shop_domain_maps_to_store(self):
        async with self.sessions() as session:
            res = await create_chat_request(
                body=ChatRequestIntakeBody(shop="irranova.myshopify.com", phone="0612345678"),
                request=_FakeRequest(), db=session,
            )
            row = await session.get(ChatRequest, res["id"])
        self.assertEqual(row.store_key, "irranova")

    async def test_call_cycle_assigns_and_counts(self):
        rid = (await self._intake())["id"]
        res = await self._act(rid, "call", client_action_id="click-1")
        req = res["request"]
        self.assertEqual(req["attempts"], 1)
        self.assertEqual(req["status"], "calling")
        self.assertEqual(req["assigned_to"]["id"], self.agent.id)

        # A retried click is recorded once.
        dup = await self._act(rid, "call", client_action_id="click-1")
        self.assertTrue(dup["deduped"])
        self.assertEqual(dup["request"]["attempts"], 1)

        for _ in range(5):
            res = await self._act(rid, "call")
        self.assertEqual(res["request"]["attempts"], 4)

        listing = await self._list(level="n4")
        self.assertEqual([r["id"] for r in listing["requests"]], [rid])
        self.assertEqual(listing["level_counts"]["n4"], 1)
        self.assertEqual(listing["level_counts"]["new"], 0)

    async def test_ordered_closes_and_reopen_restores(self):
        rid = (await self._intake())["id"]
        await self._act(rid, "call")
        res = await self._act(rid, "ordered", order_ref="#1234")
        self.assertEqual(res["request"]["status"], "ordered")
        self.assertEqual(res["request"]["order_ref"], "#1234")
        self.assertIsNotNone(res["request"]["closed_at"])

        with self.assertRaises(HTTPException) as ctx:
            await self._act(rid, "call")
        self.assertEqual(ctx.exception.status_code, 409)

        closed = await self._list(level="closed")
        self.assertEqual([r["id"] for r in closed["requests"]], [rid])
        self.assertEqual((await self._list())["level_counts"]["total"], 0)

        res = await self._act(rid, "reopen")
        self.assertEqual(res["request"]["status"], "calling")
        self.assertIsNone(res["request"]["closed_at"])

    async def test_scopes_and_claiming(self):
        a = (await self._intake(phone="0611111111"))["id"]
        b = (await self._intake(phone="0622222222"))["id"]
        await self._act(a, "claim", user=self.other)

        mine = await self._list(scope="mine")
        self.assertEqual(mine["requests"], [])
        unassigned = await self._list(scope="unassigned")
        self.assertEqual([r["id"] for r in unassigned["requests"]], [b])
        self.assertEqual(unassigned["scope_counts"]["unassigned_new"], 1)

        with self.assertRaises(HTTPException) as ctx:
            await self._act(a, "claim")
        self.assertEqual(ctx.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            await self._act(a, "assign", assign_to=self.agent.id)
        res = await self._act(a, "assign", user=self.admin, assign_to=self.agent.id)
        self.assertEqual(res["request"]["assigned_to"]["id"], self.agent.id)

    async def test_pull_claims_unassigned_new_requests(self):
        for i in range(3):
            await self._intake(phone=f"061111111{i}")
        async with self.sessions() as session:
            res = await pull_chat_requests(body=ChatPullBody(store="irrakids", limit=2), db=session, user=self.agent)
        self.assertEqual(res["pulled"], 2)
        mine = await self._list(scope="mine")
        self.assertEqual(len(mine["requests"]), 2)

    async def test_search_by_phone_and_name(self):
        await self._intake(phone="0611111111", name="Sara")
        await self._intake(phone="0622222222", name="Youssef")
        by_phone = await self._list(q="+212 622222222")
        self.assertEqual([r["customer_name"] for r in by_phone["requests"]], ["Youssef"])
        by_name = await self._list(q="sar")
        self.assertEqual([r["customer_name"] for r in by_name["requests"]], ["Sara"])

    async def test_notes_history_and_team_stats(self):
        rid = (await self._intake())["id"]
        await self._act(rid, "call")
        await self._act(rid, "note", note="Call back after 6pm")
        await self._act(rid, "ordered")
        async with self.sessions() as session:
            row = await session.get(ChatRequest, rid)
            history = await chat_request_history(request_id=rid, db=session, user=self.agent)
            stats = await chat_team_stats(store="irrakids", db=session, user=self.agent)
        self.assertIn("Call back after 6pm", row.note)
        self.assertEqual(
            [e["action"] for e in history["events"]],
            ["ordered", "note", "call", "requested"],
        )
        mine = next(a for a in stats["agents"] if a["id"] == self.agent.id)
        self.assertEqual(mine["calls_today"], 1)
        self.assertEqual(mine["ordered_today"], 1)


if __name__ == "__main__":
    unittest.main()
