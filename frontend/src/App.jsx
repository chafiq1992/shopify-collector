import React, { useEffect, useRef, useState, Suspense } from "react";
import { CheckCircle, PackageSearch, PackageCheck, XCircle, ChevronLeft, ChevronRight, Search, Settings, Boxes, Printer, LogOut, PackageOpen } from "lucide-react";
import { authFetch, authHeaders, loadAuth, clearAuth } from "./lib/auth";
import { printOrdersLocally } from "./lib/localPrintClient";
import { enqueueOrdersToRelay, isRelayConfigured } from "./lib/printRelayClient";
import { getOrCreatePrintRequest, normalizePrintOrders, submitPrintOrders, withPrintLock } from "./lib/printSubmission.js";
import StorePicker from "./components/StorePicker.jsx";
import { persistStoreSelection, readCurrentStore } from "./lib/stores";
import { DELIVERY_COMPANIES } from "./lib/deliveryCompanies";
import './components/collector.css';

const OrderCard = React.lazy(() => import('./components/OrderCard.jsx'));
const OrderTagEditor = React.lazy(() => import('./components/OrderTagEditor.jsx'));
const PresetSettingsModal = React.lazy(() => import('./components/PresetSettingsModal.jsx'));
const ProfilePickerModal = React.lazy(() => import('./components/ProfilePickerModal.jsx'));

// Types (JSDoc only)
/**
 * @typedef {{ id?: string, image?: string|null, sku?: string|null, title?: string|null, qty: number, status?: ('fulfilled'|'unfulfilled'|'removed'|'unknown') }} Variant
 * @typedef {{ id: string, number: string, customer?: string|null, shipping_city?: string|null, variants: Variant[], note?: string|null, tags: string[], considered_fulfilled?: boolean }} Order
 */

const API = {
  async getOrders(params = {}, signal) {
    const q = new URLSearchParams(params).toString();
    const res = await authFetch(`/api/orders?${q}`, { headers: authHeaders(), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Could not load orders (${res.status}). Please retry.`);
    return data;
  },
  async addTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: 'POST',
      headers: authHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ tag })
    });
    if (!res.ok) throw new Error(`Could not add tag (${res.status}). Please retry.`);
  },
  async removeTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/remove-tag${qs}`, {
      method: 'POST',
      headers: authHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ tag })
    });
    if (!res.ok) throw new Error(`Could not remove tag (${res.status}). Please retry.`);
  },
  async appendNote(orderId, append, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: 'POST',
      headers: authHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ append })
    });
    if (!res.ok) throw new Error(`Could not save order note (${res.status}). Please retry.`);
  },
  async markCollected(orderId, orderNumber, store, metadata = {}) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/collected${qs}`, {
      method: 'POST',
      headers: authHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ order_number: orderNumber, store, metadata })
    });
    if (res.status === 401) throw new Error("Session expired. Please login again.");
    if (!res.ok) throw new Error("Failed to mark collected");
    return res.json();
  },
  async markOut(orderId, orderNumber, store, metadata = {}) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/out${qs}`, {
      method: 'POST',
      headers: authHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ order_number: orderNumber, store, metadata })
    });
    if (res.status === 401) throw new Error("Session expired. Please login again.");
    if (!res.ok) throw new Error("Failed to mark out");
    return res.json();
  },
};

// Profiles configuration
const PROFILES = {
  stock: {
    id: "stock",
    label: "Stock",
  },
};

async function copyTextToClipboard(text){
  const str = String(text ?? "");
  if (!str) return { ok: false, method: "empty" };
  // 1) Modern async clipboard (requires user gesture on iOS Safari)
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(str);
      return { ok: true, method: "clipboard" };
    }
  } catch {}
  // 2) Fallback: execCommand copy (older Safari)
  try {
    const el = document.createElement("textarea");
    el.value = str;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.top = "0";
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, el.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    if (ok) return { ok: true, method: "execCommand" };
  } catch {}
  // 3) Last resort: prompt (user can long-press to copy)
  try {
    window.prompt("Copy this Product ID:", str);
    return { ok: false, method: "prompt" };
  } catch {}
  return { ok: false, method: "failed" };
}

const PENDING_ACTIONS_KEY = "orderCollectorPendingActionsV1";
function loadPendingActions(){
  try {
    const raw = localStorage.getItem(PENDING_ACTIONS_KEY);
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function savePendingActions(arr){
  try { localStorage.setItem(PENDING_ACTIONS_KEY, JSON.stringify(Array.isArray(arr) ? arr : [])); } catch {}
}

function codTagSortValue(order, collectPrefix = "cod"){
  try {
    const prefix = String(collectPrefix || "cod").trim().toLowerCase() || "cod";
    const tags = Array.isArray(order?.tags) ? order.tags : [];
    let best = "";
    for (const rawTag of tags){
      const tag = String(rawTag || "").trim();
      const lower = tag.toLowerCase();
      if (!lower.startsWith(`${prefix} `)) continue;
      const datePart = tag.slice(prefix.length).trim();
      const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(datePart);
      if (!match) continue;
      const [, dd, mm, yy] = match;
      const sortable = `20${yy}-${mm}-${dd}`;
      if (!best || sortable < best) best = sortable;
    }
    return best;
  } catch {
    return "";
  }
}

function sortOrdersByCodTagThenCreated(a, b, collectPrefix = "cod"){
  const aCod = codTagSortValue(a, collectPrefix);
  const bCod = codTagSortValue(b, collectPrefix);
  return (
    String(aCod || "9999-12-31").localeCompare(String(bCod || "9999-12-31")) ||
    String(a?.created_at || "").localeCompare(String(b?.created_at || "")) ||
    String(a?.number || "").localeCompare(String(b?.number || ""))
  );
}

function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

async function withRetries(fn, { attempts = 3, baseDelayMs = 350 } = {}){
  let lastErr = null;
  for (let i = 0; i < attempts; i++){
    try {
      return await fn(i);
    } catch (e){
      lastErr = e;
      // small backoff + jitter
      const wait = baseDelayMs * Math.pow(1.6, i) + Math.floor(Math.random() * 120);
      await sleep(wait);
    }
  }
  throw lastErr || new Error("Request failed");
}

function ActionOverlay({ state }){
  // state: { open, type, variant, title, subtitle, confettiKey }
  if (!state?.open) return null;
  const variant = state.variant || "info"; // success | danger | info
  const isSuccess = variant === "success";
  const isDanger = variant === "danger";
  const bg = isSuccess ? "bg-emerald-600" : isDanger ? "bg-red-600" : "bg-gray-900";
  const ring = isSuccess ? "ring-emerald-200" : isDanger ? "ring-red-200" : "ring-gray-200";
  const anim = isSuccess ? "oc-pop" : isDanger ? "oc-shake" : "oc-pop";
  const Icon = state.type === "print" ? Printer : state.type === "out" ? XCircle : CheckCircle;
  return (
    <div className="fixed inset-0 z-[60] pointer-events-none flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[1px]" />
      {state.type === "collected" && isSuccess && (
        <div key={String(state.confettiKey || 0)} className="oc-confetti" aria-hidden="true">
          {Array.from({ length: 24 }).map((_, i) => (
            <i key={i} className={`oc-confetti-piece oc-c${(i % 6) + 1}`} style={{ left: `${(i * 4) % 100}%`, animationDelay: `${(i % 8) * 0.02}s` }} />
          ))}
        </div>
      )}
      <div className={`relative pointer-events-none w-[92%] max-w-sm rounded-2xl shadow-xl ring-4 ${ring} ${bg} text-white px-5 py-4 ${anim}`}>
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 rounded-xl bg-white/15 p-2 ${state.type === "print" ? "oc-printing" : ""}`}>
            <Icon className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-extrabold tracking-tight">{state.title || ""}</div>
            {state.subtitle ? <div className="text-sm text-white/90 mt-0.5">{state.subtitle}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App(){
  const [auth, setAuth] = useState(() => loadAuth());
  const [agentToday, setAgentToday] = useState({ fulfilledToday: 0, loading: false });
  const [orders, setOrders] = useState([]);
  const [tags, setTags] = useState([]);
  const [apiError, setApiError] = useState(null);
  const [editingTag, setEditingTag] = useState(null);
  const [index, setIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [productIdFilter, setProductIdFilter] = useState("");
  const [showProductFilter, setShowProductFilter] = useState(false);
  const [statusFilter, setStatusFilter] = useState("collect"); // collect|verification|urgent|m3tla
  // COD date filtering is optional; keep it empty by default so collectors see orders immediately.
  const [codDate, setCodDate] = useState(""); // legacy single date (YYYY-MM-DD)
  const [codFromDate, setCodFromDate] = useState(""); // YYYY-MM-DD
  const [codToDate, setCodToDate] = useState(""); // YYYY-MM-DD
  const [tagFilter, setTagFilter] = useState(null);
  const [showDeliveryPicker, setShowDeliveryPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false });
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [excludeOut, setExcludeOut] = useState(false);
  const [excludeStockTags, setExcludeStockTags] = useState(false);
  const [productSortOldToNew, setProductSortOldToNew] = useState(() => {
    try { return localStorage.getItem("orderCollectorProductSortOldToNew") === '1'; } catch { return false; }
  });
  const [selectedOutMap, setSelectedOutMap] = useState({}); // orderId -> Set<variantId>
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfilePicker, setShowProfilePicker] = useState(false);
  const [showConfirm, setShowConfirm] = useState(null); // 'collected' | 'out' | 'print' | null
  const [actionBusy, setActionBusy] = useState(false);
  const [overlay, setOverlay] = useState({ open: false });
  const overlayTimerRef = useRef(null);
  const [pendingCount, setPendingCount] = useState(() => loadPendingActions().length);
  const [store, setStore] = useState(() => {
    return readCurrentStore();
  });
  const [profile, setProfile] = useState(() => {
    try {
      const raw = localStorage.getItem("orderCollectorProfile");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  // Subfilter for Stock profile: 'btis' or 'en att b'
  const [stockFilter, setStockFilter] = useState(() => {
    try {
      return localStorage.getItem("orderCollectorStockFilter") || "btis";
    } catch { return "btis"; }
  });
  const [preset, setPreset] = useState(() => {
    try {
      const raw = localStorage.getItem("orderCollectorPreset");
      return raw ? JSON.parse(raw) : { collectPrefix: "cod", collectExcludeTag: "pc", verificationIncludeTag: "pc" };
    } catch { return { collectPrefix: "cod", collectExcludeTag: "pc", verificationIncludeTag: "pc" }; }
  });
  const [selectedOrderNumbers, setSelectedOrderNumbers] = useState(() => {
    try {
      const raw = localStorage.getItem(`orderCollectorSelected_${store}`);
      if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) return new Set(arr); }
    } catch {}
    return new Set();
  });
  const [printBusy, setPrintBusy] = useState(false);
  const printLockRef = useRef(false);
  const printRequestRef = useRef(null);
  const [printMsg, setPrintMsg] = useState(null);
  const [reloadCounter, setReloadCounter] = useState(0);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorPreset", JSON.stringify(preset)); } catch {}
  }, [preset]);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorProfile", JSON.stringify(profile)); } catch {}
  }, [profile]);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorStockFilter", stockFilter); } catch {}
  }, [stockFilter]);
  useEffect(()=>{
    persistStoreSelection(store);
  }, [store]);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorProductSortOldToNew", productSortOldToNew ? '1' : '0'); } catch {}
  }, [productSortOldToNew]);
  // Persist selected order numbers to survive page changes / app close
  useEffect(()=>{
    try {
      const arr = Array.from(selectedOrderNumbers);
      if (arr.length > 0) {
        localStorage.setItem(`orderCollectorSelected_${store}`, JSON.stringify(arr));
      } else {
        localStorage.removeItem(`orderCollectorSelected_${store}`);
      }
    } catch {}
  }, [selectedOrderNumbers, store]);

  const wsRef = useRef(null);
  const requestIdRef = useRef(0);
  const loadControllerRef = useRef(null);
  const currentOrderIdRef = useRef(null);
  const wsReloadTimerRef = useRef(null);
  const inventoryRefreshRef = useRef(() => {});
  const liveStoreRef = useRef(store);
  liveStoreRef.current = store;
  const recentSelfActionRef = useRef(new Map());
  function handleLogout(){
    clearAuth();
    setAuth(null);
    setAgentToday({ fulfilledToday: 0, loading: false });
  }

  function navigate(path){
    const p = String(path || "/");
    try {
      history.pushState(null, "", p);
      try { window.dispatchEvent(new PopStateEvent("popstate")); } catch {}
    } catch {
      try { location.href = p; } catch {}
    }
  }

  // If an authenticated app API call gets a 401, authFetch() clears storage;
  // this listener makes the UI switch to Login immediately.
  useEffect(() => {
    const onCleared = () => {
      try { setAuth(null); } catch {}
      try { setAgentToday({ fulfilledToday: 0, loading: false }); } catch {}
    };
    try { window.addEventListener("orderCollectorAuthCleared", onCleared); } catch {}
    return () => { try { window.removeEventListener("orderCollectorAuthCleared", onCleared); } catch {} };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadTodaySummary(){
      if (!auth?.access_token) return;
      try {
        if (!cancelled) setAgentToday(prev => ({ ...prev, loading: true }));
        const res = await authFetch("/api/agent/today-summary", { headers: authHeaders({ "Accept": "application/json" }) });
        if (!res.ok) throw new Error("Failed to load summary");
        const js = await res.json();
        if (cancelled) return;
        setAgentToday({
          fulfilledToday: Number(js?.fulfilled_today || 0),
          loading: false,
        });
      } catch {
        if (!cancelled) setAgentToday(prev => ({ ...prev, loading: false }));
      }
    }
    loadTodaySummary();
    return () => { cancelled = true; };
  }, [auth?.access_token, reloadCounter]);

  function vibrate(ms = 20){
    try { if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate(ms); } catch {}
  }

  function computeCodDatesCSV(from, to){
    try {
      if (!from && !to) return "";
      const [fy,fm,fd] = (from || to || "").split("-");
      const [ty,tm,td] = (to || from || "").split("-");
      const start = new Date(parseInt(fy), parseInt(fm)-1, parseInt(fd));
      const end = new Date(parseInt(ty), parseInt(tm)-1, parseInt(td));
      if (isNaN(start.getTime()) || isNaN(end.getTime())) return "";
      const a = start <= end ? start : end;
      const b = start <= end ? end : start;
      const out = [];
      for (let dt = new Date(a); dt <= b; dt.setDate(dt.getDate() + 1)){
        const y = dt.getFullYear();
        const m = String(dt.getMonth()+1).padStart(2,'0');
        const d = String(dt.getDate()).padStart(2,'0');
        out.push(`${d}/${m}/${String(y).slice(-2)}`);
      }
      return out.join(",");
    } catch { return ""; }
  }

  function formatRangeLabel(from, to){
    try {
      if (!from && !to) return "";
      const [fy,fm,fd] = (from || to || "").split("-");
      const [ty,tm,td] = (to || from || "").split("-");
      const a = `${fd}/${fm}/${String(fy).slice(-2)}`;
      const b = `${td}/${tm}/${String(ty).slice(-2)}`;
      return a === b ? a : `${a} — ${b}`;
    } catch { return ""; }
  }

  async function load({ preserveIndex = false } = {}){
    const reqId = ++requestIdRef.current;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const prevOrderId = preserveIndex ? currentOrderIdRef.current : null;
    setLoading(true);
    setApiError(null);
    if (!auth?.access_token){
      setLoading(false);
      setOrders([]);
      return;
    }
    try {
    const codDatesCSV = computeCodDatesCSV(codFromDate, codToDate);
    const usingStockProfile = !!(profile && profile.id === 'stock');
    const isGlobalSearch = (!usingStockProfile && !statusFilter && (search || '').trim() && !showProductFilter);
    // Build base query from Stock subfilter, else empty
    const stockBase = usingStockProfile
      ? (stockFilter === 'btis'
          ? 'status:open fulfillment_status:unfulfilled tag:btis'
          : 'status:open fulfillment_status:unfulfilled tag:"en att b"')
      : '';
    // When excludeStockTags is enabled (non-Stock profile), prepend NOT-tag filters for multiple tags
    const excludedTags = ["btis", "en att b", "en att", "an att b2", "an att b3"];
    const negativeTagQuery = (!usingStockProfile && excludeStockTags && !isGlobalSearch)
      ? excludedTags.map(t => (t.includes(' ') ? ` -tag:"${t}"` : ` -tag:${t}`)).join('')
      : '';
    const baseQuery = (isGlobalSearch ? '' : `${stockBase}${negativeTagQuery}`).trim();
    const isProductMode = !!(productIdFilter || "").trim();
    const applyCodDates = (!usingStockProfile && !isGlobalSearch && (statusFilter === "collect" || statusFilter === "verification" || isProductMode));
    const isBulkFilter = (!usingStockProfile && ((statusFilter === "collect" || statusFilter === "verification") || isProductMode));
    const perPage = isBulkFilter ? 250 : 30;

    // First page
    const effectiveStatusFilter = (usingStockProfile ? "all" : (statusFilter || "all"));
    let data = await API.getOrders({
      limit: perPage,
      status_filter: effectiveStatusFilter,
      tag_filter: isGlobalSearch ? "" : (tagFilter || ""),
      search: search || "",
      product_id: (productIdFilter || ""),
      // Apply date range to all non-Stock filters (collect, verification, product)
      cod_date: "",
      cod_dates: applyCodDates ? (codDatesCSV || "") : "",
      collect_prefix: preset.collectPrefix,
      collect_exclude_tag: preset.collectExcludeTag,
      verification_include_tag: preset.verificationIncludeTag,
      exclude_out: (isGlobalSearch ? false : (usingStockProfile ? false : excludeOut)),
      base_query: baseQuery,
      store,
      // Skip collect ranking when forcing product old->new sort
      disable_collect_ranking: (!!(productIdFilter||"").trim() && productSortOldToNew) ? true : false,
    }, controller.signal);
    if (reqId !== requestIdRef.current) return; // stale response
    if (data && data.error){
      setApiError(String(data.error));
    }
    let ords = data.orders || [];
    let totalCountFromApi = data.totalCount || ords.length;
    // Auto-paginate for bulk filters to load ALL orders
    if (isBulkFilter) {
      try {
        let next = data.nextCursor || null;
        let hasNext = (data.pageInfo || {}).hasNextPage || false;
        const seenCursors = new Set();
        while (hasNext && next) {
          if (seenCursors.has(next)) throw new Error('Order pagination stalled. Please retry.');
          seenCursors.add(next);
          const page = await API.getOrders({
            limit: perPage,
            cursor: next,
            status_filter: (usingStockProfile ? "all" : statusFilter),
            tag_filter: tagFilter || "",
            search: search || "",
            product_id: (productIdFilter || ""),
            // Always carry date range for non-Stock profiles (applies to collect/verification/product modes)
            cod_date: "",
            cod_dates: applyCodDates ? (codDatesCSV || "") : "",
            collect_prefix: preset.collectPrefix,
            collect_exclude_tag: preset.collectExcludeTag,
            verification_include_tag: preset.verificationIncludeTag,
            exclude_out: (usingStockProfile ? false : excludeOut),
            base_query: baseQuery,
            store,
            disable_collect_ranking: (isProductMode && productSortOldToNew) ? true : false,
          }, controller.signal);
          if (reqId !== requestIdRef.current) return; // stale response
          const more = page.orders || [];
          ords = ords.concat(more);
          totalCountFromApi = page.totalCount || totalCountFromApi;
          hasNext = (page.pageInfo || {}).hasNextPage || false;
          next = page.nextCursor || null;
        }
        // Since we loaded all, disable further paging
        data.pageInfo = { hasNextPage: false };
        data.nextCursor = null;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        setApiError(error.message || 'Some orders could not be loaded. Please retry.');
      }
    }
    if (reqId !== requestIdRef.current || controller.signal.aborted) return;
    ords = [...new Map(ords.map(order => [order.id, order])).values()];
    // Client-side exclusion for specific tags when enabled (non-Stock profile)
    if (!usingStockProfile && excludeStockTags){
      const disallowed = new Set(["btis", "en att b", "en att", "an att b2", "an att b3"]);
      ords = ords.filter(o => !((o.tags || []).some(t => disallowed.has(String(t).toLowerCase()))));
    }
    // Client-side product id filter (matches Shopify GID or trailing numeric id)
    const pidFilter = (productIdFilter || "").trim();
    if (pidFilter){
      const isNumeric = /^\d+$/.test(pidFilter);
      const matchesPid = (pid) => {
        if (!pid) return false;
        const s = String(pid);
        if (isNumeric){
          const tail = (s.match(/(\d+)$/) || [])[1] || "";
          return tail === pidFilter;
        }
        return s.toLowerCase().includes(pidFilter.toLowerCase());
      };
      ords = (ords || []).filter(o => (o.variants || []).some(v => matchesPid(v.product_id)));
    }
    // Optional product sort override: old -> new
    if (productSortOldToNew && isProductMode){
      try { ords.sort((a,b) => sortOrdersByCodTagThenCreated(a, b, preset.collectPrefix)); } catch {}
    }
    setOrders(ords);
    setTags(data.tags || []);
    setPageInfo(data.pageInfo || { hasNextPage: false });
    setNextCursor(data.nextCursor || null);
    if (prevOrderId){
      const newIdx = ords.findIndex(o => o && o.id === prevOrderId);
      if (newIdx >= 0){
        setIndex(newIdx);
      } else {
        // Order disappeared (e.g. tag changed). Keep current numeric position clamped to new bounds.
        setIndex(prev => {
          if (!ords.length) return 0;
          return Math.min(prev, ords.length - 1);
        });
      }
    } else {
      setIndex(0);
    }
    setLoading(false);
    setTotalCount(pidFilter ? ords.length : (totalCountFromApi || ords.length));
    } catch (error) {
      if (reqId === requestIdRef.current && error.name !== 'AbortError') setApiError(error.message || 'Could not load orders. Please retry.');
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }

  async function loadMore(){
    if (loadingMore) return;
    if (!pageInfo?.hasNextPage || !nextCursor) return;
    setLoadingMore(true);
    const reqId = requestIdRef.current;
    if (!auth?.access_token){
      setLoadingMore(false);
      return;
    }
    // Recompute filters to ensure consistency
    const codDatesCSV = computeCodDatesCSV(codFromDate, codToDate);
    const usingStockProfile = !!(profile && profile.id === 'stock');
    const isGlobalSearch = (!usingStockProfile && !statusFilter && (search || '').trim() && !showProductFilter);
    const stockBase = usingStockProfile
      ? (stockFilter === 'btis'
          ? 'status:open fulfillment_status:unfulfilled tag:btis'
          : 'status:open fulfillment_status:unfulfilled tag:"en att b"')
      : '';
    const excludedTags = ["btis", "en att b", "en att", "an att b2", "an att b3"];
    const negativeTagQuery = (!usingStockProfile && excludeStockTags && !isGlobalSearch)
      ? excludedTags.map(t => (t.includes(' ') ? ` -tag:"${t}"` : ` -tag:${t}`)).join('')
      : '';
    const baseQuery = (isGlobalSearch ? '' : `${stockBase}${negativeTagQuery}`).trim();
    try {
      const isBulkFilter = (!usingStockProfile && ((statusFilter === "collect" || statusFilter === "verification") || !!(productIdFilter || "").trim()));
      const perPage = isBulkFilter ? 250 : 30;
      const isProductMode = !!(productIdFilter || "").trim();
      const applyCodDates = (!usingStockProfile && !isGlobalSearch && (statusFilter === "collect" || statusFilter === "verification" || isProductMode));
      const effectiveStatusFilter = (usingStockProfile ? "all" : (statusFilter || "all"));
      const data = await API.getOrders({
        limit: perPage,
        cursor: nextCursor,
        status_filter: effectiveStatusFilter,
        tag_filter: isGlobalSearch ? "" : (tagFilter || ""),
        search: search || "",
        product_id: (productIdFilter || ""),
        cod_date: "",
        // Carry date range for non-Stock profiles in product/collect/verification modes
        cod_dates: applyCodDates ? (codDatesCSV || "") : "",
        collect_prefix: preset.collectPrefix,
        collect_exclude_tag: preset.collectExcludeTag,
        verification_include_tag: preset.verificationIncludeTag,
        exclude_out: (isGlobalSearch ? false : (usingStockProfile ? false : excludeOut)),
        base_query: baseQuery,
        store,
        disable_collect_ranking: (isProductMode && productSortOldToNew) ? true : false,
      });
      const more = data.orders || [];
      if (reqId !== requestIdRef.current) return;
      setOrders(prev => {
        const seen = new Set(prev.map(order => order.id));
        const merged = prev.concat(more.filter(order => !seen.has(order.id)));
        if (productSortOldToNew && isProductMode){
          try { merged.sort((a,b) => sortOrdersByCodTagThenCreated(a, b, preset.collectPrefix)); } catch {}
        }
        return merged;
      });
      setPageInfo(data.pageInfo || { hasNextPage: false });
      setNextCursor(data.nextCursor || null);
    } catch (error) {
      if (reqId === requestIdRef.current) setApiError(error.message || 'Could not load more orders. Please retry.');
    } finally { setLoadingMore(false); }
  }

  // One debounced request handles filters and typing; cancel obsolete mobile requests.
  useEffect(() => {
    const t = setTimeout(() => loadRef.current(), 250);
    return () => { clearTimeout(t); loadControllerRef.current?.abort(); ++requestIdRef.current; };
  }, [statusFilter, tagFilter, codFromDate, codToDate, excludeOut, excludeStockTags, profile, stockFilter, store, reloadCounter, search, auth?.access_token]);

  // Keep a ref to the latest load() so the WebSocket handler (mounted once)
  // always uses the freshest filter state — otherwise webhook-triggered reloads
  // refetch with stale closure values (e.g. empty productIdFilter) and silently
  // wipe out an active Product filter.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    let stopped = false;
    let reconnectTimer;
    let reconnectDelay = 1000;
    let connectedBefore = false;
    const pendingIds = new Set();
    function connect() {
      if (stopped) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        reconnectDelay = 1000;
        if (connectedBefore && document.visibilityState !== 'hidden') loadRef.current({ preserveIndex: true });
        connectedBefore = true;
      };
      ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.store && msg.store !== liveStoreRef.current) return;
        if (msg.type === 'inventory.purchase_orders_changed') {
          inventoryRefreshRef.current();
          return;
        }
        if (
          msg.type === "order.tag_added" ||
          msg.type === "order.tag_removed" ||
          msg.type === "order.tag_replaced" ||
          msg.type === "order.note_updated" ||
          msg.type === "order.fulfilled"
        ){
          if (msg.id) pendingIds.add(String(msg.id));
          if (wsReloadTimerRef.current) clearTimeout(wsReloadTimerRef.current);
          wsReloadTimerRef.current = setTimeout(() => {
            wsReloadTimerRef.current = null;
            // Skip reload if every event was for an order we just acted on ourselves.
            try {
              const now = Date.now();
              for (const [k, t] of recentSelfActionRef.current){
                if (now - t > 12000) recentSelfActionRef.current.delete(k);
              }
              if (pendingIds.size > 0){
                let allSelf = true;
                for (const id of pendingIds){
                  if (!recentSelfActionRef.current.has(id)) { allSelf = false; break; }
                }
                pendingIds.clear();
                if (allSelf) return;
              }
            } catch {}
            // Use loadRef so we always reload with the LATEST filter state
            // (productIdFilter, statusFilter, etc.). The WS handler is bound
            // once with `[]` deps, so calling `load` directly would use the
            // stale closure from first render and silently drop active filters.
            try { (loadRef.current || load)({ preserveIndex: true }); } catch {}
          }, 1500);
        }
      } catch {}
    };
      ws.onclose = () => {
        if (stopped) return;
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(30000, reconnectDelay * 2);
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      try { if (wsReloadTimerRef.current) clearTimeout(wsReloadTimerRef.current); } catch {}
      wsRef.current?.close();
    };
  }, []);

  // Keep a ref of the currently visible order id so reloads can preserve position.
  useEffect(() => {
    try { currentOrderIdRef.current = (orders[index] && orders[index].id) || null; } catch {}
  }, [orders, index]);

  const [totalCount, setTotalCount] = useState(0);
  const total = orders.length;
  const current = orders[index] || null;

  // Refresh only the visible order's inventory fields. Keep collection, tags and
  // multi-order selections intact when returning to the app or receiving a PO.
  useEffect(() => {
    if (!current?.id || !auth?.access_token) return;
    let cancelled = false;
    let inFlight = false;
    let refreshAgain = false;
    const controller = new AbortController();
    const orderId = current.id;
    async function refreshInventory() {
      if (cancelled || document.visibilityState === 'hidden') return;
      if (inFlight) { refreshAgain = true; return; }
      inFlight = true;
      try {
        const data = await API.getOrders({ store, search: current.number, status_filter: 'all', limit: 5 }, controller.signal);
        const fresh = (data.orders || []).find(order => order.id === orderId);
        if (cancelled || !fresh) return;
        const byId = new Map((fresh.variants || []).map(variant => [variant.line_item_id || variant.id, variant]));
        setOrders(previous => previous.map(order => order.id !== orderId ? order : {
          ...order,
          variants: order.variants.map(variant => {
            const latest = byId.get(variant.line_item_id || variant.id);
            return latest ? { ...variant, pending_purchase_orders: latest.pending_purchase_orders || [], on_hand_quantity: latest.on_hand_quantity } : variant;
          }),
        }));
      } catch { /* Keep last confirmed stock information while offline. */ }
      finally {
        inFlight = false;
        if (refreshAgain && !cancelled) { refreshAgain = false; refreshInventory(); }
      }
    }
    inventoryRefreshRef.current = refreshInventory;
    const timer = setInterval(refreshInventory, 60000);
    window.addEventListener('focus', refreshInventory);
    window.addEventListener('online', refreshInventory);
    document.addEventListener('visibilitychange', refreshInventory);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      inventoryRefreshRef.current = () => {};
      window.removeEventListener('focus', refreshInventory);
      window.removeEventListener('online', refreshInventory);
      document.removeEventListener('visibilitychange', refreshInventory);
    };
  }, [current?.id, current?.number, store, auth?.access_token]);

  function gotoNext(){
    setIndex(i => {
      const next = (i + 1) % Math.max(1, total || 1);
      // Prefetch when close to end of loaded orders
      try {
        if (orders && orders.length > 0 && (i >= orders.length - 5)){
          if (pageInfo?.hasNextPage && nextCursor) { loadMore(); }
        }
      } catch {}
      return next;
    });
    vibrate(10);
  }
  function gotoPrev(){
    setIndex(i => (i - 1 + Math.max(1, total || 1)) % Math.max(1, total || 1));
    vibrate(10);
  }

  function toggleOrderSelected(orderNumber){
    setSelectedOrderNumbers(prev => {
      const next = new Set(prev);
      if (next.has(orderNumber)) next.delete(orderNumber); else next.add(orderNumber);
      return next;
    });
  }

  async function handlePrintOrders(orderNumbers, requestId){
    return submitPrintOrders({
      orders: orderNumbers, store, requestId,
      relayConfigured: isRelayConfigured(),
      enqueueRelay: enqueueOrdersToRelay,
      printLocal: printOrdersLocally,
    });
  }

  function toggleVariantOut(orderId, variantId){
    setSelectedOutMap(prev => {
      const set = new Set(prev[orderId] || []);
      if (set.has(variantId)) set.delete(variantId); else set.add(variantId);
      return { ...prev, [orderId]: set };
    });
  }

  async function handleMarkCollected(order){
    await runCollected([order], { source: "single", afterSingle: true });
  }

  async function handleMarkOut(order){
    const selected = Array.from(selectedOutMap[order.id] || []);
    if (selected.length === 0){
      alert("Select the missing variant(s) before marking OUT.");
      return;
    }
    const titles = order.variants
      .filter(v => selected.includes(v.id))
      .map(v => v.title || v.sku || "")
      .join(", ");
    await runOut([{ order, titles }], { afterSingle: true });
  }

  // Swipe navigation removed; use buttons below instead

  if (false) {
  // Lightweight routing: render OrderTagger page when path matches
  const currentPath = (typeof location !== 'undefined' ? String(location.pathname || '').trim() : '/');
  if (!auth?.access_token && currentPath !== '/login'){
    return (
      <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
        <LoginPage onSuccess={handleLoginSuccess} />
      </Suspense>
    );
  }
  if (currentPath === '/login'){
    return (
      <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
        <LoginPage onSuccess={handleLoginSuccess} />
      </Suspense>
    );
  }

  try {
    if (currentPath === '/invoices-verifier'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <InvoicesVerifierPage />
        </Suspense>
      );
    }
    if (currentPath === '/order-tagger'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <OrderTaggerPage />
        </Suspense>
      );
    }
    if (currentPath === '/order-lookup'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <OrderLookupPage />
        </Suspense>
      );
    }
    if (currentPath === '/order-browser'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <OrderBrowserPage />
        </Suspense>
      );
    }
    if (currentPath === '/variant-orders'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <VariantOrdersPage />
        </Suspense>
      );
    }
    if (currentPath === '/admin'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <AdminAnalyticsPage />
        </Suspense>
      );
    }
    if (currentPath === '/my-analytics'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <MyAnalyticsPage />
        </Suspense>
      );
    }
    if (currentPath === '/shopify-connect'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <ShopifyConnectPage store={store} setStore={setStore} />
        </Suspense>
      );
    }
  } catch {}
  }

  return (
    <div className="collector-shell">
      <ActionOverlay state={overlay} />
      <header className="collector-header">
        {loading && (
          <div className="progress-track">
            <div className="progress-thumb"></div>
          </div>
        )}
        <div className="collector-topbar">
          <PackageSearch className="hidden h-5 w-5 shrink-0 sm:block" />
          <StorePicker value={store} onChange={(next)=>{
            vibrate(10); setEditingTag(null);
            let saved = [];
            try { const parsed = JSON.parse(localStorage.getItem(`orderCollectorSelected_${next}`) || '[]'); if (Array.isArray(parsed)) saved = parsed; } catch {}
            setSelectedOrderNumbers(new Set(saved)); setSelectedOutMap({}); setOrders([]); setIndex(0); setStore(next);
          }} className="collector-store" />
          <div className="ml-auto flex items-center gap-2">
            <button aria-label="Open Inventory Helper" title="Inventory Helper" onClick={()=>{ vibrate(10); navigate('/inventory-helper'); }} className="p-1.5 rounded-full hover:bg-gray-100">
              <PackageOpen className="w-4 h-4 text-indigo-600" />
            </button>
            {auth?.user && (
              <div className="collector-session hidden sm:flex items-center gap-2 text-xs text-gray-700 border border-gray-200 rounded-lg px-2 py-1 bg-white">
                <span className="font-semibold">{auth.user.email}</span>
                <span className="uppercase text-[10px] px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">{auth.user.role}</span>
                <span className="uppercase text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                  {agentToday.loading ? "All stores today: …" : `All stores today: ${agentToday.fulfilledToday}`}
                </span>
                {pendingCount > 0 && (
                  <span className="uppercase text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                    Sync {pendingCount}
                  </span>
                )}
                <button aria-label="Logout" onClick={()=>{ vibrate(10); handleLogout(); }} className="p-1.5 rounded-full hover:bg-gray-100">
                  <LogOut className="w-4 h-4 text-gray-700" />
                </button>
              </div>
            )}

            <button aria-label="Choose profile" onClick={()=>{ vibrate(10); setShowProfilePicker(true); }} className="p-1.5 rounded-full hover:bg-gray-100">
              <Boxes className={`w-4 h-4 ${profile?.id === 'stock' ? 'text-blue-600' : 'text-gray-700'}`} />
            </button>
            <button aria-label="Settings" onClick={()=>{ vibrate(10); setShowSettings(true); }} className="p-1.5 rounded-full hover:bg-gray-100">
              <Settings className="w-4 h-4" />
            </button>
            <PackageCheck className="w-4 h-4 text-gray-600" />
            <span className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-medium">{loading ? "…" : totalCount}</span>
          </div>
        </div>
        <div className="collector-controls">
          {apiError && (
            <div className="collector-error" role="alert">
              <button type="button" className="collector-error-message" aria-label="Read refresh error" title={apiError} onClick={()=>alert(apiError)}>{apiError}</button>
              <button type="button" onClick={()=>load({preserveIndex:true})}>Retry</button>
            </div>
          )}
          <div className="collector-search">
            <Search className="w-4 h-4 text-gray-500" />
            <input
              value={search}
              onChange={(e)=>setSearch(e.target.value)}
              placeholder="Search order # or SKU"
              aria-label="Search orders"
            />
          </div>
          <div className="collector-filters">
            {profile && profile.id === 'stock' ? (
              <>
                <Chip
                  label="btis"
                  active={stockFilter === 'btis'}
                  onClick={()=>{ setStockFilter('btis'); setShowDatePicker(false); }}
                />
                <Chip
                  label="en att b"
                  active={stockFilter === 'en att b'}
                  onClick={()=>{ setStockFilter('en att b'); setShowDatePicker(false); }}
                />
              </>
            ) : (
              <>
                <Chip
                  label="Collect"
                  active={statusFilter === "collect"}
                  onClick={()=>{
                    setStatusFilter(prev => prev === "collect" ? null : "collect");
                    setShowDatePicker(true);
                    try {
                      const now = new Date();
                      const yyyy = now.getFullYear();
                      const mm = String(now.getMonth()+1).padStart(2,'0');
                      const dd = String(now.getDate()).padStart(2,'0');
                      if (!statusFilter || statusFilter !== 'collect'){
                        setCodDate(`${yyyy}-${mm}-${dd}`);
                        setCodFromDate(`${yyyy}-${mm}-${dd}`);
                        setCodToDate(`${yyyy}-${mm}-${dd}`);
                      }
                    } catch {}
                    // Force refresh even if filters didn't change
                    setReloadCounter(c => c + 1);
                  }}
                />
                <Chip
                  label="Verification"
                  active={statusFilter === "verification"}
                  onClick={()=>{ 
                    setStatusFilter(prev => prev === "verification" ? null : "verification"); 
                    setShowDatePicker(true);
                    try {
                      const now = new Date();
                      const yyyy = now.getFullYear();
                      const mm = String(now.getMonth()+1).padStart(2,'0');
                      const dd = String(now.getDate()).padStart(2,'0');
                      if (!statusFilter || statusFilter !== 'verification'){
                        setCodFromDate(`${yyyy}-${mm}-${dd}`);
                        setCodToDate(`${yyyy}-${mm}-${dd}`);
                      }
                    } catch {}
                  }}
                />
                <Chip
                  label="Urgent"
                  active={statusFilter === "urgent"}
                  onClick={()=>{ setStatusFilter(prev => prev === "urgent" ? null : "urgent"); setShowDatePicker(false); }}
                />
                <Chip
                  label="m3tla"
                  active={statusFilter === "m3tla"}
                  onClick={()=>{ setStatusFilter(prev => prev === "m3tla" ? null : "m3tla"); setShowDatePicker(false); }}
                />
              <Chip
                label="Product"
                active={showProductFilter}
                onClick={()=>{
                  if (showProductFilter){
                    const hadProduct = !!(productIdFilter || '').trim();
                    setShowProductFilter(false);
                    if (hadProduct) setProductIdFilter("");
                    setReloadCounter(c => c + 1);
                  } else {
                    setShowProductFilter(true);
                  }
                }}
              />
              <Chip
                label={tagFilter ? `Delivery: ${tagFilter}` : "Delivery"}
                active={!!tagFilter}
                onClick={()=>{ setShowDeliveryPicker(true); }}
              />
                <div className="flex items-center gap-1">
                  <SmallChip
                    label="Exclude OUT"
                    active={excludeOut}
                    onClick={()=> { setExcludeOut(v => !v); }}
                  />
                  <SmallChip
                    label="Exclude stock tags"
                    title="Exclude btis, en att b, en att, an att b2 and an att b3"
                    active={excludeStockTags}
                    onClick={()=> { setExcludeStockTags(v => !v); }}
                  />
                </div>
              </>
            )}
          </div>
          {/* Date range bar: compact layout without preview pill */}
          {(!profile || profile.id !== 'stock') && (
            <div className="collector-date-bar">
              <div className="collector-date-label">Date range</div>
              <div className="collector-date-inputs">
                <input
                  type="date"
                  value={codFromDate}
                  onChange={(e)=>{ setCodFromDate(e.target.value); }}
                  aria-label="From date"
                />
                <span className="text-[11px] uppercase tracking-wide text-gray-400">to</span>
                <input
                  type="date"
                  value={codToDate}
                  onChange={(e)=>{ setCodToDate(e.target.value); }}
                  aria-label="To date"
                />
                <button
                  className="collector-date-apply"
                  onClick={()=>{ vibrate(15); setReloadCounter(c=>c+1); }}
                >Apply</button>
                <button
                  onClick={()=>{ vibrate(15); setCodFromDate(""); setCodToDate(""); setReloadCounter(c=>c+1); }}
                >Clear</button>
              </div>
            </div>
          )}
          {showProductFilter && (
            <div className="collector-product-filter flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-gray-400">Product ID</span>
              <input
                value={productIdFilter}
                onChange={(e)=>setProductIdFilter(e.target.value)}
                placeholder="Paste Shopify GID or numeric ID"
                className="min-h-11 min-w-0 flex-1 text-base border border-gray-300 rounded-lg px-2 py-1"
              />
              <label className="ml-2 inline-flex items-center gap-1 text-[11px] text-gray-700">
                <input
                  type="checkbox"
                  checked={productSortOldToNew}
                  onChange={(e)=>{ setProductSortOldToNew(e.target.checked); setReloadCounter(c=>c+1); }}
                />
                <span>Sort old → new</span>
              </label>
              <button
                className="text-[11px] text-gray-500 underline"
                onClick={()=>{ setProductIdFilter(""); setShowProductFilter(false); setReloadCounter(c=>c+1); }}
              >Clear</button>
              <button
                className="text-[11px] text-blue-600 underline"
                onClick={()=>{ setReloadCounter(c=>c+1); }}
              >Apply</button>
            </div>
          )}
        </div>
      </header>

      <main className="collector-main">
        <div className="collector-stage">
        {current ? (
          <div className="collector-order-container">
            <Suspense fallback={<div className="text-center py-10 text-gray-500">Loading…</div>}>
            <OrderCard
              key={current.id}
              order={current}
              selectedOut={selectedOutMap[current.id] || new Set()}
              onToggleVariant={(vid)=>toggleVariantOut(current.id, vid)}
              onMarkCollected={()=>handleMarkCollected(current)}
              onMarkOut={()=>handleMarkOut(current)}
              onPrev={gotoPrev}
              onNext={gotoNext}
              position={index + 1}
              total={total}
              selectedForPrint={selectedOrderNumbers.has(current.number)}
              onToggleSelectOrder={()=>toggleOrderSelected(current.number)}
              onEditTag={(order, tag)=>setEditingTag({ order, tag, store })}
              onCopyProductId={async (pid)=>{
                try {
                  if (!pid) return;
                  const r = await copyTextToClipboard(pid);
                  if (r.ok){
                    setPrintMsg(`Copied product id`);
                  } else {
                    setPrintMsg(`Product id shown (tap & hold to copy)`);
                  }
                  try { setTimeout(() => setPrintMsg(null), 1500); } catch {}
                  vibrate(20);
                } catch {}
              }}
            />
            </Suspense>
          </div>
        ) : (
          <div className="text-center py-24 text-gray-500">
            <PackageCheck className="w-10 h-10 mx-auto mb-3"/>
            <p>No orders match these filters.</p>
          </div>
        )}
        </div>
      </main>
      <div className="collector-actions">
        <div className="collector-actions-inner">
          <button type="button" className="collector-nav" aria-label="Prev order" title="Previous order" onClick={()=>{ vibrate(10); gotoPrev(); }}><ChevronLeft size={26}/></button>
          <div className="collector-footer-center">
            {printMsg && <div className="collector-status" role="status" title={printMsg}>{printMsg}</div>}
            <div className="collector-selection-toolbar">
              <strong className="collector-selection-count" aria-live="polite">Selected <span>{selectedOrderNumbers.size}</span></strong>
              <button type="button" className="collector-clear-selection" disabled={!selectedOrderNumbers.size} onClick={()=>setSelectedOrderNumbers(new Set())}>Clear</button>
              <button type="button" className="collector-action-print" disabled={printBusy} aria-label={`Print${selectedOrderNumbers.size ? ` ${selectedOrderNumbers.size} orders` : ''}`} onClick={()=>setShowConfirm('print')}><Printer size={13}/><span>{printBusy ? 'Printing…' : 'Print'}</span></button>
            </div>
            {selectedOrderNumbers.size > 0 && <div className="collector-selection-row">
              <div className="collector-selection" aria-label="Selected orders">
                {Array.from(selectedOrderNumbers).map(number => <button key={number} type="button" onClick={()=>toggleOrderSelected(number)} aria-label={`Deselect order ${number}`}>{number}<span aria-hidden="true">×</span></button>)}
              </div>
            </div>}
            <div className="collector-action-row">
              <button type="button" className="collector-action-collected" disabled={actionBusy} onClick={()=>{ vibrate(10); setShowConfirm('collected'); }}><CheckCircle size={13}/><span>Collected</span></button>
              <button type="button" className="collector-action-out" disabled={actionBusy} onClick={()=>{ vibrate(10); setShowConfirm('out'); }}><XCircle size={13}/><span>OUT</span></button>
            </div>
          </div>
          <button type="button" className="collector-nav" aria-label="Next order" title="Next order" onClick={()=>{ vibrate(10); gotoNext(); }}><ChevronRight size={26}/></button>
        </div>
      </div>
      {editingTag && <Suspense fallback={null}><OrderTagEditor
        key={`${editingTag.store}:${editingTag.order.id}:${editingTag.tag}`}
        {...editingTag}
        suggestions={tags}
        onClose={()=>setEditingTag(null)}
        onReconciled={(orderId, orderTags)=>setOrders(previous=>previous.map(order=>order.id === orderId ? {...order, tags: orderTags} : order))}
        onSaved={(orderId, oldTag, newTag, data)=>{
          recentSelfActionRef.current.set(String(orderId), Date.now());
          setOrders(previous=>previous.map(order=>order.id === orderId ? { ...order, tags: data.tags || [...new Set((order.tags || []).map(tag=>tag === oldTag ? newTag : tag))] } : order));
          setTags(previous=>[...new Set([...previous, newTag])].sort());
          setPrintMsg('Tag updated');
          setTimeout(()=>setPrintMsg(message=>message === 'Tag updated' ? null : message), 2500);
        }}
      /></Suspense>}
      {showConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="collector-confirm-title" className="collector-confirm-dialog flex max-h-[calc(100dvh-2rem)] w-full max-w-sm flex-col rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
            <h3 id="collector-confirm-title" className="shrink-0 text-lg font-semibold mb-2">{showConfirm === 'collected' ? 'Confirm Collected' : showConfirm === 'out' ? 'Confirm OUT' : 'Confirm Print'}</h3>
            {(() => {
              const selected = Array.from(selectedOrderNumbers || []);
              const targets = selected.length > 0 ? orders.filter(o => selected.includes(o.number)) : (current ? [current] : []);
              const targetNumbers = showConfirm === 'print' && selected.length > 0 ? selected : targets.map(o => o.number);
              const missingOut = showConfirm === 'out' ? targets.filter(o => !(selectedOutMap[o.id] && selectedOutMap[o.id].size > 0)).map(o => o.number) : [];
              return (
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain text-sm text-gray-600 mb-4">
                  {showConfirm === 'collected' && (
                    <p>{`Mark ${targetNumbers.length} order${targetNumbers.length>1?'s':''} as Collected and add tag pc?`}</p>
                  )}
                  {showConfirm === 'out' && (
                    <p>{`Append selected OUT titles to note and add tag out for ${targetNumbers.length} order${targetNumbers.length>1?'s':''}?`}</p>
                  )}
                  {showConfirm === 'print' && (
                    <p>{`Print ${targetNumbers.length} order${targetNumbers.length>1?'s':''}?`}</p>
                  )}
                  {showConfirm !== 'print' && selected.length > targets.length && <p className="mt-2 text-xs text-amber-700">{selected.length - targets.length} selected orders outside the current filters will remain selected.</p>}
                  {targetNumbers.length > 0 && (
                    <div className="mt-2 flex gap-1 flex-wrap">
                      {targetNumbers.map(n => (
                        <span key={n} className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">{n}</span>
                      ))}
                    </div>
                  )}
                  {showConfirm === 'out' && missingOut.length > 0 && (
                    <div className="mt-3 text-xs text-red-600">
                      No OUT variants selected for: {missingOut.join(', ')}
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="flex shrink-0 justify-end gap-3">
              <button onClick={()=>setShowConfirm(null)} className="min-h-11 px-4 py-2 rounded-xl border border-gray-300 text-sm font-medium hover:bg-gray-50">Cancel</button>
              <button
                onClick={async ()=>{
                  const selected = Array.from(selectedOrderNumbers || []);
                  const targets = selected.length > 0 ? orders.filter(o => selected.includes(o.number)) : (current ? [current] : []);
                  try {
                    setShowConfirm(null);
                    if (actionBusy) return;
                    if (showConfirm === 'collected'){
                      await runCollected(targets, { source: selected.length > 0 ? "bulk" : "single", afterSingle: selected.length === 0 });
                      if (selected.length > 0) setSelectedOrderNumbers(previous=>new Set([...previous].filter(number=>!targets.some(order=>order.number === number))));
                    } else if (showConfirm === 'out'){
                      // Only process orders with at least one selected variant
                      const processable = targets.filter(o => (selectedOutMap[o.id] && selectedOutMap[o.id].size > 0));
                      const list = processable.map(o => {
                        const sel = Array.from(selectedOutMap[o.id] || []);
                        const titles = (o.variants || [])
                          .filter(v => sel.includes(v.id))
                          .map(v => v.title || v.sku || "")
                          .join(", ");
                        return { order: o, titles };
                      });
                      await runOut(list, { afterSingle: selected.length === 0 });
                      if (selected.length > 0) setSelectedOrderNumbers(previous=>new Set([...previous].filter(number=>!processable.some(order=>order.number === number))));
                    } else if (showConfirm === 'print'){
                      const nums = selected.length > 0 ? selected : targets.map(o => o.number);
                      await runPrint(nums);
                    }
                  } catch (e){
                    setApiError(e?.message || "Action failed");
                    try { alert(e?.message || "Action failed"); } catch {}
                  }
                }}
                className={`min-h-11 px-4 py-2 rounded-xl text-white text-sm font-semibold ${showConfirm === 'collected' ? 'bg-green-600 hover:bg-green-700' : showConfirm === 'out' ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
              >Confirm</button>
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"><div className="rounded-xl bg-white px-4 py-3 shadow">Loading…</div></div>}>
        <PresetSettingsModal
          preset={preset}
          onClose={()=>setShowSettings(false)}
          onSave={(p)=>{ setPreset(p); setShowSettings(false); load(); }}
        />
        </Suspense>
      )}
      {showProfilePicker && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"><div className="rounded-xl bg-white px-4 py-3 shadow">Loading…</div></div>}>
        <ProfilePickerModal
          profiles={PROFILES}
          current={profile}
          onClose={()=>setShowProfilePicker(false)}
          onSelect={(p)=>{ setProfile(p); setShowProfilePicker(false); }}
        />
        </Suspense>
      )}
      {showDeliveryPicker && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={()=>setShowDeliveryPicker(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-gray-200 p-4 mx-4" onClick={(e)=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold">Filter by delivery company</h3>
              {tagFilter && (
                <button
                  className="text-[11px] font-semibold text-red-600 underline"
                  onClick={()=>{ vibrate(10); setTagFilter(null); setShowDeliveryPicker(false); }}
                >Clear</button>
              )}
            </div>
            <p className="text-xs text-gray-500 mb-3">Adds <span className="font-mono">tag:&lt;company&gt;</span> on top of your current filters.</p>
            <div className="grid grid-cols-3 gap-2">
              {DELIVERY_COMPANIES.map(tag => {
                const isActive = tagFilter === tag;
                return (
                  <button
                    key={tag}
                    onClick={()=>{ vibrate(10); setTagFilter(tag); setShowDeliveryPicker(false); }}
                    className={`inline-flex items-center justify-center h-9 px-2 rounded-xl text-xs font-semibold border transition-colors ${isActive ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"}`}
                  >{tag}</button>
                );
              })}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={()=>setShowDeliveryPicker(false)}
                className="px-3 py-1.5 rounded-xl border border-gray-300 text-xs font-medium hover:bg-gray-50"
              >Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function showOverlay(next, ms = 950){
    try { if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current); } catch {}
    setOverlay(next);
    overlayTimerRef.current = setTimeout(() => setOverlay({ open: false }), ms);
  }

  function queueAction(action){
    const arr = loadPendingActions();
    const next = arr.concat([action]);
    savePendingActions(next);
    setPendingCount(next.length);
  }

  async function flushPending(){
    const arr = loadPendingActions();
    if (!arr.length) { setPendingCount(0); return; }
    let remaining = arr.slice();
    // Process oldest first, one-by-one (keeps app smooth and avoids request bursts)
    for (const item of arr){
      try {
        if (item.type === "collected"){
          await withRetries(() => API.markCollected(item.orderId, item.orderNumber, item.store, item.metadata || {}), { attempts: 3 });
        } else if (item.type === "out"){
          await withRetries(() => API.markOut(item.orderId, item.orderNumber, item.store, item.metadata || {}), { attempts: 3 });
        } else {
          // unknown action type
        }
        remaining = remaining.filter(x => x.id !== item.id);
        savePendingActions(remaining);
        setPendingCount(remaining.length);
      } catch {
        // stop on first failure to avoid hammering when offline
        break;
      }
    }
  }

  // Background sync for pending actions (reliable for flaky mobile networks)
  useEffect(() => {
    const onOnline = () => { try { flushPending(); } catch {} };
    try { window.addEventListener("online", onOnline); } catch {}
    const t = setInterval(() => { try { flushPending(); } catch {} }, 15000);
    // initial attempt
    try { flushPending(); } catch {}
    return () => {
      try { window.removeEventListener("online", onOnline); } catch {}
      try { clearInterval(t); } catch {}
    };
  }, [store, auth?.access_token]);

  async function runCollected(targetOrders, { source = "single", afterSingle = false } = {}){
    if (!targetOrders || targetOrders.length === 0) return;
    setActionBusy(true);
    try {
      const now = Date.now();
      for (const o of targetOrders){ try { recentSelfActionRef.current.set(String(o.id), now); } catch {} }
      // sequential for reliability + nicer UX pacing
      for (const o of targetOrders){
        await withRetries(() => API.markCollected(o.id, o.number, store, { source }), { attempts: 3 });
      }
      vibrate(20);
      showOverlay({ open: true, type: "collected", variant: "success", title: "Collected!", subtitle: "Great job — keep going.", confettiKey: Date.now() }, 1050);
      if (afterSingle) gotoNext();
    } catch (e){
      // If auth expired, do not queue: force re-login
      if (String(e?.message || "").toLowerCase().includes("session expired")) {
        try { setAuth(null); } catch {}
        showOverlay({ open: true, type: "collected", variant: "danger", title: "Login required", subtitle: "Your session expired — please login again." }, 1200);
        setApiError("Session expired. Please login again.");
        return;
      }
      // If offline/flaky, queue and keep user moving (backend is idempotent)
      try {
        for (const o of targetOrders){
          queueAction({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, type: "collected", orderId: o.id, orderNumber: o.number, store, metadata: { source }, ts: Date.now() });
        }
      } catch {}
      showOverlay({ open: true, type: "collected", variant: "info", title: "Saved — syncing…", subtitle: "We’ll send it when connection is stable." }, 1100);
      setApiError(e?.message || "Failed to mark collected");
      if (afterSingle) gotoNext();
    } finally {
      setActionBusy(false);
      try { flushPending(); } catch {}
    }
  }

  async function runOut(items, { afterSingle = false } = {}){
    if (!items || items.length === 0) return;
    setActionBusy(true);
    try {
      const now = Date.now();
      for (const it of items){ try { recentSelfActionRef.current.set(String(it.order.id), now); } catch {} }
      for (const it of items){
        await withRetries(() => API.markOut(it.order.id, it.order.number, store, { titles: it.titles }), { attempts: 3 });
        setSelectedOutMap(prev => ({ ...prev, [it.order.id]: new Set() }));
      }
      vibrate(30);
      showOverlay({ open: true, type: "out", variant: "danger", title: "Marked OUT", subtitle: "Noted and tagged." }, 900);
      if (afterSingle) gotoNext();
    } catch (e){
      // If auth expired, do not queue: force re-login
      if (String(e?.message || "").toLowerCase().includes("session expired")) {
        try { setAuth(null); } catch {}
        showOverlay({ open: true, type: "out", variant: "danger", title: "Login required", subtitle: "Your session expired — please login again." }, 1200);
        setApiError("Session expired. Please login again.");
        return;
      }
      try {
        for (const it of items){
          queueAction({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, type: "out", orderId: it.order.id, orderNumber: it.order.number, store, metadata: { titles: it.titles }, ts: Date.now() });
        }
      } catch {}
      showOverlay({ open: true, type: "out", variant: "info", title: "Saved — syncing…", subtitle: "We’ll send it when connection is stable." }, 1100);
      setApiError(e?.message || "Failed to mark out");
      if (afterSingle) gotoNext();
    } finally {
      setActionBusy(false);
      try { flushPending(); } catch {}
    }
  }

  async function runPrint(orderNumbers){
    const list = normalizePrintOrders(orderNumbers);
    if (!list.length) return;
    if (actionBusy) return;
    return withPrintLock(printLockRef, async () => {
      // Keep the token after an uncertain failure so an explicit retry cannot
      // create another job if the first request was already accepted.
      const requestId = getOrCreatePrintRequest(printRequestRef, store, list);
      setActionBusy(true);
      setPrintBusy(true);
      setPrintMsg(null);
      showOverlay({ open: true, type: "print", variant: "info", title: "Sending to printer…", subtitle: `${list.length} order(s).` }, 1600);
      try {
        // The backend updates print tags asynchronously and the agent fetches live
        // overrides, so tagging every order here only delays the queue submission.
        const result = await handlePrintOrders(list, requestId);
        printRequestRef.current = null;
        setPrintMsg(result.message);
        showOverlay({ open: true, type: "print", variant: "success", title: result.title, subtitle: result.message }, 900);
      } catch (e){
        const message = e?.message || "Check the print queue before retrying.";
        setPrintMsg(`Print failed: ${message}`);
        showOverlay({ open: true, type: "print", variant: "danger", title: "Print failed", subtitle: message }, 1600);
      } finally {
        setPrintBusy(false);
        setActionBusy(false);
      }
    });
  }
}

const Chip = React.memo(function Chip({ label, active, onClick }){
  return (
    <button
      onClick={()=>{ try { onClick && onClick(); } finally { try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {} } }}
      className={`collector-chip${active ? ' is-active' : ''}`}
    >
      {label}
    </button>
  );
});

const SmallChip = React.memo(function SmallChip({ label, active, onClick, title }){
  return (
    <button
      onClick={()=>{ try { onClick && onClick(); } finally { try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {} } }}
      title={title}
      className={`collector-chip collector-chip-secondary${active ? ' is-active' : ''}`}
    >
      {label}
    </button>
  );
});
