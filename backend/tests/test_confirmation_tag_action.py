import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.confirmation_routes import (
    AgentTagActionBody,
    _tz,
    admin_confirmation_stats,
    agent_tag_action,
)
from backend.app.db import Base
from backend.app.models import OrderEvent, User


class ReliableConfirmationActionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            self.user = User(
                id="collector-acting-in-confirmation",
                email="helper@example.com",
                name="Helper",
                password_hash="unused",
                role="collector",
                is_active=True,
                agent_tags=["helper"],
            )
            session.add(self.user)
            await session.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_non_agent_confirmation_click_is_saved_and_counted(self):
        body = AgentTagActionBody(
            order_id="gid://shopify/Order/123",
            tag="n1",
            op="add",
            store="irranova",
            client_action_id="action-12345678",
            actor_id=self.user.id,
        )
        add_tag = AsyncMock(return_value={"ok": True})
        with patch("backend.app.main._shopify_add_tag", add_tag):
            async with self.sessions() as session:
                result = await agent_tag_action(body=body, user=self.user, db=session)

        self.assertTrue(result["ok"])
        self.assertTrue(result["audited"])
        self.assertFalse(result["deduped"])
        add_tag.assert_awaited_once()

        async with self.sessions() as session:
            event = await session.scalar(
                select(OrderEvent).where(OrderEvent.client_action_id == body.client_action_id)
            )
        self.assertIsNotNone(event)
        self.assertEqual(event.action, "confirmation_phone_n1")
        self.assertEqual(event.event_metadata["source"], "confirmation")
        self.assertEqual(event.event_metadata["role"], "collector")
        self.assertTrue(event.event_metadata["confirmation_actor"])

    async def test_replayed_click_returns_success_without_second_shopify_write(self):
        body = AgentTagActionBody(
            order_id="gid://shopify/Order/456",
            tag="cod 03/08/26",
            op="add",
            store="irranova",
            client_action_id="action-87654321",
            actor_id=self.user.id,
        )
        add_tag = AsyncMock(return_value={"ok": True})
        with patch("backend.app.main._shopify_add_tag", add_tag):
            async with self.sessions() as session:
                first = await agent_tag_action(body=body, user=self.user, db=session)
            async with self.sessions() as session:
                second = await agent_tag_action(body=body, user=self.user, db=session)

        self.assertFalse(first["deduped"])
        self.assertTrue(second["deduped"])
        self.assertTrue(second["audited"])
        add_tag.assert_awaited_once()

    async def test_confirmation_actor_is_visible_in_admin_counter_despite_role(self):
        body = AgentTagActionBody(
            order_id="gid://shopify/Order/789",
            tag="n2",
            op="add",
            store="irranova",
            client_action_id="action-counter-1234",
            actor_id=self.user.id,
        )
        with patch(
            "backend.app.main._shopify_add_tag",
            AsyncMock(return_value={"ok": True}),
        ):
            async with self.sessions() as session:
                await agent_tag_action(body=body, user=self.user, db=session)

        day = datetime.now(_tz()).date().isoformat()
        async with self.sessions() as session:
            report = await admin_confirmation_stats(
                from_date=day,
                to_date=day,
                store="irranova",
                db=session,
                _=self.user,
            )

        row = next(item for item in report["rows"] if item["user_id"] == self.user.id)
        self.assertEqual(row["n2"], 1)
        self.assertEqual(report["summary"]["n2"], 1)


if __name__ == "__main__":
    unittest.main()
