import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch, authHeaders, clearAuth } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import { persistStoreSelection, readCurrentStore } from "../lib/stores";
import { enqueueTagWrite, useSyncQueueLength, readQueue } from "../lib/syncQueue";
import {
  PHONE_TAGS, WHATSAPP_TAGS, nextInCycle, tagsInCycle,
  moroccoInternational, copyToClipboard,
  todayDDMMYY, todayISO, isoToDDMMYY, isCodTag,
} from "../lib/confirmationActions";

// ---------- API helpers ----------
const API = {
  async me() {
    const res = await authFetch("/api/auth/me", { headers: authHeaders() });
    if (!res.ok) throw new Error("auth required");
    return res.json();
  },
  async agentMe() {
    const res = await authFetch("/api/agent/me", { headers: authHeaders() });
    if (!res.ok) throw new Error("agent/me failed");
    return res.json();
  },
  async getQueue(store, { limit = 50, cursor = null } = {}) {
    const qs = new URLSearchParams({ store, limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    const res = await authFetch(`/api/agent/queue?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Failed to load queue" }));
      throw new Error(js.detail || `Failed to load queue (${res.status})`);
    }
    return res.json();
  },
  async teamStats(store) {
    const qs = new URLSearchParams({ store });
    const res = await authFetch(`/api/agent/team-stats?${qs}`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to load team stats");
    return res.json();
  },
};

function shopifyOrderUrl(order, shopDomain) {
  const domain = String(shopDomain || "").trim();
  if (!domain) return null;
  // Prefer the numeric legacy ID; fall back to extracting it from the GID string.
  let numeric = String(order?.legacy_id || "").trim();
  if (!numeric) {
    const gid = String(order?.id || "");
    const m = gid.match(/(\d+)\s*$/);
    if (m) numeric = m[1];
  }
  if (!numeric) return null;
  // Shop domain is typically "*.myshopify.com" — the admin UI lives at /admin/orders/{id}.
  return `https://${domain.replace(/^https?:\/\//, "")}/admin/orders/${numeric}`;
}

function goto(path, store) {
  try {
    const s = (store && store !== "all") ? String(store) : "";
    const url = s ? `${path}?store=${encodeURIComponent(s)}` : path;
    history.pushState(null, "", url);
    try { window.dispatchEvent(new PopStateEvent("popstate")); } catch {}
  } catch { try { location.href = path; } catch {} }
}

// Apply pending sync-queue tag writes to a list of orders so the UI keeps showing
// recent agent clicks until Shopify has propagated the tag change.
function applyPendingQueueWrites(orders) {
  let pending;
  try { pending = readQueue(); } catch { pending = []; }
  if (!pending || pending.length === 0) return orders;
  const byOrder = new Map();
  for (const it of pending) {
    if (!it?.orderId) continue;
    const arr = byOrder.get(it.orderId) || [];
    arr.push(it);
    byOrder.set(it.orderId, arr);
  }
  return orders.map((o) => {
    const items = byOrder.get(o.id);
    if (!items || items.length === 0) return o;
    const lower = new Set((o.tags || []).map((t) => String(t || "").toLowerCase()));
    const order = [...(o.tags || [])];
    for (const it of items) {
      const k = String(it.tag || "").toLowerCase();
      if (!k) continue;
      if (it.action === "add" && !lower.has(k)) {
        lower.add(k);
        order.push(it.tag);
      } else if (it.action === "remove" && lower.has(k)) {
        lower.delete(k);
        const idx = order.findIndex((t) => String(t || "").toLowerCase() === k);
        if (idx >= 0) order.splice(idx, 1);
      }
    }
    return { ...o, tags: order };
  });
}

// ---------- Top-level page ----------
export default function Confirmation() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await API.me();
        if (cancelled) return;
        setMe(data);
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load user");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center text-gray-700 px-4 text-center">
        {error}. <a className="ml-2 underline" href="/login">Sign in</a>
      </div>
    );
  }
  if (!me) {
    return <div className="min-h-screen w-full flex items-center justify-center text-gray-500">Loading…</div>;
  }

  // Any logged-in user can use the confirmation page; whether their queue is non-empty
  // depends purely on the Shopify tags assigned to them in /admin.
  return <AgentView me={me} />;
}

// ---------- Header ----------
function Header({ title, store, setStore, rightSlot }) {
  return (
    <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="text-lg font-semibold">{title}</div>
        <div className="ml-auto flex items-center gap-2">
          {rightSlot}
          <StorePicker value={store} onChange={(v) => setStore(v)} />
          <button
            onClick={() => { clearAuth(); try { location.href = "/login"; } catch {} }}
            className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50"
          >Logout</button>
        </div>
      </div>
    </header>
  );
}

// ---------- Agent view ----------
function AgentView({ me }) {
  const [store, setStore] = useState(() => readCurrentStore());
  useEffect(() => { persistStoreSelection(store); }, [store]);

  const [agentInfo, setAgentInfo] = useState(null);
  const [data, setData] = useState({ orders: [], assigned_total: 0, today_label: "", nextCursor: null, shop_domain: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastLoadedAt, setLastLoadedAt] = useState(null);
  const [nowTick, setNowTick] = useState(0);
  const [expanded, setExpanded] = useState(() => new Set());
  const [datePickerFor, setDatePickerFor] = useState(null);
  const [chosenDate, setChosenDate] = useState(() => todayISO());
  const [teamStats, setTeamStats] = useState([]);
  // Bulk selection + bulk-tag UI
  const [selected, setSelected] = useState(() => new Set());
  const [bulkTag, setBulkTag] = useState("");
  const [showBulkSuggestions, setShowBulkSuggestions] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const requestIdRef = useRef(0);
  const teamRequestIdRef = useRef(0);
  const syncCount = useSyncQueueLength();

  const loadAgentMe = useCallback(async () => {
    try {
      const js = await API.agentMe();
      setAgentInfo(js);
    } catch {}
  }, []);
  useEffect(() => { loadAgentMe(); }, [loadAgentMe]);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true); setError(null);
    try {
      const js = await API.getQueue(store, { limit: 41 });
      if (reqId !== requestIdRef.current) return;
      // Belt-and-suspenders: hide any order that still carries a cod-prefix tag.
      const orders = (js.orders || [])
        .filter((o) => !(o.tags || []).some(isCodTag))
        .slice(0, 41);
      setData({
        orders,
        assigned_total: js.assigned_total || 0,
        today_label: js.today_label || "",
        nextCursor: js.nextCursor || null,
        shop_domain: js.shop_domain || "",
      });
      setLastLoadedAt(Date.now());
    } catch (e) {
      if (reqId !== requestIdRef.current) return;
      setError(e?.message || "Failed to load queue");
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [store]);

  const loadTeam = useCallback(async () => {
    const reqId = ++teamRequestIdRef.current;
    try {
      const js = await API.teamStats(store);
      if (reqId !== teamRequestIdRef.current) return;
      setTeamStats(js.agents || []);
    } catch {}
  }, [store]);

  useEffect(() => { load(); loadTeam(); }, [load, loadTeam]);

  // 15-second polling
  useEffect(() => {
    const t = setInterval(() => { load(); loadTeam(); }, 15_000);
    return () => clearInterval(t);
  }, [load, loadTeam]);

  // 1s freshness ticker + re-apply pending writes (so stats reflect just-clicked actions
  // even when Shopify hasn't fully propagated the tag yet).
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Orders, with pending sync-queue writes layered on top.
  const ordersForView = useMemo(
    () => applyPendingQueueWrites(data.orders || []),
    // recomputes on each `nowTick` so newly enqueued writes are picked up promptly
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.orders, syncCount, nowTick]
  );

  // ---------- Optimistic local mutations ----------
  function updateLocalOrderTags(orderId, mutate) {
    setData((prev) => ({
      ...prev,
      orders: prev.orders.map((o) =>
        o.id === orderId ? { ...o, tags: mutate([...(o.tags || [])]) } : o
      ),
    }));
  }

  function removeLocalOrder(orderId) {
    setData((prev) => ({
      ...prev,
      orders: prev.orders.filter((o) => o.id !== orderId),
      assigned_total: Math.max(0, (prev.assigned_total || 0) - 1),
    }));
  }

  function dedupTags(tags) {
    const seen = new Set();
    const out = [];
    for (const t of tags) {
      const k = String(t || "").toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(t);
    }
    return out;
  }

  function cyclePhone(order, cycle) {
    const next = nextInCycle(order.tags || [], cycle);
    const cycleSet = new Set(cycle.map((t) => t.toLowerCase()));
    const present = (order.tags || []).filter((t) => cycleSet.has(String(t || "").toLowerCase()));
    updateLocalOrderTags(order.id, (tags) => {
      const filtered = tags.filter((t) => !cycleSet.has(String(t || "").toLowerCase()));
      return dedupTags([...filtered, next]);
    });
    for (const old of present) {
      if (String(old).toLowerCase() === next.toLowerCase()) continue;
      enqueueTagWrite({ orderId: order.id, action: "remove", tag: old, store });
    }
    enqueueTagWrite({ orderId: order.id, action: "add", tag: next, store });
    return next;
  }

  async function handlePhone(order) {
    await copyToClipboard(order.phone || "");
    cyclePhone(order, PHONE_TAGS);
  }

  async function handleWhatsApp(order) {
    const intl = moroccoInternational(order.phone || "");
    await copyToClipboard(intl);
    cyclePhone(order, WHATSAPP_TAGS);
  }

  function openDatePicker(order) {
    setChosenDate(todayISO());
    setDatePickerFor(order.id);
  }

  function submitConfirm(order) {
    const dd = isoToDDMMYY(chosenDate);
    if (!dd) return;
    const tag = `cod ${dd}`;
    // Any cod-dated order disappears from the queue immediately — see backend filter.
    removeLocalOrder(order.id);
    enqueueTagWrite({ orderId: order.id, action: "add", tag, store });
    setDatePickerFor(null);
  }

  function removeTagOptimistic(order, tag) {
    updateLocalOrderTags(order.id, (tags) => tags.filter((t) => String(t || "").toLowerCase() !== String(tag || "").toLowerCase()));
    enqueueTagWrite({ orderId: order.id, action: "remove", tag, store });
  }

  // ---------- Bulk selection / bulk tagging ----------
  function toggleRowSelected(orderId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
      return next;
    });
  }

  const allSelected = useMemo(
    () => ordersForView.length > 0 && ordersForView.every((o) => selected.has(o.id)),
    [ordersForView, selected]
  );

  function toggleSelectAll() {
    setSelected((prev) => {
      if (ordersForView.length === 0) return prev;
      const next = new Set(prev);
      if (allSelected) {
        for (const o of ordersForView) next.delete(o.id);
      } else {
        for (const o of ordersForView) next.add(o.id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  // Suggestion pool = current orders' tags ∪ agent's own assigned tags. Filtered by input.
  const tagSuggestions = useMemo(() => {
    const pool = new Set();
    for (const o of ordersForView) for (const t of (o.tags || [])) if (t) pool.add(t);
    const ownTags = (agentInfo?.tags || me?.tags || []);
    for (const t of ownTags) if (t) pool.add(t);
    const q = String(bulkTag || "").trim().toLowerCase();
    const list = [...pool].filter((t) => String(t || "").toLowerCase() !== q);
    if (!q) return list.slice(0, 10);
    return list.filter((t) => String(t || "").toLowerCase().includes(q)).slice(0, 10);
  }, [ordersForView, agentInfo, me, bulkTag]);

  async function applyBulkTag() {
    const tag = String(bulkTag || "").trim();
    if (!tag || selected.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selected];
      const isCod = isCodTag(tag);
      for (const id of ids) {
        // Optimistic UI update
        if (isCod) {
          removeLocalOrder(id);
        } else {
          updateLocalOrderTags(id, (tags) => dedupTags([...tags, tag]));
        }
        enqueueTagWrite({ orderId: id, action: "add", tag, store });
      }
      setBulkTag("");
      setShowBulkSuggestions(false);
      clearSelection();
    } finally {
      setBulkBusy(false);
    }
  }

  // ---------- Stats ----------
  const stats = useMemo(() => {
    let n1 = 0, n2 = 0, n3 = 0, notCalled = 0, contacted = 0;
    for (const o of ordersForView) {
      const tags = (o.tags || []).map((t) => String(t || "").trim().toLowerCase());
      const has1 = tags.includes("n1");
      const has2 = tags.includes("n2");
      const has3 = tags.includes("n3");
      if (has3) n3++;
      else if (has2) n2++;
      else if (has1) n1++;
      else notCalled++;
      if (has1 || has2 || has3) contacted++;
    }
    return { n1, n2, n3, notCalled, contacted };
  }, [ordersForView]);

  const confirmedToday = useMemo(() => {
    const mine = teamStats.find((a) => a.id === me.id);
    return mine?.confirmed_today || 0;
  }, [teamStats, me?.id]);

  const updatedAgoSec = useMemo(() => {
    if (!lastLoadedAt) return null;
    return Math.max(0, Math.floor((Date.now() - lastLoadedAt) / 1000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLoadedAt, nowTick]);

  const tagsAssigned = agentInfo?.tags || me?.tags || [];

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <Header
        title="Confirmation"
        store={store}
        setStore={setStore}
        rightSlot={
          <div className="flex items-center gap-2">
            {syncCount > 0 && (
              <span className="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                Syncing {syncCount}
              </span>
            )}
            <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700 border border-gray-200">
              {updatedAgoSec == null ? "Updating…" : `Updated ${updatedAgoSec}s ago`}
            </span>
            <button onClick={() => { load(); loadTeam(); }} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">
              Refresh
            </button>
          </div>
        }
      />
      <main className="max-w-7xl mx-auto px-4 py-4 space-y-4">
        {/* Stats pills */}
        <div className="flex flex-wrap gap-2">
          <StatPill label="Assigned" value={data.assigned_total} />
          <StatPill label="In view" value={ordersForView.length} />
          <StatPill label="Not called" value={stats.notCalled} accent="indigo" />
          <StatPill label="N1" value={stats.n1} />
          <StatPill label="N2" value={stats.n2} />
          <StatPill label="N3" value={stats.n3} />
          <StatPill label="Total contacted" value={stats.contacted} />
          <StatPill label="Confirmed today" value={confirmedToday} accent="emerald" />
        </div>
        {data.assigned_total > ordersForView.length && (
          <div className="text-xs text-gray-500">
            Showing {ordersForView.length} of {data.assigned_total} — paginate to see the rest.
          </div>
        )}
        {tagsAssigned.length === 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No tags assigned to your account yet. Ask your admin to add at least one Shopify tag.
          </div>
        )}
        {error && <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}

        {/* Bulk-action bar */}
        <section className="bg-white border border-gray-200 rounded-2xl p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-gray-600 inline-flex items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                ref={(el) => {
                  if (!el) return;
                  const partial = selected.size > 0 && !allSelected;
                  el.indeterminate = partial;
                }}
              />
              {selected.size > 0 ? `${selected.size} selected` : "Select all visible"}
            </label>
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <input
                type="text"
                value={bulkTag}
                onChange={(e) => { setBulkTag(e.target.value); setShowBulkSuggestions(true); }}
                onFocus={() => setShowBulkSuggestions(true)}
                onBlur={() => setTimeout(() => setShowBulkSuggestions(false), 120)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyBulkTag(); } }}
                placeholder="Tag to add (e.g. agent_yasmine, cod 18/05/26)"
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5"
              />
              {showBulkSuggestions && tagSuggestions.length > 0 && (
                <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-auto">
                  {tagSuggestions.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onMouseDown={(ev) => { ev.preventDefault(); setBulkTag(t); setShowBulkSuggestions(false); }}
                      className="block w-full text-left text-xs px-3 py-1.5 hover:bg-indigo-50"
                    >{t}</button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={applyBulkTag}
              disabled={bulkBusy || selected.size === 0 || !bulkTag.trim()}
              className="text-xs px-4 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
              title="Add the chosen tag to every selected order"
            >
              {bulkBusy ? "Applying…" : `Apply to ${selected.size || "…"}`}
            </button>
            {selected.size > 0 && (
              <button
                onClick={clearSelection}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50"
              >Clear</button>
            )}
            <div className="text-[11px] text-gray-500 ml-auto">
              Tip: a <code className="bg-gray-100 px-1 rounded">cod dd/mm/yy</code> tag removes the order from your queue.
            </div>
          </div>
        </section>

        {/* Order table */}
        <section className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                      aria-label="Select all visible orders"
                    />
                  </th>
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">Address</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Tags</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ordersForView.length === 0 && !loading && (
                  <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500">No orders in your queue.</td></tr>
                )}
                {ordersForView.map((o) => {
                  const isOpen = expanded.has(o.id);
                  const pickerOpen = datePickerFor === o.id;
                  return (
                    <React.Fragment key={o.id}>
                      <tr
                        className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer ${selected.has(o.id) ? "bg-indigo-50/40" : ""}`}
                        onClick={(e) => {
                          const tag = (e.target?.tagName || "").toLowerCase();
                          if (["button", "input", "select", "a", "svg", "path", "label"].includes(tag)) return;
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(o.id)) next.delete(o.id); else next.add(o.id);
                            return next;
                          });
                        }}
                      >
                        <td className="px-3 py-2 w-8" onClick={(ev) => ev.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(o.id)}
                            onChange={() => toggleRowSelected(o.id)}
                            aria-label={`Select order ${o.name || o.number}`}
                          />
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {(() => {
                            const url = shopifyOrderUrl(o, data.shop_domain);
                            const label = o.name || `#${o.number}`;
                            return url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(ev) => ev.stopPropagation()}
                                className="text-indigo-700 hover:text-indigo-900 hover:underline"
                                title="Open in Shopify admin"
                              >{label}</a>
                            ) : (
                              <span>{label}</span>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2">{o.customer_name || <span className="text-gray-400">—</span>}</td>
                        <td className="px-3 py-2 font-mono text-xs">{o.phone || <span className="text-gray-400">—</span>}</td>
                        <td className="px-3 py-2 text-xs text-gray-700">
                          {[o.shipping_address1, o.shipping_city].filter(Boolean).join(", ") || <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{o.total_price} {o.currency}</td>
                        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                          {o.created_at ? new Date(o.created_at).toLocaleString() : ""}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {(o.tags || []).map((t) => (
                              <span key={t} className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border ${isCodTag(t) ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-50 text-gray-700 border-gray-200"}`}>
                                {t}
                                <button
                                  onClick={(ev) => { ev.stopPropagation(); removeTagOptimistic(o, t); }}
                                  className="ml-1 text-gray-400 hover:text-rose-600"
                                  title="Remove tag"
                                >×</button>
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <div className="inline-flex gap-1">
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handlePhone(o); }}
                              className="text-xs px-3 py-1 rounded-lg bg-sky-600 text-white hover:bg-sky-700"
                              title="Copy phone + advance n1/n2/n3"
                            >
                              📞 {tagsInCycle(o.tags || [], PHONE_TAGS).slice(-1)[0] || ""}
                            </button>
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handleWhatsApp(o); }}
                              className="text-xs px-3 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                              title="Copy international phone + advance wtp1/wtp2/wtp3"
                            >
                              💬 {tagsInCycle(o.tags || [], WHATSAPP_TAGS).slice(-1)[0] || ""}
                            </button>
                            <button
                              onClick={(ev) => { ev.stopPropagation(); openDatePicker(o); }}
                              className="text-xs px-3 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                              title="Confirm for a delivery date"
                            >✅</button>
                          </div>
                        </td>
                      </tr>
                      {pickerOpen && (
                        <tr className="bg-indigo-50/40">
                          <td colSpan={9} className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-700">Confirm delivery for:</span>
                              <input
                                type="date"
                                value={chosenDate}
                                onChange={(e) => setChosenDate(e.target.value)}
                                className="text-sm border border-gray-300 rounded px-2 py-1"
                              />
                              <button
                                onClick={(ev) => { ev.stopPropagation(); submitConfirm(o); }}
                                className="text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                              >Confirm</button>
                              <button
                                onClick={(ev) => { ev.stopPropagation(); setDatePickerFor(null); }}
                                className="text-xs px-3 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50"
                              >Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {isOpen && (
                        <tr className="bg-gray-50/60">
                          <td colSpan={9} className="px-3 py-3">
                            <LineItemsGrid order={o} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Team panels: assigned + confirmed today */}
        <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
          <div>
            <div className="text-sm font-semibold mb-2">Team — assigned now</div>
            {teamStats.length === 0 ? (
              <div className="text-xs text-gray-500">No team data yet.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {teamStats.map((a) => (
                  <div key={`a-${a.id}`} className={`text-xs rounded-lg border px-3 py-2 ${a.id === me.id ? "border-indigo-300 bg-indigo-50" : "border-gray-200 bg-gray-50"}`}>
                    <div className="font-medium flex items-center gap-1">
                      {a.name || a.email}
                      {a.is_catchall && <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-700 border border-amber-200 rounded px-1">catch-all</span>}
                    </div>
                    <div className="text-gray-700">{a.assigned} assigned</div>
                    <div className="text-[10px] text-gray-500 truncate max-w-[180px]" title={(a.tags || []).join(", ")}>
                      {(a.tags || []).length === 0 ? (a.is_catchall ? "no tag · sees all open unshipped" : "no tag") : (a.tags || []).join(", ")}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="text-sm font-semibold mb-2">Team — confirmed today {data.today_label && <span className="text-xs text-gray-500 font-normal">(any cod date, clicks counted today)</span>}</div>
            {teamStats.length === 0 ? (
              <div className="text-xs text-gray-500">No team data yet.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {teamStats.map((a) => (
                  <div key={`c-${a.id}`} className={`text-xs rounded-lg border px-3 py-2 ${a.id === me.id ? "border-emerald-300 bg-emerald-50" : "border-gray-200 bg-gray-50"}`}>
                    <div className="font-medium">{a.name || a.email}</div>
                    <div className="text-gray-700">{a.confirmed_today} confirmed</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function StatPill({ label, value, accent }) {
  const palette = accent === "indigo"
    ? "bg-indigo-50 text-indigo-700 border-indigo-200"
    : accent === "emerald"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : "bg-white text-gray-700 border-gray-200";
  return (
    <div className={`rounded-xl border px-3 py-2 min-w-[88px] ${palette}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-lg font-semibold leading-tight">{value}</div>
    </div>
  );
}

function LineItemsGrid({ order }) {
  const items = order.line_items || [];
  if (items.length === 0) return <div className="text-xs text-gray-500">No line items.</div>;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {items.map((li, idx) => (
        <div key={idx} className="bg-white border border-gray-200 rounded-xl p-3">
          <div className="w-full h-32 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center mb-2">
            {li.image ? (
              <img src={li.image} alt={li.title} className="w-full h-full object-cover" />
            ) : <span className="text-xs text-gray-400">no image</span>}
          </div>
          <div className="text-sm font-medium leading-tight line-clamp-2">{li.title}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {(li.options || []).map((opt, i) => (
              <span key={i} className="text-[10px] bg-gray-100 text-gray-700 border border-gray-200 px-2 py-0.5 rounded-full">
                {opt.name} {opt.value}
              </span>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
            <div className="bg-gray-50 rounded p-1">
              <div className="text-[10px] uppercase text-gray-500">Qty</div>
              <div className="font-semibold">{li.quantity}</div>
            </div>
            <div className="bg-gray-50 rounded p-1">
              <div className="text-[10px] uppercase text-gray-500">Unit</div>
              <div className="font-semibold">{li.unit_price}</div>
            </div>
            <div className="bg-gray-50 rounded p-1">
              <div className="text-[10px] uppercase text-gray-500">Total</div>
              <div className="font-semibold">{(Number(li.unit_price || 0) * Number(li.quantity || 0)).toFixed(2)}</div>
            </div>
          </div>
          {li.sku && <div className="mt-1 text-[10px] text-gray-500 truncate" title={li.sku}>SKU: {li.sku}</div>}
        </div>
      ))}
    </div>
  );
}
