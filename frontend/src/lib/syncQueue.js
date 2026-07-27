// Durable FIFO queue for Shopify tag writes from the Confirmation page.
// Survives tab close / network loss via localStorage. A single worker per tab
// drains the queue, retrying with exponential backoff. UI subscribes to the
// queue length via useSyncQueueLength().

import { useEffect, useState } from "react";
import { authFetch, authHeaders, loadAuth } from "./auth";

const STORAGE_KEY = "orderCollectorConfirmSyncQueue";
const TICK_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

let workerStarted = false;
const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {}
  notify();
}

function currentActorId() {
  return String(loadAuth()?.user?.id || "").trim();
}

function belongsToCurrentActor(item) {
  const queuedActor = String(item?.actorId || "").trim();
  const activeActor = currentActorId();
  // Legacy queue items did not store actorId. Let the currently authenticated
  // user drain those once; every new item is strictly agent-bound.
  return !queuedActor || (!!activeActor && queuedActor === activeActor);
}

function visibleQueue() {
  return read().filter(belongsToCurrentActor);
}

function notify() {
  const items = visibleQueue();
  listeners.forEach((cb) => {
    try { cb(items.length); } catch {}
  });
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function enqueueTagWrite({ orderId, action, tag, store, source = "confirmation" }) {
  // action: "add" | "remove"
  if (!orderId || !tag || (action !== "add" && action !== "remove")) return null;
  const items = read();
  items.push({
    id: uid(),
    orderId,
    action,
    tag,
    store: store || "",
    source,
    actorId: currentActorId() || null,
    attempts: 0,
    nextAttemptAt: Date.now(),
    enqueuedAt: Date.now(),
  });
  write(items);
  startWorker();
  return items[items.length - 1];
}

export function getQueueLength() {
  return visibleQueue().length;
}

export function readQueue() {
  return visibleQueue();
}

export function subscribeToQueue(cb) {
  listeners.add(cb);
  try { cb(visibleQueue().length); } catch {}
  return () => listeners.delete(cb);
}

async function attemptItem(item) {
  if (!belongsToCurrentActor(item)) {
    return { ok: false, drop: false, blocked: true, status: "wrong-agent" };
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
  if (!res.ok) {
    // 401/403: keep the item queued — the user just needs to re-auth and the
    // worker will replay it. Dropping these silently was a key source of
    // missing audit rows ("agent says 30 confirmed, dashboard shows 0").
    // 408/429: transient — retry with backoff.
    // Other 4xx: permanent (bad request, gone, etc.) — drop to avoid spam.
    if (res.status === 401 || res.status === 403 || res.status === 409) {
      return { ok: false, drop: false, status: res.status };
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      return { ok: false, drop: true, status: res.status };
    }
    return { ok: false, drop: false, status: res.status };
  }
  return { ok: true };
}

async function tick() {
  let items = read();
  if (items.length === 0) return;
  const now = Date.now();
  const idx = items.findIndex(
    (it) => belongsToCurrentActor(it) && (it.nextAttemptAt || 0) <= now
  );
  if (idx < 0) return;
  const item = items[idx];
  let result;
  try {
    result = await attemptItem(item);
  } catch {
    result = { ok: false, drop: false };
  }
  items = read(); // re-read in case other tabs have mutated it
  const i = items.findIndex((it) => it.id === item.id);
  if (i < 0) return;
  if (result.ok || result.drop) {
    items.splice(i, 1);
  } else {
    const attempts = (items[i].attempts || 0) + 1;
    const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1));
    items[i] = {
      ...items[i],
      attempts,
      nextAttemptAt: Date.now() + wait,
      lastError: result.status || "network",
    };
  }
  write(items);
}

export function startWorker() {
  if (workerStarted) return;
  workerStarted = true;
  setInterval(() => { tick(); }, TICK_MS);
  // Also try once immediately for snappier first-attempt response.
  setTimeout(() => { tick(); }, 0);
}

export function useSyncQueueLength() {
  const [n, setN] = useState(() => getQueueLength());
  useEffect(() => {
    startWorker();
    const unsub = subscribeToQueue(setN);
    function onStorage(e) {
      if (e?.key === STORAGE_KEY) setN(getQueueLength());
    }
    try { window.addEventListener("storage", onStorage); } catch {}
    return () => {
      try { unsub(); } catch {}
      try { window.removeEventListener("storage", onStorage); } catch {}
    };
  }, []);
  return n;
}
