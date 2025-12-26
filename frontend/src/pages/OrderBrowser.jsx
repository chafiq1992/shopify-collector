import React, { useEffect, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";

// Minimal API client reused across pages
const API = {
  async getOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await authFetch(`/api/orders?${q}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch orders (${res.status})`);
    return res.json();
  },
  async addTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: "POST",
      headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ tag }),
    });
    if (!res.ok) throw new Error("Failed to add tag");
  },
  async appendNote(orderId, append, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: "POST",
      headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ append }),
    });
    if (!res.ok) throw new Error("Failed to update note");
  },
  async fetchOverrides(numbersCSV, store, forceLive = false) {
    const params = new URLSearchParams({
      orders: numbersCSV,
      store: store || "",
      force_live: forceLive ? "true" : "false",
    }).toString();
    const res = await authFetch(`/api/overrides?${params}`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to fetch overrides");
    return res.json();
  }
};

export default function OrderBrowser(){
  // Persist store choice in session and URL param like other pages
  const [store, setStore] = useState(() => {
    try {
      const params = new URLSearchParams(location.search);
      const s = (params.get("store") || sessionStorage.getItem("orderCollectorStore") || "irrakids").trim().toLowerCase();
      return (s === "irranova" ? "irranova" : "irrakids");
    } catch { return "irrakids"; }
  });
  useEffect(() => {
    try { sessionStorage.setItem("orderCollectorStore", store); } catch {}
    try {
      const params = new URLSearchParams(location.search);
      if ((params.get("store") || "").trim().toLowerCase() !== store){
        params.set("store", store);
        history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
      }
    } catch {}
  }, [store]);

  // Filters
  const [tagFilter, setTagFilter] = useState("");
  const [fulfillmentFilter, setFulfillmentFilter] = useState("all"); // all | unfulfilled | fulfilled
  const [showFilters, setShowFilters] = useState(true);
  const [search, setSearch] = useState(""); // optional order # search
  const [fulfilledFrom, setFulfilledFrom] = useState("");
  const [fulfilledTo, setFulfilledTo] = useState("");
  const [financialStatus, setFinancialStatus] = useState("all"); // all | paid | pending

  // Data
  // Pagination model: cache pages client-side (Shopify-like Prev/Next UX without losing "Prev")
  const [pages, setPages] = useState([]); // [{ orders, nextCursor, hasNextPage }]
  const [pageIndex, setPageIndex] = useState(0);
  const [perPage, setPerPage] = useState(25);
  const orders = pages[pageIndex]?.orders || [];
  const [availableTags, setAvailableTags] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pagingBusy, setPagingBusy] = useState(false);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  // Expanded rows and per-order inputs
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [noteAppendById, setNoteAppendById] = useState({});
  const [newTagById, setNewTagById] = useState({});
  const [overridesByNumber, setOverridesByNumber] = useState({});

  function updateOrderInPages(orderId, updater){
    setPages(prev => prev.map(p => ({
      ...p,
      orders: (p.orders || []).map(o => {
        if (o.id !== orderId) return o;
        try { return updater(o); } catch { return o; }
      })
    })));
  }

  function buildBaseQuery(){
    let q = "";
    if (fulfillmentFilter === "unfulfilled"){
      q += " fulfillment_status:unfulfilled";
    } else if (fulfillmentFilter === "fulfilled"){
      q += " fulfillment_status:fulfilled";
    }
    // If a fulfillment date range is set, ensure we only query fulfilled orders
    if ((fulfilledFrom || fulfilledTo) && !q.includes("fulfillment_status:fulfilled")){
      q += " fulfillment_status:fulfilled";
    }
    return q.trim();
  }

  async function loadFirstPage(){
    const reqId = ++requestIdRef.current;
    setPages([]);
    setPageIndex(0);
    setLoading(true);
    setError(null);
    try {
      const data = await API.getOrders({
        limit: perPage,
        status_filter: "all",
        tag_filter: (tagFilter || "").trim(),
        search: (search || "").trim(),
        base_query: buildBaseQuery(),
        fulfillment_from: (fulfilledFrom || "").trim(),
        fulfillment_to: (fulfilledTo || "").trim(),
        financial_status: (financialStatus === "all" ? "" : financialStatus),
        store,
      });
      if (reqId !== requestIdRef.current) return;
      const firstOrders = data.orders || [];
      setAvailableTags(data.tags || []);
      setTotalCount(Number(data.totalCount || firstOrders.length || 0));
      setPages([{
        orders: firstOrders,
        nextCursor: data.nextCursor || null,
        hasNextPage: !!(data.pageInfo || {}).hasNextPage,
      }]);
    } catch (e){
      setError(e?.message || "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }

  async function gotoNextPage(){
    // If next page is already cached, just navigate.
    if (pageIndex < pages.length - 1){
      setPageIndex(i => i + 1);
      return;
    }
    const current = pages[pageIndex];
    if (!current?.hasNextPage || !current?.nextCursor) return;
    if (pagingBusy) return;
    setPagingBusy(true);
    try {
      const data = await API.getOrders({
        limit: perPage,
        cursor: current.nextCursor,
        status_filter: "all",
        tag_filter: (tagFilter || "").trim(),
        search: (search || "").trim(),
        base_query: buildBaseQuery(),
        fulfillment_from: (fulfilledFrom || "").trim(),
        fulfillment_to: (fulfilledTo || "").trim(),
        financial_status: (financialStatus === "all" ? "" : financialStatus),
        store,
      });
      const nextOrders = data.orders || [];
      setAvailableTags(data.tags || []);
      setTotalCount(Number(data.totalCount || totalCount || nextOrders.length || 0));
      setPages(prev => prev.concat([{
        orders: nextOrders,
        nextCursor: data.nextCursor || null,
        hasNextPage: !!(data.pageInfo || {}).hasNextPage,
      }]));
      setPageIndex(i => i + 1);
    } catch (e){
      // Best-effort: keep user on current page
    } finally {
      setPagingBusy(false);
    }
  }

  useEffect(() => {
    // Debounce search a bit
    const t = setTimeout(() => { loadFirstPage(); }, 350);
    return () => clearTimeout(t);
  }, [tagFilter, fulfillmentFilter, store, search, fulfilledFrom, fulfilledTo, perPage]);
  useEffect(() => {
    // Reload when financial status changes
    const t = setTimeout(() => { loadFirstPage(); }, 0);
    return () => clearTimeout(t);
  }, [financialStatus]);

  function toggleExpanded(order){
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(order.id)) next.delete(order.id); else next.add(order.id);
      return next;
    });
    // Fetch overrides when expanding
    try {
      const num = String(order.number || "").replace(/^#/, "");
      API.fetchOverrides(num, store, true).then(js => {
        const ov = (js.overrides || {})[num] || null;
        setOverridesByNumber(prev => ({ ...prev, [num]: ov }));
      }).catch(()=>{});
    } catch {}
  }

  async function handleAddTag(order){
    const tag = String(newTagById[order.id] || "").trim();
    if (!tag) return;
    try {
      await API.addTag(order.id, tag, store);
      setNewTagById(prev => ({ ...prev, [order.id]: "" }));
      // Optimistic update
      updateOrderInPages(order.id, (o) => ({ ...o, tags: Array.from(new Set([...(o.tags || []), tag])) }));
    } catch (e){
      alert(e?.message || "Failed to add tag");
    }
  }

  async function handleAppendNote(order){
    const append = String(noteAppendById[order.id] || "").trim();
    if (!append) return;
    try {
      await API.appendNote(order.id, append, store);
      setNoteAppendById(prev => ({ ...prev, [order.id]: "" }));
      updateOrderInPages(order.id, (o) => ({ ...o, note: ((o.note || "").trim() ? `${(o.note || "").trim()}\n${append}` : append) }));
    } catch (e){
      alert(e?.message || "Failed to update note");
    }
  }

  function gotoPrevPage(){
    setPageIndex(i => Math.max(0, i - 1));
  }

  const currentPage = pages[pageIndex] || { orders: [], hasNextPage: false, nextCursor: null };
  const hasPrevPage = pageIndex > 0;
  const hasNextPage = !!currentPage.hasNextPage;
  const startIndex = totalCount > 0 ? (pageIndex * perPage + 1) : (orders.length ? 1 : 0);
  const endIndex = totalCount > 0
    ? Math.min(totalCount, pageIndex * perPage + orders.length)
    : (pageIndex * perPage + orders.length);

  function SummaryBar(){
    return (
      <div className="mb-6 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-gray-900">Orders</h2>
            <span className="text-gray-500 font-medium text-sm bg-gray-100 px-2.5 py-0.5 rounded-full">{totalCount} total</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-600 shadow-sm">
              Showing {startIndex}-{endIndex}
            </span>
            {store && <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 border border-indigo-100 text-indigo-700">Store: {store}</span>}
            {fulfillmentFilter !== 'all' && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 border border-amber-100 text-amber-700 capitalize">
                {fulfillmentFilter}
              </span>
            )}
            {(tagFilter || "").trim() && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-50 border border-purple-100 text-purple-700">
                Tag: {tagFilter.trim()}
              </span>
            )}
            {(search || "").trim() && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 border border-blue-100 text-blue-700">
                Search: {search.trim()}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 bg-white p-1.5 rounded-xl border border-gray-200 shadow-sm">
          <label className="text-xs font-medium text-gray-500 pl-2">
            Rows:
          </label>
          <select
            value={perPage}
            onChange={(e)=>setPerPage(parseInt(e.target.value || "25", 10))}
            className="text-xs font-bold bg-transparent border-none outline-none text-gray-900 pr-1 cursor-pointer"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>
    );
  }

  function PaginationBar(){
    if (totalCount === 0) return null;
    return (
      <div className="mt-8 flex items-center justify-between border-t border-gray-200 pt-6">
        <div className="text-xs text-gray-500 font-medium">
          Page <span className="text-gray-900 font-bold">{pageIndex + 1}</span> of <span className="text-gray-900 font-bold">{Math.ceil(totalCount / perPage) || 1}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={gotoPrevPage}
            disabled={!hasPrevPage || loading || pagingBusy}
            className="px-4 py-2 rounded-full text-xs font-bold border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm active:scale-95"
          >
            Previous
          </button>
          <button
            onClick={gotoNextPage}
            disabled={!hasNextPage || loading || pagingBusy}
            className="px-4 py-2 rounded-full text-xs font-bold bg-gray-900 text-white hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm active:scale-95"
          >
            Next
          </button>
        </div>
      </div>
    );
  }

  function paymentPill(financialStatus){
    const raw = String(financialStatus || "").trim();
    const k = raw.toLowerCase().replace(/\s+/g, "_");
    const label = raw
      ? raw.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      : "—";
    if (k.includes("paid")) return { label: "Paid", cls: "bg-emerald-600 text-white" };
    if (k.includes("pending") || k.includes("authorized")) return { label: "Pending", cls: "bg-amber-500 text-white" };
    if (k.includes("partially")) return { label: "Partial", cls: "bg-blue-600 text-white" };
    if (k.includes("refunded") || k.includes("voided")) return { label: "Refunded", cls: "bg-gray-700 text-white" };
    return { label: label, cls: "bg-gray-200 text-gray-800 border border-gray-300" };
  }

  function fulfillmentPill(order){
    const fulfilled = !!(order?.considered_fulfilled || order?.fulfilled_at);
    return fulfilled
      ? { label: "Fulfilled", cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" }
      : { label: "Unfulfilled", cls: "bg-amber-50 text-amber-800 border border-amber-200" };
  }

  function tagPillClasses(tag){
    const t = String(tag || "").trim();
    const tl = t.toLowerCase();
    if (tl === "out") return "bg-red-600 text-white";
    if (tl === "pc" || tl === "collected") return "bg-emerald-600 text-white";
    if (tl === "urgent") return "bg-amber-500 text-white";
    if (tl === "btis") return "bg-purple-600 text-white";
    if (tl === "en att b") return "bg-orange-600 text-white";
    if (tl === "cod print") return "bg-indigo-600 text-white";
    // Deterministic palette for everything else
    const palettes = [
      "bg-sky-50 text-sky-700 border border-sky-200",
      "bg-teal-50 text-teal-700 border border-teal-200",
      "bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200",
      "bg-lime-50 text-lime-800 border border-lime-200",
      "bg-rose-50 text-rose-700 border border-rose-200",
      "bg-slate-50 text-slate-700 border border-slate-200",
    ];
    let h = 0;
    for (let i = 0; i < tl.length; i++) h = ((h << 5) - h + tl.charCodeAt(i)) | 0;
    const idx = Math.abs(h) % palettes.length;
    return palettes[idx];
  }

  function SkeletonRow(){
    return (
      <div className="border border-gray-100 rounded-2xl bg-white p-4 shadow-sm animate-pulse">
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <div className="h-5 w-24 bg-gray-200 rounded-md"></div>
              <div className="h-4 w-32 bg-gray-100 rounded-md"></div>
            </div>
            <div className="h-4 w-48 bg-gray-100 rounded-md mb-2"></div>
            <div className="flex gap-2 mt-2">
              <div className="h-5 w-16 bg-gray-100 rounded-full"></div>
              <div className="h-5 w-16 bg-gray-100 rounded-full"></div>
            </div>
          </div>
          <div className="flex gap-2">
             <div className="h-6 w-20 bg-gray-200 rounded-full"></div>
             <div className="h-6 w-20 bg-gray-200 rounded-full"></div>
          </div>
        </div>
      </div>
    );
  }

  function OrderRow({ order }){
    const expanded = expandedIds.has(order.id);
    const num = String(order.number || "");
    const numKey = num.replace(/^#/, "");
    const ov = overridesByNumber[numKey];
    const fulfilledOn = order.fulfilled_at ? formatDate(order.fulfilled_at) : null;
    const shippingCity = (ov && ov.shippingAddress && ov.shippingAddress.city) || order.shipping_city || null;
    const pay = paymentPill(order.financial_status);
    const fulf = fulfillmentPill(order);
    const noteText = String(order.note || "").trim();

    return (
      <div className={`border transition-all duration-200 rounded-2xl bg-white overflow-hidden ${expanded ? "border-blue-200 ring-4 ring-blue-50/50 shadow-md" : "border-gray-100 hover:border-gray-200 hover:shadow-md"}`}>
        <button onClick={()=>toggleExpanded(order)} className="w-full px-5 py-4 text-left flex items-start gap-4 group">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-base font-extrabold tracking-tight text-gray-900">{num}</span>
                  <span className="text-xs font-medium text-gray-400">{formatDate(order.created_at)}</span>
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 font-bold tabular-nums">
                    {formatMoney(order.total_price)}
                  </span>
                </div>
                <div className="mt-1 text-sm text-gray-600 truncate flex items-center gap-2">
                  <span className="font-semibold text-gray-800">{order.customer || ov?.customer?.displayName || "—"}</span>
                  {shippingCity && <span className="text-gray-400 font-light">{`· ${shippingCity}`}</span>}
                  {fulfilledOn && <span className="text-gray-400 font-light">{`· Fulfilled ${fulfilledOn}`}</span>}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] uppercase tracking-wider font-bold shadow-sm ${pay.cls}`}>
                  {pay.label}
                </span>
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] uppercase tracking-wider font-bold shadow-sm ${fulf.cls}`}>
                  {fulf.label}
                </span>
              </div>
            </div>

            <div className="mt-3 flex gap-1.5 flex-wrap">
              {(order.tags || []).map(t => (
                <span
                  key={t}
                  className={`text-[10px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wide border shadow-sm ${tagPillClasses(t)}`}
                  title={t}
                >
                  {t}
                </span>
              ))}
            </div>

            <div className={`mt-3 rounded-xl border px-4 py-3 transition-colors ${noteText ? "bg-amber-50/50 border-amber-100" : "bg-gray-50/50 border-gray-100"}`}>
              <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold mb-1.5">Note</div>
              <div className={`text-sm whitespace-pre-wrap leading-relaxed ${noteText ? "text-gray-800 font-medium" : "text-gray-400 italic"}`}>
                {noteText ? noteText : "No note attached"}
              </div>
            </div>
          </div>
          <div className="text-xs font-bold text-gray-300 group-hover:text-blue-600 transition-colors pt-1">
            {expanded ? "Hide" : "Edit"}
          </div>
        </button>
        {expanded && (
          <div className="px-5 pb-5 pt-1 border-t border-gray-100 bg-gray-50/30">
            {/* Shipping / Customer */}
            <div className="rounded-xl border border-gray-200 p-4 bg-white shadow-sm mb-4">
              <div className="text-xs uppercase tracking-widest font-bold text-gray-400 mb-2">Shipping Details</div>
              <div className="text-sm text-gray-800 leading-relaxed font-medium">
                {renderShipping(ov)}
              </div>
              {(() => {
                const phone =
                  (ov && ov.shippingAddress && ov.shippingAddress.phone) ||
                  (ov && ov.customer && ov.customer.phone) ||
                  (ov && ov.phone) ||
                  null;
                return phone ? <div className="text-sm text-gray-500 mt-2 flex items-center gap-2"><span>📞</span> {phone}</div> : null;
              })()}
            </div>
            {/* Items */}
            <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
              {(order.variants || []).map((v, idx) => (
                <div key={order.id + ":" + idx} className="group flex gap-3 items-center border border-gray-200 bg-white rounded-xl p-2.5 hover:border-blue-300 hover:shadow-sm transition-all">
                  <div className="w-14 h-14 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center shrink-0 border border-gray-100">
                    {v.image ? (
                      <img src={v.image} alt="" loading="lazy" className="w-full h-full object-cover transition-transform group-hover:scale-105"/>
                    ) : (
                      <div className="text-[10px] text-gray-400 font-medium">No img</div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-gray-900 truncate" title={v.title || v.sku}>{v.title || v.sku || "Item"}</div>
                    <div className="text-[11px] text-gray-500 font-medium mt-0.5">Qty: <span className="text-gray-900">{v.qty}</span></div>
                    <div className={`text-[10px] uppercase tracking-wide font-bold mt-1 ${v.status === 'fulfilled' ? 'text-emerald-600' : v.status === 'unfulfilled' ? 'text-amber-600' : 'text-gray-400'}`}>
                      {v.status || "unknown"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* Note + Tag */}
            <div className="mt-5 grid md:grid-cols-2 gap-4">
              <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                <div className="text-xs uppercase tracking-widest font-bold text-gray-400 mb-2">Append Note</div>
                <div className="flex gap-2">
                  <input
                    value={noteAppendById[order.id] || ""}
                    onChange={(e)=>setNoteAppendById(prev => ({ ...prev, [order.id]: e.target.value }))}
                    placeholder="Type to append..."
                    className="flex-1 text-sm border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:bg-white transition-all"
                  />
                  <button onClick={()=>handleAppendNote(order)} className="text-xs font-bold px-4 py-2 rounded-lg bg-gray-900 text-white hover:bg-black active:scale-95 transition-all">Add</button>
                </div>
                {order.note && (
                  <div className="mt-3 text-xs text-gray-600 whitespace-pre-wrap bg-amber-50/50 border border-amber-100 rounded-lg p-3 max-h-32 overflow-auto font-medium">
                    {order.note}
                  </div>
                )}
              </div>
              <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                <div className="text-xs uppercase tracking-widest font-bold text-gray-400 mb-2">Add Tag</div>
                <div className="flex gap-2">
                  <input
                    value={newTagById[order.id] || ""}
                    onChange={(e)=>setNewTagById(prev => ({ ...prev, [order.id]: e.target.value }))}
                    placeholder="New tag..."
                    className="flex-1 text-sm border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:bg-white transition-all"
                    list={`tag-suggestions-${order.id}`}
                  />
                  <button onClick={()=>handleAddTag(order)} className="text-xs font-bold px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition-all">Add</button>
                </div>
                <datalist id={`tag-suggestions-${order.id}`}>
                  {(availableTags || []).slice(0,50).map(t => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-gray-200">
        {loading && (
          <div className="progress-track">
            <div className="progress-thumb"></div>
          </div>
        )}
        <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-2">
          <div className="font-semibold">Order Browser</div>
          <div className="ml-3 inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white">
            <button
              onClick={()=>setStore('irrakids')}
              className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === 'irrakids' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >Irrakids</button>
            <button
              onClick={()=>setStore('irranova')}
              className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === 'irranova' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >Irranova</button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={()=>setShowFilters(v=>!v)} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">
              {showFilters ? "Hide filters" : "Show filters"}
            </button>
          </div>
        </div>
        {showFilters && (
          <div className="max-w-5xl mx-auto px-4 pb-3">
            <div className="grid md:grid-cols-3 gap-3">
              <div className="bg-gray-100 rounded-xl px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Search</div>
                <input
                  value={search}
                  onChange={(e)=>setSearch(e.target.value)}
                  placeholder="Search order #"
                  className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white"
                />
              </div>
              <div className="bg-gray-100 rounded-xl px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Tag</div>
                <div className="flex items-center gap-2">
                  <input
                    value={tagFilter}
                    onChange={(e)=>setTagFilter(e.target.value)}
                    placeholder="Filter by tag"
                    className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white"
                    list="all-tag-suggestions"
                  />
                  <button onClick={()=>setTagFilter("")} className="text-xs px-2 py-1 rounded-lg border border-gray-300 bg-white">Clear</button>
                </div>
                <datalist id="all-tag-suggestions">
                  {(availableTags || []).slice(0,100).map(t => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
              <div className="bg-gray-100 rounded-xl px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Fulfillment</div>
                <div className="flex items-center gap-2">
                  <FilterChip label="All" active={fulfillmentFilter === 'all'} onClick={()=>setFulfillmentFilter('all')} />
                  <FilterChip label="Unfulfilled" active={fulfillmentFilter === 'unfulfilled'} onClick={()=>setFulfillmentFilter('unfulfilled')} />
                  <FilterChip label="Fulfilled" active={fulfillmentFilter === 'fulfilled'} onClick={()=>setFulfillmentFilter('fulfilled')} />
                </div>
              </div>
              <div className="bg-gray-100 rounded-xl px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Payment</div>
                <div className="flex items-center gap-2">
                  <FilterChip label="All" active={financialStatus === 'all'} onClick={()=>setFinancialStatus('all')} />
                  <FilterChip label="Paid" active={financialStatus === 'paid'} onClick={()=>setFinancialStatus('paid')} />
                  <FilterChip label="Pending" active={financialStatus === 'pending'} onClick={()=>setFinancialStatus('pending')} />
                </div>
              </div>
              <div className="bg-gray-100 rounded-xl px-3 py-2 md:col-span-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Fulfilled between</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="date"
                    value={fulfilledFrom}
                    onChange={(e)=>setFulfilledFrom(e.target.value)}
                    className="text-sm border border-gray-300 rounded px-2 py-1"
                  />
                  <span className="text-[11px] uppercase tracking-wide text-gray-400">to</span>
                  <input
                    type="date"
                    value={fulfilledTo}
                    onChange={(e)=>setFulfilledTo(e.target.value)}
                    className="text-sm border border-gray-300 rounded px-2 py-1"
                  />
                  <button
                    className="ml-2 inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold bg-blue-600 text-white active:scale-[.98]"
                    onClick={()=>loadFirstPage()}
                  >Apply</button>
                  <button
                    className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold bg-gray-200 text-gray-800 active:scale-[.98]"
                    onClick={()=>{
                      setFulfilledFrom("");
                      setFulfilledTo("");
                      // Ensure reload uses cleared values
                      setTimeout(() => { try { loadFirstPage(); } catch {} }, 0);
                    }}
                  >Clear</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">
        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3 font-medium flex items-center gap-2">
            <span>⚠️</span> {error}
          </div>
        )}
        <SummaryBar />
        <div className="flex flex-col gap-4">
          {loading && orders.length === 0 ? (
            Array.from({length: 5}).map((_, i) => <SkeletonRow key={i} />)
          ) : (
            orders.map(o => <OrderRow key={o.id} order={o} />)
          )}
          {!loading && orders.length === 0 && (
            <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-gray-300">
              <div className="text-gray-400 mb-2 text-4xl">📦</div>
              <div className="text-gray-500 font-medium">No orders found</div>
              <div className="text-sm text-gray-400 mt-1">Try adjusting your filters</div>
            </div>
          )}
        </div>
        <PaginationBar />
      </main>
    </div>
  );
}

function FilterChip({ label, active, onClick }){
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center justify-center h-7 px-3 rounded-full text-[11px] border font-medium transition-colors ${active ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  );
}

function formatMoney(v){
  try {
    const n = Number(v || 0);
    return `${n.toFixed(2)}`;
  } catch {
    return String(v || "");
  }
}

function formatDate(iso){
  try {
    const d = new Date(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch { return ""; }
}

function renderShipping(ov){
  if (!ov) return <span className="text-gray-500">No shipping info</span>;
  const shp = ov.shippingAddress || {};
  const lines = [
    (shp.name || "").trim(),
    (shp.address1 || "").trim(),
    (shp.address2 || "").trim(),
    [shp.city, shp.province, shp.zip].filter(Boolean).join(" "),
    (shp.country || "").trim(),
  ].filter(Boolean);
  if (lines.length === 0) return <span className="text-gray-500">No shipping info</span>;
  return (
    <div className="text-sm text-gray-700 whitespace-pre-line">
      {lines.join("\n")}
    </div>
  );
}



