"""Print retries must never create or claim a second copy of a batch."""
import asyncio
import time
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app import main
from backend.app.models import PrintJob


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def queue(monkeypatch, tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'print.db').as_posix()}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def setup():
        async with engine.begin() as conn:
            await conn.run_sync(PrintJob.__table__.create)

    run(setup())
    monkeypatch.setattr(main, "SessionLocal", sessions)
    monkeypatch.setattr(main, "PCS", {"test-pc": "secret", "other-pc": "other-secret"})
    monkeypatch.setattr(main, "WORKER_LOOPS", True)
    monkeypatch.setattr(main, "JOB_STORE", {})
    yield sessions
    run(engine.dispose())


def payload(job_id=None, orders=None):
    return {"job_id": job_id or uuid.uuid4().hex, "orders": orders or [str(n) for n in range(1000, 1030)], "copies": 1, "ts": int(time.time()), "store": "irrakids"}


async def pull(pc="test-pc", secret="secret", **kwargs):
    return await main.pull(pc_id=pc, x_pc_secret=secret, secret=None, **kwargs)


def test_two_agents_claim_30_orders_only_once(queue):
    async def scenario():
        await main._enqueue_job("test-pc", payload(), "orders:batch")
        results = await asyncio.gather(pull(), pull())
        claimed = [job for result in results for job in result["jobs"]]
        assert len(claimed) == 1
        assert len(claimed[0]["orders"]) == 30
    run(scenario())


def test_simultaneous_submissions_create_one_batch(queue):
    async def scenario():
        results = await asyncio.gather(*[
            main._enqueue_job("test-pc", payload(), "orders:same-batch") for _ in range(8)
        ])
        assert len({result["job_id"] for result in results}) == 1
        assert len((await pull())["jobs"]) == 1
    run(scenario())


def test_active_batch_stays_deduplicated_after_click_window(queue):
    async def scenario():
        first = payload()
        await main._enqueue_job("test-pc", first, "orders:same-batch")
        async with queue() as session:
            from datetime import datetime, timedelta, timezone
            await session.execute(update(PrintJob).values(created_at=datetime.now(timezone.utc) - timedelta(minutes=5)))
            await session.commit()
        duplicate = await main._enqueue_job("test-pc", payload(), "orders:same-batch")
        assert duplicate["dedup"] is True
        assert duplicate["job_id"] == first["job_id"]
    run(scenario())


def test_request_retry_after_print_ack_does_not_reprint(queue):
    async def scenario():
        job = payload(main._print_job_id("test-pc", "browser-request"))
        await main._enqueue_job("test-pc", job)
        await pull()
        await main.ack(main.AckBody(pc_id="test-pc", secret="secret", job_id=job["job_id"]))
        duplicate = await main._enqueue_job("test-pc", job)
        assert duplicate["dedup"] is True
        assert duplicate["status"] == "completed"
        assert (await pull())["jobs"] == []
    run(scenario())


def test_lost_dedup_response_retry_after_window_does_not_reprint(queue):
    async def scenario():
        original, duplicate = payload(), payload()
        await main._enqueue_job("test-pc", original, "orders:same")
        await main._enqueue_job("test-pc", duplicate, "orders:same")
        await pull()
        await main.ack(main.AckBody(pc_id="test-pc", secret="secret", job_id=original["job_id"]))
        async with queue() as session:
            from datetime import datetime, timedelta, timezone
            await session.execute(update(PrintJob).values(created_at=datetime.now(timezone.utc) - timedelta(minutes=5)))
            await session.commit()
        retry = await main._enqueue_job("test-pc", duplicate, "orders:same")
        assert retry["job_id"] == original["job_id"]
        assert retry["status"] == "completed"
        assert (await pull())["jobs"] == []
    run(scenario())


@pytest.mark.parametrize("changed", [{"store": "other-store"}, {"orders": ["9999"]}, {"copies": 2}, {"pdf_url": "https://example.test/other.pdf"}])
def test_request_id_cannot_be_reused_for_changed_content(queue, changed):
    async def scenario():
        job = payload(main._print_job_id("test-pc", "same-request"))
        await main._enqueue_job("test-pc", job)
        with pytest.raises(HTTPException) as exc:
            await main._enqueue_job("test-pc", {**job, **changed})
        assert exc.value.status_code == 409
        assert (await pull())["jobs"][0]["orders"] == job["orders"]
    run(scenario())


def test_expired_agent_cannot_renew_nack_or_ack_a_new_claim(queue):
    async def scenario():
        job = payload()
        await main._enqueue_job("test-pc", job)
        first = (await pull())["jobs"][0]
        async with queue() as session:
            await session.execute(update(PrintJob).values(leased_at=int(time.time()) - 100))
            await session.commit()
        second = (await pull())["jobs"][0]
        assert second["lease_attempt"] == first["lease_attempt"] + 1
        stale = main.AckBody(pc_id="test-pc", secret="secret", job_id=job["job_id"], lease_attempt=first["lease_attempt"])
        assert (await main.renew(stale))["renewed"] is False
        await main.nack(stale)
        with pytest.raises(HTTPException) as exc:
            await main.ack(stale)
        assert exc.value.status_code == 409
        async with queue() as session:
            assert await session.scalar(select(PrintJob.status)) == "inflight"
        current = main.AckBody(pc_id="test-pc", secret="secret", job_id=job["job_id"], lease_attempt=second["lease_attempt"])
        assert (await main.renew(current))["renewed"] is True
        await main.ack(current)
        assert (await pull())["jobs"] == []
    run(scenario())


def test_batch_heartbeat_prevents_reclaim(queue):
    async def scenario():
        job = payload()
        await main._enqueue_job("test-pc", job)
        await pull()
        async with queue() as session:
            await session.execute(update(PrintJob).values(leased_at=int(time.time()) - 89))
            await session.commit()
        result = await main.renew(main.AckBody(pc_id="test-pc", secret="secret", job_id=job["job_id"]))
        assert result["renewed"] is True
        assert (await pull())["jobs"] == []
    run(scenario())


def test_ambiguous_spool_failure_is_held_for_manual_review(queue):
    async def scenario():
        job = payload()
        await main._enqueue_job("test-pc", job)
        await pull()
        result = await main.nack(main.AckBody(pc_id="test-pc", secret="secret", job_id=job["job_id"], retry=False))
        assert result["status"] == "failed"
        assert (await pull())["jobs"] == []
    run(scenario())


def test_late_nack_cannot_requeue_acknowledged_print(queue):
    async def scenario():
        job = payload()
        await main._enqueue_job("test-pc", job)
        await pull()
        body = main.AckBody(pc_id="test-pc", secret="secret", job_id=job["job_id"])
        await main.ack(body)
        assert (await main.nack(body))["status"] == "completed"
        assert (await pull())["jobs"] == []
    run(scenario())


def test_simultaneous_ack_and_nack_preserve_completion(queue):
    async def scenario():
        for _ in range(10):
            job = payload()
            await main._enqueue_job("test-pc", job)
            await pull()
            body = main.AckBody(pc_id="test-pc", secret="secret", job_id=job["job_id"])
            await asyncio.gather(main.ack(body), main.nack(body))
            async with queue() as session:
                assert await session.scalar(select(PrintJob.status).where(PrintJob.job_id == job["job_id"])) == "completed"
        assert (await pull())["jobs"] == []
    run(scenario())


def test_expired_final_attempt_is_failed_and_not_reclaimed(queue):
    async def scenario():
        job = payload()
        await main._enqueue_job("test-pc", job)
        async with queue() as session:
            await session.execute(update(PrintJob).values(status="inflight", attempts=4, leased_at=int(time.time()) - 100))
            await session.commit()
        assert (await pull())["jobs"] == []
        async with queue() as session:
            assert await session.scalar(select(PrintJob.status)) == "failed"
    run(scenario())


def test_same_batch_on_different_printers_is_not_deduplicated(queue):
    async def scenario():
        one = await main._enqueue_job("test-pc", payload(), "orders:same")
        two = await main._enqueue_job("other-pc", payload(), "orders:same")
        assert one["job_id"] != two["job_id"]
        assert len((await pull())["jobs"]) == 1
        assert len((await pull("other-pc", "other-secret"))["jobs"]) == 1
    run(scenario())


@pytest.mark.parametrize("operation", ["enqueue", "ack", "nack", "renew", "pull"])
def test_queue_outage_is_not_reported_as_success_or_fallback(monkeypatch, operation):
    def unavailable():
        raise RuntimeError("simulated queue outage")
    monkeypatch.setattr(main, "SessionLocal", unavailable)
    monkeypatch.setattr(main, "PCS", {"test-pc": "secret"})
    monkeypatch.setattr(main, "WORKER_LOOPS", True)
    monkeypatch.setattr(main, "JOB_STORE", {})
    body = main.AckBody(pc_id="test-pc", secret="secret", job_id="jid")
    coro = main._enqueue_job("test-pc", payload()) if operation == "enqueue" else pull() if operation == "pull" else getattr(main, operation)(body)
    with pytest.raises(HTTPException) as exc:
        run(coro)
    assert exc.value.status_code == 503
    assert main.JOB_STORE == {}


def test_print_order_normalization_removes_duplicate_labels():
    assert main._print_order_numbers(["#1001", "1001", " #1002 ", "", "  "]) == ["1001", "1002"]


def _label_readiness(monkeypatch, result):
    from backend.app import delivery_sync

    async def readiness(**kwargs):
        return result

    monkeypatch.setattr(delivery_sync, "check_label_readiness", readiness)


def test_label_is_not_queued_until_the_order_lands_in_its_envoy(queue, monkeypatch):
    _label_readiness(monkeypatch, {"ok": False, "status": 409, "reason": "not_accepted",
                                   "message": "glog has not accepted this order yet."})
    body = main.EnqueueLabelBody(delivery_order_id="4242", store="irrakids", envoy_code="EN-1")
    with pytest.raises(HTTPException) as exc:
        run(main.enqueue_label(body, x_api_key=main.RELAY_API_KEY, authorization=None))
    assert exc.value.status_code == 409
    assert exc.value.detail == "glog has not accepted this order yet."

    async def queued():
        async with queue() as session:
            return (await session.scalars(select(PrintJob))).all()

    assert run(queued()) == []


def test_ready_label_is_queued_with_the_current_envoy(queue, monkeypatch):
    _label_readiness(monkeypatch, {"ok": True, "envoyCode": "EN-2", "company": "Kech", "partnerApi": False})
    body = main.EnqueueLabelBody(delivery_order_id="4242", store="irrakids", envoy_code=None)
    result = run(main.enqueue_label(body, x_api_key=main.RELAY_API_KEY, authorization=None))
    assert result["ok"] is True

    async def queued():
        async with queue() as session:
            return (await session.scalars(select(PrintJob))).all()

    jobs = run(queued())
    assert [(job.payload["delivery_order_id"], job.payload["envoy_code"]) for job in jobs] == [("4242", "EN-2")]


def test_memory_queue_keeps_completion_receipt(monkeypatch):
    monkeypatch.setattr(main, "SessionLocal", None)
    monkeypatch.setattr(main, "JOB_STORE", {})
    monkeypatch.setattr(main, "PCS", {"test-pc": "secret"})
    monkeypatch.setattr(main, "WORKER_LOOPS", True)
    async def scenario():
        job = payload()
        await main._enqueue_job("test-pc", job)
        await pull()
        await main.ack(main.AckBody(pc_id="test-pc", secret="secret", job_id=job["job_id"]))
        assert (await main._enqueue_job("test-pc", job))["dedup"] is True
        assert (await pull())["jobs"] == []
    run(scenario())
