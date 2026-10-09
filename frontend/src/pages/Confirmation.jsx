import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Ban,
  CalendarCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  Ellipsis,
  Hourglass,
  Inbox,
  MessageCircleOff,
  MessageCircleReply,
  ExternalLink,
  Minus,
  Package,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Trophy,
  Users,
  X,
  MapPin,
} from "lucide-react";
import { authFetch, authHeaders } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import OrderLabel from "../components/OrderLabel";
import { useToasts, ToastStack } from "../components/Toast";
import { AnimatedNumber, useDepartingList, useFlipList } from "../components/Motion";
import ChatConfirmationView, { useChatWaitingCount } from "./ChatConfirmation";
import { persistStoreSelection, readCurrentStore } from "../lib/stores";
import { groupConfirmationOrders, orderPhone } from "../lib/confirmationOrderGroups";
import {
  enqueueTagWrite,
  enqueueTagWrites,
  retrySyncQueueNow,
  useSyncQueueState,
  readQueue,
} from "../lib/syncQueue";
import { copyNodeAsPng, triggerDownload } from "../lib/labelClipboard";
import {
  ACTION_BTN, ACTION_THEMES, BTN, BTN_TAP, CARD, TONES,
  KpiCard, Modal, ModalHeader, PreviewAge, SkeletonCards, SkeletonRows, SourceOption, Spinner, TopBar,
  initialOf, isInteractiveTarget, timeAgo,
} from "../components/ConfirmationUi";
import {
  PHONE_TAGS, NOWTP_TAGS, ENATT_TAGS,
  nextInCycle, tagsInCycle, hasNowtpTag, hasEnattTag,
  moroccoInternational, copyToClipboard,
  todayDDMMYY, todayISO, isoToDDMMYY, isCodTag,
} from "../lib/confirmationActions";

// Queue levels, in the order agents work through them. `key` is the backend level.
const LEVELS = [
  { key: "",      label: "All",         tone: "slate",   count: "total" },
  { key: "new",   label: "New",         tone: "indigo",  count: "new" },
  { key: "n1",    label: "N1",          tone: "amber",   count: "n1" },
  { key: "n2",    label: "N2",          tone: "orange",  count: "n2" },
  { key: "n3",    label: "N3",          tone: "rose",    count: "n3" },
  { key: "n4",    label: "N4",          tone: "red",     count: "n4" },
  { key: "nowtp", label: "No WhatsApp", tone: "violet",  count: "nowtp" },
  { key: "enatt", label: "En attente",  tone: "fuchsia", count: "enatt" },
];

function tagTone(tag) {
  const t = String(tag || "").trim().toLowerCase();
  if (isCodTag(t)) return "emerald";
  if (t === "n1") return "amber";
  if (t === "n2") return "orange";
  if (t === "n3") return "rose";
  if (t === "n4") return "red";
  if (t.startsWith("nowtp")) return "violet";
  if (t.startsWith("enatt")) return "fuchsia";
  return "slate";
}

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
  async webConfirmationChat(sessionId) {
    const res = await authFetch(`/api/agent/web-confirmation/${encodeURIComponent(sessionId)}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Failed to load the chat" }));
      throw new Error(js.detail || `Failed to load the chat (${res.status})`);
    }
    return res.json();
  },
  async customerOrders(store, customerId, after = null) {
    const qs = new URLSearchParams({ store, customer_id: customerId });
    if (after) qs.set("after", after);
    const res = await authFetch(`/api/agent/customer-orders?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Failed to load customer history" }));
      throw new Error(js.detail || `Failed to load customer history (${res.status})`);
    }
    return res.json();
  },
  async phoneOrders(store, phone, after = null) {
    const qs = new URLSearchParams({ store, phone });
    if (after) qs.set('after', after);
    const res = await authFetch(`/api/agent/phone-orders?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({}));
      throw new Error(js.detail || 'Failed to load orders with this phone');
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
  async pullPreview({ store, level, exclude_tags, include_assigned, source_agent_id, target_agent_id }) {
    const res = await authFetch(`/api/agent/pull/preview`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        store, level, exclude_tags, include_assigned: !!include_assigned,
        source_agent_id: source_agent_id || null, target_agent_id: target_agent_id || null,
      }),
    });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Preview failed" }));
      throw new Error(js.detail || `Preview failed (${res.status})`);
    }
    return res.json();
  },
  async pullExecute({ store, level, exclude_tags, limit, agent_tag, include_assigned, source_agent_id, target_agent_id }) {
    const res = await authFetch(`/api/agent/pull/execute`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        store, level, exclude_tags, limit, agent_tag, include_assigned: !!include_assigned,
        source_agent_id: source_agent_id || null, target_agent_id: target_agent_id || null,
      }),
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
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 px-4">
        <div className={`${CARD} cf-pop-in max-w-sm w-full p-6 text-center`}>
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-rose-50 text-rose-600">
            <CircleAlert className="h-5 w-5" aria-hidden />
          </div>
          <div className="text-sm font-semibold text-slate-900">{error}</div>
          <a className={`${BTN.primary} mt-4 h-10 w-full`} href="/login">Sign in</a>
        </div>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center gap-2 bg-slate-50 text-sm text-slate-500">
        <Spinner /> Loading your queue…
      </div>
    );
  }

  // Any logged-in user can use the confirmation page; whether their queue is non-empty
  // depends purely on the Shopify tags assigned to them in /admin.
  return <ConfirmationViews me={me} />;
}

function readViewFromUrl() {
  try {
    return new URLSearchParams(location.search).get("tab") === "chat" ? "chat" : "orders";
  } catch {
    return "orders";
  }
}

// Orders and Chat confirmation share the store selection, the top bar and the
// waiting-chat badge; each tab owns its own queue, polling and dialogs.
function ConfirmationViews({ me }) {
  const [store, setStore] = useState(() => readCurrentStore());
  useEffect(() => { persistStoreSelection(store); }, [store]);
  const [view, setView] = useState(readViewFromUrl);
  const chatWaiting = useChatWaitingCount(store);

  useEffect(() => {
    const onPop = () => setView(readViewFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function changeView(next) {
    setView(next);
    try {
      const params = new URLSearchParams(location.search);
      if (next === "chat") params.set("tab", "chat"); else params.delete("tab");
      const qs = params.toString();
      history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash || ""}`);
    } catch {}
  }

  const shared = { me, store, setStore, view, onViewChange: changeView, chatBadge: chatWaiting.count };
  if (view === "chat") {
    return <ChatConfirmationView {...shared} onWaitingChanged={chatWaiting.refresh} />;
  }
  return <AgentView {...shared} />;
}

// ---------- Agent view ----------
function AgentView({ me, store, setStore, view, onViewChange, chatBadge }) {

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
  const [expanded, setExpanded] = useState(() => new Set());
  const [phoneOrdersByKey, setPhoneOrdersByKey] = useState({});
  const relatedBusy = useRef(new Set());
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
  // Pull-orders modal — opened by the "Get more orders" panel. `pullMode` is
  // `{ mode, includeAssigned }` where mode is the level being pulled ("new" | "n1" |
  // "n2" | "n3" | "n4" | "nowtp" | "enatt"); null = closed.
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
    setPhoneOrdersByKey(prev => Object.fromEntries(Object.entries(prev).map(([key, entry]) => [key, { ...entry, orders: patchArr(entry.orders) }])));
  }
  // Per-row "..." dropdown + cancel-order modal
  const [actionsDropdownFor, setActionsDropdownFor] = useState(null);
  const [cancelModalFor, setCancelModalFor] = useState(null);
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
      pushToast(`${label} saved and counted`, "success", 2600);
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
  // `syncState` changes on every enqueue/ack, which is exactly when this can change.
  const ordersForView = useMemo(
    () => applyPendingQueueWrites(currentOrders, store),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentOrders, store, syncState]
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
    // A confirmed/cancelled order must not stay selected for a later bulk action.
    setSelected((prev) => {
      if (!prev.has(orderId)) return prev;
      const next = new Set(prev);
      next.delete(orderId);
      return next;
    });
    setExpanded((prev) => {
      if (!prev.has(orderId)) return prev;
      const next = new Set(prev);
      next.delete(orderId);
      return next;
    });
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
      ok ? `Copied ${order.phone} · saving ${next.toUpperCase()}…` : `Saving ${next.toUpperCase()} · phone copy blocked`,
      ok ? "info" : "warn",
    );
  }

  function handleNowtp(order) {
    // Cycles nowtp1 → nowtp2 → nowtp3 → nowtp4 (locks at nowtp4).
    const next = cyclePhone(order, NOWTP_TAGS);
    if (next) pushToast(`Saving No WhatsApp · ${next}…`, "info");
  }

  function handleEnatt(order) {
    // Cycles enatt1 → enatt2 → enatt3 → enatt4 (locks at enatt4). Use for "en attente"
    // (order pending follow-up).
    const next = cyclePhone(order, ENATT_TAGS);
    if (next) pushToast(`Saving En attente · ${next}…`, "info");
  }

  async function handleCopyPhone(order) {
    // Copies the customer's phone in WhatsApp-friendly international format, sans the
    // leading '+'. moroccoInternational already strips the '+'.
    const intl = moroccoInternational(order.phone || "");
    const ok = await copyToClipboard(intl);
    pushToast(
      ok ? `Copied ${intl}` : "Clipboard blocked",
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

  const tagsAssigned = agentInfo?.tags || me?.tags || [];

  // ---------- Motion: rows slide into place, leave in place, new ones flash ----------
  const listResetKey = `${store}|${filterLevel}|${pageIndex}`;
  const groupedOrders = useMemo(() => groupConfirmationOrders(ordersForView), [ordersForView]);
  const displayRows = useDepartingList(groupedOrders, (o) => o.id, { resetKey: listResetKey });
  const flipSignature = displayRows.map((r) => r.item.id).join(",");
  const tableBodyRef = useRef(null);
  const cardListRef = useRef(null);
  useFlipList(tableBodyRef, flipSignature, listResetKey);
  useFlipList(cardListRef, flipSignature, listResetKey);

  const searchInputRef = useRef(null);
  const refreshAll = useCallback(() => { loadFirst(); loadTeam(); }, [loadFirst, loadTeam]);

  // Keyboard helpers for agents who live on this page: "/" jumps to search,
  // "r" refreshes. Ignored while typing in a field or when a dialog is open.
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || e.target?.isContentEditable) return;
      if (pullMode || cancelModalFor) return;
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "r" || e.key === "R") {
        refreshAll();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pullMode, cancelModalFor, refreshAll]);

  function openPull(mode, opts = {}) {
    setPullMode({ mode, includeAssigned: !!opts.includeAssigned });
  }

  // Team ranking for the "Confirmed today" card — a little friendly motivation.
  const myRank = useMemo(() => {
    const ranked = [...teamStats].sort((a, b) => Number(b.confirmed_today || 0) - Number(a.confirmed_today || 0));
    const idx = ranked.findIndex((a) => a.id === me.id);
    return idx >= 0 ? { rank: idx + 1, of: ranked.length } : null;
  }, [teamStats, me?.id]);
  const sortedTeam = useMemo(
    () => [...teamStats].sort((a, b) => Number(b.confirmed_today || 0) - Number(a.confirmed_today || 0)),
    [teamStats],
  );
  const teamMaxConfirmed = useMemo(
    () => Math.max(1, ...teamStats.map((a) => Number(a.confirmed_today || 0))),
    [teamStats],
  );

  const levelCounts = meta.level_counts || {};
  const activeLevel = LEVELS.find((l) => l.key === filterLevel) || LEVELS[0];
  const firstLoad = loading && pages.length === 0;
  const isAdmin = me?.role === "admin";

  function renderTags(o, isSyncing, { size = "sm" } = {}) {
    const tags = o.tags || [];
    if (tags.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1">
        {tags.map((t) => {
          const tone = TONES[tagTone(t)] || TONES.slate;
          return (
            <span
              key={t}
              className={`group inline-flex items-center rounded-md ring-1 ring-inset ${tone.soft} ${size === "xs" ? "text-[10.5px] px-1.5 py-0.5" : "text-[11px] px-1.5 py-0.5"} font-medium`}
            >
              {t}
              <button
                type="button"
                disabled={isSyncing}
                onClick={(ev) => { ev.stopPropagation(); removeTagOptimistic(o, t); }}
                className="ml-0.5 -mr-0.5 rounded px-0.5 opacity-50 hover:opacity-100 hover:text-rose-600 disabled:cursor-wait"
                title={`Remove tag ${t}`}
                aria-label={`Remove tag ${t}`}
              >×</button>
            </span>
          );
        })}
      </div>
    );
  }

  function renderActions(o, isSyncing, { stretch = false } = {}) {
    const phoneLevel = (tagsInCycle(o.tags || [], PHONE_TAGS).slice(-1)[0] || "").toUpperCase();
    const nowtp = tagsInCycle(o.tags || [], NOWTP_TAGS).slice(-1)[0];
    const enatt = tagsInCycle(o.tags || [], ENATT_TAGS).slice(-1)[0];
    const menuOpen = actionsDropdownFor === o.id;
    const grow = stretch ? "flex-1" : "";
    return (
      <div className={`flex items-center gap-1.5 ${stretch ? "w-full" : ""}`}>
        <button
          type="button"
          disabled={isSyncing}
          onClick={(ev) => { ev.stopPropagation(); handlePhone(o); }}
          className={`${ACTION_BTN} ${ACTION_THEMES.call} ${grow} min-w-[64px]`}
          title="Copy phone + record the next call attempt (N1 → N4)"
        >
          <Phone className="h-3.5 w-3.5" aria-hidden />
          <span>{phoneLevel || "Call"}</span>
        </button>
        <button
          type="button"
          disabled={isSyncing}
          onClick={(ev) => { ev.stopPropagation(); handleNowtp(o); }}
          className={`${ACTION_BTN} ${ACTION_THEMES.nowtp} ${grow}`}
          title="No WhatsApp — cycles nowtp1 → nowtp4"
        >
          <MessageCircleOff className="h-3.5 w-3.5" aria-hidden />
          <span>{nowtp ? nowtp.replace("nowtp", "NW") .toUpperCase() : "NW"}</span>
        </button>
        <button
          type="button"
          disabled={isSyncing}
          onClick={(ev) => { ev.stopPropagation(); handleEnatt(o); }}
          className={`${ACTION_BTN} ${ACTION_THEMES.enatt} ${grow}`}
          title="En attente — cycles enatt1 → enatt4"
        >
          <Hourglass className="h-3.5 w-3.5" aria-hidden />
          <span>{enatt ? enatt.replace("enatt", "EA").toUpperCase() : "EA"}</span>
        </button>
        <button
          type="button"
          disabled={isSyncing}
          onClick={(ev) => { ev.stopPropagation(); openDatePicker(o); }}
          className={`${ACTION_BTN} ${ACTION_THEMES.confirm} ${grow}`}
          title="Confirm for a delivery date"
        >
          <Check className="h-4 w-4" aria-hidden />
          <span className={stretch ? "" : "hidden 2xl:inline"}>Confirm</span>
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); setActionsDropdownFor((p) => (p === o.id ? null : o.id)); }}
            className={`${ACTION_BTN} ${ACTION_THEMES.more} w-8 !px-0`}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
          >
            <Ellipsis className="h-4 w-4" aria-hidden />
          </button>
          {menuOpen && (
            <div
              role="menu"
              onClick={(ev) => ev.stopPropagation()}
              className="cf-pop-in absolute right-0 top-full z-20 mt-1.5 w-48 overflow-hidden rounded-xl bg-white py-1 shadow-lg shadow-slate-900/10 ring-1 ring-slate-900/10"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => { handleCopyPhone(o); setActionsDropdownFor(null); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              ><Copy className="h-4 w-4 text-slate-400" aria-hidden /> Copy phone (intl.)</button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setCancelModalFor(o); setActionsDropdownFor(null); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50"
              ><Ban className="h-4 w-4" aria-hidden /> Cancel order…</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderConfirmPicker(o, isSyncing) {
    const today = todayISO();
    const tomorrow = todayISO(new Date(Date.now() + 86_400_000));
    const quick = [
      { label: "Today", value: today },
      { label: "Tomorrow", value: tomorrow },
    ];
    return (
      <div
        className="cf-collapse-in flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50/70 px-3 py-2.5 ring-1 ring-inset ring-emerald-200"
        onClick={(ev) => ev.stopPropagation()}
      >
        <CalendarCheck className="h-4 w-4 text-emerald-600" aria-hidden />
        <span className="text-xs font-semibold text-emerald-900">Deliver on</span>
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => setChosenDate(q.value)}
            className={`h-8 rounded-lg px-2.5 text-xs font-semibold ring-1 ring-inset transition ${
              chosenDate === q.value
                ? "bg-emerald-600 text-white ring-emerald-600"
                : "bg-white text-emerald-800 ring-emerald-200 hover:bg-emerald-100"
            }`}
          >{q.label}</button>
        ))}
        <input
          type="date"
          value={chosenDate}
          onChange={(e) => setChosenDate(e.target.value)}
          className="h-8 rounded-lg border-0 bg-white px-2 text-sm text-slate-800 ring-1 ring-inset ring-emerald-200 focus:ring-2 focus:ring-emerald-500"
        />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDatePickerFor(null)}
            className={`${BTN.ghost} h-8 text-xs`}
          >Cancel</button>
          <button
            type="button"
            disabled={isSyncing || !chosenDate}
            onClick={() => submitConfirm(o)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 active:scale-[0.97] transition disabled:opacity-50"
          ><Check className="h-3.5 w-3.5" aria-hidden /> Confirm {isoToDDMMYY(chosenDate) || ""}</button>
        </div>
      </div>
    );
  }

  function toggleExpanded(orderId) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
      return next;
    });
  }

  function renderPhone(o, { big = false } = {}) {
    if (!o.phone) return <span className="text-xs text-slate-400">No phone</span>;
    return (
      <span className="inline-flex items-center gap-1 rounded-lg bg-sky-50 py-0.5 pl-2 pr-0.5 ring-1 ring-inset ring-sky-200">
        <span className={`font-mono font-semibold tracking-tight text-sky-900 ${big ? "text-[15px]" : "text-[13px]"}`}>{o.phone}</span>
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); handleCopyPhone(o); }}
          title={`Copy ${moroccoInternational(o.phone)} (international, no +)`}
          aria-label="Copy phone number"
          className="rounded-md p-1 text-sky-500 hover:bg-sky-100 hover:text-sky-700 active:scale-90 transition"
        ><Copy className="h-3.5 w-3.5" aria-hidden /></button>
      </span>
    );
  }

  // Reusable order card — same look and behaviour for the queue (mobile), the global
  // search results, and the expanded customer's order list. Closes over every action
  // handler and piece of state so callers don't need to pass anything beyond the order.
  async function loadRelatedOrders(o, more = false, force = false) {
    const phone = orderPhone(o), key = `${store}:${phone}`;
    if (!phone || relatedBusy.current.has(key)) return;
    const previous = phoneOrdersByKey[key];
    if (!more && previous?.loaded && !force) return;
    relatedBusy.current.add(key);
    setPhoneOrdersByKey(prev => ({ ...prev, [key]: { ...prev[key], loading: true, error: null } }));
    try {
      const js = await API.phoneOrders(store, phone, more ? previous?.page_info?.end_cursor : null);
      setPhoneOrdersByKey(prev => {
        const existing = more ? prev[key]?.orders || [] : [];
        const seen = new Set(existing.map(order => order.id));
        return { ...prev, [key]: { ...js, loaded: true, loading: false, orders: [...existing, ...(js.orders || []).filter(order => !seen.has(order.id))] } };
      });
    } catch (error) {
      setPhoneOrdersByKey(prev => ({ ...prev, [key]: { ...prev[key], loading: false, error: error.message } }));
    } finally { relatedBusy.current.delete(key); }
  }

  function openOrder(o, nested = false) {
    if (!expanded.has(o.id) && !nested) loadRelatedOrders(o);
    toggleExpanded(o.id);
  }

  function relatedFor(o) {
    const phone = orderPhone(o), entry = phoneOrdersByKey[`${store}:${phone}`];
    const seen = new Set([o.id]);
    const rows = [...(o.relatedOrders || []), ...(entry?.orders || [])].filter(order => {
      if (seen.has(order.id) || !phone || orderPhone(order) !== phone) return false;
      seen.add(order.id); return true;
    });
    return { entry, rows: applyPendingQueueWrites(rows, store) };
  }

  function renderGroupBadge(o, nested) {
    if (nested) return null;
    const count = relatedFor(o).rows.length;
    return count > 0 ? <button type="button" onClick={() => openOrder(o)} aria-expanded={expanded.has(o.id)}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
      <Package size={12} aria-hidden /> {count + 1} orders <span aria-hidden>▾</span>
    </button> : null;
  }

  function renderRelatedOrders(o) {
    if (!orderPhone(o)) return null;
    const { entry, rows } = relatedFor(o);
    return <section className="mt-4 rounded-2xl border border-indigo-200 bg-white" aria-label="Other orders with this phone">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-100 bg-indigo-50/60 px-4 py-3 rounded-t-2xl">
        <div><div className="text-sm font-semibold text-indigo-900">Other orders with this phone {rows.length > 0 ? `(${rows.length})` : ''}</div>
          <div className="text-xs text-slate-500">Each order keeps its own items, chat, status and actions.</div></div>
        <button type="button" onClick={() => loadRelatedOrders(o, false, true)} disabled={entry?.loading} className={BTN.secondary}>Refresh</button>
      </div>
      {entry?.loading && <p className="px-4 py-3 text-xs text-slate-500">Loading orders…</p>}
      {entry?.error && <p className="px-4 py-3 text-xs text-rose-600">{entry.error} <button type="button" onClick={() => loadRelatedOrders(o, false, true)} className="underline">Retry</button></p>}
      {!entry?.loading && !entry?.error && rows.length === 0 && <p className="px-4 py-3 text-xs text-slate-500">{entry?.page_info?.has_next_page ? 'No other matches in the recent orders checked. Load older orders to continue.' : 'No other orders found with this phone.'}</p>}
      <div className="divide-y divide-slate-100">{rows.map(order => renderOrderCard(order, { nested: true }))}</div>
      {entry?.page_info?.has_next_page && <div className="p-3"><button type="button" disabled={entry.loading} onClick={() => loadRelatedOrders(o, true)} className={BTN.secondary}>Load older orders</button></div>}
    </section>;
  }

  function renderOrderCard(o, { leaving = false, nested = false } = {}) {
    const isOpen = expanded.has(o.id);
    const pickerOpen = datePickerFor === o.id;
    const isSelected = selected.has(o.id);
    const isSyncing = pendingOrderIds.has(o.id);
    const url = shopifyOrderUrl(o, meta.shop_domain);
    const label = o.name || `#${o.number}`;
    return (
      <div
        key={o.id}
        data-flip-key={o.id}
        className={`relative p-3.5 transition-colors ${leaving ? "cf-leave" : ""} ${
          isOpen || pickerOpen ? "bg-indigo-50/60" : isSelected ? "bg-indigo-50/40" : "bg-white"
        }`}
        onClick={(e) => { if (!leaving && !isInteractiveTarget(e)) openOrder(o, nested); }}
      >
        {(isOpen || pickerOpen || isSelected) && (
          <span aria-hidden className={`absolute left-0 inset-y-0 w-1 ${isOpen || pickerOpen ? "bg-indigo-500" : "bg-indigo-200"}`} />
        )}
        <div className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleRowSelected(o.id)}
            aria-label={`Select order ${label}`}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-[15px] font-bold text-indigo-700 hover:underline">{label}</a>
          ) : (
            <span className="text-[15px] font-bold">{label}</span>
          )}
          {o.web_confirmation && <WebChatBadge />}
          {renderGroupBadge(o, nested)}
          <span className="text-[11px] text-slate-400" title={o.created_at ? new Date(o.created_at).toLocaleString() : ""}>{timeAgo(o.created_at)}</span>
          <span className="ml-auto whitespace-nowrap text-[15px] font-bold tabular-nums text-slate-900">
            {o.total_price} <span className="text-[11px] font-medium text-slate-500">{o.currency}</span>
          </span>
        </div>

        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-slate-900">
              {o.customer_name || <span className="font-normal text-slate-400">No name</span>}
            </div>
            <div className="truncate text-xs text-slate-500">
              {[o.shipping_address1, o.shipping_city].filter(Boolean).join(", ") || "No address"}
            </div>
          </div>
          {isSyncing && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
              <Spinner className="h-3 w-3" /> Saving
            </span>
          )}
        </div>

        <div className="mt-2">{renderPhone(o, { big: true })}</div>
        {(o.tags || []).length > 0 && <div className="mt-2">{renderTags(o, isSyncing)}</div>}

        <div className="mt-3">{renderActions(o, isSyncing, { stretch: true })}</div>

        {pickerOpen && <div className="mt-2.5">{renderConfirmPicker(o, isSyncing)}</div>}

        {isOpen && (
          <div className="cf-collapse-in mt-3" onClick={(ev) => ev.stopPropagation()}>
            <OrderExpanded
              order={o}
              store={store}
              shopDomain={meta.shop_domain}
              onToast={pushToast}
              onOrderUpdated={(updatedOrder) => patchOrderInPlace(o.id, () => updatedOrder)}
            />
            {!nested && renderRelatedOrders(o)}
          </div>
        )}
      </div>
    );
  }

  function renderTableRow({ item: o, leaving }) {
    const isOpen = expanded.has(o.id);
    const pickerOpen = datePickerFor === o.id;
    const isSelected = selected.has(o.id);
    const isSyncing = pendingOrderIds.has(o.id);
    const url = shopifyOrderUrl(o, meta.shop_domain);
    const label = o.name || `#${o.number}`;
    const active = isOpen || pickerOpen;
    const rowBg = active ? "bg-indigo-50/70" : isSelected ? "bg-indigo-50/40" : "bg-white";
    return (
      <React.Fragment key={o.id}>
        <tr
          data-flip-key={o.id}
          className={`group border-t border-slate-100 cursor-pointer transition-colors ${rowBg} ${active ? "" : "hover:bg-slate-50/80"} ${leaving ? "cf-leave" : ""}`}
          onClick={(e) => { if (!leaving && !isInteractiveTarget(e)) openOrder(o); }}
        >
          <td className={`relative w-10 pl-4 pr-1 py-3 ${active ? "shadow-[inset_3px_0_0_rgb(99_102_241)]" : ""}`}>
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleRowSelected(o.id)}
              aria-label={`Select order ${label}`}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
          </td>
          <td className="px-2 py-3 whitespace-nowrap">
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 hover:text-indigo-900 hover:underline" title="Open in Shopify admin">{label}</a>
            ) : (
              <span className="font-semibold">{label}</span>
            )}
            {o.web_confirmation && <span className="ml-1.5 align-middle"><WebChatBadge compact /></span>}
            <div className="text-[11px] text-slate-400" title={o.created_at ? new Date(o.created_at).toLocaleString() : ""}>
              {timeAgo(o.created_at)}
            </div>
          </td>
          <td className="px-2 py-3 max-w-[240px]">
            <div className="truncate font-medium text-slate-900">{o.customer_name || <span className="text-slate-400">—</span>}</div>
            {renderGroupBadge(o)}
            <div className="truncate text-xs text-slate-500">
              {[o.shipping_address1, o.shipping_city].filter(Boolean).join(", ") || "—"}
            </div>
          </td>
          <td className="px-2 py-3 whitespace-nowrap">{renderPhone(o)}</td>
          <td className="px-2 py-3 whitespace-nowrap text-right font-semibold tabular-nums text-slate-900">
            {o.total_price} <span className="text-[11px] font-medium text-slate-500">{o.currency}</span>
          </td>
          <td className="px-3 py-3">
            <div className="flex items-center gap-2 max-w-[260px]">
              {renderTags(o, isSyncing, { size: "xs" })}
              {isSyncing && <Spinner className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
            </div>
          </td>
          {/* The open "more" menu overflows into the next rows, so its sticky cell must stack above theirs. */}
          <td className={`sticky right-0 px-3 py-3 ${actionsDropdownFor === o.id ? "z-20" : "z-[1]"} ${rowBg} ${active ? "" : "group-hover:bg-slate-50"} shadow-[-8px_0_12px_-10px_rgba(15,23,42,0.18)]`}>
            <div className="flex justify-end">{renderActions(o, isSyncing)}</div>
          </td>
        </tr>
        {pickerOpen && !leaving && (
          <tr className="bg-indigo-50/40">
            <td colSpan={7} className="px-4 py-2.5">{renderConfirmPicker(o, isSyncing)}</td>
          </tr>
        )}
        {isOpen && !leaving && (
          <tr className="bg-slate-50/70">
            <td colSpan={7} className="px-4 py-4">
              <div className="cf-collapse-in">
                <OrderExpanded
                  order={o}
                  store={store}
                  shopDomain={meta.shop_domain}
                  onToast={pushToast}
                  onOrderUpdated={(updatedOrder) => patchOrderInPlace(o.id, () => updatedOrder)}
                />
                {renderRelatedOrders(o)}
              </div>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  }

  const emptyState = !loading && displayRows.length === 0 && (
    <div className="cf-fade-in flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
        <Inbox className="h-6 w-6" aria-hidden />
      </div>
      {filterLevel ? (
        <>
          <div className="text-sm font-semibold text-slate-900">No {activeLevel.label} orders right now</div>
          <div className="mt-1 text-xs text-slate-500">Everything at this level has been handled.</div>
          <button type="button" onClick={() => setFilterLevel("")} className={`${BTN.secondary} mt-4 h-9`}>Show all orders</button>
        </>
      ) : (
        <>
          <div className="text-sm font-semibold text-slate-900">Your queue is clear</div>
          <div className="mt-1 text-xs text-slate-500">Nice work. Pull more orders to keep going.</div>
          {tagsAssigned.length > 0 && (
            <button type="button" onClick={() => openPull("new")} className={`${BTN.primary} mt-4 h-9`}>
              <Sparkles className="h-4 w-4" aria-hidden /> Get new orders
            </button>
          )}
        </>
      )}
    </div>
  );

  const pagerControls = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => goToPage(pageIndex - 1)}
        disabled={!hasPrevPage || pageBusy}
        className={`${BTN.secondary} h-8 w-8 !px-0`}
        aria-label="Previous page"
      ><ChevronLeft className="h-4 w-4" aria-hidden /></button>
      <span className="min-w-[64px] text-center text-xs font-medium text-slate-600 tabular-nums">
        Page {pageIndex + 1}{pages.length > 1 ? ` / ${pages.length}${pages[pages.length - 1]?.nextCursor ? "+" : ""}` : ""}
      </span>
      <button
        type="button"
        onClick={() => goToPage(pageIndex + 1)}
        disabled={!hasNextPage || pageBusy}
        className={`${BTN.secondary} h-8 w-8 !px-0`}
        aria-label="Next page"
      >{pageBusy ? <Spinner className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" aria-hidden />}</button>
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <TopBar
        me={me}
        store={store}
        loading={loading}
        lastLoadedAt={lastLoadedAt}
        syncState={syncState}
        onRefresh={() => { refreshAll(); pushToast("Refreshing…", "info", 1200); }}
        onInventory={() => goto("/inventory-helper", store)}
        view={view}
        onViewChange={onViewChange}
        chatBadge={chatBadge}
      />
      <main className={`mx-auto w-full max-w-[1440px] px-3 sm:px-5 lg:px-8 py-4 sm:py-6 space-y-4 sm:space-y-5 ${selected.size > 0 ? "pb-28" : ""}`}>
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
          inputRef={searchInputRef}
        />

        {tagsAssigned.length === 0 && (
          <div className="flex items-start gap-2.5 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
            <span>No tags are assigned to your account yet, so your queue is empty. Ask your admin to add at least one Shopify tag.</span>
          </div>
        )}
        {error && (
          <div className="cf-fade-in flex items-start gap-2.5 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-900 ring-1 ring-inset ring-rose-200">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={refreshAll} className="text-xs font-semibold underline">Try again</button>
          </div>
        )}
        {syncState.blockedCount > 0 && (
          <div className="cf-fade-in flex flex-wrap items-center gap-2 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-900 ring-1 ring-inset ring-rose-200" role="status" aria-live="polite">
            <CircleAlert className="h-4 w-4 shrink-0 text-rose-600" aria-hidden />
            <span className="font-semibold">{syncCount} action{syncCount === 1 ? "" : "s"} not saved yet</span>
            <span className="text-xs opacity-80">
              {syncState.lastError || "Keep this page open; every action is queued safely and will be counted after confirmation."}
            </span>
            <button type="button" onClick={retrySyncQueueNow} className={`${BTN.secondary} ml-auto h-8 text-xs`}>Retry now</button>
          </div>
        )}

        {/* Overview + get more orders */}
        <section className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 sm:gap-4">
            <KpiCard icon={Inbox} tone="sky" label="In my queue" value={Number(levelCounts.total || 0)} loading={firstLoad} />
            <KpiCard
              icon={Sparkles}
              tone="indigo"
              label="Not called yet"
              value={stats.fresh}
              loading={firstLoad}
              active={filterLevel === "new"}
              onClick={() => setFilterLevel((p) => (p === "new" ? "" : "new"))}
            />
            <KpiCard icon={Phone} tone="amber" label="Contacted" value={stats.contacted} loading={firstLoad} />
            <KpiCard
              icon={CalendarCheck}
              tone="emerald"
              label="Confirmed today"
              value={confirmedToday}
              hint={myRank && myRank.of > 1 ? `#${myRank.rank} of ${myRank.of} in team` : null}
            />
          </div>
          <GetMoreOrdersCard
            disabled={tagsAssigned.length === 0 && !isAdmin}
            isAdmin={isAdmin}
            onPull={openPull}
          />
        </section>

        {/* Queue */}
        <section className={`${CARD} overflow-hidden`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 sm:px-5">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900">My queue</h2>
              <p className="text-xs text-slate-500">
                {firstLoad ? "Loading orders…" : (
                  <>
                    {ordersForView.length} shown
                    {meta.assigned_total > ordersForView.length && <> of <AnimatedNumber value={meta.assigned_total} /></>}
                    {filterLevel ? <> · {activeLevel.label}</> : null}
                    {" "}· tap a row for details
                  </>
                )}
              </p>
            </div>
            <div className="ml-auto hidden sm:block">{pagerControls}</div>
          </div>

          <LevelTabs value={filterLevel} counts={levelCounts} onChange={setFilterLevel} />

          <div className="flex items-center gap-2 border-y border-slate-100 bg-slate-50/70 px-4 py-2 sm:px-5 xl:hidden">
            <label className="inline-flex select-none items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </label>
          </div>

          {/* Desktop table only at xl+ (≥1280px effective width). At anything narrower
              (including a zoomed-in desktop) the scroll-free card list takes over so
              the action buttons can never end up clipped. */}
          <div className="hidden xl:block overflow-x-auto">
            <table className="cf-order-queue-table w-full table-fixed text-xs">
              <colgroup>
                <col className="w-9" />
                <col className="w-[100px]" />
                <col />
                <col className="w-[155px]" />
                <col className="w-[100px]" />
                <col className="w-[210px]" />
                <col className="w-[285px]" />
              </colgroup>
              <thead className="border-t border-slate-100 bg-slate-50/70 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="w-10 pl-4 pr-1 py-2.5">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                      aria-label="Select all visible orders"
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </th>
                  <th className="px-2 py-2.5">Order</th>
                  <th className="px-2 py-2.5">Customer</th>
                  <th className="px-2 py-2.5">Phone</th>
                  <th className="px-2 py-2.5 text-right">Total</th>
                  <th className="px-3 py-2.5">Tags</th>
                  <th className="sticky right-0 bg-slate-50 px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody ref={tableBodyRef}>
                {firstLoad && <SkeletonRows columns={7} />}
                {displayRows.map(renderTableRow)}
              </tbody>
            </table>
            {emptyState}
          </div>

          {/* Card list — used on anything narrower than xl (≤1280px), including
              zoomed-in desktops, so the action buttons never get clipped. */}
          <div className="xl:hidden">
            {firstLoad && <SkeletonCards />}
            <div ref={cardListRef} className="divide-y divide-slate-100">
              {displayRows.map(({ item, leaving }) => renderOrderCard(item, { leaving }))}
            </div>
            {emptyState}
          </div>

          <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 sm:px-5">
            <span className="text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{ordersForView.length}</span> on this page ·{" "}
              <span className="font-semibold text-slate-700"><AnimatedNumber value={meta.assigned_total} /></span> {filterLevel ? activeLevel.label : "total"}
            </span>
            <div className="ml-auto">{pagerControls}</div>
          </div>
        </section>

        {/* Team performance */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-500" aria-hidden />
            <h2 className="text-sm font-semibold text-slate-900">Team today</h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">all stores</span>
            {meta.today_label && (
              <span className="ml-auto text-[11px] text-slate-500">{meta.today_label} · confirmations counted by clicks today</span>
            )}
          </div>
          {sortedTeam.length === 0 ? (
            <div className={`${CARD} px-4 py-6 text-center text-xs text-slate-500`}>No team data yet.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {sortedTeam.map((a, idx) => (
                <AgentCard key={a.id} agent={a} rank={idx + 1} isMe={a.id === me.id} maxConfirmed={teamMaxConfirmed} />
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Floating bulk-action bar — only while something is selected. */}
      {selected.size > 0 && (
        <div className="cf-slide-up fixed bottom-3 left-1/2 z-40 w-[min(760px,calc(100vw-1.5rem))] -translate-x-1/2 sm:bottom-5">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-slate-900 p-2 pl-4 text-white shadow-2xl shadow-slate-900/30 ring-1 ring-white/10">
            <span className="text-sm font-semibold tabular-nums">{selected.size} selected</span>
            <div className="relative min-w-[180px] flex-1">
              <input
                type="text"
                value={bulkTag}
                onChange={(e) => { setBulkTag(e.target.value); setShowBulkSuggestions(true); }}
                onFocus={() => setShowBulkSuggestions(true)}
                onBlur={() => setTimeout(() => setShowBulkSuggestions(false), 120)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyBulkTag(); } }}
                placeholder="Tag to add, e.g. cod 18/05/26"
                className="h-9 w-full rounded-xl border-0 bg-white/10 px-3 text-sm text-white placeholder:text-slate-400 focus:bg-white/15 focus:ring-2 focus:ring-indigo-400"
              />
              {showBulkSuggestions && tagSuggestions.length > 0 && (
                <div className="cf-pop-in absolute bottom-full z-20 mb-2 max-h-56 w-full overflow-auto rounded-xl bg-white py-1 text-slate-800 shadow-xl ring-1 ring-slate-900/10">
                  {tagSuggestions.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onMouseDown={(ev) => { ev.preventDefault(); setBulkTag(t); setShowBulkSuggestions(false); }}
                      className="block w-full px-3 py-1.5 text-left text-xs hover:bg-indigo-50"
                    >{t}</button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={applyBulkTag}
              disabled={bulkBusy || !bulkTag.trim()}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-500 px-3.5 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-40 active:scale-[0.97] transition"
              title="Add the tag to every selected order (a cod dd/mm/yy tag removes them from your queue)"
            >{bulkBusy ? <Spinner /> : <Check className="h-4 w-4" aria-hidden />} Apply</button>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 hover:bg-white/10 hover:text-white"
              aria-label="Clear selection"
              title="Clear selection"
            ><X className="h-4 w-4" aria-hidden /></button>
          </div>
        </div>
      )}

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
          initialMode={pullMode.mode}
          initialIncludeAssigned={pullMode.includeAssigned}
          store={store}
          me={{ ...me, tags: tagsAssigned }}
          isAdmin={isAdmin}
          team={teamStats}
          onClose={() => setPullMode(null)}
          onSuccess={(result, summary) => {
            setPullMode(null);
            const pulled = Number(result.pulled || 0);
            if (pulled === 0) {
              pushToast("No orders were left to pull — someone may have just taken them.", "warn", 5000);
            } else {
              const took = Number(result.reassigned || 0);
              pushToast(
                summary?.message
                  || (`Pulled ${pulled} order${pulled === 1 ? "" : "s"} into your queue`
                    + (took ? ` (${took} taken over from another agent)` : "")),
                "success",
                4500,
              );
            }
            // A tag removal that failed leaves the order owned by two agents.
            if (result.reassign_failed) {
              pushToast(
                `${result.reassign_failed} order${result.reassign_failed === 1 ? "" : "s"} kept the previous agent's tag — remove it by hand`,
                "error",
                7000,
              );
            }
            // The agent's queue + every other agent's queue changed — refresh both.
            if (filterLevel && pulled > 0 && (!result.target_agent_id || result.target_agent_id === me.id)) {
              setFilterLevel("");
            } else {
              loadFirst();
            }
            loadTeam();
          }}
        />
      )}
    </div>
  );
}

// ---------- Overview widgets ----------

const PULL_BUTTONS = [
  { mode: "n1", label: "N1", tone: "amber" },
  { mode: "n2", label: "N2", tone: "orange" },
  { mode: "n3", label: "N3", tone: "rose" },
  { mode: "n4", label: "N4", tone: "red" },
  { mode: "nowtp", label: "No WA", tone: "violet" },
  { mode: "enatt", label: "En att.", tone: "fuchsia" },
];

function GetMoreOrdersCard({ onPull, isAdmin, disabled }) {
  return (
    <div className={`${CARD} relative overflow-hidden p-4`}>
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-gradient-to-br from-indigo-200/50 to-violet-200/40 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">Get more orders</h2>
          <p className="mt-0.5 hidden text-xs text-slate-500 sm:block">Pulled orders get your tag and leave everyone else's queue.</p>
        </div>
      </div>
      <div className="relative mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          data-testid="pull-new"
          disabled={disabled}
          onClick={() => onPull("new")}
          className={`${BTN.primary} h-10`}
        >
          <Sparkles className="h-4 w-4" aria-hidden /> New orders
        </button>
        <button
          type="button"
          disabled={disabled && !isAdmin}
          onClick={() => onPull("new", { includeAssigned: true })}
          className={`${BTN.secondary} h-10`}
          title="Move orders that currently sit in another agent's queue"
        >
          <ArrowRightLeft className="h-4 w-4 text-indigo-600" aria-hidden /> {isAdmin ? "Move orders" : "From an agent"}
        </button>
      </div>
      <div className="cf-scroll-x relative -mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {PULL_BUTTONS.map((b) => (
          <button
            key={b.mode}
            type="button"
            disabled={disabled}
            onClick={() => onPull(b.mode)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:ring-slate-300 active:scale-[0.96] transition disabled:opacity-50"
            title={`Pull ${b.label} orders into your queue`}
          >
            <span aria-hidden className={`h-2 w-2 rounded-full ${TONES[b.tone].dot}`} />
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Level filter for the queue. Doubles as the per-level counter, so agents see where
// their work is at a glance. Scrolls sideways on phones instead of wrapping.
function LevelTabs({ value, counts, onChange }) {
  return (
    <div className="cf-scroll-x mt-3 flex gap-1.5 overflow-x-auto px-4 pb-3 sm:px-5" role="tablist" aria-label="Filter by call level">
      {LEVELS.map((lv) => {
        const active = value === lv.key;
        const tone = TONES[lv.tone];
        const n = Number(counts?.[lv.count] || 0);
        return (
          <button
            key={lv.key || "all"}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(active && lv.key ? "" : lv.key)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-2.5 pr-1.5 text-xs font-semibold transition duration-200 active:scale-[0.96] ${
              active ? `${tone.solid} shadow-sm` : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            {!active && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />}
            {lv.label}
            <span className={`min-w-[22px] rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${active ? "bg-white/25" : n > 0 ? "bg-slate-100 text-slate-700" : "bg-slate-50 text-slate-400"}`}>
              <AnimatedNumber value={n} />
            </span>
          </button>
        );
      })}
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

  const fieldLabel = "mb-1.5 block text-xs font-semibold text-slate-700";
  const checkRow = "flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50";
  return (
    <Modal onClose={onClose} busy={busy} labelledBy="cancel-order-title">
      <ModalHeader
        id="cancel-order-title"
        icon={Ban}
        tone="rose"
        title={`Cancel order ${orderLabel}?`}
        subtitle={order?.customer_name ? `${order.customer_name} · ${amount}` : amount}
        onClose={onClose}
        busy={busy}
      />
      <div className="space-y-4 overflow-y-auto px-5 py-4">
        <div>
          <label className={fieldLabel} htmlFor="cancel-reason">Reason for cancellation</label>
          <select
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-10 w-full rounded-xl border-0 bg-white px-3 text-sm ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-rose-500"
          >
            <option value="CUSTOMER">Customer changed or canceled order</option>
            <option value="INVENTORY">Items unavailable</option>
            <option value="FRAUD">Fraudulent order</option>
            <option value="DECLINED">Payment declined</option>
            <option value="STAFF">Staff error</option>
            <option value="OTHER">Other</option>
          </select>
        </div>

        <div>
          <label className={fieldLabel} htmlFor="cancel-note">Staff note <span className="font-normal text-slate-400">· only staff can see it</span></label>
          <textarea
            id="cancel-note"
            value={staffNote}
            onChange={(e) => setStaffNote(e.target.value)}
            rows={2}
            className="w-full rounded-xl border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-rose-500"
            placeholder="Optional"
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className={checkRow}>
            <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500" />
            Cancel {amount} pending
          </label>
          <label className={checkRow}>
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500" />
            Restock inventory
          </label>
        </div>

        {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">{err}</div>}
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3">
        <button type="button" onClick={onClose} disabled={busy} className={`${BTN.secondary} h-10`}>Keep order</button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-rose-700 disabled:opacity-50 active:scale-[0.97] transition"
        >{busy ? <><Spinner /> Cancelling…</> : "Cancel order"}</button>
      </div>
    </Modal>
  );
}

// Pull-orders modal — opened by the "Get more orders" panel. Lets the agent
// claim a batch of orders into their queue. Two flavours, picked by `mode`:
//
//   "new"   — orders that no other active agent has claimed (no other agent
//             tag is present). The "include other agents' orders" switch widens
//             this to every order that isn't already mine, so an order sitting
//             in someone else's queue can be taken over; execute strips their
//             tag either way, so the order never ends up with two agent tags.
//   "n1"/"n2"/"n3"/"n4"/"nowtp"/"enatt" — orders carrying that call-attempt
//             tag, optionally MINUS up to two agent-specified exclude tags
//             (e.g. "n2 but not fz and not zineb"). These can currently sit in
//             other agents' queues; the execute call strips those tags so the
//             pulled order becomes exclusively this agent's.
//
// Whenever other agents' orders are in the pool, the modal lists who owns how
// many, and the agent can take from just one of them ("move Zineb's orders to
// me"). Admins can also pick whose queue the orders go to.
//
// The count refreshes as filters change (debounced) and every 20 seconds while the
// modal is open, so it never goes stale while the agent is deciding.
const PULL_MODES = [
  { mode: "new",   label: "New",         title: "Pull new orders",         tone: "indigo",  icon: Sparkles },
  { mode: "n1",    label: "N1",          title: "Pull N1 orders",          tone: "amber",   icon: Phone },
  { mode: "n2",    label: "N2",          title: "Pull N2 orders",          tone: "orange",  icon: Phone },
  { mode: "n3",    label: "N3",          title: "Pull N3 orders",          tone: "rose",    icon: Phone },
  { mode: "n4",    label: "N4",          title: "Pull N4 orders",          tone: "red",     icon: Phone },
  { mode: "nowtp", label: "No WhatsApp", title: "Pull No-WhatsApp orders", tone: "violet",  icon: MessageCircleOff },
  { mode: "enatt", label: "En attente",  title: "Pull En-attente orders",  tone: "fuchsia", icon: Hourglass },
];
const SOURCE_UNASSIGNED = "__unassigned__";
const PULL_REFRESH_MS = 20_000;

function agentLabel(a) {
  return a?.name || a?.email || "agent";
}

function PullOrdersModal({ initialMode = "new", initialIncludeAssigned = false, store, me, isAdmin, team, onClose, onSuccess }) {
  const [mode, setMode] = useState(initialMode);
  const cfg = PULL_MODES.find((m) => m.mode === mode) || PULL_MODES[0];
  const isLevelMode = mode !== "new";
  const [excludeA, setExcludeA] = useState("");
  const [excludeB, setExcludeB] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  // "new" mode only: drop the other-agent exclusions so already-assigned orders
  // show up in the pool and can be taken over.
  const [includeAssigned, setIncludeAssigned] = useState(!!initialIncludeAssigned);
  // Whose orders to take: "" = anyone in the pool, SOURCE_UNASSIGNED, or an agent id.
  const [sourceId, setSourceId] = useState("");

  // Whose queue the orders go to. Admins can pick any tagged agent; everyone else
  // always pulls into their own queue.
  const targetOptions = useMemo(() => {
    const list = [];
    const seen = new Set();
    if ((me?.tags || []).length > 0 || !isAdmin) { list.push({ id: me.id, name: me.name, email: me.email, tags: me.tags || [], isMe: true }); seen.add(me.id); }
    if (isAdmin) {
      for (const a of team || []) {
        if (!a?.id || seen.has(a.id) || !(a.tags || []).length) continue;
        seen.add(a.id);
        list.push({ id: a.id, name: a.name, email: a.email, tags: a.tags || [], isMe: a.id === me.id });
      }
    }
    return list;
  }, [me, isAdmin, team]);
  const [targetId, setTargetId] = useState(() => targetOptions[0]?.id || me.id);
  const target = targetOptions.find((t) => t.id === targetId) || targetOptions[0] || { id: me.id, name: me.name, isMe: true };
  const targetIsMe = target.id === me.id;

  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState(null);
  const [previewAt, setPreviewAt] = useState(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Which of the owner's agent_tags to apply on pull. Defaults to the first.
  const [agentTag, setAgentTag] = useState(() => (target.tags || [])[0] || "");
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
  const showOwners = isLevelMode || includeAssigned;
  const effectiveSource = showOwners ? sourceId : "";

  // Debounced preview. Re-fetches whenever a filter settles, and on each refresh tick.
  useEffect(() => {
    const handle = setTimeout(async () => {
      const reqId = ++previewReqRef.current;
      setPreviewing(true); setPreviewErr(null);
      try {
        const js = await API.pullPreview({
          store, level: mode, exclude_tags: excludeTags, include_assigned: includeAssigned,
          source_agent_id: effectiveSource || null,
          target_agent_id: targetIsMe ? null : target.id,
        });
        if (reqId !== previewReqRef.current) return;
        setPreview(js);
        setPreviewAt(Date.now());
        const ownerTags = js.agent_tags || [];
        setAgentTag((cur) => (cur && ownerTags.some((t) => t.toLowerCase() === cur.toLowerCase()) ? cur : (js.agent_tag || ownerTags[0] || "")));
      } catch (e) {
        if (reqId !== previewReqRef.current) return;
        setPreviewErr(e?.message || "Preview failed");
        setPreview(null);
      } finally {
        if (reqId === previewReqRef.current) setPreviewing(false);
      }
    }, 300);
    return () => clearTimeout(handle);
    // agentTag doesn't affect the count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, mode, excludeA, excludeB, includeAssigned, effectiveSource, target.id, refreshNonce]);

  // Keep the number live while the modal stays open.
  useEffect(() => {
    const t = setInterval(() => {
      if (!busy && document.visibilityState === "visible") setRefreshNonce((n) => n + 1);
    }, PULL_REFRESH_MS);
    return () => clearInterval(t);
  }, [busy]);

  const available = preview ? Number(preview.available || 0) : null;

  // Never leave "How many" asking for more than exists (a stale 20 when only 18 remain).
  useEffect(() => {
    if (available != null && available > 0 && !takeAll && Number(amount) > available) setAmount(available);
  }, [available, takeAll, amount]);
  const assignedAvailable = preview ? Number(preview.assigned_available || 0) : 0;
  const byAgent = preview?.by_agent || [];
  const sourceAgent = byAgent.find((a) => a.id === effectiveSource) || null;
  const wanted = takeAll ? available : Math.max(0, Number(amount) || 0);
  const willPull = available == null ? wanted : Math.min(wanted || 0, available);

  async function submit() {
    const limit = takeAll ? 0 : Math.max(0, Number(amount) || 0);
    if (!takeAll && limit <= 0) {
      setErr("Enter a number greater than 0 (or pick Take all).");
      return;
    }
    if (!agentTag) {
      setErr(targetIsMe
        ? "No agent tag selected. Ask admin to assign one to your account."
        : `${agentLabel(target)} has no tag yet.`);
      return;
    }
    setBusy(true); setErr(null);
    try {
      const js = await API.pullExecute({
        store, level: mode, exclude_tags: excludeTags, limit, agent_tag: agentTag,
        include_assigned: includeAssigned,
        source_agent_id: effectiveSource || null,
        target_agent_id: targetIsMe ? null : target.id,
      });
      const n = Number(js.pulled || 0);
      const orders = `${n} order${n === 1 ? "" : "s"}`;
      const from = effectiveSource === SOURCE_UNASSIGNED ? " unassigned" : "";
      const fromAgent = sourceAgent ? ` from ${agentLabel(sourceAgent)}` : "";
      const message = targetIsMe
        ? (sourceAgent ? `Moved ${orders}${fromAgent} to your queue` : null)
        : `Moved ${n}${from} order${n === 1 ? "" : "s"}${fromAgent} to ${agentLabel(target)}`;
      onSuccess?.(js, { message });
    } catch (e) {
      setErr(e?.message || "Pull failed");
    } finally {
      setBusy(false);
    }
  }

  const presets = [10, 20, 50, 100];
  const submitDisabled = busy || previewing || !preview || available === 0 || (!takeAll && !(Number(amount) > 0));
  const title = !isLevelMode && includeAssigned
    ? (isAdmin ? "Move orders between agents" : "Take orders from an agent")
    : cfg.title;
  const inputCls = "h-10 w-full rounded-xl border-0 bg-white px-3 text-sm ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500";

  return (
    <Modal onClose={onClose} busy={busy} labelledBy="pull-title" maxWidth="max-w-lg">
      <ModalHeader
        id="pull-title"
        icon={!isLevelMode && includeAssigned ? ArrowRightLeft : cfg.icon}
        tone={cfg.tone}
        title={title}
        subtitle={<>Store <span className="font-semibold text-slate-700">{store}</span></>}
        onClose={onClose}
        busy={busy}
      />

      <div className="space-y-4 overflow-y-auto px-5 py-4">
        {/* Which pool */}
        <div className="cf-scroll-x -mx-5 flex gap-1.5 overflow-x-auto px-5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="tablist" aria-label="Which orders">
          {PULL_MODES.map((m) => {
            const active = m.mode === mode;
            return (
              <button
                key={m.mode}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={busy}
                onClick={() => { setMode(m.mode); setSourceId(""); }}
                className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition active:scale-[0.96] ${
                  active ? `${TONES[m.tone].solid} shadow-sm` : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                }`}
              >
                {!active && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${TONES[m.tone].dot}`} />}
                {m.label}
              </button>
            );
          })}
        </div>

        {!isLevelMode && (
          <label
            className={`flex cursor-pointer select-none items-start gap-3 rounded-xl px-3.5 py-3 ring-1 ring-inset transition-colors ${
              includeAssigned ? "bg-amber-50 ring-amber-200" : "bg-slate-50 ring-slate-200 hover:bg-slate-100"
            }`}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={includeAssigned}
              disabled={busy}
              onChange={(e) => {
                setIncludeAssigned(e.target.checked);
                setSourceId("");
                // Switching off hides the exclude inputs — don't keep filtering
                // the pool by values the agent can no longer see.
                if (!e.target.checked) { setExcludeA(""); setExcludeB(""); }
              }}
            />
            <span
              aria-hidden="true"
              className={`mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors duration-200 ${includeAssigned ? "bg-amber-500" : "bg-slate-300"}`}
            >
              <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${includeAssigned ? "translate-x-4" : "translate-x-0"}`} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-800">Include orders already assigned to another agent</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {includeAssigned
                  ? "Pick an agent below to move only their orders. Their tag is removed from every order taken."
                  : "Off: only orders nobody is working on right now."}
              </span>
            </span>
          </label>
        )}

        {/* Who currently owns the pool */}
        {showOwners && (
          <div className="cf-collapse-in">
            <div className="mb-2 flex items-center gap-2">
              <Users className="h-4 w-4 text-slate-400" aria-hidden />
              <span className="text-xs font-semibold text-slate-700">Take orders from</span>
              {previewing && preview && <Spinner className="h-3.5 w-3.5 text-slate-400" />}
            </div>
            {!preview && previewing ? (
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((i) => <div key={i} className="cf-shimmer h-12 rounded-xl" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Take orders from">
                <SourceOption
                  testId="source-all"
                  active={!effectiveSource}
                  onClick={() => setSourceId("")}
                  title="Everyone"
                  subtitle="Anyone in this pool"
                  count={preview?.pool_total ?? preview?.available ?? 0}
                  disabled={busy}
                />
                <SourceOption
                  testId="source-unassigned"
                  active={effectiveSource === SOURCE_UNASSIGNED}
                  onClick={() => setSourceId(SOURCE_UNASSIGNED)}
                  title="Unassigned"
                  subtitle="Nobody is working on them"
                  count={preview?.unassigned_available ?? 0}
                  disabled={busy}
                />
                {byAgent.map((a) => (
                  <SourceOption
                    key={a.id}
                    testId={`source-${a.id}`}
                    active={effectiveSource === a.id}
                    onClick={() => setSourceId(a.id)}
                    title={agentLabel(a)}
                    subtitle={`${(a.tags || []).join(", ")}${a.is_active === false ? " · inactive" : ""}`}
                    count={a.count}
                    avatar={initialOf(agentLabel(a))}
                    disabled={busy}
                  />
                ))}
              </div>
            )}
            {preview && byAgent.length === 0 && (
              <div className="mt-2 text-xs text-slate-500">No other agent owns orders in this pool right now.</div>
            )}
          </div>
        )}

        {/* Where the orders go (admins) */}
        {isAdmin && targetOptions.length > 0 && (
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-700" htmlFor="pull-target">Assign to</label>
            <select
              id="pull-target"
              value={target.id}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value;
                setTargetId(next);
                if (next === effectiveSource) setSourceId("");
                const t = targetOptions.find((o) => o.id === next);
                setAgentTag((t?.tags || [])[0] || "");
              }}
              className={inputCls}
            >
              {targetOptions.map((t) => (
                <option key={t.id} value={t.id}>{t.isMe ? `Me (${agentLabel(t)})` : agentLabel(t)} — {(t.tags || []).join(", ")}</option>
              ))}
            </select>
          </div>
        )}

        {(isLevelMode || includeAssigned) && (
          <div>
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900"
              aria-expanded={showFilters || excludeTags.length > 0}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
              Exclude tags{excludeTags.length ? ` (${excludeTags.length})` : ""}
              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showFilters || excludeTags.length ? "rotate-90" : ""}`} aria-hidden />
            </button>
            {(showFilters || excludeTags.length > 0) && (
              <div className="cf-collapse-in mt-2 grid grid-cols-2 gap-2">
                <input type="text" value={excludeA} onChange={(e) => setExcludeA(e.target.value)} placeholder="e.g. fz" aria-label="Exclude tag 1" className={inputCls} />
                <input type="text" value={excludeB} onChange={(e) => setExcludeB(e.target.value)} placeholder="e.g. zineb" aria-label="Exclude tag 2" className={inputCls} />
              </div>
            )}
          </div>
        )}

        {/* Live count */}
        <div className="rounded-2xl bg-gradient-to-br from-indigo-50 to-violet-50 px-4 py-3 ring-1 ring-inset ring-indigo-100">
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-indigo-900">Available now</div>
              <div className="mt-0.5 text-[11px] text-indigo-700/80">
                {previewErr ? "Couldn't load the count" : previewAt ? <PreviewAge at={previewAt} busy={previewing} source="Shopify" /> : "Counting…"}
              </div>
            </div>
            <div className="ml-auto text-3xl font-bold leading-none tracking-tight text-indigo-950">
              {available == null ? (previewing ? <Spinner className="h-6 w-6 text-indigo-400" /> : "—") : <AnimatedNumber value={available} />}
            </div>
            <button
              type="button"
              onClick={() => setRefreshNonce((n) => n + 1)}
              disabled={previewing || busy}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/80 text-indigo-600 ring-1 ring-inset ring-indigo-200 hover:bg-white disabled:opacity-60"
              title="Recount now"
              aria-label="Recount now"
            ><RefreshCw className={`h-4 w-4 ${previewing ? "animate-spin" : ""}`} aria-hidden /></button>
          </div>
          {!previewing && assignedAvailable > 0 && (
            <div className="mt-2 border-t border-indigo-100 pt-2 text-[11px] text-amber-800">
              {sourceAgent
                ? <>All {assignedAvailable} belong to <b>{agentLabel(sourceAgent)}</b> and will leave their queue.</>
                : <>{assignedAvailable} of these currently belong to another agent and will be taken over.</>}
            </div>
          )}
        </div>
        {previewErr && (
          <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">{previewErr}</div>
        )}

        {(preview?.agent_tags || target.tags || []).length > 1 && (
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-700" htmlFor="pull-tag">Apply tag</label>
            <select id="pull-tag" value={agentTag} onChange={(e) => setAgentTag(e.target.value)} className={inputCls}>
              {(preview?.agent_tags || target.tags || []).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}

        <div>
          <div className="mb-1.5 text-xs font-semibold text-slate-700">How many</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {presets.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => { setAmount(n); setTakeAll(false); }}
                disabled={busy || (available != null && n > available && Number(amount) !== n)}
                className={`h-9 min-w-[48px] rounded-xl px-3 text-sm font-semibold transition active:scale-[0.96] disabled:opacity-35 ${
                  !takeAll && Number(amount) === n
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                }`}
              >{n}</button>
            ))}
            <button
              type="button"
              onClick={() => setTakeAll((p) => !p)}
              disabled={busy || available === 0}
              className={`h-9 rounded-xl px-3 text-sm font-semibold transition active:scale-[0.96] disabled:opacity-35 ${
                takeAll ? "bg-indigo-600 text-white shadow-sm" : "bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
              }`}
            >All{available != null ? ` (${available})` : ""}</button>
            <input
              type="number"
              min={1}
              max={available || 9999}
              value={takeAll ? (available ?? "") : amount}
              onChange={(e) => { setAmount(e.target.value); setTakeAll(false); }}
              disabled={busy || takeAll}
              aria-label="Number of orders"
              className="h-9 w-20 rounded-xl border-0 px-3 text-sm ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
        </div>

        {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">{err}</div>}
      </div>

      <div className="border-t border-slate-100 bg-slate-50/70 px-5 py-3">
        <div className="mb-2.5 text-[11px] leading-relaxed text-slate-500">
          {agentTag ? <>Orders get <code className="rounded bg-white px-1 py-px font-semibold text-slate-700 ring-1 ring-slate-200">{agentTag}</code></> : "Orders get the agent's tag"}
          {" "}and every other agent's tag is removed — each order belongs to exactly one agent
          {targetIsMe ? " (you)." : <> (<b>{agentLabel(target)}</b>).</>}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={`${BTN.secondary} h-10`}>Cancel</button>
          <button
            type="button"
            data-testid="pull-submit"
            onClick={submit}
            disabled={submitDisabled}
            className={`${BTN.primary} h-10 px-4`}
          >
            {busy ? <><Spinner /> Moving orders…</> : (
              <>
                {targetIsMe ? <Sparkles className="h-4 w-4" aria-hidden /> : <ArrowRightLeft className="h-4 w-4" aria-hidden />}
                {targetIsMe ? "Pull" : "Move"} {takeAll ? "all" : ""} {willPull > 0 ? willPull : ""} {!takeAll && willPull > 0 ? `order${willPull === 1 ? "" : "s"}` : takeAll ? "" : "orders"}
                {!targetIsMe && <span className="hidden sm:inline"> to {agentLabel(target)}</span>}
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Global Shopify search panel — orders + customers in the selected store. Independent
// of the agent's tag-filtered queue. Phone-like input is normalized server-side so
// `+212 614 162-654`, `0614162654`, and `614162654` all match the same record.
function GlobalSearch({
  query, onQueryChange, onSearchNow, onClear, loading, error, results, store, onStoreChange, pushToast,
  renderOrderCard, expandedCustomerId, customerOrdersById, onToggleCustomer, inputRef,
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
      pushToast(`Copied ${label}`, "success");
    } catch {
      pushToast(`Clipboard blocked`, "warn");
    }
  }

  return (
    <section className={`${CARD} p-2.5 sm:p-3`}>
      <div className="flex items-center gap-2">
        <div className="flex h-11 max-w-[42%] shrink-0 items-center gap-1.5 rounded-xl bg-slate-50 pl-3 pr-1 ring-1 ring-inset ring-slate-200 sm:max-w-none">
          <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:inline">Store</span>
          <StorePicker
            value={store}
            onChange={onStoreChange}
            allowCustom={false}
            className="h-full !rounded-none !border-0 !bg-transparent !p-0 !pr-1 text-sm font-semibold text-slate-900 shadow-none focus:!ring-0"
          />
        </div>
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSearchNow?.();
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); onClear?.(); } }}
              placeholder="Phone or order #"
              className="h-11 w-full rounded-xl border-0 bg-white pl-9 pr-10 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-indigo-500"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
              {loading
                ? <Spinner className="h-4 w-4 text-indigo-500" />
                : !query && <kbd className="hidden sm:inline rounded border border-slate-200 bg-slate-50 px-1.5 text-[10px] font-semibold text-slate-400">/</kbd>}
            </span>
          </div>
          <button
            type="submit"
            disabled={(query || "").trim().length < 2}
            className={`${BTN.primary} hidden h-11 px-4 sm:inline-flex`}
          >
            Search
          </button>
          {(query || "").length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className={`${BTN.secondary} h-11 w-11 !px-0`}
              aria-label="Clear search"
            ><X className="h-4 w-4" aria-hidden /></button>
          )}
        </form>
      </div>

      {hasQuery && searchKind && !loading && (
        <div className="mt-2 flex flex-wrap gap-2 px-1">
          <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-200">
            {searchKind === "phone" ? "Phone match" : searchKind === "order" ? "Order-number match" : "Customer / order search"}
          </span>
          {normalizedPhone && (
            <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 font-mono text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
              Normalized: {normalizedPhone}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-inset ring-rose-200">{error}</div>
      )}

      {hasQuery && !loading && !error && !hasResults && results && (
        <div className="mt-3 px-1 text-sm text-slate-500">No orders or customers match "{query}" in {store}.</div>
      )}

      {hasResults && (
        <div className="cf-fade-in mt-3 space-y-4">
          {orders.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5 px-1">
                {searchKind === "phone"
                  ? `Customer orders (${orders.length}) · newest first`
                  : `Orders (${orders.length})`}
              </div>
              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100">
                {groupConfirmationOrders(orders).map((o) => (
                  <React.Fragment key={o.id}>{renderOrderCard(o)}</React.Fragment>
                ))}
              </div>
            </div>
          )}

          {customers.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5 px-1">
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
                              ><Copy className="h-3.5 w-3.5" aria-hidden /></button>
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
                              {groupConfirmationOrders(custOrders).map((o) => (
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

const TEAM_LEVELS = [
  { key: "new", label: "New", tone: "indigo" },
  { key: "n1", label: "N1", tone: "amber" },
  { key: "n2", label: "N2", tone: "orange" },
  { key: "n3", label: "N3", tone: "rose" },
  { key: "n4", label: "N4", tone: "red" },
  { key: "nowtp", label: "NoWA", tone: "violet" },
  { key: "enatt", label: "Enatt", tone: "fuchsia" },
];

function AgentCard({ agent, isMe, rank, maxConfirmed = 1 }) {
  const b = agent.breakdown || {};
  const confirmed = Number(agent.confirmed_today || 0);
  const pending = Number(b.total || 0);
  const medal = confirmed > 0 ? ["bg-amber-400 text-amber-950", "bg-slate-300 text-slate-800", "bg-orange-300 text-orange-950"][rank - 1] : null;
  return (
    <div className={`${CARD} p-4 transition hover:shadow-md ${isMe ? "ring-2 ring-indigo-500/70 border-transparent" : ""}`}>
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold ${isMe ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700"}`}>
            {initialOf(agent.name || agent.email)}
          </div>
          {medal && (
            <span className={`absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ring-2 ring-white ${medal}`}>{rank}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-900" title={agent.name || agent.email}>{agent.name || agent.email}</span>
            {isMe && <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-200">You</span>}
            {agent.is_catchall && <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">Catch-all</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {(agent.tags || []).map((t) => (
              <span key={t} className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-600">{t}</span>
            ))}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold leading-none tabular-nums text-emerald-600"><AnimatedNumber value={confirmed} /></div>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">confirmed</div>
        </div>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-[width] duration-700 ease-out"
          style={{ width: `${Math.round((confirmed / Math.max(1, maxConfirmed)) * 100)}%` }}
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-slate-500">In queue</span>
        <span className="font-semibold tabular-nums text-slate-800"><AnimatedNumber value={pending} /></span>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {TEAM_LEVELS.map((lv) => {
          const n = Number(b[lv.key] || 0);
          const tone = TONES[lv.tone];
          return (
            <div
              key={lv.key}
              className={`rounded-lg px-1 py-1 text-center ring-1 ring-inset ${n > 0 ? tone.soft : "bg-slate-50 text-slate-400 ring-slate-100"}`}
              title={`${lv.label}: ${n}`}
            >
              <div className="text-[9px] font-semibold uppercase leading-tight opacity-80">{lv.label}</div>
              <div className="text-sm font-bold leading-tight tabular-nums">{n}</div>
            </div>
          );
        })}
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

// COD form orders confirmed in the store's own chat right after the purchase (the confirmation
// flow's template is answered there instead of WhatsApp). Other orders show nothing new.
function WebChatBadge({ compact = false }) {
  return (
    <span
      title="Website confirmation flow: confirmed in the store's chat right after the COD form"
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200"
    >
      <MessageCircleReply className="h-3 w-3" aria-hidden />
      {compact ? <span className="sr-only">Website confirmation chat</span> : "Web chat"}
    </span>
  );
}

function OrderConfirmationChat({ sessionId, phone }) {
  const [view, setView] = useState({ loading: true });
  const whatsappPhone = orderPhone({ phone });
  useEffect(() => {
    let cancelled = false;
    setView({ loading: true });
    API.webConfirmationChat(sessionId)
      .then((js) => { if (!cancelled) setView({ url: js && /^https:\/\//.test(js.url || "") ? js.url : null }); })
      .catch((e) => { if (!cancelled) setView({ error: e?.message || "Failed to load the chat" }); });
    return () => { cancelled = true; };
  }, [sessionId]);
  return (
    <div className="cf-order-chat min-w-0 w-full max-w-[420px] self-start bg-white border border-emerald-200 rounded-2xl p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <MessageCircleReply size={15} className="text-emerald-600" aria-hidden />
        <span className="text-[11px] uppercase tracking-wider font-semibold text-emerald-700">Website + WhatsApp conversation</span>
        <span className="text-xs text-gray-500">Website chat followed by messages to this store's connected WhatsApp numbers, matched by phone from the time of purchase. Updates while open.</span>
      </div>
      {view.loading ? (
        <div className="flex h-24 items-center justify-center"><Spinner /></div>
      ) : view.url ? (
        <div className="space-y-1.5">
          <iframe
            src={view.url}
            title="Website confirmation chat"
            className="block h-[520px] w-full rounded-xl bg-[#efeae2] ring-1 ring-inset ring-slate-200"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
          <a href={view.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 hover:underline">
            <ExternalLink className="h-3 w-3" aria-hidden /> Open the chat in a new tab
          </a>
        </div>
      ) : (
        <p className="text-xs text-rose-600">{view.error || "The chat is unavailable."}</p>
      )}
      {whatsappPhone && <div className="mt-3 border-t border-emerald-100 pt-3">
        <a href={`whatsapp://send?phone=${whatsappPhone}`} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600">
          <MessageCircleReply size={18} aria-hidden /> Open in WhatsApp
        </a>
        <p className="mt-2 text-center text-xs text-slate-500">Reply using your WhatsApp app · <a href={`https://wa.me/${whatsappPhone}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-emerald-700 hover:underline">Open in browser</a></p>
      </div>}
    </div>
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
  const [historyMoreLoading, setHistoryMoreLoading] = useState(false);
  const [historyMoreError, setHistoryMoreError] = useState(null);
  const historyRequest = useRef({ key: "", busy: false });
  const historyKey = `${store}:${order?.customer_id || ""}`;
  historyRequest.current.key = historyKey;

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
    setHistory(null);
    setHistoryError(null);
    setHistoryMoreError(null);
    setHistoryMoreLoading(false);
    historyRequest.current = { key: historyKey, busy: false };
    setHistoryLoading(false);
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

  async function loadOlderOrders() {
    const cursor = history?.page_info?.end_cursor;
    if (!cursor || !history?.page_info?.has_next_page || historyRequest.current.busy) return;
    const key = historyKey;
    const request = historyRequest.current;
    request.busy = true;
    setHistoryMoreLoading(true);
    setHistoryMoreError(null);
    try {
      const next = await API.customerOrders(store, order.customer_id, cursor);
      if (historyRequest.current !== request || historyRequest.current.key !== key) return;
      setHistory((previous) => {
        const seen = new Set((previous?.orders || []).map((item) => item.id));
        return { ...next, orders: [...(previous?.orders || []), ...(next.orders || []).filter((item) => !seen.has(item.id))] };
      });
    } catch (error) {
      if (historyRequest.current === request && historyRequest.current.key === key) setHistoryMoreError(error?.message || "Failed to load older orders");
    } finally {
      if (historyRequest.current === request && historyRequest.current.key === key) {
        historyRequest.current.busy = false;
        setHistoryMoreLoading(false);
      }
    }
  }

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
    <div className="cf-order-details space-y-3">
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

      <div className={`cf-order-details-layout ${order.web_confirmation ? "cf-order-details-with-chat" : ""}`}>
        {order.web_confirmation && <OrderConfirmationChat sessionId={order.web_confirmation.session_id} phone={order.phone || order.customer_phone} />}
        <div className="cf-order-details-panels">
          <div className="cf-order-details-column">
            <div className="cf-order-shipping min-w-0 bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
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

            <div className="cf-order-note min-w-0 bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
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
          <div className="cf-order-details-column">
            {/* Customer order history */}
            <div className="cf-order-history min-w-0 bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
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
                  <div
                    className="cf-customer-history-scroll overflow-auto rounded-lg border border-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    tabIndex={0}
                    role="region"
                    aria-label="Customer orders, newest first. Scroll to see older orders."
                    onScroll={(event) => {
                      const element = event.currentTarget;
                      if (element.scrollTop > 0 && element.scrollHeight - element.clientHeight - element.scrollTop < 40 && !historyMoreError) loadOlderOrders();
                    }}
                  >
                    <table className="cf-customer-history-table w-full text-[11px]">
                      <thead className="sticky top-0 z-10 bg-gray-50 text-left text-[9px] uppercase tracking-wide text-gray-500">
                        <tr>
                          <th className="px-2 py-1.5">Order</th>
                          <th className="px-2 py-1.5">Date</th>
                          <th className="px-2 py-1.5">Fulfillment</th>
                          <th className="px-2 py-1.5">Payment</th>
                          <th className="px-2 py-1.5">Status</th>
                          <th className="px-2 py-1.5 text-right">Total</th>
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
                              <td className="px-2 py-1.5 font-medium whitespace-nowrap">
                                {url ? (
                                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">{h.name || `#${h.number}`}</a>
                                ) : (h.name || `#${h.number}`)}
                                {isCurrent && <span className="ml-1 text-[10px] text-indigo-700 font-semibold">(current)</span>}
                              </td>
                              <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{h.created_at ? new Date(h.created_at).toLocaleDateString() : ""}</td>
                              <td className="px-2 py-1.5"><StatusBadge kind="fulfillment" value={h.fulfillment_status} /></td>
                              <td className="px-2 py-1.5"><StatusBadge kind="financial" value={h.financial_status} /></td>
                              <td className="px-2 py-1.5">
                                {isCancelled
                                  ? <StatusBadge kind="lifecycle" value="cancelled" />
                                  : <span className="text-[10px] text-gray-400">—</span>}
                              </td>
                              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{h.total_price} {h.currency}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              )}
              {(history?.orders || []).length > 5 && <p className="mt-2 text-[11px] text-gray-500">Latest 5 visible · scroll for older orders</p>}
              {historyMoreError && <p className="mt-2 text-xs text-rose-700" role="alert">{historyMoreError}</p>}
              {history?.page_info?.has_next_page && (
                <button type="button" onClick={loadOlderOrders} disabled={historyMoreLoading}
                  className={`mt-2 text-xs font-semibold text-indigo-700 hover:underline disabled:opacity-50 ${BTN_TAP}`}>
                  {historyMoreLoading ? "Loading older orders…" : historyMoreError ? "Retry older orders" : "Load older orders"}
                </button>
              )}
            </div>

            {/* Line items */}
            <div className="cf-order-items min-w-0 bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
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
              <LineItemsGrid order={order} onToast={notify} />
            </div>

          </div>
        </div>
      </div>

      {/* Off-screen label used for the PNG capture. Positioned far off-screen so it
          stays out of the visible layout while still being rendered for html-to-image. */}
      <div style={{ position: "absolute", left: -10000, top: 0, pointerEvents: "none" }} aria-hidden>
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

function LineItemsGrid({ order, onToast }) {
  const items = order.line_items || [];
  if (items.length === 0) return <div className="text-xs text-gray-500">No line items.</div>;

  async function copyVariantId(variantId) {
    const copied = await copyToClipboard(variantId);
    onToast?.(copied ? `Copied variant ID ${variantId}` : "Clipboard blocked", copied ? "success" : "warn");
  }

  return (
    <div className="space-y-2">
      {items.map((li, idx) => {
        const variantId = String(li.variant_id || "").split("/").pop();
        const options = (li.options || []).filter((opt) => opt.value && opt.value !== "Default Title");
        return (
        <article key={li.id || idx} className="cf-product-card flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50/50 p-2.5">
          <div className="flex h-[76.8px] w-[76.8px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            {li.image ? (
              <img src={li.image} alt={li.title || "Product"} loading="lazy" className="h-full w-full object-contain" />
            ) : <Package size={28} className="text-gray-400" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1">
            {variantId ? (
              <button type="button" onClick={() => copyVariantId(variantId)}
                aria-label={`Copy variant ID ${variantId}`} title="Copy variant ID"
                className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-bold text-indigo-700 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${BTN_TAP}`}>
                <span className="shrink-0 text-[10px] uppercase tracking-wide">Variant ID</span>
                <span className="break-all font-mono">{variantId}</span>
                <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden />
              </button>
            ) : <div className="text-xs text-gray-500">Variant ID unavailable</div>}
            {options.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {options.map((opt, optionIdx) => (
                  <span key={`${opt.name}-${optionIdx}`} className="rounded-md border border-indigo-100 bg-white px-2 py-1 text-xs font-bold text-gray-900">
                    {opt.name}: <strong>{opt.value}</strong>
                  </span>
                ))}
              </div>
            ) : li.variant_title && li.variant_title !== "Default Title" ? (
              <div className="mt-1 text-xs font-bold text-gray-900">{li.variant_title}</div>
            ) : null}
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
              <span className="font-semibold text-gray-600">{li.quantity} × {li.unit_price}</span>
              <span className="font-bold text-emerald-700">{(Number(li.unit_price || 0) * Number(li.quantity || 0)).toFixed(2)} {order.currency}</span>
            </div>
          </div>
        </article>
        );
      })}
    </div>
  );
}
