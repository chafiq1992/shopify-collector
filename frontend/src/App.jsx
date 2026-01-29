import React, { useEffect, useRef, useState, Suspense } from "react";
import { CheckCircle, PackageSearch, PackageCheck, XCircle, ChevronLeft, ChevronRight, Search, Settings, Boxes, Printer, LogOut } from "lucide-react";
import { authFetch, authHeaders, loadAuth, saveAuth, clearAuth } from "./lib/auth";
import { printOrdersLocally } from "./lib/localPrintClient";
import { enqueueOrdersToRelay, isRelayConfigured } from "./lib/printRelayClient";

const OrderCard = React.lazy(() => import('./components/OrderCard.jsx'));
const PresetSettingsModal = React.lazy(() => import('./components/PresetSettingsModal.jsx'));
const ProfilePickerModal = React.lazy(() => import('./components/ProfilePickerModal.jsx'));
const OrderTaggerPage = React.lazy(() => import('./pages/OrderTagger.jsx'));
const OrderLookupPage = React.lazy(() => import('./pages/OrderLookup.jsx'));
const OrderBrowserPage = React.lazy(() => import('./pages/OrderBrowser.jsx'));
const VariantOrdersPage = React.lazy(() => import('./pages/VariantOrders.jsx'));
const LoginPage = React.lazy(() => import('./pages/Login.jsx'));
const AdminAnalyticsPage = React.lazy(() => import('./pages/AdminAnalytics.jsx'));
const ShopifyConnectPage = React.lazy(() => import('./pages/ShopifyConnect.jsx'));
const InvoicesVerifierPage = React.lazy(() => import('./pages/InvoicesVerifier.jsx'));

// Types (JSDoc only)
/**
 * @typedef {{ id?: string, image?: string|null, sku?: string|null, title?: string|null, qty: number, status?: ('fulfilled'|'unfulfilled'|'removed'|'unknown') }} Variant
 * @typedef {{ id: string, number: string, customer?: string|null, shipping_city?: string|null, variants: Variant[], note?: string|null, tags: string[], considered_fulfilled?: boolean }} Order
 */

const API = {
  async getOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await authFetch(`/api/orders?${q}`, { headers: authHeaders() });
    return res.json();
  },
  async addTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await authFetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: 'POST',
      headers: authHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ tag })
    });
  },
  async removeTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await authFetch(`/api/orders/${encodeURIComponent(orderId)}/remove-tag${qs}`, {
      method: 'POST',
      headers: authHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ tag })
    });
  },
  async appendNote(orderId, append, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await authFetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: 'POST',
      headers: authHeaders({'Content-Type':'application/json'}),
      body: JSON.stringify({ append })
    });
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
  // Lightweight client-side routing: force re-render on history changes
  const [routeTick, setRouteTick] = useState(0);
  const [orders, setOrders] = useState([]);
  const [tags, setTags] = useState([]);
  const [apiError, setApiError] = useState(null);
  const [index, setIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [productIdFilter, setProductIdFilter] = useState("");
  const [showProductFilter, setShowProductFilter] = useState(false);
  const [statusFilter, setStatusFilter] = useState("collect"); // collect|verification
  // COD date filtering is optional; keep it empty by default so collectors see orders immediately.
  const [codDate, setCodDate] = useState(""); // legacy single date (YYYY-MM-DD)
  const [codFromDate, setCodFromDate] = useState(""); // YYYY-MM-DD
  const [codToDate, setCodToDate] = useState(""); // YYYY-MM-DD
  const [tagFilter, setTagFilter] = useState(null);
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
    // Prefer URL ?store=..., then sessionStorage; default to irrakids
    try {
      const params = new URLSearchParams(location.search);
      const fromUrl = (params.get('store') || '').trim().toLowerCase();
      if (fromUrl === 'irrakids' || fromUrl === 'irranova') return fromUrl;
    } catch {}
    try {
      const fromSession = (sessionStorage.getItem('orderCollectorStore') || '').trim().toLowerCase();
      if (fromSession === 'irrakids' || fromSession === 'irranova') return fromSession;
    } catch {}
    return 'irrakids';
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
  const [selectedOrderNumbers, setSelectedOrderNumbers] = useState(() => new Set());
  const [printBusy, setPrintBusy] = useState(false);
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
    // Persist store per-tab and reflect in URL to keep it stable across reloads
    try { sessionStorage.setItem('orderCollectorStore', store); } catch {}
    try {
      const params = new URLSearchParams(location.search);
      const prev = (params.get('store') || '').trim().toLowerCase();
      if (prev !== store){
        params.set('store', store);
        const qs = params.toString();
        const nextUrl = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash || ''}`;
        history.replaceState(null, '', nextUrl);
      }
    } catch {}
  }, [store]);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorProductSortOldToNew", productSortOldToNew ? '1' : '0'); } catch {}
  }, [productSortOldToNew]);

  const wsRef = useRef(null);
  const requestIdRef = useRef(0);
  function handleLoginSuccess(data){
    // Login page controls remember-me storage; this is a harmless fallback
    saveAuth(data);
    setAuth(data);
  }
  function handleLogout(){
    clearAuth();
    setAuth(null);
  }

  function navigate(path){
    const p = String(path || "/");
    try {
      history.pushState(null, "", p);
      // pushState doesn't emit popstate; we force a re-render
      setRouteTick(x => x + 1);
    } catch {
      try { location.href = p; } catch {}
    }
  }

  useEffect(() => {
    const onPop = () => { try { setRouteTick(x => x + 1); } catch {} };
    try { window.addEventListener("popstate", onPop); } catch {}
    return () => { try { window.removeEventListener("popstate", onPop); } catch {} };
  }, []);

  // If any API call gets a 401, authFetch() clears storage; this listener makes the UI switch to Login immediately.
  useEffect(() => {
    const onCleared = () => {
      try { setAuth(null); } catch {}
    };
    try { window.addEventListener("orderCollectorAuthCleared", onCleared); } catch {}
    return () => { try { window.removeEventListener("orderCollectorAuthCleared", onCleared); } catch {} };
  }, []);

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

  async function load(){
    const reqId = ++requestIdRef.current;
    setLoading(true);
    setApiError(null);
    if (!auth?.access_token){
      setLoading(false);
      setOrders([]);
      return;
    }
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
    });
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
        while (hasNext && next) {
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
          });
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
      } catch {}
    }
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
      try { ords.sort((a,b) => String(a.created_at||"").localeCompare(String(b.created_at||""))); } catch {}
    }
    setOrders(ords);
    setTags(data.tags || []);
    setPageInfo(data.pageInfo || { hasNextPage: false });
    setNextCursor(data.nextCursor || null);
    setIndex(0);
    setLoading(false);
    setTotalCount(pidFilter ? ords.length : (totalCountFromApi || ords.length));
  }

  async function loadMore(){
    if (loadingMore) return;
    if (!pageInfo?.hasNextPage || !nextCursor) return;
    setLoadingMore(true);
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
      setOrders(prev => {
        const merged = prev.concat(more);
        if (productSortOldToNew && isProductMode){
          try { merged.sort((a,b) => String(a.created_at||"").localeCompare(String(b.created_at||""))); } catch {}
        }
        return merged;
      });
      setPageInfo(data.pageInfo || { hasNextPage: false });
      setNextCursor(data.nextCursor || null);
    } catch {}
    setLoadingMore(false);
  }

  useEffect(() => { load(); }, [statusFilter, tagFilter, codFromDate, codToDate, excludeOut, excludeStockTags, profile, stockFilter, store, reloadCounter, auth?.access_token]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => load(), 350);
    return () => clearTimeout(t);
  }, [search, auth?.access_token]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (
          msg.type === "order.tag_added" ||
          msg.type === "order.tag_removed" ||
          msg.type === "order.note_updated" ||
          msg.type === "order.fulfilled"
        ){
          load();
        }
      } catch {}
    };
    ws.onclose = () => {
      setTimeout(() => { if (wsRef.current === ws) wsRef.current = null; }, 1000);
    };
    return () => ws.close();
  }, []);

  const [totalCount, setTotalCount] = useState(0);
  const total = orders.length;
  const current = orders[index] || null;

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

  async function handlePrintOrders(orderNumbers){
    const list = orderNumbers.map(n => String(n));
    setPrintBusy(true);
    setPrintMsg(null);
    // Prefer relay path first so the agent can ensure customer info (Irranova)
    try {
      const r = await enqueueOrdersToRelay(list, 1, undefined, store);
      setPrintBusy(false);
      if (r.ok){
        setPrintMsg(`Queued ${r.queued ?? list.length} order(s) for printing`);
        return;
      }
      // Fall through to local on non-ok
    } catch {}
    // Fallback: direct local printing (no pre-checks)
    const res = await printOrdersLocally(list, 1, store);
    setPrintBusy(false);
    if (res.ok){
      setPrintMsg(`Printed ${res.results?.length ?? list.length} order(s)`);
    } else {
      setPrintMsg(`Print failed: ${res.error || 'unknown error'}`);
    }
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
    if (currentPath === '/shopify-connect'){
      return (
        <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center text-gray-600">Loading…</div>}>
          <ShopifyConnectPage store={store} setStore={setStore} />
        </Suspense>
      );
    }
  } catch {}

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900 overflow-hidden">
      <ActionOverlay state={overlay} />
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
        {loading && (
          <div className="progress-track">
            <div className="progress-thumb"></div>
          </div>
        )}
        <div className="max-w-5xl mx-auto px-4 py-1 flex items-center gap-2">
          <PackageSearch className="w-5 h-5" />
          <div className="ml-3 inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white">
            <button
              onClick={()=>setStore('irrakids')}
              onMouseDown={()=>vibrate(10)}
              className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === 'irrakids' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >Irrakids</button>
            <button
              onClick={()=>setStore('irranova')}
              onMouseDown={()=>vibrate(10)}
              className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === 'irranova' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >Irranova</button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {auth?.user && (
              <div className="hidden sm:flex items-center gap-2 text-xs text-gray-700 border border-gray-200 rounded-lg px-2 py-1 bg-white">
                <span className="font-semibold">{auth.user.email}</span>
                <span className="uppercase text-[10px] px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">{auth.user.role}</span>
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
            {auth?.user?.role === 'admin' && (
              <>
                <button
                  onClick={()=>navigate('/admin')}
                  className="text-xs px-3 py-1 rounded-full border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                >
                  Admin
                </button>
                <button
                  onClick={()=>navigate('/invoices-verifier')}
                  className="text-xs px-3 py-1 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                >
                  Invoices
                </button>
                <button
                  onClick={()=>navigate('/shopify-connect')}
                  className="text-xs px-3 py-1 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                >
                  Shopify Connect
                </button>
              </>
            )}
            {auth?.user && (
              <button
                onClick={()=>navigate('/variant-orders')}
                className="text-xs px-3 py-1 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
              >
                Products
              </button>
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
        <div className="max-w-5xl mx-auto px-4 pb-1 flex flex-col gap-1">
          {apiError && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-3 py-2 text-xs">
              <div className="font-semibold">Backend error</div>
              <div className="mt-0.5">{apiError}</div>
              <div className="mt-1 text-[11px] text-amber-800/80">
                Usually this means Shopify credentials are missing in Cloud Run (set <span className="font-mono">SHOPIFY_PASSWORD</span> or <span className="font-mono">IRRAKIDS_SHOPIFY_PASSWORD</span>).
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1">
            <Search className="w-4 h-4 text-gray-500" />
            <input
              value={search}
              onChange={(e)=>setSearch(e.target.value)}
              placeholder="Search order # or SKU"
              className="bg-transparent outline-none w-full text-xs"
            />
          </div>
          <div className="flex items-center gap-1 overflow-x-auto flex-nowrap -mx-4 px-4">
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
                <div className="flex items-center gap-1">
                  <SmallChip
                    label="Exclude OUT"
                    active={excludeOut}
                    onClick={()=> { setExcludeOut(v => !v); }}
                  />
                  <SmallChip
                    label="Exclude btis/en att/an att b2/b3"
                    active={excludeStockTags}
                    onClick={()=> { setExcludeStockTags(v => !v); }}
                  />
                </div>
              </>
            )}
          </div>
          {/* Date range bar: compact layout without preview pill */}
          {(!profile || profile.id !== 'stock') && (
            <div className="bg-white border border-gray-200 rounded-xl px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-gray-400">Date range</span>
                <input
                  type="date"
                  value={codFromDate}
                  onChange={(e)=>{ setCodFromDate(e.target.value); }}
                  className="text-xs border border-gray-300 rounded px-2 py-0.5"
                />
                <span className="text-[11px] uppercase tracking-wide text-gray-400">to</span>
                <input
                  type="date"
                  value={codToDate}
                  onChange={(e)=>{ setCodToDate(e.target.value); }}
                  className="text-xs border border-gray-300 rounded px-2 py-0.5"
                />
              </div>
              <div className="mt-2 flex items-center gap-3">
                <button
                  className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold bg-blue-600 text-white active:scale-[.98]"
                  onClick={()=>{ vibrate(15); setReloadCounter(c=>c+1); }}
                >Apply</button>
                <button
                  className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold bg-gray-200 text-gray-800 active:scale-[.98]"
                  onClick={()=>{ vibrate(15); setCodFromDate(""); setCodToDate(""); setReloadCounter(c=>c+1); }}
                >Clear</button>
              </div>
            </div>
          )}
          {showProductFilter && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-gray-400">Product ID</span>
              <input
                value={productIdFilter}
                onChange={(e)=>setProductIdFilter(e.target.value)}
                placeholder="Paste Shopify GID or numeric ID"
                className="text-xs border border-gray-300 rounded px-2 py-0.5 w-60"
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

      <main className="max-w-5xl mx-auto px-4 py-4 pb-48">
        {current ? (
          <div className="relative">
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
      </main>
      <div className="fixed bottom-0 inset-x-0 z-40 border-t border-gray-200 bg-white/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="grid grid-cols-1 gap-2 mb-2">
            <button onClick={()=>setShowConfirm('print')} disabled={printBusy} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl text-white text-sm bg-indigo-600 hover:bg-indigo-700 active:scale-[.98] shadow-sm disabled:opacity-60">
              <Printer className="w-4 h-4"/> <span className="font-semibold">{printBusy ? 'Printing…' : `Print${selectedOrderNumbers.size ? ` (${selectedOrderNumbers.size})` : ''}`}</span>
            </button>
            {printMsg && <div className="text-sm text-gray-600 text-center">{printMsg}</div>}
            {selectedOrderNumbers.size > 0 && (
              <div className="text-xs text-gray-700 text-center">
                <span className="font-medium">Selected:</span> {selectedOrderNumbers.size} order{selectedOrderNumbers.size>1?'s':''}
                <div className="mt-1 overflow-x-auto whitespace-nowrap px-1">
                  {Array.from(selectedOrderNumbers).map(n => (
                    <span key={n} className="inline-block mr-1 px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">{n}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={actionBusy} onClick={()=>{ try { vibrate(10); } catch {}; setShowConfirm('collected'); }} className="touch-manipulation flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl text-white text-sm bg-green-600 hover:bg-green-700 active:scale-[.98] shadow-sm disabled:opacity-60 disabled:cursor-not-allowed">
              <CheckCircle className="w-4 h-4"/> <span className="font-semibold">{`Collected${selectedOrderNumbers.size ? ` (${selectedOrderNumbers.size})` : ''}`}</span>
            </button>
            <button type="button" disabled={actionBusy} onClick={()=>{ try { vibrate(10); } catch {}; setShowConfirm('out'); }} className="touch-manipulation flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl text-white text-sm bg-red-600 hover:bg-red-700 active:scale-[.98] shadow-sm disabled:opacity-60 disabled:cursor-not-allowed">
              <XCircle className="w-4 h-4"/> <span className="font-semibold">{`OUT${selectedOrderNumbers.size ? ` (${selectedOrderNumbers.size})` : ''}`}</span>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <button onClick={()=>{ try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {}; gotoPrev(); }} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl bg-gray-200 text-gray-900 text-sm hover:bg-gray-300 active:scale-[.98] shadow-sm">
              <ChevronLeft className="w-4 h-4"/> <span className="font-semibold">Prev order</span>
            </button>
            <button onClick={()=>{ try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {}; gotoNext(); }} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl bg-gray-900 text-white text-sm hover:bg:black active:scale-[.98] shadow-sm">
              <ChevronRight className="w-4 h-4"/> <span className="font-semibold">Next order</span>
            </button>
          </div>
        </div>
      </div>
      {showConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
            <h3 className="text-lg font-semibold mb-2">{showConfirm === 'collected' ? 'Confirm Collected' : showConfirm === 'out' ? 'Confirm OUT' : 'Confirm Print'}</h3>
            {(() => {
              const selected = Array.from(selectedOrderNumbers || []);
              const targets = selected.length > 0 ? orders.filter(o => selected.includes(o.number)) : (current ? [current] : []);
              const targetNumbers = targets.map(o => o.number);
              const missingOut = showConfirm === 'out' ? targets.filter(o => !(selectedOutMap[o.id] && selectedOutMap[o.id].size > 0)).map(o => o.number) : [];
              return (
                <div className="text-sm text-gray-600 mb-4">
                  {showConfirm === 'collected' && (
                    <p>{`Mark ${targetNumbers.length} order${targetNumbers.length>1?'s':''} as Collected and add tag pc?`}</p>
                  )}
                  {showConfirm === 'out' && (
                    <p>{`Append selected OUT titles to note and add tag out for ${targetNumbers.length} order${targetNumbers.length>1?'s':''}?`}</p>
                  )}
                  {showConfirm === 'print' && (
                    <p>{`Print ${targetNumbers.length} order${targetNumbers.length>1?'s':''}?`}</p>
                  )}
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
            <div className="flex justify-end gap-3">
              <button onClick={()=>setShowConfirm(null)} className="px-4 py-2 rounded-xl border border-gray-300 text-sm font-medium hover:bg-gray-50">Cancel</button>
              <button
                onClick={async ()=>{
                  const selected = Array.from(selectedOrderNumbers || []);
                  const targets = selected.length > 0 ? orders.filter(o => selected.includes(o.number)) : (current ? [current] : []);
                  try {
                    setShowConfirm(null);
                    if (actionBusy) return;
                    if (showConfirm === 'collected'){
                      await runCollected(targets, { source: selected.length > 0 ? "bulk" : "single", afterSingle: selected.length === 0 });
                      if (selected.length > 0) setSelectedOrderNumbers(new Set());
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
                      if (selected.length > 0) setSelectedOrderNumbers(new Set());
                    } else if (showConfirm === 'print'){
                      const nums = targets.map(o => o.number);
                      await runPrint(nums);
                    }
                  } catch (e){
                    setApiError(e?.message || "Action failed");
                    try { alert(e?.message || "Action failed"); } catch {}
                  }
                }}
                className={`px-4 py-2 rounded-xl text-white text-sm font-semibold ${showConfirm === 'collected' ? 'bg-green-600 hover:bg-green-700' : showConfirm === 'out' ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
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
    const list = (orderNumbers || []).map(n => String(n));
    if (!list.length) return;
    if (actionBusy) return;
    setActionBusy(true);
    showOverlay({ open: true, type: "print", variant: "info", title: "Printing…", subtitle: "Sending to printer." }, 1600);
    try {
      // Trigger webhook by tagging before printing so overrides get cached
      try {
        for (const o of orders.filter(x => list.includes(x.number))){
          await withRetries(() => API.addTag(o.id, "cod print", store), { attempts: 2, baseDelayMs: 250 });
        }
      } catch {}
      // Small delay to allow webhook to reach the server (best-effort)
      try { await sleep(400); } catch {}
      await handlePrintOrders(list);
      showOverlay({ open: true, type: "print", variant: "success", title: "Queued to print", subtitle: "Nice — moving fast." }, 900);
    } catch (e){
      showOverlay({ open: true, type: "print", variant: "danger", title: "Print failed", subtitle: e?.message || "Try again." }, 1200);
    } finally {
      setActionBusy(false);
    }
  }
}

const Chip = React.memo(function Chip({ label, active, onClick }){
  return (
    <button
      onClick={()=>{ try { onClick && onClick(); } finally { try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {} } }}
      className={`inline-flex items-center justify-center h-8 min-w-[92px] px-3 rounded-full text-xs border font-medium transition-colors ${active ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  );
});

const SmallChip = React.memo(function SmallChip({ label, active, onClick }){
  return (
    <button
      onClick={()=>{ try { onClick && onClick(); } finally { try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {} } }}
      className={`inline-flex items-center justify-center h-7 min-w-[120px] px-3 rounded-full text-[11px] border font-medium transition-colors ${active ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  );
});

 
