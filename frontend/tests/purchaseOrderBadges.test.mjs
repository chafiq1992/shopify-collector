import assert from "node:assert/strict";
import test from "node:test";
import { applyPurchaseOrderBadges, badgeVariantInputs, createPurchaseOrderWatcher } from "../src/lib/purchaseOrderBadges.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
test("deleted variants cannot make badge input invalid for the rest of the order", () => {
  assert.deepEqual(badgeVariantInputs([{id:null},{id:'deleted-line-1'},{id:'gid://shopify/ProductVariant/1',inventory_item_id:''},{id:'gid://shopify/ProductVariant/2',inventory_item_id:'gid://shopify/InventoryItem/2'}]),[
    {id:'gid://shopify/ProductVariant/1',inventory_item_id:null},
    {id:'gid://shopify/ProductVariant/2',inventory_item_id:'gid://shopify/InventoryItem/2'},
  ]);
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function timers() {
  const pending = new Map(); let id = 0;
  return { pending, setTimer: (fn, delay) => { pending.set(++id, { fn, delay }); return id; }, clearTimer: (key) => pending.delete(key) };
}

test("badge updates preserve order edits, stock and fulfillment and remove completed badges", () => {
  const order = { id: "order", tags: ["edited"], note: "edited note", variants: [{ id: "v1", status: "fulfilled", on_hand_quantity: 5, pending_purchase_orders: [{ id: 1 }] }, { id: "v2", qty: 2 }] };
  const result = applyPurchaseOrderBadges(order, { v1: [], v2: [{ id: 2 }] });
  assert.deepEqual(result.variants[0].pending_purchase_orders, []);
  assert.deepEqual(result.variants[1].pending_purchase_orders, [{ id: 2 }]);
  assert.equal(result.tags, order.tags);
  assert.equal(result.note, order.note);
  assert.equal(result.variants[0].status, "fulfilled");
  assert.equal(result.variants[0].on_hand_quantity, 5);
  assert.deepEqual(order.variants[0].pending_purchase_orders, [{ id: 1 }]);
});

test("a cold refresh never overlaps; loading polls become periodic when hydration completes", async () => {
  const clock = timers(), first = deferred(), second = deferred(), states = [], results = []; let calls = 0;
  const watcher = createPurchaseOrderWatcher({ ...clock, fetchBadges: () => (++calls === 1 ? first.promise : second.promise), onState: (s) => states.push(s), onResult: (r) => results.push(r) });
  await watcher.refresh(); assert.equal(calls, 1);
  first.resolve({ badges: {}, loading: true, unavailable: false }); await tick();
  assert.equal(calls, 2);
  assert.equal(states.at(-1), "loading");
  assert.equal(clock.pending.size, 0);
  second.resolve({ badges: { v: [{ id: 2 }] }, loading: false, unavailable: false }); await tick();
  assert.equal(states.at(-1), "ready");
  assert.equal([...clock.pending.values()][0].delay, 60000);
  assert.deepEqual(results.at(-1), { v: [{ id: 2 }] });
  watcher.stop(); assert.equal(clock.pending.size, 0);
});

test("switching orders or stores aborts and ignores late badge responses", async () => {
  const request = deferred(), clock = timers(); let updates = 0, signal;
  const watcher = createPurchaseOrderWatcher({ ...clock, fetchBadges: (s) => { signal = s; return request.promise; }, onState: () => {}, onResult: () => updates++ });
  watcher.stop(); request.resolve({ badges: { wrongStore: [] }, loading: false }); await tick();
  assert.equal(signal.aborted, true); assert.equal(updates, 0); assert.equal(clock.pending.size, 0);
});

test("failure retains prior badges, marks status unknown, and retries without overlap", async () => {
  const clock = timers(), states = [], results = [];
  const watcher = createPurchaseOrderWatcher({ ...clock, fetchBadges: async () => { throw new Error("offline"); }, onState: (s) => states.push(s), onResult: (r) => results.push(r) });
  await tick(); assert.deepEqual(results, []); assert.equal(states.at(-1), "unavailable");
  assert.equal([...clock.pending.values()][0].delay, 10000); watcher.stop();
});

test("backend backoff is visible rather than a confirmed absence of pending purchases", async () => {
  const clock = timers(), states = [];
  const watcher = createPurchaseOrderWatcher({ ...clock, fetchBadges: async () => ({ badges: {}, unavailable: true, loading: false }), onState: (s) => states.push(s), onResult: () => {} });
  await tick(); assert.equal(states.at(-1), "unavailable");
  assert.equal([...clock.pending.values()][0].delay, 10000); watcher.stop();
});
