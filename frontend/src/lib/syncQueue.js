// Durable, cross-tab FIFO queue for Confirmation actions.
// A click is persisted before the UI changes. The worker retries until the
// server confirms both the Shopify mutation and its analytics audit row.

import { useEffect, useState } from "react";
import { authFetch, authHeaders, loadAuth } from "./auth";
import {
  confirmationRetryDelay,
  firstReadyQueueIndex,
  isBlockingConfirmationStatus,
  queueItemBelongsToActor,
  shouldRekeyConfirmationAction,
} from "./confirmationSyncPolicy";

const STORAGE_KEY = "orderCollectorConfirmSyncQueue";
const TICK_MS = 1000;
const LOCK_NAME = "order-collector-confirmation-sync";

let workerStarted = false;
let tickRunning = false;
const listeners = new Set();

function availableStores() {
  const stores = [];
  try { if (localStorage) stores.push(localStorage); } catch {}
  try { if (sessionStorage) stores.push(sessionStorage); } catch {}
  return stores;
}

function read() {
  for (const storage of availableStores()) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

function write(items) {
  let saved = false;
  for (const storage of availableStores()) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(items));
      saved = true;
      break;
    } catch {}
  }
  if (saved) notify();
  return saved;
}

function currentActorId() {
  return String(loadAuth()?.user?.id || "").trim();
}

function belongsToCurrentActor(item) {
  return queueItemBelongsToActor(item, currentActorId());
}

function visibleQueue() {
  return read().filter(belongsToCurrentActor);
}

function queueState(items = visibleQueue()) {
  const blocked = items.filter((item) => item.blocked || isBlockingConfirmationStatus(item.lastStatus));
  const latestError = [...items].reverse().find((item) => item.lastError);
  return {
    count: items.length,
    blockedCount: blocked.length,
    items,
    lastError: latestError?.lastError || null,
    lastStatus: latestError?.lastStatus || null,
  };
}

function notify() {
  const items = visibleQueue();
  const state = queueState(items);
  listeners.forEach((cb) => {
    try { cb(state.count, items, state); } catch {}
  });
}

function uid() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function enqueueTagWrites(actions) {
  const valid = (actions || []).filter((item) => (
    item?.orderId && item?.tag && (item?.action === "add" || item?.action === "remove")
  ));
  if (valid.length === 0) return null;
  const items = read();
  const actorId = currentActorId() || null;
  const enqueuedAt = Date.now();
  const created = valid.map((item, index) => ({
    id: uid(),
    orderId: item.orderId,
    action: item.action,
    tag: item.tag,
    orderLabel: item.orderLabel || "",
    silentSuccess: !!item.silentSuccess,
    store: item.store || "",
    source: item.source || "confirmation",
    actorId,
    attempts: 0,
    nextAttemptAt: enqueuedAt + index,
    enqueuedAt: enqueuedAt + index,
    blocked: false,
    lastError: null,
    lastStatus: null,
  }));
  if (!write([...items, ...created])) return null;
  startWorker();
  setTimeout(() => { tick(); }, 0);
  return created;
}

export function enqueueTagWrite(action) {
  return enqueueTagWrites([action])?.[0] || null;
}

export function getQueueLength() {
  return visibleQueue().length;
}

export function getSyncQueueState() {
  return queueState();
}

export function readQueue() {
  return visibleQueue();
}

export function subscribeToQueue(cb) {
  listeners.add(cb);
  const items = visibleQueue();
  const state = queueState(items);
  try { cb(state.count, items, state); } catch {}
  return () => listeners.delete(cb);
}

async function attemptItem(item) {
  if (!belongsToCurrentActor(item)) {
    return { ok: false, blocked: true, status: "wrong-agent", detail: "Queued action belongs to another user" };
  }
  const res = await authFetch("/api/agent/tag-action", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      order_id: item.orderId,
      tag: item.tag,
      op: item.action,
      store: item.store || "",
      client_action_id: item.id,
      actor_id: item.actorId || currentActorId() || null,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (res.ok && payload?.ok !== false && payload?.audited !== false) {
    return { ok: true, payload };
  }
  const detail = String(payload?.detail || `Server returned ${res.status}`);
  const rekey = shouldRekeyConfirmationAction(res.status, detail);
  return {
    ok: false,
    blocked: isBlockingConfirmationStatus(res.status),
    rekey,
    status: res.status || "network",
    detail,
  };
}

function emitSynced(item, payload) {
  try {
    window.dispatchEvent(new CustomEvent("confirmationActionSynced", {
      detail: { item, payload: payload || {} },
    }));
  } catch {}
}

async function tickOne() {
  let items = read();
  if (items.length === 0) return;

  // Strict FIFO per actor: never let an "add N2" jump ahead of a failed
  // "remove N1" from the same click sequence.
  const idx = firstReadyQueueIndex(items, currentActorId(), Date.now());
  if (idx < 0) return;
  const item = items[idx];

  let result;
  try {
    result = await attemptItem(item);
  } catch (error) {
    result = { ok: false, blocked: false, status: "network", detail: error?.message || "Network unavailable" };
  }

  items = read();
  const currentIdx = items.findIndex((queued) => queued.id === item.id);
  if (currentIdx < 0) return;
  if (result.ok) {
    items.splice(currentIdx, 1);
    write(items);
    emitSynced(item, result.payload);
    return;
  }

  const attempts = (items[currentIdx].attempts || 0) + 1;
  const wait = confirmationRetryDelay(attempts);
  items[currentIdx] = {
    ...items[currentIdx],
    id: result.rekey ? uid() : items[currentIdx].id,
    attempts,
    blocked: !!result.blocked,
    nextAttemptAt: Date.now() + wait,
    lastAttemptAt: Date.now(),
    lastStatus: result.status || "network",
    lastError: result.detail || "Action has not synced yet",
  };
  write(items);
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    if (globalThis.navigator?.locks?.request) {
      await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (lock) await tickOne();
      });
    } else {
      await tickOne();
    }
  } finally {
    tickRunning = false;
  }
}

export function retrySyncQueueNow() {
  const items = read().map((item) => (
    belongsToCurrentActor(item)
      ? { ...item, nextAttemptAt: Date.now(), blocked: false }
      : item
  ));
  write(items);
  setTimeout(() => { tick(); }, 0);
}

export function startWorker() {
  if (workerStarted) return;
  workerStarted = true;
  setInterval(() => { tick(); }, TICK_MS);
  setTimeout(() => { tick(); }, 0);
  try {
    window.addEventListener("online", retrySyncQueueNow);
    window.addEventListener("focus", retrySyncQueueNow);
  } catch {}
}

export function useSyncQueueLength() {
  const [n, setN] = useState(() => getQueueLength());
  useEffect(() => {
    startWorker();
    const unsub = subscribeToQueue(setN);
    function onStorage(event) {
      if (event?.key === STORAGE_KEY) setN(getQueueLength());
    }
    try { window.addEventListener("storage", onStorage); } catch {}
    return () => {
      try { unsub(); } catch {}
      try { window.removeEventListener("storage", onStorage); } catch {}
    };
  }, []);
  return n;
}

export function useSyncQueueState() {
  const [state, setState] = useState(() => getSyncQueueState());
  useEffect(() => {
    startWorker();
    const unsub = subscribeToQueue((_count, _items, nextState) => setState(nextState));
    function onStorage(event) {
      if (event?.key === STORAGE_KEY) setState(getSyncQueueState());
    }
    try { window.addEventListener("storage", onStorage); } catch {}
    return () => {
      try { unsub(); } catch {}
      try { window.removeEventListener("storage", onStorage); } catch {}
    };
  }, []);
  return state;
}
