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
    chat_request_conversation,
    chat_request_history,
    chat_team_stats,
    create_chat_request,
    list_chat_requests,
    normalize_phone,
    pull_chat_requests,
)
from backend.app.db import Base
from backend.app.models import ChatLabel, ChatRequest, ChatRequestEvent, User


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

        # An ordered request is listed under Ordered only, never also under Closed.
        ordered = await self._list(level="ordered")
        self.assertEqual([r["id"] for r in ordered["requests"]], [rid])
        closed = await self._list(level="closed")
        self.assertEqual(closed["requests"], [])
        counts = (await self._list())["level_counts"]
        self.assertEqual((counts["total"], counts["closed"], counts["ordered"]), (0, 0, 1))

        res = await self._act(rid, "reopen")
        self.assertEqual(res["request"]["status"], "calling")
        self.assertIsNone(res["request"]["closed_at"])

    async def test_cancelled_has_its_own_view(self):
        lost = (await self._intake(phone="0611111111"))["id"]
        await self._act(lost, "not_interested")
        cancelled = (await self._intake(phone="0622222222"))["id"]
        await self._act(cancelled, "cancelled")
        # An ordered request can be cancelled later, and keeps its order number.
        was_ordered = (await self._intake(phone="0633333333"))["id"]
        await self._act(was_ordered, "ordered", order_ref="#1500")
        res = await self._act(was_ordered, "cancelled")
        self.assertEqual((res["request"]["status"], res["request"]["order_ref"]), ("cancelled", "#1500"))

        view = await self._list(level="cancelled")
        self.assertEqual(sorted(r["id"] for r in view["requests"]), sorted([cancelled, was_ordered]))
        self.assertEqual([r["id"] for r in (await self._list(level="closed"))["requests"]], [lost])
        self.assertEqual((await self._list(level="ordered"))["requests"], [])
        counts = view["level_counts"]
        self.assertEqual((counts["closed"], counts["cancelled"], counts["ordered"]), (1, 2, 0))

        # Other closing actions still need a reopen first.
        with self.assertRaises(HTTPException) as ctx:
            await self._act(lost, "cancelled")
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual((await self._act(cancelled, "reopen"))["request"]["status"], "new")

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


# Website chat viewer links (added to the shared fixture class).
async def test_website_chat_link_is_signed_short_lived_and_only_for_storefront_chats(self):
    import hashlib, hmac, re, time
    request = _FakeRequest()
    request.headers['x-chat-intake-key'] = 'shared-test-key'
    sid = 'a' * 32
    body = ChatRequestIntakeBody(store='irrakids', phone='0612345678', message='Customer: hi', source_id=f'storefront:{sid}:3')
    with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key', 'CHAT_VIEW_BASE_URL': 'https://chat.example'}):
        async with self.sessions() as session:
            created = await routes.integration_chat_request(body=body, request=request, db=session)
        rid = created['request']['id'] if 'request' in created else created['id']
        async with self.sessions() as session:
            result = await chat_request_conversation(request_id=rid, db=session, user=self.agent)
    match = re.fullmatch(r'https://chat\.example/storefront/chat-view/' + sid + r'\?token=(\d+)\.([a-f0-9]{64})', result['url'])
    self.assertIsNotNone(match)
    expires = int(match[1])
    self.assertTrue(time.time() < expires <= time.time() + 12 * 3600 + 5)
    expected = hmac.new(b'shared-test-key', f'chat-view:{sid}:{expires}'.encode(), hashlib.sha256).hexdigest()
    self.assertEqual(match[2], expected)

async def test_requests_without_a_website_chat_have_no_link(self):
    await self._intake()
    async with self.sessions() as session:
        rid = (await session.scalar(select(ChatRequest.id)))
        with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key'}):
            with self.assertRaises(HTTPException) as caught:
                await chat_request_conversation(request_id=rid, db=session, user=self.agent)
    self.assertEqual(caught.exception.status_code, 404)


ChatRequestTests.test_website_chat_link_is_signed_short_lived_and_only_for_storefront_chats = test_website_chat_link_is_signed_short_lived_and_only_for_storefront_chats
ChatRequestTests.test_requests_without_a_website_chat_have_no_link = test_requests_without_a_website_chat_have_no_link
del test_website_chat_link_is_signed_short_lived_and_only_for_storefront_chats, test_requests_without_a_website_chat_have_no_link


# Chats where the website AI placed the order (added to the shared fixture class).
async def test_ordered_website_chat_closes_its_callback_and_shows_under_ordered(self):
    request = _FakeRequest()
    request.headers['x-chat-intake-key'] = 'shared-test-key'
    sid = 'c' * 32
    with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key'}):
        async with self.sessions() as db:
            lead = await routes.integration_chat_request(ChatRequestIntakeBody(store='irrakids', phone='0612345678', message='Customer: hi', source_id=f'storefront:{sid}:1'), request, db)
        await self._act(lead['id'], 'claim')
        body = ChatRequestIntakeBody(store='irrakids', phone='0612345678', message='Customer: hi\n\nStore: done', source_id=f'storefront:{sid}:order', order_ref='4455', outcome='ordered')
        async with self.sessions() as db:
            ordered = await routes.integration_chat_request(body, request, db)
        async with self.sessions() as db:
            again = await routes.integration_chat_request(body, request, db)
            saved = await db.get(ChatRequest, lead['id'])
    self.assertEqual((ordered['id'], again['id']), (lead['id'], lead['id']))
    self.assertEqual((saved.status, saved.order_ref, saved.message), ('ordered', '4455', 'Customer: hi\n\nStore: done'))
    listed = await self._list(user=self.other, scope='mine', level='ordered')
    self.assertEqual([r['id'] for r in listed['requests']], [lead['id']])
    self.assertEqual(listed['level_counts']['ordered'], 1)
    self.assertEqual((await self._list(level=None))['total'], 0)


async def test_ordered_chat_without_a_callback_is_created_closed_with_its_chat_link(self):
    request = _FakeRequest()
    request.headers['x-chat-intake-key'] = 'shared-test-key'
    sid = 'd' * 32
    body = ChatRequestIntakeBody(store='irrakids', phone='0699887766', name='Sara', message='Customer: bghit had sbbat', source_id=f'storefront:{sid}:order', order_ref='7788', outcome='ordered', product_title='Boots')
    with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key'}):
        async with self.sessions() as db:
            created = await routes.integration_chat_request(body, request, db)
        async with self.sessions() as db:
            saved = await db.get(ChatRequest, created['id'])
            link = await chat_request_conversation(request_id=created['id'], db=db, user=self.agent)
    self.assertEqual((saved.status, saved.order_ref, saved.customer_name, saved.product_title), ('ordered', '7788', 'Sara', 'Boots'))
    self.assertIsNotNone(saved.closed_at)
    self.assertIn('/storefront/chat-view/' + sid, link['url'])
    # The customer came back and wrote more: same request, longer chat, no second order.
    later = ChatRequestIntakeBody(**{**body.model_dump(), 'message': body.message + '\n\nCustomer: imta ywsal?', 'source_id': f'storefront:{sid}:order:9'})
    with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key'}):
        async with self.sessions() as db:
            again = await routes.integration_chat_request(later, request, db)
        async with self.sessions() as db:
            saved = await db.get(ChatRequest, created['id'])
            actions = (await db.execute(select(ChatRequestEvent.action).where(ChatRequestEvent.request_id == created['id']))).scalars().all()
    self.assertEqual(again['id'], created['id'])
    self.assertTrue(saved.message.endswith('imta ywsal?'))
    self.assertEqual(sorted(actions), ['chat_updated', 'ordered'])


async def test_public_intake_cannot_mark_a_request_ordered(self):
    await self._intake(outcome='ordered', order_ref='1')
    async with self.sessions() as session:
        saved = await session.scalar(select(ChatRequest))
    self.assertEqual(saved.status, 'new')


for _test in (test_ordered_website_chat_closes_its_callback_and_shows_under_ordered,
              test_ordered_chat_without_a_callback_is_created_closed_with_its_chat_link,
              test_public_intake_cannot_mark_a_request_ordered):
    setattr(ChatRequestTests, _test.__name__, _test)
del _test, test_ordered_website_chat_closes_its_callback_and_shows_under_ordered
del test_ordered_chat_without_a_callback_is_created_closed_with_its_chat_link, test_public_intake_cannot_mark_a_request_ordered


# Reason labels after talking to the customer (added to the shared fixture class).
async def test_stores_start_with_the_usual_reasons_and_agents_can_add_more(self):
    async with self.sessions() as db:
        first = await routes.list_chat_labels(store="irrakids", db=db, user=self.agent)
    self.assertEqual([l["key"] for l in first["labels"]], ["size", "only_ask", "price", "later", "no_answer", "other"])
    async with self.sessions() as db:
        added = await routes.create_chat_label(routes.ChatLabelBody(store="irrakids", name="  Delivery   time "), db=db, user=self.agent)
        again = await routes.create_chat_label(routes.ChatLabelBody(store="irrakids", name="delivery time"), db=db, user=self.other)
        arabic = await routes.create_chat_label(routes.ChatLabelBody(store="irrakids", name="التوصيل غالي"), db=db, user=self.agent)
    self.assertEqual((added["label"]["name"], added["label"]["key"]), ("Delivery time", "delivery_time"))
    self.assertTrue(again["existing"])
    self.assertEqual(again["label"]["id"], added["label"]["id"])
    self.assertEqual(arabic["label"]["key"], "label")
    async with self.sessions() as db:
        with self.assertRaises(HTTPException) as caught:
            await routes.update_chat_label(added["label"]["id"], routes.ChatLabelBody(archived=True), db=db, user=self.agent)
        self.assertEqual(caught.exception.status_code, 403)
        await routes.update_chat_label(added["label"]["id"], routes.ChatLabelBody(archived=True), db=db, user=self.admin)
    async with self.sessions() as db:
        shown = await routes.list_chat_labels(store="irrakids", db=db, user=self.agent)
        other_store = await routes.list_chat_labels(store="irranova", db=db, user=self.agent)
    self.assertNotIn("Delivery time", [l["name"] for l in shown["labels"]])
    self.assertEqual(len(other_store["labels"]), 6)
    # A store set up before "Other" existed gets it, last, without duplicates.
    async with self.sessions() as db:
        await db.execute(ChatLabel.__table__.delete().where(ChatLabel.store_key == "irranova", ChatLabel.key == "other"))
        await db.commit()
        again = await routes.list_chat_labels(store="irranova", db=db, user=self.agent)
        twice = await routes.list_chat_labels(store="irranova", db=db, user=self.agent)
    self.assertEqual([l["key"] for l in again["labels"]][-1], "other")
    self.assertEqual(len(twice["labels"]), 6)


async def test_labels_on_requests_filter_the_queue_and_explain_lost_customers(self):
    for phone in ("0611111111", "0622222222", "0633333333", "0644444444"):
        await self._intake(phone=phone)
    async with self.sessions() as db:
        labels = {l["key"]: l["id"] for l in (await routes.list_chat_labels(store="irrakids", db=db, user=self.agent))["labels"]}
        ids = [r.id for r in (await db.execute(select(ChatRequest).order_by(ChatRequest.id))).scalars()]
    one, two, three, four = ids
    result = await self._act(one, "labels", labels=[labels["price"], labels["later"]])
    self.assertEqual([l["name"] for l in result["request"]["labels"]], ["Price", "Later"])
    await self._act(one, "not_interested")
    await self._act(two, "labels", labels=[labels["price"]])
    await self._act(two, "ordered", order_ref="1001")
    await self._act(three, "labels", labels=[labels["size"]])
    await self._act(four, "wrong_number")
    # Changing the set replaces it, and the history says what changed.
    await self._act(three, "labels", labels=[labels["size"], labels["no_answer"]])
    updated = await self._act(three, "labels", labels=[labels["no_answer"]])
    self.assertEqual([l["key"] for l in updated["request"]["labels"]], ["no_answer"])
    async with self.sessions() as db:
        history = await chat_request_history(request_id=three, db=db, user=self.agent)
    self.assertIn({"added": [], "removed": ["Size"]}, [{k: e["detail"].get(k) for k in ("added", "removed")} for e in history["events"] if e["action"] == "labels"])
    with self.assertRaises(HTTPException):
        await self._act(three, "labels", labels=[999999])
    # The queue filters by reason, across every status, for the whole team.
    priced = await self._list(user=self.other, scope="mine", level="any", label=labels["price"])
    self.assertEqual(sorted(r["id"] for r in priced["requests"]), [one, two])
    lost = await self._list(user=self.other, scope="mine", level="lost")
    self.assertEqual(sorted(r["id"] for r in lost["requests"]), [one, four])
    async with self.sessions() as db:
        report = await routes.chat_request_reasons(store="irrakids", days=30, db=db, user=self.agent)
    self.assertEqual(report["outcomes"], {"ordered": 1, "not_interested": 1, "wrong_number": 1, "open": 1})
    rows = {r["key"]: r for r in report["labels"]}
    self.assertEqual({k: rows["price"][k] for k in ("total", "ordered", "lost", "open")}, {"total": 2, "ordered": 1, "lost": 1, "open": 0})
    self.assertEqual(rows["no_answer"]["open"], 1)
    self.assertEqual(report["labels"][0]["key"], "price")  # most lost customers first
    self.assertEqual((report["lost_without_label"], report["labelled"]), (1, 3))


for _test in (test_stores_start_with_the_usual_reasons_and_agents_can_add_more,
              test_labels_on_requests_filter_the_queue_and_explain_lost_customers):
    setattr(ChatRequestTests, _test.__name__, _test)
del _test, test_stores_start_with_the_usual_reasons_and_agents_can_add_more, test_labels_on_requests_filter_the_queue_and_explain_lost_customers


async def test_label_pills_count_requests_in_the_current_view(self):
    async with self.sessions() as db:
        labels = {l["key"]: l["id"] for l in (await routes.list_chat_labels(store="irrakids", db=db, user=self.agent))["labels"]}
    a = (await self._intake(phone="0611111111"))["id"]
    b = (await self._intake(phone="0622222222"))["id"]
    c = (await self._intake(phone="0633333333"))["id"]
    await self._act(a, "labels", labels=[labels["size"], labels["price"]])
    await self._act(b, "labels", labels=[labels["size"]])
    await self._act(c, "labels", labels=[labels["size"]])
    await self._act(c, "not_interested")

    open_view = await self._list()
    self.assertEqual(open_view["label_counts"], {str(labels["size"]): 2, str(labels["price"]): 1})
    # Filtering by one label keeps the other pills' counts for the same view.
    by_price = await self._list(label=labels["price"])
    self.assertEqual([r["id"] for r in by_price["requests"]], [a])
    self.assertEqual(by_price["label_counts"][str(labels["size"])], 2)
    closed = await self._list(level="closed")
    self.assertEqual(closed["label_counts"], {str(labels["size"]): 1})


setattr(ChatRequestTests, "test_label_pills_count_requests_in_the_current_view", test_label_pills_count_requests_in_the_current_view)
del test_label_pills_count_requests_in_the_current_view
