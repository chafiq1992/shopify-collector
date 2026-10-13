import test from "node:test";
import assert from "node:assert/strict";
import { getOrCreatePrintRequest, normalizePrintOrders, sendLocalOrders, sendRelayOrders, submitPrintOrders, withPrintLock } from "../src/lib/printSubmission.js";

const receipt = () => Response.json({ ok: true, job_id: "job-1", queued: 1 });

test("one relay job reports all 30 selected orders and never calls local printing", async () => {
  const orders = Array.from({ length: 30 }, (_, index) => String(index + 100));
  let relayCalls = 0;
  const result = await submitPrintOrders({
    orders, store: "irranova", requestId: "attempt-1", relayConfigured: true,
    enqueueRelay: async (...args) => {
      relayCalls++;
      assert.deepEqual(args, [orders, 1, undefined, "irranova", "attempt-1"]);
      return { ok: true, queued: 1 };
    },
    printLocal: async () => assert.fail("must not submit a second print"),
  });
  assert.equal(relayCalls, 1);
  assert.equal(result.message, "Queued 30 order(s) for printing");
});

test("normalization removes repeated representations of the same order", () => {
  assert.deepEqual(normalizePrintOrders(["#100", " 100 ", 101, "#101", ""]), ["100", "101"]);
});

test("same-store failed retry keeps its token while a successful new print or different store gets a new one", () => {
  const pending = { current: null };
  const original = getOrCreatePrintRequest(pending, "irrakids", ["100", "101"]);
  assert.equal(getOrCreatePrintRequest(pending, "irrakids", ["101", "100"]), original);
  assert.notEqual(getOrCreatePrintRequest(pending, "irranova", ["100", "101"]), original);
  const beforeSuccess = getOrCreatePrintRequest(pending, "irrakids", ["100", "101"]);
  pending.current = null;
  assert.notEqual(getOrCreatePrintRequest(pending, "irrakids", ["100", "101"]), beforeSuccess);
});

test("rapid overlapping print actions submit only once, then release the lock", async () => {
  const lock = { current: false };
  let finish;
  let submissions = 0;
  const action = () => { submissions++; return new Promise(resolve => { finish = resolve; }); };
  const first = withPrintLock(lock, action);
  const second = withPrintLock(lock, action);
  assert.equal(submissions, 1);
  assert.equal(lock.current, true);
  assert.equal(await second, undefined);
  finish("accepted");
  assert.equal(await first, "accepted");
  assert.equal(lock.current, false);
  await assert.rejects(withPrintLock(lock, async () => { throw new Error("failure"); }), /failure/);
  assert.equal(lock.current, false);
});

for (const status of [401, 403, 409, 422, 500, 502]) {
  test(`relay HTTP ${status} never tries legacy or local printing`, async () => {
    const calls = [];
    await assert.rejects(submitPrintOrders({
      orders: ["100"], requestId: "attempt-1", relayConfigured: true,
      enqueueRelay: () => sendRelayOrders({
        base: "https://relay.example", body: "{}", headers: {}, legacyHeaders: {},
        fetchFn: async url => { calls.push(url); return Response.json({ detail: "enqueue rejected" }, { status }); },
      }),
      printLocal: async () => assert.fail("failure must not create another print"),
    }), /enqueue rejected/);
    assert.deepEqual(calls, ["https://relay.example/api/enqueue-orders"]);
  });
}

test("lost relay response never retries a possibly accepted print", async () => {
  let calls = 0;
  await assert.rejects(submitPrintOrders({
    orders: ["100"], requestId: "attempt-1", relayConfigured: true,
    enqueueRelay: () => sendRelayOrders({
      base: "https://relay.example", body: "{}", headers: {}, legacyHeaders: {},
      fetchFn: async () => { calls++; throw new TypeError("Failed to fetch"); },
    }),
    printLocal: async () => assert.fail("lost response must not create another print"),
  }), /may already be queued/);
  assert.equal(calls, 1);
});

test("invalid receipt never triggers another route or success message", async () => {
  let calls = 0;
  const result = await sendRelayOrders({
    base: "https://relay.example", body: "{}", headers: {}, legacyHeaders: {},
    fetchFn: async () => { calls++; return new Response("invalid json", { status: 200 }); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /may already be queued/);
  assert.equal(calls, 1);
});

for (const invalid of [{}, { ok: true }, { ok: true, job_id: "" }, { job_id: "job-1" }]) {
  test(`incomplete JSON receipt ${JSON.stringify(invalid)} is not reported as queued`, async () => {
    let calls = 0;
    const result = await sendRelayOrders({
      base: "https://relay.example", body: "{}", headers: {}, legacyHeaders: {},
      fetchFn: async () => { calls++; return Response.json(invalid); },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid receipt/);
    assert.equal(calls, 1);
  });
}

test("retained failed receipt is an error and never creates a fallback print", async () => {
  await assert.rejects(submitPrintOrders({
    orders: ["100"], requestId: "attempt-1", relayConfigured: true,
    enqueueRelay: () => sendRelayOrders({
      base: "https://relay.example", body: "{}", headers: {}, legacyHeaders: {},
      fetchFn: async () => Response.json({ ok: true, job_id: "job-1", dedup: true, status: "failed", error: "Printer unavailable" }),
    }),
    printLocal: async () => assert.fail("failed receipt must not create another print"),
  }), /Printer unavailable/);
});

test("completed retry receipt says already submitted instead of queued again", async () => {
  const result = await submitPrintOrders({
    orders: ["100"], requestId: "attempt-1", relayConfigured: true,
    enqueueRelay: () => sendRelayOrders({
      base: "https://relay.example", body: "{}", headers: {}, legacyHeaders: {},
      fetchFn: async () => Response.json({ ok: true, job_id: "job-1", dedup: true, status: "completed" }),
    }),
  });
  assert.equal(result.title, "Already sent to printer");
});

test("local transport permits a 120-second batch and sends the request token exactly once", async () => {
  let cancelled;
  const body = JSON.stringify({ orders: ["100"], request_id: "attempt-1" });
  const result = await sendLocalOrders({
    base: "http://127.0.0.1:8787", body, headers: {},
    schedule: (_callback, delay) => { assert.equal(delay, 120000); return "timer"; },
    cancel: timer => { cancelled = timer; },
    fetchFn: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8787/print/orders");
      assert.equal(options.body, body);
      assert.equal(options.signal.aborted, false);
      return Response.json({ ok: true, results: [{ order: "100", printed: true }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(cancelled, "timer");
});

test("local timeout warns the batch may still print and does not claim success", async () => {
  let abort;
  let cancelled = false;
  const submission = sendLocalOrders({
    base: "http://127.0.0.1:8787", body: "{}", headers: {},
    schedule: callback => { abort = callback; return "timer"; },
    cancel: () => { cancelled = true; },
    fetchFn: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
    }),
  });
  abort();
  const result = await submission;
  assert.equal(result.ok, false);
  assert.equal(result.error, "Local print response timed out; the batch may still be printing. Check the printer before retrying.");
  assert.equal(cancelled, true);
});

for (const status of [404, 405]) {
  test(`missing route HTTP ${status} uses legacy with exactly the same request token/body`, async () => {
    const calls = [];
    const body = JSON.stringify({ orders: ["100"], copies: 1, pc_id: "pc-1", request_id: "attempt-1" });
    const result = await sendRelayOrders({
      base: "https://relay.example", body,
      headers: { Authorization: "Bearer app-token" }, legacyHeaders: { "x-api-key": "relay-token" },
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1 ? new Response("", { status }) : receipt();
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(call => call.url), ["https://relay.example/api/enqueue-orders", "https://relay.example/enqueue"]);
    assert.equal(calls[0].options.body, body);
    assert.equal(calls[1].options.body, body);
    assert.deepEqual(calls[1].options.headers, { "x-api-key": "relay-token" });
  });
}

test("explicitly absent relay uses local once with the same request token", async () => {
  let localCalls = 0;
  const result = await submitPrintOrders({
    orders: ["#100", "100"], store: "irrakids", requestId: "attempt-1", relayConfigured: false,
    enqueueRelay: async () => assert.fail("no relay configured"),
    printLocal: async (...args) => {
      localCalls++;
      assert.deepEqual(args, [["100"], 1, "irrakids", "attempt-1"]);
      return { ok: true, results: [{ order: "100", printed: true }] };
    },
  });
  assert.equal(localCalls, 1);
  assert.equal(result.message, "Sent 1 order(s) to printer");
});

test("partial local failure is reported as failure", async () => {
  await assert.rejects(submitPrintOrders({
    orders: ["100", "101"], requestId: "attempt-1", relayConfigured: false,
    printLocal: async () => ({ ok: true, results: [{ order: "100", printed: true }, { order: "101", printed: false }] }),
  }), /1 order\(s\) could not be printed/);
});
