import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Minus,
  Package,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
  MapPin,
} from "lucide-react";
import { authFetch, authHeaders, clearAuth } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import OrderLabel from "../components/OrderLabel";
import { useToasts, ToastStack } from "../components/Toast";
import { persistStoreSelection, readCurrentStore } from "../lib/stores";
import {
  enqueueTagWrite,
  enqueueTagWrites,
  retrySyncQueueNow,
  useSyncQueueState,
  readQueue,
} from "../lib/syncQueue";
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
const ACTION_BTN_BASE = "inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold text-white shadow-md hover:shadow-lg hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-offset-1 active:scale-[0.95] transition-all duration-100 min-w-[60px] justify-center disabled:opacity-50 disabled:cursor-wait disabled:hover:translate-y-0 disabled:hover:shadow-md";
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
  async unarchiveOrder(orderId, store) {
    const res = await authFetch(`/api/agent/orders/${encodeURIComponent(orderId)}/unarchive`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ store }),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Unarchive failed" }));
      throw new Error(js.detail || `Unarchive failed (${res.status})`);
    }
    return res.json();
  },
  async searchProductVariants(store, q) {
    const qs = new URLSearchParams({ store, q, first: "20" });
    const res = await authFetch(`/api/agent/product-variants/search?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Product search failed" }));
      throw new Error(js.detail || `Product search failed (${res.status})`);
    }
    return res.json();
  },
  async editOrderItems(payload) {
    const res = await authFetch("/api/agent/order-items/edit", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Could not update order items" }));
      throw new Error(js.detail || `Could not update order items (${res.status})`);
    }
    return res.json();
  },
  async updateOrderShipping(payload) {
    const res = await authFetch("/api/agent/order-shipping/update", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Could not update shipping" }));
      throw new Error(js.detail || `Could not update shipping (${res.status})`);
    }
    return res.json();
  },
  async pullPreview({ store, level, exclude_tags }) {
    const res = await authFetch(`/api/agent/pull/preview`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ store, level, exclude_tags }),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Preview failed" }));
      throw new Error(js.detail || `Preview failed (${res.status})`);
    }
    return res.json();
  },
  async pullExecute({ store, level, exclude_tags, limit, agent_tag }) {
    const res = await authFetch(`/api/agent/pull/execute`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ store, level, exclude_tags, limit, agent_tag }),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Pull failed" }));
      throw new Error(js.detail || `Pull failed (${res.status})`);
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
function applyPendingQueueWrites(orders, store) {
  let pending;
  try { pending = readQueue(); } catch { pending = []; }
  if (!pending || pending.length === 0) return orders;
  const byOrder = new Map();
  for (const it of pending) {
    if (!it?.orderId) continue;
    if (store && it.store && String(it.store).toLowerCase() !== String(store).toLowerCase()) continue;
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
function Header({ title, rightSlot, me }) {
  const initial = ((me?.name || me?.email || "?").trim().charAt(0) || "?").toUpperCase();
  return (
    <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-gray-200">
      <div className="w-full px-3 sm:px-4 xl:px-6 py-3 flex items-center gap-3 flex-wrap">
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
  // Pull-orders modal — opened by the "Get more orders" panel. `pullMode` is the
  // level being pulled ("new" | "n1" | "n2" | "n3" | "n4" | "nowtp" | "enatt");
  // null = closed.
  const [pullMode, setPullMode] = useState(null);
  // Toast notifications (button feedback)
  const [toasts, pushToast, dismissToast] = useToasts();

  // Global Shopify search (orders + customers). Independent of the agent's queue.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null); // { orders, customers, shop_domain, query }
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const searchReqIdRef = useRef(0);
  const searchTimerRef = useRef(null);
  const [expandedCustomerId, setExpandedCustomerId] = useState(null);
  const [customerOrdersById, setCustomerOrdersById] = useState({});

  const runSearch = useCallback(async (queryValue) => {
    const q = (queryValue || "").trim();
    if (q.length < 2) return;
    const reqId = ++searchReqIdRef.current;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const js = await API.search(store, q);
      if (reqId !== searchReqIdRef.current) return;
      setSearchResults(js);
      const primed = {};
      for (const customer of (js.customers || [])) {
        if (customer?.id && Array.isArray(customer.orders)) {
          primed[customer.id] = { orders: customer.orders, loading: false };
        }
      }
      setCustomerOrdersById(primed);
    } catch (e) {
      if (reqId !== searchReqIdRef.current) return;
      setSearchError(e?.message || "Search failed");
      setSearchResults(null);
      setCustomerOrdersById({});
    } finally {
      if (reqId === searchReqIdRef.current) setSearchLoading(false);
    }
  }, [store]);

  // Short debounce keeps typing smooth; Enter or the Search button runs immediately.
  useEffect(() => {
    const q = (searchQuery || "").trim();
    if (q.length < 2) {
      searchReqIdRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(null);
      setCustomerOrdersById({});
      return;
    }
    searchTimerRef.current = setTimeout(() => runSearch(q), 250);
    return () => {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    };
  }, [searchQuery, runSearch]);

  function searchNow() {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    runSearch(searchQuery);
  }

  function clearSearch() {
    searchReqIdRef.current += 1;
    setSearchQuery("");
    setSearchResults(null);
    setSearchError(null);
    setExpandedCustomerId(null);
    setCustomerOrdersById({});
  }

  function changeStore(nextStore) {
    if (!nextStore || nextStore === store) return;
    searchReqIdRef.current += 1;
    setStore(nextStore);
    setSearchResults(null);
    setSearchError(null);
    setExpandedCustomerId(null);
    setCustomerOrdersById({});
  }

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
  const [unarchiveBusyIds, setUnarchiveBusyIds] = useState(() => new Set());
  const requestIdRef = useRef(0);
  const teamRequestIdRef = useRef(0);
  const syncState = useSyncQueueState();
  const syncCount = syncState.count;

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

  // Poll only while this tab is visible. Refresh immediately when the user returns so
  // foreground freshness stays the same without paying for hidden-tab work.
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (pageIndex === 0) loadFirst();
      loadTeam();
    };
    const t = setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
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

  // Success is announced only after the backend confirms that Shopify changed
  // and the analytics event committed. The earlier UI used to say "success"
  // immediately after queueing, which hid failed or unauthorized requests.
  useEffect(() => {
    function onSynced(event) {
      const item = event?.detail?.item;
      if (!item || item.action !== "add" || item.silentSuccess) return;
      const rawTag = String(item.tag || "");
      const label = isCodTag(rawTag) ? "Confirmation" : rawTag.toUpperCase();
      pushToast(`✓ ${label} saved and counted`, "success", 2600);
    }
    window.addEventListener("confirmationActionSynced", onSynced);
    return () => window.removeEventListener("confirmationActionSynced", onSynced);
  }, [pushToast]);

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
    () => applyPendingQueueWrites(currentOrders, store),
    // recomputes on each `nowTick` so newly enqueued writes are picked up promptly
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentOrders, store, syncCount, nowTick]
  );
  const pendingOrderIds = useMemo(
    () => new Set(
      (syncState.items || [])
        .filter((item) => !item.store || item.store === store)
        .map((item) => item.orderId)
    ),
    [syncState.items, store]
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

  function queueActions(actions) {
    const queued = enqueueTagWrites(actions);
    if (!queued) {
      pushToast("Action was not saved. Keep this order open and try again.", "error", 7000);
      return false;
    }
    return true;
  }

  function cyclePhone(order, cycle) {
    const next = nextInCycle(order.tags || [], cycle);
    const cycleSet = new Set(cycle.map((t) => t.toLowerCase()));
    const present = (order.tags || []).filter((t) => cycleSet.has(String(t || "").toLowerCase()));
    const writes = present
      .filter((old) => String(old).toLowerCase() !== next.toLowerCase())
      .map((old) => ({ orderId: order.id, orderLabel: order.name || `#${order.number}`, action: "remove", tag: old, store }));
    writes.push({ orderId: order.id, orderLabel: order.name || `#${order.number}`, action: "add", tag: next, store });
    if (!queueActions(writes)) return null;
    updateLocalOrderTags(order.id, (tags) => {
      const filtered = tags.filter((t) => !cycleSet.has(String(t || "").toLowerCase()));
      return dedupTags([...filtered, next]);
    });
    return next;
  }

  async function handlePhone(order) {
    const ok = await copyToClipboard(order.phone || "");
    const next = cyclePhone(order, PHONE_TAGS);
    if (!next) return;
    pushToast(
      ok ? `📞 Copied ${order.phone} · saving ${next.toUpperCase()}…` : `📞 Saving ${next.toUpperCase()} · phone copy blocked`,
      ok ? "info" : "warn",
    );
  }

  function handleNowtp(order) {
    // Cycles nowtp1 → nowtp2 → nowtp3 → nowtp4 (locks at nowtp4).
    const next = cyclePhone(order, NOWTP_TAGS);
    if (next) pushToast(`🚫 Saving No-WhatsApp · ${next}…`, "info");
  }

  function handleEnatt(order) {
    // Cycles enatt1 → enatt2 → enatt3 → enatt4 (locks at enatt4). Use for "en attente"
    // (order pending follow-up).
    const next = cyclePhone(order, ENATT_TAGS);
    if (next) pushToast(`⏳ Saving En attente · ${next}…`, "info");
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
    if (!queueActions([{ orderId: order.id, orderLabel: order.name || `#${order.number}`, action: "add", tag, store }])) return;
    // Add the cod tag everywhere (queue, search results, expanded customer)…
    updateLocalOrderTags(order.id, (tags) => dedupTags([...tags, tag]));
    // …then drop the row from the agent's queue (matches backend filter).
    removeLocalOrder(order.id);
    setDatePickerFor(null);
    pushToast(`Saving ${order.name || `#${order.number}`} for ${dd}…`, "info");
  }

  function removeTagOptimistic(order, tag) {
    if (!enqueueTagWrite({ orderId: order.id, orderLabel: order.name || `#${order.number}`, action: "remove", tag, store })) {
      pushToast("Tag removal was not saved. Please try again.", "error", 6000);
      return;
    }
    updateLocalOrderTags(order.id, (tags) => tags.filter((t) => String(t || "").toLowerCase() !== String(tag || "").toLowerCase()));
    pushToast(`Removing tag · ${tag}…`, "info");
  }

  async function handleUnarchive(order) {
    const label = order.name || `#${order.number}`;
    setActionsDropdownFor(null);
    setUnarchiveBusyIds((prev) => new Set(prev).add(order.id));
    try {
      const js = await API.unarchiveOrder(order.id, store);
      patchOrderInPlace(order.id, () => js.order || { ...order, archived: false, closed_at: null });
      await loadFirst();
      pushToast(`✓ ${label} unarchived and restored to Today Suivi`, "success", 4500);
    } catch (e) {
      pushToast(e?.message || `Could not unarchive ${label}`, "error", 7000);
    } finally {
      setUnarchiveBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(order.id);
        return next;
      });
    }
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
      const orderById = new Map(ordersForView.map((order) => [order.id, order]));
      const writes = ids.map((id) => {
        const order = orderById.get(id);
        return {
          orderId: id,
          orderLabel: order?.name || (order?.number ? `#${order.number}` : ""),
          action: "add",
          tag,
          store,
          silentSuccess: true,
        };
      });
      if (!queueActions(writes)) return;
      for (const id of ids) {
        if (isCod) {
          removeLocalOrder(id);
        } else {
          updateLocalOrderTags(id, (tags) => dedupTags([...tags, tag]));
        }
      }
      pushToast(`Saving "${tag}" on ${ids.length} order${ids.length === 1 ? "" : "s"}…`, "info");
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
    const isSyncing = pendingOrderIds.has(o.id);
    const isArchived = Boolean(o.archived || (o.closed_at && !o.cancelled_at));
    const isUnarchiving = unarchiveBusyIds.has(o.id);
    const currentPhoneTag = tagsInCycle(o.tags || [], PHONE_TAGS).slice(-1)[0] || "";
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
          {isArchived && (
            <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full border border-amber-300 bg-amber-50 text-amber-800 px-1.5 py-0.5">
              Archived
            </span>
          )}
          <span className="ml-auto text-base font-bold text-gray-900 tabular-nums whitespace-nowrap">
            {o.total_price} <span className="text-xs font-medium text-gray-500">{o.currency}</span>
          </span>
        </div>
        <div className="text-[11px] text-gray-500 mt-0.5">
          {o.created_at ? new Date(o.created_at).toLocaleString() : ""}
          {isSyncing && <span className="ml-2 font-semibold text-amber-700">Saving action…</span>}
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
                  disabled={isSyncing}
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
          <div className="relative min-w-0 col-span-1">
            <button
              disabled={isSyncing}
              onClick={(ev) => { ev.stopPropagation(); handlePhone(o); }}
              className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.sky} !min-w-0 w-full !px-2`}
              title="Copy phone + advance n1/n2/n3/n4"
            >
              <span aria-hidden className="text-sm">📞</span>
              <span>{currentPhoneTag.toUpperCase() || "Call"}</span>
            </button>
            {currentPhoneTag && (
              <button
                type="button"
                disabled={isSyncing}
                onClick={(ev) => { ev.stopPropagation(); removeTagOptimistic(o, currentPhoneTag); }}
                className={`absolute z-10 -right-1.5 -top-1.5 h-5 w-5 rounded-full border border-sky-700 bg-white text-sky-700 text-sm font-bold leading-none shadow hover:bg-rose-50 hover:border-rose-600 hover:text-rose-700 ${BTN_TAP}`}
                title={`Remove ${currentPhoneTag.toUpperCase()} try`}
                aria-label={`Remove ${currentPhoneTag.toUpperCase()} try`}
              >×</button>
            )}
          </div>
          <button
            disabled={isSyncing}
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
            disabled={isSyncing}
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
            disabled={isSyncing}
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
            {isArchived && (
              <button
                disabled={isUnarchiving}
                onClick={() => handleUnarchive(o)}
                className="block w-full text-left text-sm px-3 py-2 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
              >{isUnarchiving ? "Restoring…" : "↩ Unarchive to Today Suivi"}</button>
            )}
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
              disabled={isSyncing}
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
            <OrderExpanded
              order={o}
              store={store}
              shopDomain={meta.shop_domain}
              onToast={pushToast}
              onOrderUpdated={(updatedOrder) => patchOrderInPlace(o.id, () => updatedOrder)}
            />
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
        rightSlot={
          <div className="flex items-center gap-2">
            <button onClick={() => { try { history.pushState(null, "", "/inventory-helper"); window.dispatchEvent(new PopStateEvent("popstate")); } catch { location.href = "/inventory-helper"; } }} className={`text-xs px-3 py-1 rounded-full border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 ${BTN_TAP}`}>
              Inventory
            </button>
            {syncCount > 0 && (
              <button
                type="button"
                onClick={retrySyncQueueNow}
                className={`text-xs px-2 py-1 rounded-full border ${
                  syncState.blockedCount > 0
                    ? "bg-rose-100 text-rose-800 border-rose-300"
                    : "bg-amber-100 text-amber-800 border-amber-200"
                }`}
                title={syncState.lastError || "Actions are being saved"}
              >
                {syncState.blockedCount > 0 ? `Not saved yet ${syncCount} · Retry` : `Saving ${syncCount}`}
              </button>
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
      <main className="w-full px-3 sm:px-4 xl:px-6 py-4 space-y-4">
        {/* Global Shopify search */}
        <GlobalSearch
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onSearchNow={searchNow}
          onClear={clearSearch}
          loading={searchLoading}
          error={searchError}
          results={searchResults}
          store={store}
          onStoreChange={changeStore}
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
        {syncCount > 0 && (
          <div className={`rounded-xl border px-3 py-2 text-sm flex flex-wrap items-center gap-2 ${
            syncState.blockedCount > 0
              ? "border-rose-300 bg-rose-50 text-rose-900"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`} role="status" aria-live="polite">
            <span className="font-semibold">
              {syncState.blockedCount > 0
                ? `${syncCount} action${syncCount === 1 ? "" : "s"} not saved yet`
                : `Saving ${syncCount} action${syncCount === 1 ? "" : "s"}…`}
            </span>
            <span className="text-xs opacity-80">
              {syncState.lastError || "Keep this page open; every action is queued safely and will be counted after confirmation."}
            </span>
            {syncState.items?.[0] && (
              <span className="rounded-md bg-white/70 px-2 py-1 text-xs font-medium">
                Next: {syncState.items[0].orderLabel || "order"} · {String(syncState.items[0].tag || "").toUpperCase()}
              </span>
            )}
            <button
              type="button"
              onClick={retrySyncQueueNow}
              className="ml-auto rounded-lg border border-current bg-white/70 px-3 py-1 text-xs font-semibold hover:bg-white"
            >Retry now</button>
          </div>
        )}

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

        {/* Pull-orders panel — claim unassigned orders or yank level-tagged
            orders away from other agents. Each button opens a modal that
            previews the available count and lets the agent choose how many to
            take. After approve, those orders are tagged with the agent's own
            tag and every other active agent's tag is stripped off them. */}
        <section className="bg-gradient-to-br from-indigo-50 to-violet-50 border border-indigo-200 rounded-2xl p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xs font-semibold text-indigo-900 mr-2">
              ➕ Get more orders
            </div>
            <button
              type="button"
              onClick={() => setPullMode("new")}
              className={`text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 shadow-sm ${BTN_TAP}`}
              title="Pull unassigned new orders into your queue"
            >✨ New</button>
            <button
              type="button"
              onClick={() => setPullMode("n1")}
              className={`text-xs px-3 py-1.5 rounded-lg bg-amber-500 text-white font-medium hover:bg-amber-600 shadow-sm ${BTN_TAP}`}
              title="Pull N1 orders (with optional exclusion tags) into your queue"
            >📞 N1</button>
            <button
              type="button"
              onClick={() => setPullMode("n2")}
              className={`text-xs px-3 py-1.5 rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600 shadow-sm ${BTN_TAP}`}
            >📞 N2</button>
            <button
              type="button"
              onClick={() => setPullMode("n3")}
              className={`text-xs px-3 py-1.5 rounded-lg bg-rose-500 text-white font-medium hover:bg-rose-600 shadow-sm ${BTN_TAP}`}
            >📞 N3</button>
            <button
              type="button"
              onClick={() => setPullMode("n4")}
              className={`text-xs px-3 py-1.5 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 shadow-sm ${BTN_TAP}`}
            >📞 N4</button>
            <button
              type="button"
              onClick={() => setPullMode("nowtp")}
              className={`text-xs px-3 py-1.5 rounded-lg bg-violet-500 text-white font-medium hover:bg-violet-600 shadow-sm ${BTN_TAP}`}
            >🚫 Nowtp</button>
            <button
              type="button"
              onClick={() => setPullMode("enatt")}
              className={`text-xs px-3 py-1.5 rounded-lg bg-fuchsia-500 text-white font-medium hover:bg-fuchsia-600 shadow-sm ${BTN_TAP}`}
            >⏳ Enatt</button>
            <div className="text-[11px] text-indigo-700/80 ml-auto">
              Pulled orders are tagged with your tag and any other agent's tag is removed.
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
                  const isSyncing = pendingOrderIds.has(o.id);
                  const currentPhoneTag = tagsInCycle(o.tags || [], PHONE_TAGS).slice(-1)[0] || "";
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
                                  disabled={isSyncing}
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
                            <div className="relative inline-flex">
                              <button
                                disabled={isSyncing}
                                onClick={(ev) => { ev.stopPropagation(); handlePhone(o); }}
                                className={`${ACTION_BTN_BASE} ${ACTION_BTN_THEMES.sky} !min-w-[44px] !px-2`}
                                title="Copy phone + advance n1/n2/n3/n4"
                              >
                                <span aria-hidden className="text-sm">📞</span>
                                <span>{currentPhoneTag.toUpperCase() || "Call"}</span>
                              </button>
                              {currentPhoneTag && (
                                <button
                                  type="button"
                                  disabled={isSyncing}
                                  onClick={(ev) => { ev.stopPropagation(); removeTagOptimistic(o, currentPhoneTag); }}
                                  className={`absolute z-10 -right-1.5 -top-1.5 h-5 w-5 rounded-full border border-sky-700 bg-white text-sky-700 text-sm font-bold leading-none shadow hover:bg-rose-50 hover:border-rose-600 hover:text-rose-700 ${BTN_TAP}`}
                                  title={`Remove ${currentPhoneTag.toUpperCase()} try`}
                                  aria-label={`Remove ${currentPhoneTag.toUpperCase()} try`}
                                >×</button>
                              )}
                            </div>
                            <button
                              disabled={isSyncing}
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
                              disabled={isSyncing}
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
                              disabled={isSyncing}
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
                                disabled={isSyncing}
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
                            <OrderExpanded
                              order={o}
                              store={store}
                              shopDomain={meta.shop_domain}
                              onToast={pushToast}
                              onOrderUpdated={(updatedOrder) => patchOrderInPlace(o.id, () => updatedOrder)}
                            />
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
              <span className="text-[10px] uppercase tracking-wide font-semibold bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-full px-2 py-0.5">all stores</span>
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
      {pullMode && (
        <PullOrdersModal
          mode={pullMode}
          store={store}
          myTags={agentInfo?.tags || me?.tags || []}
          onClose={() => setPullMode(null)}
          onSuccess={(result) => {
            setPullMode(null);
            pushToast(
              `✅ Pulled ${result.pulled} order${result.pulled === 1 ? "" : "s"} into your queue`,
              "success",
            );
            // The agent's queue + every other agent's queue changed — refresh both.
            loadFirst();
            loadTeam();
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

// Pull-orders modal — opened by the "Get more orders" panel. Lets the agent
// claim a batch of orders into their queue. Two flavours, picked by `mode`:
//
//   "new"   — orders that no other active agent has claimed (no other agent
//             tag is present). No extra inputs needed.
//   "n1"/"n2"/"n3"/"n4"/"nowtp"/"enatt" — orders carrying that call-attempt
//             tag, optionally MINUS up to two agent-specified exclude tags
//             (e.g. "n2 but not fz and not zineb"). These can currently sit in
//             other agents' queues; the execute call strips those tags so the
//             pulled order becomes exclusively this agent's.
//
// The modal previews the available count as the agent edits the exclude
// inputs (debounced), then lets them pick how many to actually pull via
// preset chips (10/20/50/100/All) or a free-form number.
const PULL_LABELS = {
  new:   { title: "Pull new (unassigned) orders", icon: "✨", color: "indigo" },
  n1:    { title: "Pull N1 orders", icon: "📞", color: "amber" },
  n2:    { title: "Pull N2 orders", icon: "📞", color: "orange" },
  n3:    { title: "Pull N3 orders", icon: "📞", color: "rose" },
  n4:    { title: "Pull N4 orders", icon: "📞", color: "red" },
  nowtp: { title: "Pull Nowtp orders", icon: "🚫", color: "violet" },
  enatt: { title: "Pull Enatt orders", icon: "⏳", color: "fuchsia" },
};

function PullOrdersModal({ mode, store, myTags, onClose, onSuccess }) {
  const cfg = PULL_LABELS[mode] || PULL_LABELS.new;
  const isLevelMode = mode !== "new";
  const [excludeA, setExcludeA] = useState("");
  const [excludeB, setExcludeB] = useState("");
  // Server-reported count for the current (mode, exclude_tags) combo.
  const [available, setAvailable] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState(null);
  // Which of the user's agent_tags to apply on pull. Defaults to first.
  const [agentTag, setAgentTag] = useState(() => (myTags && myTags[0]) || "");
  // How many orders to pull. `takeAll` overrides the number with the full pool.
  const [takeAll, setTakeAll] = useState(false);
  const [amount, setAmount] = useState(20);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const previewReqRef = useRef(0);

  const excludeTags = useMemo(
    () => [excludeA, excludeB].map((t) => String(t || "").trim()).filter(Boolean),
    [excludeA, excludeB],
  );

  // Debounced preview. Re-fetches the count whenever the exclude inputs settle.
  useEffect(() => {
    const handle = setTimeout(async () => {
      const reqId = ++previewReqRef.current;
      setPreviewing(true); setPreviewErr(null);
      try {
        const js = await API.pullPreview({ store, level: mode, exclude_tags: excludeTags });
        if (reqId !== previewReqRef.current) return;
        setAvailable(Number(js.available || 0));
        // If the server reports a different "default agent tag" and the user
        // hasn't picked one yet, pre-fill it.
        if (!agentTag && js.agent_tag) setAgentTag(js.agent_tag);
      } catch (e) {
        if (reqId !== previewReqRef.current) return;
        setPreviewErr(e?.message || "Preview failed");
        setAvailable(0);
      } finally {
        if (reqId === previewReqRef.current) setPreviewing(false);
      }
    }, 350);
    return () => clearTimeout(handle);
    // We intentionally ignore agentTag in the deps — it doesn't affect the count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, mode, excludeA, excludeB]);

  async function submit() {
    const limit = takeAll ? 0 : Math.max(0, Number(amount) || 0);
    if (!takeAll && limit <= 0) {
      setErr("Enter a number greater than 0 (or tick Take all).");
      return;
    }
    if (!agentTag) {
      setErr("No agent tag selected. Ask admin to assign one to your account.");
      return;
    }
    setBusy(true); setErr(null);
    try {
      const js = await API.pullExecute({
        store, level: mode, exclude_tags: excludeTags, limit, agent_tag: agentTag,
      });
      onSuccess?.(js);
    } catch (e) {
      setErr(e?.message || "Pull failed");
    } finally {
      setBusy(false);
    }
  }

  // Esc to close (when not busy).
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && !busy) onClose?.(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const presets = [10, 20, 50, 100];
  const submitDisabled = busy || previewing || (available != null && available === 0);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={() => { if (!busy) onClose?.(); }}
    >
      <div
        className="bg-white border border-gray-200 rounded-2xl p-5 w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold mb-1">
          {cfg.icon} {cfg.title}
        </div>
        <div className="text-[11px] text-gray-500 mb-4">
          Store: <span className="font-medium">{store}</span>
        </div>

        {isLevelMode && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs uppercase tracking-wide text-gray-500 block mb-1">Exclude tag #1</label>
              <input
                type="text"
                value={excludeA}
                onChange={(e) => setExcludeA(e.target.value)}
                placeholder="e.g. fz"
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-gray-500 block mb-1">Exclude tag #2</label>
              <input
                type="text"
                value={excludeB}
                onChange={(e) => setExcludeB(e.target.value)}
                placeholder="e.g. zineb"
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
              />
            </div>
          </div>
        )}

        <div className="mb-4 rounded-xl bg-indigo-50 border border-indigo-200 px-3 py-2 flex items-center gap-2">
          <span className="text-xs text-indigo-700">Available now</span>
          <span className="text-xl font-bold tabular-nums text-indigo-900 ml-auto">
            {previewing ? "…" : (available != null ? available : "—")}
          </span>
        </div>
        {previewErr && (
          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mb-3">
            {previewErr}
          </div>
        )}

        {(myTags || []).length > 1 && (
          <div className="mb-3">
            <label className="text-xs uppercase tracking-wide text-gray-500 block mb-1">Apply tag</label>
            <select
              value={agentTag}
              onChange={(e) => setAgentTag(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
            >
              {(myTags || []).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        )}

        <div className="mb-3">
          <label className="text-xs uppercase tracking-wide text-gray-500 block mb-1">How many</label>
          <div className="flex items-center gap-2 flex-wrap">
            {presets.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => { setAmount(n); setTakeAll(false); }}
                disabled={busy || (available != null && n > available)}
                className={`text-xs px-3 py-1 rounded-full border font-medium ${BTN_TAP} ${
                  !takeAll && Number(amount) === n
                    ? "border-indigo-500 bg-indigo-600 text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                }`}
              >{n}</button>
            ))}
            <button
              type="button"
              onClick={() => setTakeAll((p) => !p)}
              disabled={busy}
              className={`text-xs px-3 py-1 rounded-full border font-medium ${BTN_TAP} ${
                takeAll
                  ? "border-indigo-500 bg-indigo-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >Take all{available != null ? ` (${available})` : ""}</button>
            <input
              type="number"
              min={1}
              max={available || 9999}
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setTakeAll(false); }}
              disabled={busy || takeAll}
              className="w-24 border border-gray-300 rounded-lg px-2 py-1.5 text-sm disabled:bg-gray-100 disabled:text-gray-400"
            />
          </div>
        </div>

        {err && (
          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mb-3">{err}</div>
        )}

        <div className="text-[11px] text-gray-500 mb-3">
          Pulled orders get tagged{agentTag ? <> with <code className="bg-gray-100 px-1 rounded">{agentTag}</code></> : ""} and any other agent's tag is removed.
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-sm px-4 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 active:scale-[0.96] transition-transform duration-75"
          >Cancel</button>
          <button
            onClick={submit}
            disabled={submitDisabled}
            className="text-sm px-4 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 active:scale-[0.96] transition-transform duration-75 shadow-sm"
          >{busy ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              Pulling…
            </span>
          ) : `Approve & pull${takeAll ? " all" : (amount ? ` ${amount}` : "")}`}</button>
        </div>
      </div>
    </div>
  );
}

// Global Shopify search panel — orders + customers in the selected store. Independent
// of the agent's tag-filtered queue. Phone-like input is normalized server-side so
// `+212 614 162-654`, `0614162654`, and `614162654` all match the same record.
function GlobalSearch({
  query, onQueryChange, onSearchNow, onClear, loading, error, results, store, onStoreChange, pushToast,
  renderOrderCard, expandedCustomerId, customerOrdersById, onToggleCustomer,
}) {
  const orders = results?.orders || [];
  const customers = results?.customers || [];
  const hasQuery = (query || "").trim().length >= 2;
  const hasResults = hasQuery && (orders.length > 0 || customers.length > 0);
  const searchKind = results?.search_kind || "";
  const normalizedPhone = results?.normalized_phone || "";

  async function copyText(text, label) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      pushToast(`📋 Copied ${label}`, "success");
    } catch {
      pushToast(`Clipboard blocked`, "warn");
    }
  }

  return (
    <section className="bg-white border border-gray-200 rounded-2xl shadow-sm p-3">
      <div className="flex flex-col sm:flex-row sm:items-stretch gap-2">
        <div className="h-11 shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-gray-300 bg-slate-50 px-2">
          <span className="text-sm" aria-hidden>🏪</span>
          <span className="hidden xl:inline text-[9px] uppercase tracking-wider font-semibold text-gray-500">
            Store
          </span>
          <StorePicker
            value={store}
            onChange={onStoreChange}
            allowCustom={false}
            className="h-full !rounded-none !border-0 !bg-transparent !p-0 text-slate-900 shadow-none"
          />
        </div>
        <form
          className="flex flex-1 min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSearchNow?.();
          }}
        >
          <span aria-hidden className="hidden sm:inline text-base">🔎</span>
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Paste phone or enter order number"
            className="h-11 flex-1 min-w-0 text-sm border border-gray-300 rounded-xl px-3 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400"
          />
          {loading && (
            <span className="hidden lg:inline-flex items-center text-xs text-gray-500 gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-gray-300 border-t-indigo-600 animate-spin" />
              Searching…
            </span>
          )}
          <button
            type="submit"
            disabled={(query || "").trim().length < 2}
            className={`h-11 text-xs px-4 rounded-xl bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-40 ${BTN_TAP}`}
          >
            Search
          </button>
          {(query || "").length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className={`h-11 text-xs px-3 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 ${BTN_TAP}`}
            >Clear</button>
          )}
        </form>
      </div>
      <div className="mt-1.5 text-[11px] text-gray-500">
        Searching <span className="font-mono font-semibold text-gray-700">{store}</span> · phone formatting is normalized automatically.
      </div>

          {hasQuery && searchKind && !loading && (
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">
                {searchKind === "phone" ? "Phone match" : searchKind === "order" ? "Order-number match" : "Customer / order search"}
              </span>
              {normalizedPhone && (
                <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-mono font-semibold text-emerald-700">
                  Normalized: {normalizedPhone}
                </span>
              )}
            </div>
          )}

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
                {searchKind === "phone"
                  ? `Customer orders (${orders.length}) · newest first`
                  : `Orders (${orders.length})`}
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

function OrderExpanded({ order, store, shopDomain, onToast, onOrderUpdated }) {
  const notify = onToast || (() => {});
  const [editOpen, setEditOpen] = useState(false);
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-white px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">Order details</div>
          <div className="text-xs text-gray-600">
            Review the customer, products, variants, quantities, and delivery address.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className={`inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 ${BTN_TAP}`}
        >
          <Pencil size={15} aria-hidden />
          Edit order
        </button>
      </div>

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

      {editOpen && (
        <OrderEditModal
          order={order}
          store={store}
          onClose={() => setEditOpen(false)}
          onOrderUpdated={(updatedOrder, message) => {
            onOrderUpdated?.(updatedOrder);
            notify(message || `${order.name || `#${order.number}`} updated`, "success");
            setEditOpen(false);
          }}
        />
      )}
    </div>
  );
}

function shippingDraftFromOrder(order) {
  const fallbackName = String(order.customer_name || "").trim().split(/\s+/);
  return {
    first_name: order.shipping_first_name || fallbackName[0] || "",
    last_name: order.shipping_last_name || fallbackName.slice(1).join(" "),
    company: order.shipping_company || "",
    phone: order.phone || order.customer_phone || "",
    address1: order.shipping_address1 || "",
    address2: order.shipping_address2 || "",
    city: order.shipping_city || "",
    province: order.shipping_province || "",
    zip: order.shipping_zip || "",
    country: order.shipping_country || "Morocco",
  };
}

function OrderEditModal({ order, store, onClose, onOrderUpdated }) {
  const originalItems = order.line_items || [];
  const [tab, setTab] = useState("items");
  const [quantities, setQuantities] = useState(() => Object.fromEntries(
    originalItems.filter((item) => item.id).map((item) => [item.id, Number(item.quantity || 0)]),
  ));
  const [additions, setAdditions] = useState([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogResults, setCatalogResults] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const catalogRequestRef = useRef(0);
  const [replaceLineId, setReplaceLineId] = useState(null);
  const [restock, setRestock] = useState(true);
  const [notifyCustomer, setNotifyCustomer] = useState(false);
  const [staffNote, setStaffNote] = useState("");
  const [shipping, setShipping] = useState(() => shippingDraftFromOrder(order));
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event) => {
      if (event.key === "Escape" && !saveBusy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, saveBusy]);

  useEffect(() => {
    const query = catalogQuery.trim();
    if (query.length < 2) {
      catalogRequestRef.current += 1;
      setCatalogResults([]);
      setCatalogLoading(false);
      setCatalogError("");
      return undefined;
    }
    const requestId = ++catalogRequestRef.current;
    setCatalogLoading(true);
    setCatalogError("");
    const timer = setTimeout(async () => {
      try {
        const result = await API.searchProductVariants(store, query);
        if (requestId === catalogRequestRef.current) {
          setCatalogResults(result.variants || []);
        }
      } catch (error) {
        if (requestId === catalogRequestRef.current) {
          setCatalogResults([]);
          setCatalogError(error?.message || "Product search failed");
        }
      } finally {
        if (requestId === catalogRequestRef.current) setCatalogLoading(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [catalogQuery, store]);

  const itemChanges = useMemo(() => originalItems
    .filter((item) => item.id)
    .map((item) => ({
      item,
      from: Number(item.quantity || 0),
      to: Number(quantities[item.id] ?? item.quantity ?? 0),
    }))
    .filter((change) => change.from !== change.to), [originalItems, quantities]);

  const changedUnits = itemChanges.length + additions.length;
  const replacingItem = originalItems.find((item) => item.id === replaceLineId) || null;

  function minimumQuantity(item) {
    const total = Number(item.quantity || 0);
    const unfulfilled = Number(item.unfulfilled_quantity ?? total);
    return Math.max(0, total - unfulfilled);
  }

  function setItemQuantity(item, nextQuantity) {
    if (!item.id) return;
    const min = minimumQuantity(item);
    const next = Math.max(min, Math.min(999, Number(nextQuantity) || 0));
    setQuantities((current) => ({ ...current, [item.id]: next }));
  }

  function setAddedQuantity(variantId, nextQuantity) {
    const next = Math.max(0, Math.min(999, Number(nextQuantity) || 0));
    setAdditions((current) => next <= 0
      ? current.filter((item) => item.id !== variantId)
      : current.map((item) => item.id === variantId ? { ...item, quantity: next } : item));
  }

  function chooseCatalogVariant(variant) {
    if (replacingItem) {
      if (variant.id === replacingItem.variant_id) {
        setReplaceLineId(null);
        return;
      }
      const replaceQuantity = Math.max(
        1,
        Number(replacingItem.unfulfilled_quantity ?? replacingItem.quantity ?? 1),
      );
      setItemQuantity(replacingItem, minimumQuantity(replacingItem));
      setAdditions((current) => {
        const existing = current.find((item) => item.id === variant.id);
        if (existing) {
          return current.map((item) => item.id === variant.id
            ? { ...item, quantity: Math.min(999, item.quantity + replaceQuantity) }
            : item);
        }
        return [...current, { ...variant, quantity: replaceQuantity }];
      });
      setReplaceLineId(null);
      setCatalogQuery("");
      setCatalogResults([]);
      return;
    }

    const existingLine = originalItems.find((item) => (
      item.variant_id === variant.id
      && Number(item.unfulfilled_quantity ?? item.quantity ?? 0) > 0
      && item.id
    ));
    if (existingLine) {
      setItemQuantity(existingLine, Number(quantities[existingLine.id] ?? existingLine.quantity ?? 0) + 1);
    } else {
      setAdditions((current) => {
        const existing = current.find((item) => item.id === variant.id);
        if (existing) {
          return current.map((item) => item.id === variant.id
            ? { ...item, quantity: Math.min(999, item.quantity + 1) }
            : item);
        }
        return [...current, { ...variant, quantity: 1 }];
      });
    }
  }

  async function saveItemChanges() {
    if (changedUnits === 0) return;
    setSaveBusy(true);
    setSaveError("");
    try {
      const result = await API.editOrderItems({
        store,
        order_id: order.id,
        items: itemChanges.map((change) => ({
          line_item_id: change.item.id,
          quantity: change.to,
        })),
        additions: additions.map((item) => ({
          variant_id: item.id,
          quantity: Number(item.quantity || 1),
        })),
        restock,
        notify_customer: notifyCustomer,
        staff_note: staffNote.trim() || null,
      });
      onOrderUpdated(result.order, "Order items updated in Shopify");
    } catch (error) {
      setSaveError(error?.message || "Could not update order items");
    } finally {
      setSaveBusy(false);
    }
  }

  async function saveShipping() {
    setSaveBusy(true);
    setSaveError("");
    try {
      const result = await API.updateOrderShipping({
        store,
        order_id: order.id,
        shipping_address: shipping,
      });
      onOrderUpdated(result.order, "Shipping information updated in Shopify");
    } catch (error) {
      setSaveError(error?.message || "Could not update shipping information");
    } finally {
      setSaveBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-edit-title"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 p-2 backdrop-blur-[2px] sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saveBusy) onClose();
      }}
    >
      <div className="flex h-[min(94vh,920px)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
            <Pencil size={18} aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 id="order-edit-title" className="truncate text-base font-semibold text-gray-950">
              Edit {order.name || `#${order.number}`}
            </h2>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="font-medium text-gray-700">{store}</span>
              <ChevronRight size={12} aria-hidden />
              <span>Changes are saved directly to Shopify</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saveBusy}
            className="ml-auto rounded-lg border border-gray-200 bg-white p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50"
            aria-label="Close order editor"
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <nav className="flex shrink-0 gap-1 border-b border-gray-200 bg-white px-4 sm:px-6" aria-label="Order edit sections">
          {[
            { id: "items", label: "Products and quantities", icon: Package },
            { id: "shipping", label: "Shipping information", icon: MapPin },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => { setTab(id); setSaveError(""); }}
              className={`relative inline-flex items-center gap-2 px-3 py-3 text-sm font-medium transition ${
                tab === id ? "text-indigo-700" : "text-gray-600 hover:text-gray-900"
              }`}
            >
              <Icon size={16} aria-hidden />
              {label}
              {id === "items" && changedUnits > 0 && (
                <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                  {changedUnits}
                </span>
              )}
              {tab === id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-indigo-600" />}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "items" ? (
            <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px] sm:p-6">
              <div className="space-y-4">
                <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  <div className="border-b border-gray-200 px-4 py-3">
                    <h3 className="text-sm font-semibold text-gray-900">Items in this order</h3>
                    <p className="mt-0.5 text-xs text-gray-500">
                      Adjust unfulfilled quantities, remove an item, or replace its variant.
                    </p>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {originalItems.map((item, index) => {
                      const quantity = Number(quantities[item.id] ?? item.quantity ?? 0);
                      const min = minimumQuantity(item);
                      const editableUnits = Number(item.unfulfilled_quantity ?? item.quantity ?? 0);
                      const canEdit = Boolean(item.id) && editableUnits > 0;
                      const changed = quantity !== Number(item.quantity || 0);
                      return (
                        <div key={item.id || `${item.title}-${index}`} className={`p-4 ${changed ? "bg-indigo-50/40" : ""}`}>
                          <div className="flex gap-3">
                            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
                              {item.image
                                ? <img src={item.image} alt="" className="h-full w-full object-cover" />
                                : <Package size={22} className="text-gray-400" aria-hidden />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-semibold text-gray-900">{item.title}</div>
                                  {item.variant_title && item.variant_title !== "Default Title" && (
                                    <div className="mt-0.5 text-xs text-gray-600">{item.variant_title}</div>
                                  )}
                                  {item.sku && <div className="mt-1 text-[11px] font-mono text-gray-500">SKU {item.sku}</div>}
                                </div>
                                <div className="text-right text-xs">
                                  <div className="font-semibold tabular-nums text-gray-900">{item.unit_price} {item.currency || order.currency}</div>
                                  {changed && (
                                    <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 font-medium text-indigo-700">
                                      {item.quantity} <ChevronRight size={10} /> {quantity}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <div className={`inline-flex h-9 items-center rounded-lg border ${canEdit ? "border-gray-300 bg-white" : "border-gray-200 bg-gray-100"}`}>
                                  <button
                                    type="button"
                                    onClick={() => setItemQuantity(item, quantity - 1)}
                                    disabled={!canEdit || quantity <= min}
                                    className="flex h-full w-9 items-center justify-center text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-30"
                                    aria-label={`Decrease ${item.title}`}
                                  ><Minus size={14} /></button>
                                  <input
                                    type="number"
                                    min={min}
                                    max={999}
                                    value={quantity}
                                    onChange={(event) => setItemQuantity(item, event.target.value)}
                                    disabled={!canEdit}
                                    className="h-full w-12 border-x border-gray-200 bg-transparent text-center text-sm font-semibold tabular-nums outline-none disabled:text-gray-400"
                                    aria-label={`Quantity for ${item.title}`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setItemQuantity(item, quantity + 1)}
                                    disabled={!canEdit || quantity >= 999}
                                    className="flex h-full w-9 items-center justify-center text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-30"
                                    aria-label={`Increase ${item.title}`}
                                  ><Plus size={14} /></button>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReplaceLineId(item.id);
                                    setCatalogQuery("");
                                    setCatalogResults([]);
                                  }}
                                  disabled={!canEdit}
                                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Change variant
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setItemQuantity(item, min)}
                                  disabled={!canEdit || quantity <= min}
                                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-30"
                                >
                                  <Trash2 size={14} aria-hidden />
                                  Remove
                                </button>
                                <span className="ml-auto text-[11px] text-gray-500">
                                  {editableUnits > 0
                                    ? `${editableUnits} unfulfilled unit${editableUnits === 1 ? "" : "s"} editable`
                                    : "Fulfilled item — locked"}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {additions.length > 0 && (
                  <section className="overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-sm">
                    <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-3">
                      <h3 className="text-sm font-semibold text-emerald-900">Products to add</h3>
                    </div>
                    <div className="divide-y divide-gray-100">
                      {additions.map((item) => (
                        <div key={item.id} className="flex items-center gap-3 p-4">
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
                            {item.image
                              ? <img src={item.image} alt="" className="h-full w-full object-cover" />
                              : <Package size={18} className="text-gray-400" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{item.product_title}</div>
                            {item.variant_title && item.variant_title !== "Default Title" && (
                              <div className="text-xs text-gray-600">{item.variant_title}</div>
                            )}
                            <div className="text-[11px] text-gray-500">
                              {item.sku ? `SKU ${item.sku} · ` : ""}{item.price} {order.currency}
                            </div>
                          </div>
                          <div className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white">
                            <button type="button" onClick={() => setAddedQuantity(item.id, item.quantity - 1)} className="flex h-full w-9 items-center justify-center hover:bg-gray-50"><Minus size={14} /></button>
                            <div className="w-10 text-center text-sm font-semibold tabular-nums">{item.quantity}</div>
                            <button type="button" onClick={() => setAddedQuantity(item.id, item.quantity + 1)} className="flex h-full w-9 items-center justify-center hover:bg-gray-50"><Plus size={14} /></button>
                          </div>
                          <button type="button" onClick={() => setAddedQuantity(item.id, 0)} className="rounded-lg p-2 text-gray-400 hover:bg-rose-50 hover:text-rose-700" aria-label={`Remove ${item.product_title}`}><X size={16} /></button>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section className={`rounded-xl border bg-white p-4 shadow-sm ${replaceLineId ? "border-indigo-300 ring-2 ring-indigo-100" : "border-gray-200"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900">
                        {replacingItem ? `Choose a replacement for ${replacingItem.title}` : "Add another product"}
                      </h3>
                      <p className="mt-0.5 text-xs text-gray-500">
                        Search all products and variants in the selected store.
                      </p>
                    </div>
                    {replaceLineId && (
                      <button type="button" onClick={() => setReplaceLineId(null)} className="text-xs font-medium text-gray-600 hover:text-gray-900">
                        Cancel replacement
                      </button>
                    )}
                  </div>
                  <div className="relative mt-3">
                    <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      autoFocus={Boolean(replaceLineId)}
                      value={catalogQuery}
                      onChange={(event) => setCatalogQuery(event.target.value)}
                      placeholder="Search product name, variant, SKU, or barcode"
                      className="h-11 w-full rounded-lg border border-gray-300 bg-white pl-10 pr-10 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                    />
                    {catalogLoading && <span className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />}
                  </div>
                  {catalogError && <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{catalogError}</div>}
                  {catalogQuery.trim().length >= 2 && !catalogLoading && !catalogError && catalogResults.length === 0 && (
                    <div className="mt-3 rounded-lg bg-gray-50 px-3 py-5 text-center text-xs text-gray-500">No matching variants found.</div>
                  )}
                  {catalogResults.length > 0 && (
                    <div className="mt-3 max-h-72 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
                      {catalogResults.map((variant) => (
                        <button
                          key={variant.id}
                          type="button"
                          onClick={() => chooseCatalogVariant(variant)}
                          className="flex w-full items-center gap-3 p-3 text-left hover:bg-indigo-50"
                        >
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
                            {variant.image
                              ? <img src={variant.image} alt="" className="h-full w-full object-cover" />
                              : <Package size={17} className="text-gray-400" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-gray-900">{variant.product_title}</div>
                            <div className="truncate text-xs text-gray-600">
                              {variant.variant_title && variant.variant_title !== "Default Title" ? variant.variant_title : "Default variant"}
                              {variant.sku ? ` · SKU ${variant.sku}` : ""}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-sm font-semibold tabular-nums text-gray-900">{variant.price} {order.currency}</div>
                            <div className="text-[11px] text-gray-500">
                              {variant.inventory_quantity == null ? "Inventory not tracked" : `${variant.inventory_quantity} in inventory`}
                            </div>
                          </div>
                          <span className="ml-1 inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white">
                            {replacingItem ? "Replace" : "Add"} <Plus size={13} />
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <aside className="h-fit rounded-xl border border-gray-200 bg-white p-4 shadow-sm lg:sticky lg:top-4">
                <h3 className="text-sm font-semibold text-gray-900">Review changes</h3>
                <div className="mt-3 space-y-2 text-xs">
                  {itemChanges.length === 0 && additions.length === 0 ? (
                    <div className="rounded-lg bg-gray-50 px-3 py-4 text-center text-gray-500">No item changes yet.</div>
                  ) : (
                    <>
                      {itemChanges.map(({ item, from, to }) => (
                        <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2">
                          <span className="min-w-0 truncate text-gray-700">{item.title}</span>
                          <span className={`shrink-0 font-semibold tabular-nums ${to < from ? "text-rose-700" : "text-indigo-700"}`}>{from} → {to}</span>
                        </div>
                      ))}
                      {additions.map((item) => (
                        <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg bg-emerald-50 px-3 py-2">
                          <span className="min-w-0 truncate text-emerald-900">Add {item.product_title}</span>
                          <span className="shrink-0 font-semibold text-emerald-700">+{item.quantity}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
                <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
                  <label className="flex cursor-pointer items-start gap-2 text-xs text-gray-700">
                    <input type="checkbox" checked={restock} onChange={(event) => setRestock(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" />
                    <span><strong className="font-semibold">Restock removed units</strong><br /><span className="text-gray-500">Return reduced quantities to inventory.</span></span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 text-xs text-gray-700">
                    <input type="checkbox" checked={notifyCustomer} onChange={(event) => setNotifyCustomer(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" />
                    <span><strong className="font-semibold">Notify customer</strong><br /><span className="text-gray-500">Shopify emails the order update.</span></span>
                  </label>
                  <label className="block text-xs font-medium text-gray-700">
                    Staff note
                    <textarea
                      value={staffNote}
                      onChange={(event) => setStaffNote(event.target.value)}
                      rows={2}
                      maxLength={255}
                      placeholder="Reason for the change (optional)"
                      className="mt-1 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                    />
                  </label>
                </div>
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                  Shopify recalculates taxes, discounts, and the order balance when these changes are saved.
                </div>
                {saveError && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{saveError}</div>}
                <button
                  type="button"
                  onClick={saveItemChanges}
                  disabled={saveBusy || changedUnits === 0}
                  className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {saveBusy
                    ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Saving to Shopify…</>
                    : <><Check size={16} /> Save item changes</>}
                </button>
              </aside>
            </div>
          ) : (
            <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px] sm:p-6">
              <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="mb-5">
                  <h3 className="text-sm font-semibold text-gray-900">Shipping address</h3>
                  <p className="mt-0.5 text-xs text-gray-500">Update the delivery contact and address exactly as it should appear on the shipment.</p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <EditField label="First name" value={shipping.first_name} onChange={(value) => setShipping((current) => ({ ...current, first_name: value }))} />
                  <EditField label="Last name" value={shipping.last_name} onChange={(value) => setShipping((current) => ({ ...current, last_name: value }))} />
                  <EditField label="Phone" value={shipping.phone} onChange={(value) => setShipping((current) => ({ ...current, phone: value }))} placeholder="+212…" />
                  <EditField label="Company" value={shipping.company} onChange={(value) => setShipping((current) => ({ ...current, company: value }))} optional />
                  <div className="sm:col-span-2">
                    <EditField label="Address" value={shipping.address1} onChange={(value) => setShipping((current) => ({ ...current, address1: value }))} placeholder="Street, neighborhood, building…" />
                  </div>
                  <div className="sm:col-span-2">
                    <EditField label="Apartment, suite, etc." value={shipping.address2} onChange={(value) => setShipping((current) => ({ ...current, address2: value }))} optional />
                  </div>
                  <EditField label="City" value={shipping.city} onChange={(value) => setShipping((current) => ({ ...current, city: value }))} />
                  <EditField label="Province / region" value={shipping.province} onChange={(value) => setShipping((current) => ({ ...current, province: value }))} optional />
                  <EditField label="Postal code" value={shipping.zip} onChange={(value) => setShipping((current) => ({ ...current, zip: value }))} optional />
                  <EditField label="Country" value={shipping.country} onChange={(value) => setShipping((current) => ({ ...current, country: value }))} />
                </div>
              </section>

              <aside className="h-fit rounded-xl border border-gray-200 bg-white p-4 shadow-sm lg:sticky lg:top-4">
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700"><MapPin size={17} /></div>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">Delivery preview</h3>
                    <div className="text-[11px] text-gray-500">Saved to the Shopify order</div>
                  </div>
                </div>
                <div className="mt-4 rounded-lg bg-gray-50 p-3 text-sm leading-relaxed text-gray-700">
                  <div className="font-semibold text-gray-900">{[shipping.first_name, shipping.last_name].filter(Boolean).join(" ") || "Customer name"}</div>
                  {shipping.company && <div>{shipping.company}</div>}
                  <div>{shipping.address1 || "Address"}</div>
                  {shipping.address2 && <div>{shipping.address2}</div>}
                  <div>{[shipping.city, shipping.province, shipping.zip].filter(Boolean).join(", ") || "City"}</div>
                  <div>{shipping.country || "Country"}</div>
                  <div className="mt-2 font-mono text-xs">{shipping.phone || "Phone number"}</div>
                </div>
                <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-relaxed text-sky-800">
                  This changes the shipping address on this order only. It does not overwrite the customer’s saved address.
                </div>
                {saveError && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{saveError}</div>}
                <button
                  type="button"
                  onClick={saveShipping}
                  disabled={saveBusy || !shipping.address1.trim() || !shipping.city.trim() || !shipping.country.trim()}
                  className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {saveBusy
                    ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Saving to Shopify…</>
                    : <><Check size={16} /> Save shipping information</>}
                </button>
              </aside>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EditField({ label, value, onChange, placeholder = "", optional = false }) {
  return (
    <label className="block text-xs font-medium text-gray-700">
      <span>{label}</span>
      {optional && <span className="ml-1 font-normal text-gray-400">Optional</span>}
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1 h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm font-normal text-gray-900 outline-none placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
      />
    </label>
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
