import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch, authHeaders, clearAuth } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import OrderLabel from "../components/OrderLabel";
import { useToasts, ToastStack } from "../components/Toast";
import { persistStoreSelection, readCurrentStore } from "../lib/stores";
import { enqueueTagWrite, useSyncQueueLength, readQueue } from "../lib/syncQueue";
import { copyNodeAsPng, triggerDownload } from "../lib/labelClipboard";
import {
  PHONE_TAGS, NOWTP_TAGS, ENATT_TAGS,
  nextInCycle, tagsInCycle, hasNowtpTag, hasEnattTag,
  moroccoInternational, copyToClipboard,
  todayDDMMYY, todayISO, isoToDDMMYY, isCodTag,
} from "../lib/confirmationActions";

// Tailwind utility chunk applied to interactive buttons so every click visually presses
// the button. Pairs with the existing color/hover styling.
const BTN_TAP = "active:scale-[0.96] transition-transform duration-75";

// Shared "action chip" styling for the per-order action row. Gradient background +
// soft shadow + ring on hover + tap press.
const ACTION_BTN_BASE = "inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold text-white shadow-md hover:shadow-lg hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-offset-1 active:scale-[0.95] transition-all duration-100 min-w-[60px] justify-center";
const ACTION_BTN_THEMES = {
  sky:     "bg-gradient-to-br from-sky-500 to-sky-600 hover:from-sky-600 hover:to-sky-700 focus:ring-sky-400",
  violet:  "bg-gradient-to-br from-violet-500 to-violet-600 hover:from-violet-600 hover:to-violet-700 focus:ring-violet-400",
  fuchsia: "bg-gradient-to-br from-fuchsia-500 to-fuchsia-600 hover:from-fuchsia-600 hover:to-fuchsia-700 focus:ring-fuchsia-400",
  indigo:  "bg-gradient-to-br from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 focus:ring-indigo-400",
  rose:    "bg-gradient-to-br from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 focus:ring-rose-400",
  emerald: "bg-gradient-to-br from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 focus:ring-emerald-400",
};

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
  async getQueue(store, { limit = 50, cursor = null, level = null } = {}) {
    const qs = new URLSearchParams({ store, limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    if (level) qs.set("level", level);
    const res = await authFetch(`/api/agent/queue?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Failed to load queue" }));
      throw new Error(js.detail || `Failed to load queue (${res.status})`);
    }
    return res.json();
  },
  async bulkTag({ tag, store, scope = null, level = null, order_ids = null }) {
    const res = await authFetch(`/api/agent/bulk-tag`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ tag, store, scope, level, order_ids }),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Bulk tag failed" }));
      throw new Error(js.detail || `Bulk tag failed (${res.status})`);
    }
    return res.json();
  },
  async cancelOrder(orderId, { store, reason, staff_note, restock, refund }) {
    const res = await authFetch(`/api/agent/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ store, reason, staff_note, restock, refund }),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Cancel failed" }));
      throw new Error(js.detail || `Cancel failed (${res.status})`);
    }
    return res.json();
  },
  async teamStats(store) {
    const qs = new URLSearchParams({ store });
    const res = await authFetch(`/api/agent/team-stats?${qs}`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to load team stats");
    return res.json();
  },
  async customerOrders(store, customerId) {
    const qs = new URLSearchParams({ store, customer_id: customerId });
    const res = await authFetch(`/api/agent/customer-orders?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Failed to load customer history" }));
      throw new Error(js.detail || `Failed to load customer history (${res.status})`);
    }
    return res.json();
  },
  async search(store, q) {
    const qs = new URLSearchParams({ store, q });
    const res = await authFetch(`/api/agent/search?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Search failed" }));
      throw new Error(js.detail || `Search failed (${res.status})`);
    }
    return res.json();
  },
  async appendNote(orderId, append, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ append }),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Failed to add note" }));
      throw new Error(js.detail || `Failed to add note (${res.status})`);
    }
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
function Header({ title, store, setStore, rightSlot, me }) {
  const initial = ((me?.name || me?.email || "?").trim().charAt(0) || "?").toUpperCase();
  return (
    <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="text-lg font-semibold">{title}</div>
        {me && (
          <div className="inline-flex items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-full pl-1 pr-3 py-1">
            <div className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">
              {initial}
            </div>
            <div className="leading-tight">
              {me.name && (
                <div className="text-xs font-semibold text-indigo-900 leading-tight">{me.name}</div>
              )}
              <div className={`text-[11px] text-indigo-700 leading-tight ${!me.name ? "font-semibold" : ""}`}>
                {me.email}
              </div>
            </div>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {rightSlot}
          <StorePicker value={store} onChange={(v) => setStore(v)} />
          <button
            onClick={() => { clearAuth(); try { location.href = "/login"; } catch {} }}
            className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50 active:scale-[0.96] transition-transform duration-75"
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
  // Page cache, mirroring OrderBrowser. Each entry: { orders, nextCursor, startCursor }.
  // startCursor is the cursor used to fetch THIS page (null for page 0); nextCursor is the
  // cursor for the page that comes after.
  const [pages, setPages] = useState([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [meta, setMeta] = useState({ assigned_total: 0, today_label: "", shop_domain: "", level_counts: null });
  const PER_PAGE = 50;
  const [loading, setLoading] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
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
  // Filter for the top stat pills: "" | "n1" | "n2" | "n3" | "n4" | "new"
  const [filterLevel, setFilterLevel] = useState("");
  // Toast notifications (button feedback)
  const [toasts, pushToast, dismissToast] = useToasts();

  // Global Shopify search (orders + customers). Independent of the agent's queue.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null); // { orders, customers, shop_domain, query }
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const searchReqIdRef = useRef(0);

  // Debounced auto-search as the agent types (≥3 chars).
  useEffect(() => {
    const q = (searchQuery || "").trim();
    if (q.length < 3) {
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    const handle = setTimeout(async () => {
      const reqId = ++searchReqIdRef.current;
      setSearchLoading(true); setSearchError(null);
      try {
        const js = await API.search(store, q);
        if (reqId !== searchReqIdRef.current) return;
        setSearchResults(js);
      } catch (e) {
        if (reqId !== searchReqIdRef.current) return;
        setSearchError(e?.message || "Search failed");
        setSearchResults(null);
      } finally {
        if (reqId === searchReqIdRef.current) setSearchLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [searchQuery, store]);

  function clearSearch() {
    setSearchQuery("");
    setSearchResults(null);
    setSearchError(null);
    setExpandedCustomerId(null);
  }

  // Inline customer expansion from the search panel — one at a time. Loads the
  // customer's orders via /api/agent/customer-orders so renderOrderCard can render
  // them as the same interactive card the queue uses.
  const [expandedCustomerId, setExpandedCustomerId] = useState(null);
  const [customerOrdersById, setCustomerOrdersById] = useState({});

  async function toggleSearchCustomerExpand(customerId) {
    if (!customerId) return;
    if (expandedCustomerId === customerId) {
      setExpandedCustomerId(null);
      return;
    }
    setExpandedCustomerId(customerId);
    // Use cached data if already fetched.
    if (customerOrdersById[customerId]?.orders) return;
    setCustomerOrdersById((prev) => ({ ...prev, [customerId]: { orders: [], loading: true } }));
    try {
      const js = await API.customerOrders(store, customerId);
      setCustomerOrdersById((prev) => ({ ...prev, [customerId]: { orders: js.orders || [], loading: false } }));
    } catch (e) {
      setCustomerOrdersById((prev) => ({ ...prev, [customerId]: { orders: [], loading: false, error: e?.message || "Failed to load" } }));
    }
  }

  // Apply a patch function to an order across every array that may contain it: the
  // current queue page, the global search results, and any expanded customer's orders.
  // Keeps the UI consistent when the agent acts on an order from any of those places.
  function patchOrderInPlace(orderId, patch) {
    const patchArr = (arr) => (arr || []).map((o) => (o.id === orderId ? patch(o) : o));
    setPages((prev) => prev.map((p, idx) => (idx === pageIndex ? { ...p, orders: patchArr(p.orders) } : p)));
    setSearchResults((prev) => (prev ? { ...prev, orders: patchArr(prev.orders) } : prev));
    setCustomerOrdersById((prev) => {
      let touched = false;
      const next = { ...prev };
      for (const cid of Object.keys(next)) {
        const entry = next[cid];
        if (entry?.orders) {
          next[cid] = { ...entry, orders: patchArr(entry.orders) };
          touched = true;
        }
      }
      return touched ? next : prev;
    });
  }
  // Per-row "..." dropdown + cancel-order modal
  const [actionsDropdownFor, setActionsDropdownFor] = useState(null);
  const [cancelModalFor, setCancelModalFor] = useState(null);
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

  function dedupeAndFilter(raw) {
    // Safety net: drop any cod-tagged stragglers the server somehow returned. The
    // server already paginates iteratively to deliver a full PER_PAGE of non-cod orders,
    // so no client-side slicing is needed here.
    return (raw || []).filter((o) => !(o.tags || []).some(isCodTag));
  }

  // Fetch the first page and reset the cache. Used by the manual Refresh button, the
  // 15-second polling tick, and whenever the filter or store changes.
  const loadFirst = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true); setError(null);
    try {
      const js = await API.getQueue(store, { limit: PER_PAGE, level: filterLevel || null });
      if (reqId !== requestIdRef.current) return;
      const orders = dedupeAndFilter(js.orders);
      setPages([{ orders, nextCursor: js.nextCursor || null, startCursor: null }]);
      setPageIndex(0);
      setMeta({
        assigned_total: js.assigned_total || 0,
        today_label: js.today_label || "",
        shop_domain: js.shop_domain || "",
        level_counts: js.level_counts || null,
      });
      setLastLoadedAt(Date.now());
    } catch (e) {
      if (reqId !== requestIdRef.current) return;
      setError(e?.message || "Failed to load queue");
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [store, filterLevel]);

  // Move to a specific page. If not yet cached, fetch using the previous page's nextCursor.
  const goToPage = useCallback(async (targetIdx) => {
    if (targetIdx < 0) return;
    if (targetIdx < pages.length) {
      setPageIndex(targetIdx);
      return;
    }
    // Only support stepping forward by 1 (Next button).
    if (targetIdx !== pages.length) return;
    const prev = pages[pages.length - 1];
    const cursor = prev?.nextCursor;
    if (!cursor) return; // no further pages
    setPageBusy(true); setError(null);
    try {
      const js = await API.getQueue(store, { limit: PER_PAGE, cursor, level: filterLevel || null });
      const orders = dedupeAndFilter(js.orders);
      setPages((p) => [...p, { orders, nextCursor: js.nextCursor || null, startCursor: cursor }]);
      setPageIndex(targetIdx);
      setMeta((m) => ({
        ...m,
        assigned_total: js.assigned_total ?? m.assigned_total,
        today_label: js.today_label || m.today_label,
        shop_domain: js.shop_domain || m.shop_domain,
        level_counts: js.level_counts || m.level_counts,
      }));
    } catch (e) {
      setError(e?.message || "Failed to load page");
    } finally {
      setPageBusy(false);
    }
  }, [pages, store, filterLevel]);

  const loadTeam = useCallback(async () => {
    const reqId = ++teamRequestIdRef.current;
    try {
      const js = await API.teamStats(store);
      if (reqId !== teamRequestIdRef.current) return;
      setTeamStats(js.agents || []);
    } catch {}
  }, [store]);

  useEffect(() => { loadFirst(); loadTeam(); }, [loadFirst, loadTeam]);

  // 15-second polling: refresh the first page only when the user is sitting on it. If they
  // navigated to a later cached page, don't yank them back.
  useEffect(() => {
    const t = setInterval(() => {
      if (pageIndex === 0) loadFirst();
      loadTeam();
    }, 15_000);
    return () => clearInterval(t);
  }, [loadFirst, loadTeam, pageIndex]);

  // 1s freshness ticker + re-apply pending writes (so stats reflect just-clicked actions
  // even when Shopify hasn't fully propagated the tag yet).
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // When the sync queue empties — meaning every tag write the agent just clicked has
  // landed in Shopify — refetch the queue + team stats. The backend's breakdown cache
  // was already invalidated by the tag mutation, so this returns fresh N1..N4/Nowtp/
  // Enatt/New counts and prevents the "pill says N1=1 but filtered view is empty" drift.
  const prevSyncCountRef = useRef(0);
  useEffect(() => {
    if (prevSyncCountRef.current > 0 && syncCount === 0) {
      if (pageIndex === 0) loadFirst();
      loadTeam();
    }
    prevSyncCountRef.current = syncCount;
  }, [syncCount, loadFirst, loadTeam, pageIndex]);

  // Close the per-row "..." dropdown whenever the user clicks anywhere else.
  useEffect(() => {
    if (!actionsDropdownFor) return;
    function onDocClick() { setActionsDropdownFor(null); }
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  }, [actionsDropdownFor]);

  const currentOrders = pages[pageIndex]?.orders || [];
  const hasNextPage = !!(pages[pageIndex]?.nextCursor) || pageIndex + 1 < pages.length;
  const hasPrevPage = pageIndex > 0;

  // Orders for the current page, with pending sync-queue writes layered on top.
  const ordersForView = useMemo(
    () => applyPendingQueueWrites(currentOrders),
    // recomputes on each `nowTick` so newly enqueued writes are picked up promptly
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentOrders, syncCount, nowTick]
  );

  // ---------- Optimistic local mutations ----------
  function updateLocalOrderTags(orderId, mutate) {
    patchOrderInPlace(orderId, (o) => ({ ...o, tags: mutate([...(o.tags || [])]) }));
  }

  function removeLocalOrder(orderId) {
    setPages((prev) => prev.map((p, idx) => {
      if (idx !== pageIndex) return p;
      return { ...p, orders: p.orders.filter((o) => o.id !== orderId) };
    }));
    setMeta((prev) => ({ ...prev, assigned_total: Math.max(0, (prev.assigned_total || 0) - 1) }));
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
    const ok = await copyToClipboard(order.phone || "");
    const next = cyclePhone(order, PHONE_TAGS);
    pushToast(
      ok ? `📞 Copied ${order.phone} · ${(next || "").toUpperCase()}` : `📞 ${(next || "").toUpperCase()} — phone copy blocked`,
      ok ? "success" : "warn",
    );
  }

  function handleNowtp(order) {
    // Cycles nowtp1 → nowtp2 → nowtp3 → nowtp4 (locks at nowtp4).
    const next = cyclePhone(order, NOWTP_TAGS);
    pushToast(`🚫 No-WhatsApp · ${next}`, "success");
  }

  function handleEnatt(order) {
    // Cycles enatt1 → enatt2 → enatt3 → enatt4 (locks at enatt4). Use for "en attente"
    // (order pending follow-up).
    const next = cyclePhone(order, ENATT_TAGS);
    pushToast(`⏳ En attente · ${next}`, "success");
  }

  async function handleCopyPhone(order) {
    // Copies the customer's phone in WhatsApp-friendly international format, sans the
    // leading '+'. moroccoInternational already strips the '+'.
    const intl = moroccoInternational(order.phone || "");
    const ok = await copyToClipboard(intl);
    pushToast(
      ok ? `📋 Copied ${intl}` : "📋 Clipboard blocked",
      ok ? "success" : "warn",
    );
  }

  function openDatePicker(order) {
    setChosenDate(todayISO());
    setDatePickerFor(order.id);
  }

  function submitConfirm(order) {
    const dd = isoToDDMMYY(chosenDate);
    if (!dd) return;
    const tag = `cod ${dd}`;
    // Add the cod tag everywhere (queue, search results, expanded customer)…
    updateLocalOrderTags(order.id, (tags) => dedupTags([...tags, tag]));
    // …then drop the row from the agent's queue (matches backend filter).
    removeLocalOrder(order.id);
    enqueueTagWrite({ orderId: order.id, action: "add", tag, store });
    setDatePickerFor(null);
    pushToast(`✅ ${order.name || `#${order.number}`} booked for ${dd}`, "success");
  }

  function removeTagOptimistic(order, tag) {
    updateLocalOrderTags(order.id, (tags) => tags.filter((t) => String(t || "").toLowerCase() !== String(tag || "").toLowerCase()));
    enqueueTagWrite({ orderId: order.id, action: "remove", tag, store });
    pushToast(`Tag removed · ${tag}`, "info");
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
    setBulkBusy(true); setError(null);
    try {
      const ids = [...selected];
      const isCod = isCodTag(tag);
      for (const id of ids) {
        if (isCod) {
          removeLocalOrder(id);
        } else {
          updateLocalOrderTags(id, (tags) => dedupTags([...tags, tag]));
        }
        enqueueTagWrite({ orderId: id, action: "add", tag, store });
      }
      pushToast(`Tag "${tag}" applied to ${ids.length} order${ids.length === 1 ? "" : "s"}`, "success");
      setBulkTag("");
      setShowBulkSuggestions(false);
      clearSelection();
    } finally {
      setBulkBusy(false);
    }
  }

  // ---------- Stats ----------
  // Pulled from the server-computed per-level breakdown so the pills show the TRUE
  // total assigned to the agent for each level. They stay stable regardless of which
  // filter pill is currently active (each pill reflects its own slice of the same
  // unfiltered query).
  const stats = useMemo(() => {
    const c = meta.level_counts || {};
    const total = Number(c.total || 0);
    const fresh = Number(c.new || 0);
    return {
      n1: Number(c.n1 || 0),
      n2: Number(c.n2 || 0),
      n3: Number(c.n3 || 0),
      n4: Number(c.n4 || 0),
      nowtp: Number(c.nowtp || 0),
      enatt: Number(c.enatt || 0),
      fresh,
      contacted: Math.max(0, total - fresh),
    };
  }, [meta.level_counts]);

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

  // Reusable order card — same look and behaviour for the queue (mobile), the global
  // search results, and the expanded customer's order list. Closes over every action
  // handler and piece of state so callers don't need to pass anything beyond the order.
  function renderOrderCard(o) {
    const isOpen = expanded.has(o.id);
    const pickerOpen = datePickerFor === o.id;
    const isSelected = selected.has(o.id);
    const isActive = isOpen || pickerOpen;
    const url = shopifyOrderUrl(o, meta.shop_domain);
    const label = o.name || `#${o.number}`;
    return (
      <div
        key={o.id}
        className={`p-3 transition-colors ${
          isActive
            ? "bg-indigo-50/80 border-l-4 border-indigo-500 shadow-inner"
            : isSelected
              ? "bg-indigo-50/40 border-l-4 border-indigo-200"
              : "border-l-4 border-transparent"
        }`}
        onClick={(e) => {
          const tag = (e.target?.tagName || "").toLowerCase();
          if (["button", "input", "select", "a", "svg", "path", "label", "textarea"].includes(tag)) return;
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(o.id)) next.delete(o.id); else next.add(o.id);
            return next;
          });
        }}
      >
        {/* Row 1: select + order # + total + created */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleRowSelected(o.id)}
            onClick={(ev) => ev.stopPropagation()}
            aria-label={`Select order ${label}`}
            className="w-4 h-4"
          />
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(ev) => ev.stopPropagation()}
              className="text-base font-bold text-indigo-700 hover:underline"
            >{label}</a>
          ) : (
            <span className="text-base font-bold">{label}</span>
          )}
          <span className="ml-auto text-base font-bold text-gray-900 tabular-nums whitespace-nowrap">
            {o.total_price} <span className="text-xs font-medium text-gray-500">{o.currency}</span>
          </span>
        </div>
        <div className="text-[11px] text-gray-500 mt-0.5">
          {o.created_at ? new Date(o.created_at).toLocaleString() : ""}
        </div>

        {/* Customer + phone (highlighted) */}
        <div className="mt-2 flex items-start gap-2 flex-wrap">
          <div className="text-base font-bold text-gray-900 flex-1 min-w-0 truncate">
            {o.customer_name || <span className="text-gray-400 font-medium">—</span>}
          </div>
        </div>
        {o.phone ? (
          <div className="mt-1.5 inline-flex items-center gap-2 bg-sky-50 border border-sky-200 rounded-lg px-2.5 py-1">
            <span className="font-mono font-bold text-base text-sky-900 tracking-tight">{o.phone}</span>
            <button
              type="button"
              onClick={(ev) => { ev.stopPropagation(); handleCopyPhone(o); }}
              title={`Copy ${moroccoInternational(o.phone)}`}
              className={`text-sky-500 hover:text-emerald-600 hover:scale-110 ${BTN_TAP}`}
            >📋</button>
          </div>
        ) : (
          <div className="mt-1.5 text-xs text-gray-400">no phone</div>
        )}

        {/* Address */}
        <div className="mt-1.5 text-sm font-medium text-gray-700">
          {[o.shipping_address1, o.shipping_city].filter(Boolean).join(", ") || <span className="text-gray-400">—</span>}
        </div>

        {/* Tags */}
        {(o.tags || []).length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(o.tags || []).map((t) => (
              <span key={t} className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full border ${isCodTag(t) ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-50 text-gray-700 border-gray-200"}`}>
                {t}
                <button
                  onClick={(ev) => { ev.stopPropagation(); removeTagOptimistic(o, t); }}
                  className={`ml-1 text-gray-400 hover:text-rose-600 hover:scale-110 ${BTN_TAP}`}
                  title="Remove tag"
                >×</button>
              </span>
            ))}
          </div>
        )}

        {/* Action row */}
        <div className="mt-2.5 grid grid-cols-5 gap-1.5">
          <button
            onClick={(ev) => { ev.stopPropagation(); handlePhone(o); }}
            className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.sky} !min-w-0 col-span-1`}
            title="Copy phone + advance n1/n2/n3/n4"
          >
            <span aria-hidden className="text-sm">📞</span>
            <span>{(tagsInCycle(o.tags || [], PHONE_TAGS).slice(-1)[0] || "").toUpperCase() || "Call"}</span>
          </button>
          <button
            onClick={(ev) => { ev.stopPropagation(); handleNowtp(o); }}
            className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.violet} !min-w-0 col-span-1`}
            title="No-WhatsApp — cycles nowtp1 → nowtp4"
          >
            <span aria-hidden className="text-sm">🚫</span>
            <span>{(() => {
              const t = tagsInCycle(o.tags || [], NOWTP_TAGS).slice(-1)[0];
              return t ? t.replace("nowtp", "NW").toUpperCase() : "NW";
            })()}</span>
          </button>
          <button
            onClick={(ev) => { ev.stopPropagation(); handleEnatt(o); }}
            className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.fuchsia} !min-w-0 col-span-1`}
            title="En attente — cycles enatt1 → enatt4"
          >
            <span aria-hidden className="text-sm">⏳</span>
            <span>{(() => {
              const t = tagsInCycle(o.tags || [], ENATT_TAGS).slice(-1)[0];
              return t ? t.replace("enatt", "EA").toUpperCase() : "EA";
            })()}</span>
          </button>
          <button
            onClick={(ev) => { ev.stopPropagation(); openDatePicker(o); }}
            className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.emerald} !min-w-0 col-span-1`}
            title="Confirm for a delivery date"
          >
            <span aria-hidden className="text-base">✅</span>
          </button>
          <button
            onClick={(ev) => { ev.stopPropagation(); setActionsDropdownFor((p) => (p === o.id ? null : o.id)); }}
            className={`inline-flex items-center justify-center px-2 py-1.5 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 ${BTN_TAP} col-span-1`}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={actionsDropdownFor === o.id}
          >⋯</button>
        </div>

        {actionsDropdownFor === o.id && (
          <div
            className="mt-2 border border-gray-200 rounded-lg shadow-sm bg-white overflow-hidden"
            onClick={(ev) => ev.stopPropagation()}
          >
            <button
              onClick={() => { setCancelModalFor(o); setActionsDropdownFor(null); }}
              className="block w-full text-left text-sm px-3 py-2 text-rose-700 hover:bg-rose-50"
            >🚫 Cancel order…</button>
          </div>
        )}

        {pickerOpen && (
          <div className="mt-2 rounded-lg bg-indigo-50/50 border border-indigo-200 p-2 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-indigo-900">Confirm for:</span>
            <input
              type="date"
              value={chosenDate}
              onChange={(e) => setChosenDate(e.target.value)}
              onClick={(ev) => ev.stopPropagation()}
              className="text-sm border border-gray-300 rounded px-2 py-1"
            />
            <button
              onClick={(ev) => { ev.stopPropagation(); submitConfirm(o); }}
              className={`text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm ${BTN_TAP}`}
            >Confirm</button>
            <button
              onClick={(ev) => { ev.stopPropagation(); setDatePickerFor(null); }}
              className={`text-xs px-3 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 ${BTN_TAP}`}
            >Cancel</button>
          </div>
        )}

        {isOpen && (
          <div className="mt-3" onClick={(ev) => ev.stopPropagation()}>
            <OrderExpanded order={o} store={store} shopDomain={meta.shop_domain} onToast={pushToast} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <Header
        title="Confirmation"
        me={me}
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
            <button onClick={() => { loadFirst(); loadTeam(); pushToast("Refreshed", "info", 1200); }} className={`text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50 ${BTN_TAP}`}>
              Refresh
            </button>
          </div>
        }
      />
      <main className="max-w-7xl mx-auto px-4 py-4 space-y-4">
        {/* Global Shopify search */}
        <GlobalSearch
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClear={clearSearch}
          loading={searchLoading}
          error={searchError}
          results={searchResults}
          store={store}
          pushToast={pushToast}
          renderOrderCard={renderOrderCard}
          expandedCustomerId={expandedCustomerId}
          customerOrdersById={customerOrdersById}
          onToggleCustomer={toggleSearchCustomerExpand}
        />

        {/* Stats pills */}
        <div className="flex flex-wrap gap-2">
          <StatPill label="Assigned" value={meta.assigned_total} color="sky" icon="📦" />
          <StatPill label="In view" value={ordersForView.length} color="slate" icon="👁" />
          <StatPill
            label="New"
            value={stats.fresh}
            color="indigo"
            icon="✨"
            active={filterLevel === "new"}
            onClick={() => setFilterLevel((p) => (p === "new" ? "" : "new"))}
          />
          <StatPill
            label="N1"
            value={stats.n1}
            color="amber"
            icon="📞"
            active={filterLevel === "n1"}
            onClick={() => setFilterLevel((p) => (p === "n1" ? "" : "n1"))}
          />
          <StatPill
            label="N2"
            value={stats.n2}
            color="orange"
            icon="📞"
            active={filterLevel === "n2"}
            onClick={() => setFilterLevel((p) => (p === "n2" ? "" : "n2"))}
          />
          <StatPill
            label="N3"
            value={stats.n3}
            color="rose"
            icon="📞"
            active={filterLevel === "n3"}
            onClick={() => setFilterLevel((p) => (p === "n3" ? "" : "n3"))}
          />
          <StatPill
            label="N4"
            value={stats.n4}
            color="red"
            icon="📞"
            active={filterLevel === "n4"}
            onClick={() => setFilterLevel((p) => (p === "n4" ? "" : "n4"))}
          />
          <StatPill
            label="Nowtp"
            value={stats.nowtp}
            color="violet"
            icon="🚫"
            active={filterLevel === "nowtp"}
            onClick={() => setFilterLevel((p) => (p === "nowtp" ? "" : "nowtp"))}
          />
          <StatPill
            label="Enatt"
            value={stats.enatt}
            color="fuchsia"
            icon="⏳"
            active={filterLevel === "enatt"}
            onClick={() => setFilterLevel((p) => (p === "enatt" ? "" : "enatt"))}
          />
          <StatPill label="Contacted" value={stats.contacted} color="teal" icon="💬" />
          <StatPill label="Confirmed today" value={confirmedToday} color="emerald" icon="✅" />
        </div>
        {meta.assigned_total > ordersForView.length && (
          <div className="text-xs text-gray-500">
            Showing {ordersForView.length} of {meta.assigned_total} on page {pageIndex + 1} — use the pager below to see the rest.
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
                  el.indeterminate = selected.size > 0 && !allSelected;
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
              className={`text-xs px-4 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 shadow-sm ${BTN_TAP}`}
              title="Add the chosen tag to every selected order"
            >
              {bulkBusy ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                  Applying…
                </span>
              ) : `Apply to ${selected.size || "…"}`}
            </button>
            {selected.size > 0 && (
              <button
                onClick={clearSelection}
                className={`text-xs px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 ${BTN_TAP}`}
              >Clear</button>
            )}
            <div className="text-[11px] text-gray-500 ml-auto">
              Tip: a <code className="bg-gray-100 px-1 rounded">cod dd/mm/yy</code> tag removes the order from your queue.
            </div>
          </div>
        </section>

        {/* Orders — desktop table only at xl+ (≥1280px effective width). At anything
            narrower (including a zoomed-in desktop) the scroll-free card list below
            takes over so the action buttons can never end up clipped. */}
        <section className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="hidden xl:block overflow-x-auto">
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
                  <th className="px-2 py-2">Order</th>
                  <th className="px-2 py-2">Customer</th>
                  <th className="px-2 py-2">Phone</th>
                  <th className="px-2 py-2 hidden 2xl:table-cell">Address</th>
                  <th className="px-2 py-2">Total</th>
                  <th className="px-2 py-2 hidden 2xl:table-cell">Created</th>
                  <th className="px-2 py-2">Tags</th>
                  <th className="px-2 py-2 text-right sticky right-0 bg-gray-50 shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.08)]">Actions</th>
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
                        className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors ${
                          isOpen || pickerOpen
                            ? "bg-indigo-50/80 ring-1 ring-indigo-200 shadow-inner border-l-4 border-l-indigo-500"
                            : selected.has(o.id)
                              ? "bg-indigo-50/40"
                              : ""
                        }`}
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
                            const url = shopifyOrderUrl(o, meta.shop_domain);
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
                        <td className="px-3 py-2">
                          {o.phone ? (
                            <div className="inline-flex items-center gap-1.5 bg-sky-50 border border-sky-200 rounded-lg px-2 py-1">
                              <span className="font-mono font-bold text-sm text-sky-900 tracking-tight">{o.phone}</span>
                              <button
                                type="button"
                                onClick={(ev) => { ev.stopPropagation(); handleCopyPhone(o); }}
                                title={`Copy ${moroccoInternational(o.phone)} (international, no +)`}
                                className={`text-sky-500 hover:text-emerald-600 hover:scale-110 ${BTN_TAP}`}
                              >📋</button>
                            </div>
                          ) : (
                            <span className="text-gray-400 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-xs text-gray-700 hidden 2xl:table-cell">
                          {[o.shipping_address1, o.shipping_city].filter(Boolean).join(", ") || <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap font-semibold tabular-nums">{o.total_price} <span className="text-[11px] font-medium text-gray-500">{o.currency}</span></td>
                        <td className="px-2 py-2 text-xs text-gray-500 whitespace-nowrap hidden 2xl:table-cell">
                          {o.created_at ? new Date(o.created_at).toLocaleString() : ""}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {(o.tags || []).map((t) => (
                              <span key={t} className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border ${isCodTag(t) ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-50 text-gray-700 border-gray-200"}`}>
                                {t}
                                <button
                                  onClick={(ev) => { ev.stopPropagation(); removeTagOptimistic(o, t); }}
                                  className={`ml-1 text-gray-400 hover:text-rose-600 hover:scale-110 ${BTN_TAP}`}
                                  title="Remove tag"
                                >×</button>
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap sticky right-0 bg-white shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.08)]">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handlePhone(o); }}
                              className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.sky} !min-w-[44px] !px-2`}
                              title="Copy phone + advance n1/n2/n3/n4"
                            >
                              <span aria-hidden className="text-sm">📞</span>
                              <span>{(tagsInCycle(o.tags || [], PHONE_TAGS).slice(-1)[0] || "").toUpperCase() || "Call"}</span>
                            </button>
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handleNowtp(o); }}
                              className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.violet} !min-w-[44px] !px-2`}
                              title="No-WhatsApp attempt — cycles nowtp1 → nowtp2 → nowtp3 → nowtp4"
                            >
                              <span aria-hidden className="text-sm">🚫</span>
                              <span>{(() => {
                                const t = tagsInCycle(o.tags || [], NOWTP_TAGS).slice(-1)[0];
                                return t ? t.replace("nowtp", "NW").toUpperCase() : "NW";
                              })()}</span>
                            </button>
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handleEnatt(o); }}
                              className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.fuchsia} !min-w-[44px] !px-2`}
                              title="En attente — cycles enatt1 → enatt2 → enatt3 → enatt4"
                            >
                              <span aria-hidden className="text-sm">⏳</span>
                              <span>{(() => {
                                const t = tagsInCycle(o.tags || [], ENATT_TAGS).slice(-1)[0];
                                return t ? t.replace("enatt", "EA").toUpperCase() : "EA";
                              })()}</span>
                            </button>
                            <button
                              onClick={(ev) => { ev.stopPropagation(); openDatePicker(o); }}
                              className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.emerald} !min-w-[36px] !px-2`}
                              title="Confirm for a delivery date"
                            >
                              <span aria-hidden className="text-base">✅</span>
                            </button>
                            <div className="relative">
                              <button
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  setActionsDropdownFor((prev) => (prev === o.id ? null : o.id));
                                }}
                                className="text-xs px-2 py-1 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700"
                                title="More actions"
                                aria-haspopup="menu"
                                aria-expanded={actionsDropdownFor === o.id}
                              >⋯</button>
                              {actionsDropdownFor === o.id && (
                                <div
                                  role="menu"
                                  onClick={(ev) => ev.stopPropagation()}
                                  className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden"
                                >
                                  <button
                                    role="menuitem"
                                    onClick={() => { setCancelModalFor(o); setActionsDropdownFor(null); }}
                                    className="block w-full text-left text-xs px-3 py-2 hover:bg-rose-50 text-rose-700"
                                  >Cancel order…</button>
                                </div>
                              )}
                            </div>
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
                                className={`text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm ${BTN_TAP}`}
                              >Confirm</button>
                              <button
                                onClick={(ev) => { ev.stopPropagation(); setDatePickerFor(null); }}
                                className={`text-xs px-3 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 ${BTN_TAP}`}
                              >Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {isOpen && (
                        <tr className="bg-gray-50/60">
                          <td colSpan={9} className="px-3 py-3">
                            <OrderExpanded order={o} store={store} shopDomain={meta.shop_domain} onToast={pushToast} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Card list — used on anything narrower than xl (≤1280px), including
              zoomed-in desktops, so the action buttons never get clipped. */}
          <div className="xl:hidden divide-y divide-gray-100">
            {ordersForView.length === 0 && !loading && (
              <div className="px-3 py-6 text-center text-gray-500">No orders in your queue.</div>
            )}
            {ordersForView.map(renderOrderCard)}
          </div>

          {/* Pagination */}
          <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-100 bg-gray-50">
            <button
              onClick={() => goToPage(pageIndex - 1)}
              disabled={!hasPrevPage || pageBusy}
              className={`text-xs px-3 py-1 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_TAP}`}
            >← Prev</button>
            <span className="text-xs text-gray-700">
              Page {pageIndex + 1}{pages.length > 1 ? ` of ${pages.length}${hasNextPage && pages[pageIndex]?.nextCursor && pageIndex + 1 === pages.length ? "+" : ""}` : ""}
            </span>
            <button
              onClick={() => goToPage(pageIndex + 1)}
              disabled={!hasNextPage || pageBusy}
              className={`text-xs px-3 py-1 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed ${BTN_TAP}`}
            >{pageBusy ? "Loading…" : "Next →"}</button>
            <span className="ml-auto text-[11px] text-gray-500">
              {ordersForView.length} visible · {meta.assigned_total} total
            </span>
          </div>
        </section>

        {/* Team performance */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold flex items-center gap-2">
              <span>🏆</span>
              <span>Team performance today</span>
            </div>
            <div className="text-[11px] text-gray-500">
              {meta.today_label && <span>{meta.today_label} · confirmations counted by clicks today</span>}
            </div>
          </div>
          {teamStats.length === 0 ? (
            <div className="text-xs text-gray-500">No team data yet.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {teamStats.map((a) => (
                <AgentCard key={a.id} agent={a} isMe={a.id === me.id} />
              ))}
            </div>
          )}
        </section>
      </main>
      {cancelModalFor && (
        <CancelOrderModal
          order={cancelModalFor}
          store={store}
          onClose={() => setCancelModalFor(null)}
          onSuccess={() => {
            // Cancelled orders should disappear from the queue (status:open filter excludes them).
            const label = cancelModalFor.name || `#${cancelModalFor.number}`;
            removeLocalOrder(cancelModalFor.id);
            setCancelModalFor(null);
            // Refresh team-stats so any "confirmed today" / "assigned now" rollups update.
            loadTeam();
            pushToast(`Cancelled ${label}`, "success");
          }}
        />
      )}
    </div>
  );
}

function CancelOrderModal({ order, store, onClose, onSuccess }) {
  const [reason, setReason] = useState("CUSTOMER");
  const [staffNote, setStaffNote] = useState("");
  const [restock, setRestock] = useState(true);
  const [refund, setRefund] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const orderLabel = order?.name || `#${order?.number || ""}`;
  const amount = `${order?.total_price || ""} ${order?.currency || ""}`.trim();

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await API.cancelOrder(order.id, {
        store,
        reason,
        staff_note: staffNote.trim() || null,
        restock,
        refund,
      });
      onSuccess?.();
    } catch (e) {
      setErr(e?.message || "Failed to cancel order");
    } finally {
      setBusy(false);
    }
  }

  // Esc to close
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && !busy) onClose?.(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4" onClick={() => { if (!busy) onClose?.(); }}>
      <div
        className="bg-white border border-gray-200 rounded-2xl p-5 w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold mb-4">Cancel order {orderLabel}?</div>

        <div className="mb-3">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Cancel transactions</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
            Cancel {amount} pending
          </label>
        </div>

        <div className="mb-3">
          <label className="text-xs uppercase tracking-wide text-gray-500 block mb-1">Reason for cancellation</label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
          >
            <option value="CUSTOMER">Customer changed or canceled order</option>
            <option value="INVENTORY">Items unavailable</option>
            <option value="FRAUD">Fraudulent order</option>
            <option value="DECLINED">Payment declined</option>
            <option value="STAFF">Staff error</option>
            <option value="OTHER">Other</option>
          </select>
        </div>

        <div className="mb-3">
          <label className="text-xs uppercase tracking-wide text-gray-500 block mb-1">Staff note</label>
          <div className="text-[11px] text-gray-500 mb-1">Only you and other staff can see this note.</div>
          <textarea
            value={staffNote}
            onChange={(e) => setStaffNote(e.target.value)}
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
            placeholder="Optional"
          />
        </div>

        <label className="flex items-center gap-2 text-sm mb-4">
          <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
          Restock inventory
        </label>

        {err && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mb-3">{err}</div>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-sm px-4 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 active:scale-[0.96] transition-transform duration-75"
          >Cancel</button>
          <button
            onClick={submit}
            disabled={busy}
            className="text-sm px-4 py-1.5 rounded-lg bg-rose-600 text-white font-medium hover:bg-rose-700 disabled:opacity-50 active:scale-[0.96] transition-transform duration-75 shadow-sm"
          >{busy ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              Cancelling…
            </span>
          ) : "Cancel order"}</button>
        </div>
      </div>
    </div>
  );
}

// Global Shopify search panel — orders + customers in the selected store. Independent
// of the agent's tag-filtered queue. Phone-like input is normalized server-side so
// `+212 614 162-654`, `0614162654`, and `614162654` all match the same record.
function GlobalSearch({
  query, onQueryChange, onClear, loading, error, results, store, pushToast,
  renderOrderCard, expandedCustomerId, customerOrdersById, onToggleCustomer,
}) {
  const shopDomain = results?.shop_domain || "";
  const orders = results?.orders || [];
  const customers = results?.customers || [];
  const hasQuery = (query || "").trim().length >= 3;
  const hasResults = hasQuery && (orders.length > 0 || customers.length > 0);

  async function copyText(text, label) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      pushToast(`📋 Copied ${label}`, "success");
    } catch {
      pushToast(`Clipboard blocked`, "warn");
    }
  }

  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🔎</span>
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={`Search ${store || "Shopify"} — order number or phone (e.g. 71779 or +212 614 162 654)`}
          className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400"
        />
        {loading && (
          <span className="inline-flex items-center text-xs text-gray-500 gap-1.5">
            <span className="inline-block w-3 h-3 rounded-full border-2 border-gray-300 border-t-indigo-600 animate-spin" />
            Searching…
          </span>
        )}
        {(query || "").length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className={`text-xs px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 ${BTN_TAP}`}
          >Clear</button>
        )}
      </div>
      <div className="mt-1 text-[11px] text-gray-500">
        Searches every order + customer in <span className="font-mono">{store}</span>. Phone is matched with spaces / + / dashes stripped.
      </div>

      {error && (
        <div className="mt-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</div>
      )}

      {hasQuery && !loading && !error && !hasResults && (
        <div className="mt-3 text-sm text-gray-500 italic">No orders or customers match "{query}" in {store}.</div>
      )}

      {hasResults && (
        <div className="mt-3 space-y-4">
          {orders.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-indigo-600 mb-1.5">
                Orders ({orders.length})
              </div>
              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
                {orders.map((o) => (
                  <React.Fragment key={o.id}>{renderOrderCard(o)}</React.Fragment>
                ))}
              </div>
            </div>
          )}

          {customers.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-indigo-600 mb-1.5">
                Customers ({customers.length}) — tap a card to see their orders
              </div>
              <div className="space-y-2">
                {customers.map((c) => {
                  const isExpanded = expandedCustomerId === c.id;
                  const data = customerOrdersById?.[c.id];
                  const custLoading = !!data?.loading;
                  const custOrders = data?.orders || [];
                  const custError = data?.error;
                  return (
                    <div key={c.id} className={`rounded-xl border bg-white overflow-hidden ${isExpanded ? "border-indigo-300 ring-1 ring-indigo-100" : "border-gray-200"}`}>
                      <button
                        type="button"
                        onClick={() => onToggleCustomer?.(c.id)}
                        className={`w-full text-left p-3 hover:bg-gray-50 ${BTN_TAP}`}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center shrink-0">
                            {((c.name || c.email || "?").trim().charAt(0) || "?").toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-gray-900 truncate">{c.name || "—"}</div>
                            {c.email && <div className="text-xs text-gray-500 truncate">{c.email}</div>}
                          </div>
                          {c.phone && (
                            <div
                              className="inline-flex items-center gap-1.5 bg-sky-50 border border-sky-200 rounded-lg px-2 py-0.5"
                              onClick={(ev) => ev.stopPropagation()}
                            >
                              <span className="font-mono font-bold text-sm text-sky-900">{c.phone}</span>
                              <button
                                type="button"
                                onClick={() => copyText(moroccoInternational(c.phone), c.phone)}
                                className={`text-sky-500 hover:text-emerald-600 hover:scale-110 ${BTN_TAP}`}
                                title="Copy international format"
                              >📋</button>
                            </div>
                          )}
                          <span className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2 py-0.5 font-semibold text-[11px]">
                            {c.orders_count} order{c.orders_count === 1 ? "" : "s"}
                          </span>
                          <span className={`text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`} aria-hidden>▾</span>
                        </div>
                        {(c.city || c.country) && (
                          <div className="mt-1 text-[11px] text-gray-500">{[c.city, c.country].filter(Boolean).join(", ")}</div>
                        )}
                      </button>
                      {isExpanded && (
                        <div className="border-t border-gray-200 bg-gray-50/40">
                          {custLoading && (
                            <div className="px-3 py-4 text-xs text-gray-500 inline-flex items-center gap-2">
                              <span className="inline-block w-3 h-3 rounded-full border-2 border-gray-300 border-t-indigo-600 animate-spin" />
                              Loading orders…
                            </div>
                          )}
                          {custError && (
                            <div className="px-3 py-3 text-xs text-rose-700">{custError}</div>
                          )}
                          {!custLoading && !custError && custOrders.length === 0 && (
                            <div className="px-3 py-4 text-xs text-gray-500">No orders found for this customer.</div>
                          )}
                          {!custLoading && !custError && custOrders.length > 0 && (
                            <div className="divide-y divide-gray-100">
                              {custOrders.map((o) => (
                                <React.Fragment key={o.id}>{renderOrderCard(o)}</React.Fragment>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Color themes for the summary pills. Each pill has its own palette so the bar reads
// like a dashboard at a glance — the active state inverts to a saturated background.
const PILL_THEMES = {
  sky:     { idle: "bg-sky-50 text-sky-700 border-sky-200",       active: "bg-sky-600 text-white border-sky-700" },
  slate:   { idle: "bg-slate-50 text-slate-700 border-slate-200", active: "bg-slate-700 text-white border-slate-800" },
  indigo:  { idle: "bg-indigo-50 text-indigo-700 border-indigo-200", active: "bg-indigo-600 text-white border-indigo-700" },
  amber:   { idle: "bg-amber-50 text-amber-800 border-amber-200", active: "bg-amber-500 text-white border-amber-600" },
  orange:  { idle: "bg-orange-50 text-orange-700 border-orange-200", active: "bg-orange-500 text-white border-orange-600" },
  rose:    { idle: "bg-rose-50 text-rose-700 border-rose-200",    active: "bg-rose-500 text-white border-rose-600" },
  red:     { idle: "bg-red-50 text-red-700 border-red-200",       active: "bg-red-600 text-white border-red-700" },
  violet:  { idle: "bg-violet-50 text-violet-700 border-violet-200", active: "bg-violet-600 text-white border-violet-700" },
  fuchsia: { idle: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200", active: "bg-fuchsia-600 text-white border-fuchsia-700" },
  teal:    { idle: "bg-teal-50 text-teal-700 border-teal-200",    active: "bg-teal-600 text-white border-teal-700" },
  emerald: { idle: "bg-emerald-50 text-emerald-700 border-emerald-200", active: "bg-emerald-600 text-white border-emerald-700" },
};

function StatPill({ label, value, color = "slate", onClick, active = false, icon = null }) {
  const theme = PILL_THEMES[color] || PILL_THEMES.slate;
  const palette = active ? theme.active : theme.idle;
  const interactive = typeof onClick === "function";
  const clickable = interactive ? "cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition" : "";
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(e); } } : undefined}
      className={`rounded-xl border px-3 py-2 min-w-[96px] shadow-sm ${palette} ${clickable}`}
    >
      <div className="text-[10px] uppercase tracking-wide font-semibold opacity-80 flex items-center gap-1">
        {icon && <span aria-hidden>{icon}</span>}
        {label}
        {active && <span aria-hidden className="ml-auto">✕</span>}
      </div>
      <div className="text-xl font-bold leading-tight tabular-nums">{value}</div>
    </div>
  );
}

// Tiny color-coded count chip used inside the team agent cards.
const MINI_THEMES = {
  indigo:  { bg: "bg-indigo-50",  text: "text-indigo-700",  border: "border-indigo-200" },
  amber:   { bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-200" },
  orange:  { bg: "bg-orange-50",  text: "text-orange-700",  border: "border-orange-200" },
  rose:    { bg: "bg-rose-50",    text: "text-rose-700",    border: "border-rose-200" },
  red:     { bg: "bg-red-50",     text: "text-red-700",     border: "border-red-200" },
  violet:  { bg: "bg-violet-50",  text: "text-violet-700",  border: "border-violet-200" },
  fuchsia: { bg: "bg-fuchsia-50", text: "text-fuchsia-700", border: "border-fuchsia-200" },
  sky:     { bg: "bg-sky-50",     text: "text-sky-700",     border: "border-sky-200" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" },
};

function MiniStat({ label, value, color = "indigo", title }) {
  const theme = MINI_THEMES[color] || MINI_THEMES.indigo;
  return (
    <div
      className={`rounded-lg border ${theme.bg} ${theme.text} ${theme.border} px-1.5 py-1 text-center`}
      title={title || label}
    >
      <div className="text-[9px] uppercase tracking-wide font-semibold opacity-80 leading-tight">{label}</div>
      <div className="text-sm font-bold tabular-nums leading-tight">{value}</div>
    </div>
  );
}

function AgentCard({ agent, isMe }) {
  const initial = ((agent.name || agent.email || "?").trim().charAt(0) || "?").toUpperCase();
  const b = agent.breakdown || {};
  const confirmed = Number(agent.confirmed_today || 0);
  return (
    <div className={`relative bg-white border rounded-2xl p-3 shadow-sm transition hover:shadow-md ${isMe ? "border-indigo-300 ring-1 ring-indigo-200" : "border-gray-200"}`}>
      {/* Header: avatar + name + chips */}
      <div className="flex items-center gap-2 mb-2.5">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${isMe ? "bg-indigo-600 text-white" : "bg-indigo-100 text-indigo-700"}`}>
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" title={agent.name || agent.email}>
            {agent.name || agent.email}
          </div>
          <div className="text-[10px] text-gray-500 truncate" title={agent.email}>{agent.email}</div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          {isMe && (
            <span className="text-[9px] uppercase tracking-wide bg-indigo-100 text-indigo-700 border border-indigo-200 rounded px-1 py-0.5">you</span>
          )}
          {agent.is_catchall && (
            <span className="text-[9px] uppercase tracking-wide bg-amber-100 text-amber-700 border border-amber-200 rounded px-1 py-0.5">catch-all</span>
          )}
        </div>
      </div>

      {/* Tags row */}
      {(agent.tags || []).length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {(agent.tags || []).map((t) => (
            <span key={t} className="text-[10px] bg-gray-100 text-gray-700 border border-gray-200 rounded-full px-1.5 py-0.5">{t}</span>
          ))}
        </div>
      )}

      {/* Per-level breakdown */}
      <div className="grid grid-cols-4 gap-1.5">
        <MiniStat label="New"   value={Number(b.new   || 0)} color="indigo"  />
        <MiniStat label="N1"    value={Number(b.n1    || 0)} color="amber"   />
        <MiniStat label="N2"    value={Number(b.n2    || 0)} color="orange"  />
        <MiniStat label="N3"    value={Number(b.n3    || 0)} color="rose"    />
        <MiniStat label="N4"    value={Number(b.n4    || 0)} color="red"     />
        <MiniStat label="NoWTP" value={Number(b.nowtp || 0)} color="violet"  />
        <MiniStat label="Enatt" value={Number(b.enatt || 0)} color="fuchsia" />
        <MiniStat label="Pending" value={Number(b.total || 0)} color="sky" title="Total open + unshipped in this agent's queue" />
      </div>

      {/* Confirmed today */}
      <div className="mt-2.5 pt-2.5 border-t border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-emerald-700">
          <span>✅</span>
          <span>Confirmed today</span>
        </div>
        <div className="text-xl font-bold tabular-nums text-emerald-700">{confirmed}</div>
      </div>
    </div>
  );
}

// Colored status badge used in the customer-history list and order details.
function StatusBadge({ kind, value }) {
  const v = String(value || "").toLowerCase();
  // kind: "fulfillment" | "financial" | "lifecycle"
  let palette = "bg-gray-100 text-gray-700 border-gray-200";
  if (kind === "lifecycle" && v === "cancelled") palette = "bg-rose-100 text-rose-700 border-rose-200";
  else if (kind === "fulfillment") {
    if (v === "fulfilled") palette = "bg-emerald-100 text-emerald-700 border-emerald-200";
    else if (v === "partially_fulfilled" || v === "partially fulfilled") palette = "bg-sky-100 text-sky-700 border-sky-200";
    else if (v === "unfulfilled") palette = "bg-amber-100 text-amber-700 border-amber-200";
    else if (v === "scheduled") palette = "bg-violet-100 text-violet-700 border-violet-200";
    else if (v === "on_hold" || v === "on hold") palette = "bg-amber-100 text-amber-700 border-amber-200";
  } else if (kind === "financial") {
    if (v === "paid") palette = "bg-emerald-100 text-emerald-700 border-emerald-200";
    else if (v === "pending") palette = "bg-amber-100 text-amber-700 border-amber-200";
    else if (v === "partially_paid" || v === "partially paid") palette = "bg-sky-100 text-sky-700 border-sky-200";
    else if (v === "refunded" || v === "partially_refunded" || v === "partially refunded") palette = "bg-gray-100 text-gray-700 border-gray-200";
    else if (v === "voided" || v === "authorized") palette = "bg-violet-100 text-violet-700 border-violet-200";
  }
  const label = String(value || "").replace(/_/g, " ").toLowerCase();
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-wide font-medium px-2 py-0.5 rounded-full border ${palette}`}>
      {label || "—"}
    </span>
  );
}

function OrderExpanded({ order, store, shopDomain, onToast }) {
  const notify = onToast || (() => {});
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteMsg, setNoteMsg] = useState(null);

  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);

  const labelRef = useRef(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelMsg, setLabelMsg] = useState(null);

  async function handleCopyLabel() {
    if (!labelRef.current) return;
    setLabelBusy(true); setLabelMsg(null);
    try {
      const { url, clipboardOk, filename } = await copyNodeAsPng(labelRef.current, {
        filenameHint: `label-${(order.name || order.number || "order").toString().replace(/[^a-z0-9_-]+/gi, "_")}`,
      });
      if (clipboardOk) {
        setLabelMsg("Copied label image to clipboard.");
        notify("Label image copied to clipboard", "success");
      } else {
        triggerDownload(url, filename);
        setLabelMsg("Clipboard blocked — downloaded the PNG instead.");
        notify("Clipboard blocked — PNG downloaded", "warn");
      }
    } catch (e) {
      const msg = e?.message || "Failed to generate label";
      setLabelMsg(msg);
      notify(msg, "error");
    } finally {
      setLabelBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const cid = order?.customer_id;
    if (!cid) { setHistory({ orders: [], total_orders: 0 }); return; }
    setHistoryLoading(true); setHistoryError(null);
    (async () => {
      try {
        const js = await API.customerOrders(store, cid);
        if (!cancelled) setHistory(js);
      } catch (e) {
        if (!cancelled) setHistoryError(e?.message || "Failed to load customer history");
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [order?.customer_id, store]);

  async function handleAddNote() {
    const text = (noteText || "").trim();
    if (!text) return;
    setNoteBusy(true); setNoteMsg(null);
    try {
      await API.appendNote(order.id, text, store);
      setNoteMsg(`Added: "${text}"`);
      setNoteText("");
      notify(`Note added to ${order.name || `#${order.number}`}`, "success");
    } catch (e) {
      const msg = e?.message || "Failed to add note";
      setNoteMsg(msg);
      notify(msg, "error");
    } finally {
      setNoteBusy(false);
    }
  }

  const initial = (order.customer_name || "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="space-y-4">
      {/* Customer & shipping  +  Add note */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <div className="md:col-span-3 bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[11px] uppercase tracking-wider font-semibold text-indigo-600">👤 Customer & shipping</span>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center shrink-0">
              {initial}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold leading-tight">{order.customer_name || "—"}</div>
              <div className="text-xs font-mono text-gray-600 mt-0.5">{order.phone || order.customer_phone || "—"}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Address</div>
              <div className="text-gray-800">
                {order.shipping_address1 || "—"}
                {order.shipping_address2 ? `, ${order.shipping_address2}` : ""}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">City</div>
              <div className="text-gray-800 font-medium">
                {order.shipping_city || "—"}
                {order.shipping_zip ? <span className="ml-1 text-gray-500">· {order.shipping_zip}</span> : null}
              </div>
            </div>
            {order.shipping_country && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">Country</div>
                <div className="text-gray-800">{order.shipping_country}</div>
              </div>
            )}
          </div>
          {order.note && (
            <div className="mt-3 text-xs text-gray-700 bg-amber-50 border border-amber-200 rounded-lg p-2 whitespace-pre-wrap">
              <div className="text-[10px] uppercase tracking-wide text-amber-700 font-semibold mb-1">📌 Existing note</div>
              {order.note}
            </div>
          )}
        </div>

        <div className="md:col-span-2 bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[11px] uppercase tracking-wider font-semibold text-indigo-600">📝 Add note to Shopify</span>
          </div>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="e.g. customer asked to call back tomorrow morning"
            rows={3}
            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={handleAddNote}
              disabled={noteBusy || !noteText.trim()}
              className={`text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-50 shadow-sm ${BTN_TAP}`}
            >{noteBusy ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                Adding…
              </span>
            ) : "Add note"}</button>
            {noteMsg && <span className="text-[11px] text-gray-600 truncate" title={noteMsg}>{noteMsg}</span>}
          </div>
          <div className="text-[11px] text-gray-500 mt-1.5">Appends to the order note (existing notes preserved).</div>
        </div>
      </div>

      {/* Customer order history */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
        <div className="flex items-center mb-3">
          <span className="text-[11px] uppercase tracking-wider font-semibold text-indigo-600">🕓 Customer history</span>
          {history?.total_orders > 0 && (
            <span className="ml-2 text-[11px] text-gray-500">
              {history.total_orders} total order{history.total_orders === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {historyLoading && <div className="text-xs text-gray-500">Loading customer orders…</div>}
        {historyError && <div className="text-xs text-rose-700">{historyError}</div>}
        {!historyLoading && !historyError && history && (
          (history.orders || []).length === 0 ? (
            <div className="text-xs text-gray-500">No previous orders.</div>
          ) : (
            <div className="overflow-auto rounded-lg border border-gray-100">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Order</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Fulfillment</th>
                    <th className="px-3 py-2">Payment</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.orders || []).map((h, idx) => {
                    const url = shopifyOrderUrl({ id: h.id, legacy_id: h.legacy_id }, shopDomain);
                    const isCancelled = !!h.cancelled_at;
                    const isCurrent = h.id === order.id;
                    const zebra = idx % 2 === 1 ? "bg-gray-50/60" : "bg-white";
                    return (
                      <tr key={h.id} className={`border-t border-gray-100 ${isCurrent ? "bg-indigo-50/70" : zebra}`}>
                        <td className="px-3 py-2 font-medium whitespace-nowrap">
                          {url ? (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">{h.name || `#${h.number}`}</a>
                          ) : (h.name || `#${h.number}`)}
                          {isCurrent && <span className="ml-1 text-[10px] text-indigo-700 font-semibold">(current)</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{h.created_at ? new Date(h.created_at).toLocaleDateString() : ""}</td>
                        <td className="px-3 py-2"><StatusBadge kind="fulfillment" value={h.fulfillment_status} /></td>
                        <td className="px-3 py-2"><StatusBadge kind="financial" value={h.financial_status} /></td>
                        <td className="px-3 py-2">
                          {isCancelled
                            ? <StatusBadge kind="lifecycle" value="cancelled" />
                            : <span className="text-[10px] text-gray-400">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{h.total_price} {h.currency}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {/* Line items */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
        <div className="flex items-center mb-3">
          <span className="text-[11px] uppercase tracking-wider font-semibold text-indigo-600">📦 Line items</span>
          <div className="ml-auto flex items-center gap-2">
            {labelMsg && <span className="text-[11px] text-gray-600 truncate max-w-[200px]" title={labelMsg}>{labelMsg}</span>}
            <button
              type="button"
              onClick={handleCopyLabel}
              disabled={labelBusy}
              className={`text-xs px-3 py-1.5 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 font-semibold hover:bg-indigo-100 disabled:opacity-50 ${BTN_TAP}`}
              title="Generate a PNG label and copy it to your clipboard"
            >{labelBusy ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-indigo-300 border-t-indigo-700 animate-spin" />
                Generating…
              </span>
            ) : "📋 Copy label"}</button>
          </div>
        </div>
        <LineItemsGrid order={order} />
      </div>

      {/* Off-screen label used for the PNG capture. Positioned far off-screen so it
          stays out of the visible layout while still being rendered for html-to-image. */}
      <div style={{ position: "fixed", left: -10000, top: 0, pointerEvents: "none", zIndex: -1 }} aria-hidden>
        <div ref={labelRef}>
          <OrderLabel order={order} store={store} />
        </div>
      </div>
    </div>
  );
}

function LineItemsGrid({ order }) {
  const items = order.line_items || [];
  if (items.length === 0) return <div className="text-xs text-gray-500">No line items.</div>;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {items.map((li, idx) => (
        <div key={idx} className="bg-gradient-to-br from-white to-gray-50 border border-gray-200 rounded-xl p-3 hover:shadow-md transition">
          <div className="w-full aspect-square bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center mb-2 ring-1 ring-gray-200">
            {li.image ? (
              <img src={li.image} alt={li.title} className="w-full h-full object-cover" />
            ) : <span className="text-xs text-gray-400">no image</span>}
          </div>
          <div className="text-sm font-semibold leading-tight line-clamp-2 text-gray-900">{li.title}</div>
          {(li.options || []).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {(li.options || []).map((opt, i) => (
                <span key={i} className="text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full font-medium">
                  {opt.name}: {opt.value}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
            <div className="bg-sky-50 text-sky-800 border border-sky-200 rounded-md py-1">
              <div className="text-[9px] uppercase font-semibold opacity-70">Qty</div>
              <div className="font-bold tabular-nums">{li.quantity}</div>
            </div>
            <div className="bg-amber-50 text-amber-800 border border-amber-200 rounded-md py-1">
              <div className="text-[9px] uppercase font-semibold opacity-70">Unit</div>
              <div className="font-bold tabular-nums">{li.unit_price}</div>
            </div>
            <div className="bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-md py-1">
              <div className="text-[9px] uppercase font-semibold opacity-70">Total</div>
              <div className="font-bold tabular-nums">{(Number(li.unit_price || 0) * Number(li.quantity || 0)).toFixed(2)}</div>
            </div>
          </div>
          {li.sku && <div className="mt-1.5 text-[10px] text-gray-500 font-mono truncate" title={li.sku}>SKU: {li.sku}</div>}
        </div>
      ))}
    </div>
  );
}
