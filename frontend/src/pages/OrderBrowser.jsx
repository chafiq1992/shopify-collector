import React, { useEffect, useRef, useState } from "react";
import { authHeaders } from "../lib/auth";

// Minimal API client reused across pages
const API = {
  async getOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`/api/orders?${q}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch orders (${res.status})`);
    return res.json();
  },
  async addTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: "POST",
      headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ tag }),
    });
    if (!res.ok) throw new Error("Failed to add tag");
  },
  async appendNote(orderId, append, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
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
    const res = await fetch(`/api/overrides?${params}`, { headers: authHeaders() });
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
      <div className="mb-3 rounded-2xl border border-gray-200 bg-white p-3 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-semibold">Orders</div>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
              {totalCount || 0} total
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-50 text-gray-700 border border-gray-200">
              Showing {startIndex}-{endIndex}
            </span>
          </div>
          <div className="mt-1 text-xs text-gray-600 flex gap-2 flex-wrap">
            {store && <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">Store: <span className="font-semibold">{store}</span></span>}
            {fulfillmentFilter !== 'all' && (
              <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">
                Fulfillment: <span className="font-semibold">{fulfillmentFilter}</span>
              </span>
            )}
            {(tagFilter || "").trim() && (
              <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">
                Tag: <span className="font-semibold">{tagFilter.trim()}</span>
              </span>
            )}
            {(search || "").trim() && (
              <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">
                Search: <span className="font-semibold">{search.trim()}</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">
            <span className="mr-2">Per page</span>
            <select
              value={perPage}
              onChange={(e)=>setPerPage(parseInt(e.target.value || "25", 10))}
              className="text-xs border border-gray-300 rounded-lg px-2 py-1 bg-white"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
        </div>
      </div>
    );
  }

  function PaginationBar(){
    return (
      <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-3 py-2">
        <div className="text-xs text-gray-600">
          Page <span className="font-semibold">{pageIndex + 1}</span>
          {totalCount > 0 && (
            <span className="text-gray-400">{` · ${totalCount} total`}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={gotoPrevPage}
            disabled={!hasPrevPage || loading || pagingBusy}
            className="px-3 py-1.5 rounded-full text-xs font-semibold border border-gray-300 bg-white disabled:opacity-50 hover:bg-gray-50"
          >
            Prev
          </button>
          <button
            onClick={gotoNextPage}
            disabled={!hasNextPage || loading || pagingBusy}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-gray-900 text-white disabled:opacity-50"
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
      <div className="border border-gray-200 rounded-2xl bg-white overflow-hidden shadow-sm">
        <button onClick={()=>toggleExpanded(order)} className="w-full px-4 py-3 text-left flex items-start gap-3 hover:bg-gray-50/60">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-extrabold tracking-tight">{num}</span>
                  <span className="text-xs text-gray-500">{formatDate(order.created_at)}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold">
                    {formatMoney(order.total_price)}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-gray-800 truncate">
                  <span className="font-semibold">{order.customer || ov?.customer?.displayName || "—"}</span>
                  {shippingCity && <span className="text-gray-400">{` · ${shippingCity}`}</span>}
                  {fulfilledOn && <span className="text-gray-400">{` · Fulfilled ${fulfilledOn}`}</span>}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-extrabold ${pay.cls}`}>
                  {pay.label}
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold ${fulf.cls}`}>
                  {fulf.label}
                </span>
              </div>
            </div>

            <div className="mt-2 flex gap-1.5 flex-wrap">
              {(order.tags || []).map(t => (
                <span
                  key={t}
                  className={`text-[11px] px-2 py-0.5 rounded-full font-extrabold tracking-wide ${tagPillClasses(t)}`}
                  title={t}
                >
                  {t}
                </span>
              ))}
            </div>

            <div className={`mt-2 rounded-xl border px-3 py-2 ${noteText ? "bg-amber-50 border-amber-200" : "bg-gray-50 border-gray-200"}`}>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Note</div>
              <div className={`text-sm whitespace-pre-wrap ${noteText ? "text-amber-950" : "text-gray-500"}`}>
                {noteText ? noteText : "No note"}
              </div>
            </div>
          </div>
          <div className="text-xs font-semibold text-blue-700 shrink-0 pt-1">{expanded ? "Hide" : "Show"}</div>
        </button>
        {expanded && (
          <div className="px-4 pb-4">
            {/* Shipping / Customer */}
            <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
              <div className="text-sm font-semibold mb-1">Shipping</div>
              <div className="text-sm text-gray-700">
                {renderShipping(ov)}
              </div>
              {(() => {
                const phone =
                  (ov && ov.shippingAddress && ov.shippingAddress.phone) ||
                  (ov && ov.customer && ov.customer.phone) ||
                  (ov && ov.phone) ||
                  null;
                return phone ? <div className="text-sm text-gray-600 mt-1">Phone: {phone}</div> : null;
              })()}
            </div>
            {/* Items */}
            <div className="mt-3 grid sm:grid-cols-2 md:grid-cols-3 gap-2">
              {(order.variants || []).map((v, idx) => (
                <div key={order.id + ":" + idx} className="flex gap-2 items-center border border-gray-200 rounded-lg p-2">
                  <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden flex items-center justify-center">
                    {v.image ? (
                      <img src={v.image} alt="" className="w-full h-full object-cover"/>
                    ) : (
                      <div className="text-[10px] text-gray-400">No image</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{v.title || v.sku || "Item"}</div>
                    <div className="text-[11px] text-gray-500">Qty: {v.qty}</div>
                    <div className={`text-[11px] ${v.status === 'fulfilled' ? 'text-green-700' : v.status === 'unfulfilled' ? 'text-amber-700' : 'text-gray-500'}`}>
                      {v.status || "unknown"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* Note + Tag */}
            <div className="mt-4 grid md:grid-cols-2 gap-3">
              <div>
                <div className="text-sm font-semibold mb-1">Add note</div>
                <div className="flex gap-2">
                  <input
                    value={noteAppendById[order.id] || ""}
                    onChange={(e)=>setNoteAppendById(prev => ({ ...prev, [order.id]: e.target.value }))}
                    placeholder="Append text to note"
                    className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1"
                  />
                  <button onClick={()=>handleAppendNote(order)} className="text-sm px-3 py-1 rounded-lg bg-gray-900 text-white">Add</button>
                </div>
                {order.note && (
                  <div className="mt-2 text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-2 max-h-40 overflow-auto">
                    {order.note}
                  </div>
                )}
              </div>
              <div>
                <div className="text-sm font-semibold mb-1">Add tag</div>
                <div className="flex gap-2">
                  <input
                    value={newTagById[order.id] || ""}
                    onChange={(e)=>setNewTagById(prev => ({ ...prev, [order.id]: e.target.value }))}
                    placeholder="Enter tag"
                    className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1"
                    list={`tag-suggestions-${order.id}`}
                  />
                  <button onClick={()=>handleAddTag(order)} className="text-sm px-3 py-1 rounded-lg bg-blue-600 text-white">Add</button>
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
      <main className="max-w-5xl mx-auto px-4 py-4">
        {error && (
          <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}
        <SummaryBar />
        <div className="flex flex-col gap-3">
          {orders.map(o => <OrderRow key={o.id} order={o} />)}
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


