import React, { useEffect, useRef, useState, Suspense } from "react";
import { CheckCircle, PackageSearch, PackageCheck, XCircle, ChevronLeft, ChevronRight, Search, Settings, Boxes, Printer } from "lucide-react";
import { printOrdersLocally } from "./lib/localPrintClient";
import { enqueueOrdersToRelay, isRelayConfigured } from "./lib/printRelayClient";

const OrderCard = React.lazy(() => import('./components/OrderCard.jsx'));
const PresetSettingsModal = React.lazy(() => import('./components/PresetSettingsModal.jsx'));
const ProfilePickerModal = React.lazy(() => import('./components/ProfilePickerModal.jsx'));

// Types (JSDoc only)
/**
 * @typedef {{ id?: string, image?: string|null, sku?: string|null, title?: string|null, qty: number, status?: ('fulfilled'|'unfulfilled'|'removed'|'unknown') }} Variant
 * @typedef {{ id: string, number: string, customer?: string|null, shipping_city?: string|null, variants: Variant[], note?: string|null, tags: string[], considered_fulfilled?: boolean }} Order
 */

const API = {
  async getOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`/api/orders?${q}`);
    return res.json();
  },
  async addTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ tag })
    });
  },
  async removeTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/remove-tag${qs}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ tag })
    });
  },
  async appendNote(orderId, append, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ append })
    });
  }
};

// Profiles configuration
const PROFILES = {
  stock: {
    id: "stock",
    label: "Stock",
  },
};

export default function App(){
  const [orders, setOrders] = useState([]);
  const [tags, setTags] = useState([]);
  const [index, setIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [productIdFilter, setProductIdFilter] = useState("");
  const [showProductFilter, setShowProductFilter] = useState(false);
  const [statusFilter, setStatusFilter] = useState("collect"); // collect|verification
  const [codDate, setCodDate] = useState(() => {
    try {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth()+1).padStart(2,'0');
      const dd = String(now.getDate()).padStart(2,'0');
      return `${yyyy}-${mm}-${dd}`;
    } catch { return ""; }
  }); // legacy single date (YYYY-MM-DD)
  const [codFromDate, setCodFromDate] = useState(() => {
    try {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth()+1).padStart(2,'0');
      const dd = String(now.getDate()).padStart(2,'0');
      return `${yyyy}-${mm}-${dd}`;
    } catch { return ""; }
  }); // YYYY-MM-DD
  const [codToDate, setCodToDate] = useState(() => {
    try {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth()+1).padStart(2,'0');
      const dd = String(now.getDate()).padStart(2,'0');
      return `${yyyy}-${mm}-${dd}`;
    } catch { return ""; }
  }); // YYYY-MM-DD
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
      cod_dates: (isGlobalSearch || usingStockProfile) ? "" : (codDatesCSV || ""),
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
            cod_dates: (!usingStockProfile && !isGlobalSearch) ? (codDatesCSV || "") : "",
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
        cod_dates: (!usingStockProfile && !isGlobalSearch) ? (codDatesCSV || "") : "",
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

  useEffect(() => { load(); }, [statusFilter, tagFilter, codFromDate, codToDate, excludeOut, excludeStockTags, profile, stockFilter, store, reloadCounter]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => load(), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "order.tag_added" || msg.type === "order.tag_removed" || msg.type === "order.note_updated"){
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
    await API.addTag(order.id, "pc", store);
    vibrate(20);
    gotoNext();
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
    await Promise.all([
      API.appendNote(order.id, `OUT: ${titles}`, store),
      API.addTag(order.id, "out", store),
    ]);
    setSelectedOutMap(prev => ({ ...prev, [order.id]: new Set() }));
    vibrate(30);
    gotoNext();
  }

  // Swipe navigation removed; use buttons below instead

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900 overflow-hidden">
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
                  await navigator.clipboard.writeText(String(pid));
                  setPrintMsg(`Copied product id`);
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
            <button onClick={()=>setShowConfirm('collected')} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl text-white text-sm bg-green-600 hover:bg-green-700 active:scale-[.98] shadow-sm">
              <CheckCircle className="w-4 h-4"/> <span className="font-semibold">{`Collected${selectedOrderNumbers.size ? ` (${selectedOrderNumbers.size})` : ''}`}</span>
            </button>
            <button onClick={()=>setShowConfirm('out')} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl text-white text-sm bg-red-600 hover:bg-red-700 active:scale-[.98] shadow-sm">
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
                  setShowConfirm(null);
                  if (showConfirm === 'collected'){
                    await Promise.all(targets.map(o => API.addTag(o.id, 'pc', store)));
                    vibrate(20);
                    if (selected.length === 0) gotoNext();
                    if (selected.length > 0) setSelectedOrderNumbers(new Set());
                  } else if (showConfirm === 'out'){
                    // Only process orders with at least one selected variant
                    const processable = targets.filter(o => (selectedOutMap[o.id] && selectedOutMap[o.id].size > 0));
                    for (const o of processable){
                      const sel = Array.from(selectedOutMap[o.id] || []);
                      const titles = (o.variants || [])
                        .filter(v => sel.includes(v.id))
                        .map(v => v.title || v.sku || "")
                        .join(", ");
                      await Promise.all([
                        API.appendNote(o.id, `OUT: ${titles}`, store),
                        API.addTag(o.id, 'out', store),
                      ]);
                      setSelectedOutMap(prev => ({ ...prev, [o.id]: new Set() }));
                    }
                    vibrate(30);
                    if (selected.length === 0) gotoNext();
                    if (selected.length > 0) setSelectedOrderNumbers(new Set());
                  } else if (showConfirm === 'print'){
                    // Trigger webhook by tagging before printing so overrides get cached
                    try {
                      await Promise.all(targets.map(o => API.addTag(o.id, 'cod print', store)));
                    } catch {}
                    // Small delay to allow webhook to reach the server (best-effort)
                    try { await new Promise(r => setTimeout(r, 400)); } catch {}
                    const nums = targets.map(o => o.number);
                    await handlePrintOrders(nums);
                    // Keep selections after printing; they will be cleared upon Collected
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

 
