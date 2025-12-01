import React, { useEffect, useMemo, useRef, useState } from "react";

// Minimal API client reused across pages
const API = {
  async getOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`/api/orders?${q}`);
    if (!res.ok) throw new Error(`Failed to fetch orders (${res.status})`);
    return res.json();
  },
  async addTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ tag }),
    });
    if (!res.ok) throw new Error("Failed to add tag");
  },
  async appendNote(orderId, append, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
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
    const res = await fetch(`/api/overrides?${params}`);
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

  // Data
  const [orders, setOrders] = useState([]);
  const [availableTags, setAvailableTags] = useState([]);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false });
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  // Expanded rows and per-order inputs
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [noteAppendById, setNoteAppendById] = useState({});
  const [newTagById, setNewTagById] = useState({});
  const [overridesByNumber, setOverridesByNumber] = useState({});

  function buildBaseQuery(){
    let q = "";
    if (fulfillmentFilter === "unfulfilled"){
      q += " fulfillment_status:unfulfilled";
    } else if (fulfillmentFilter === "fulfilled"){
      q += " fulfillment_status:fulfilled";
    }
    return q.trim();
  }

  async function load(reset = true){
    const reqId = ++requestIdRef.current;
    if (reset){
      setOrders([]);
      setNextCursor(null);
      setPageInfo({ hasNextPage: false });
    }
    setLoading(true);
    setError(null);
    try {
      const data = await API.getOrders({
        limit: 30,
        status_filter: "all",
        tag_filter: (tagFilter || "").trim(),
        search: (search || "").trim(),
        base_query: buildBaseQuery(),
        store,
      });
      if (reqId !== requestIdRef.current) return;
      setOrders(data.orders || []);
      setAvailableTags(data.tags || []);
      setPageInfo(data.pageInfo || { hasNextPage: false });
      setNextCursor(data.nextCursor || null);
    } catch (e){
      setError(e?.message || "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore(){
    if (loadingMore || !pageInfo?.hasNextPage || !nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await API.getOrders({
        limit: 30,
        cursor: nextCursor,
        status_filter: "all",
        tag_filter: (tagFilter || "").trim(),
        search: (search || "").trim(),
        base_query: buildBaseQuery(),
        store,
      });
      const more = data.orders || [];
      setOrders(prev => prev.concat(more));
      setPageInfo(data.pageInfo || { hasNextPage: false });
      setNextCursor(data.nextCursor || null);
      // Preload overrides best-effort for newly loaded orders if any are expanded later
    } catch (e){
      // best-effort
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    // Debounce search a bit
    const t = setTimeout(() => { load(true); }, 350);
    return () => clearTimeout(t);
  }, [tagFilter, fulfillmentFilter, store, search]);

  function toggleExpanded(order){
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(order.id)) next.delete(order.id); else next.add(order.id);
      return next;
    });
    // Fetch overrides when expanding
    try {
      if (!overridesByNumber[order.number?.replace(/^#/, "")]){
        const num = String(order.number || "").replace(/^#/, "");
        API.fetchOverrides(num, store, false).then(js => {
          const ov = (js.overrides || {})[num] || null;
          setOverridesByNumber(prev => ({ ...prev, [num]: ov }));
        }).catch(()=>{});
      }
    } catch {}
  }

  async function handleAddTag(order){
    const tag = String(newTagById[order.id] || "").trim();
    if (!tag) return;
    try {
      await API.addTag(order.id, tag, store);
      setNewTagById(prev => ({ ...prev, [order.id]: "" }));
      // Optimistic update
      setOrders(prev => prev.map(o => o.id === order.id ? ({ ...o, tags: Array.from(new Set([...(o.tags || []), tag])) }) : o));
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
      setOrders(prev => prev.map(o => o.id === order.id ? ({ ...o, note: ((o.note || "").trim() ? `${(o.note || "").trim()}\n${append}` : append) }) : o));
    } catch (e){
      alert(e?.message || "Failed to update note");
    }
  }

  function OrderRow({ order }){
    const expanded = expandedIds.has(order.id);
    const num = String(order.number || "");
    const numKey = num.replace(/^#/, "");
    const ov = overridesByNumber[numKey];

    return (
      <div className="border border-gray-200 rounded-xl bg-white">
        <button onClick={()=>toggleExpanded(order)} className="w-full px-4 py-3 text-left flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{num}</span>
              <span className="text-xs text-gray-500">{formatDate(order.created_at)}</span>
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">{formatMoney(order.total_price)}</span>
            </div>
            <div className="text-sm text-gray-700 truncate">
              {order.customer || ov?.customer?.displayName || "—"}
              {order.shipping_city && <span className="text-gray-400">{` · ${order.shipping_city}`}</span>}
            </div>
            <div className="mt-1 flex gap-1 flex-wrap">
              {(order.tags || []).map(t => (
                <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-gray-800">{t}</span>
              ))}
            </div>
          </div>
          <div className="text-xs text-blue-700">{expanded ? "Hide" : "Show"}</div>
        </button>
        {expanded && (
          <div className="px-4 pb-4">
            {/* Shipping / Customer */}
            <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
              <div className="text-sm font-semibold mb-1">Shipping</div>
              <div className="text-sm text-gray-700">
                {renderShipping(ov)}
              </div>
              {ov?.phone && (
                <div className="text-sm text-gray-600 mt-1">Phone: {ov.phone}</div>
              )}
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
            </div>
          </div>
        )}
      </header>
      <main className="max-w-5xl mx-auto px-4 py-4">
        {error && (
          <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="flex flex-col gap-3">
          {orders.map(o => <OrderRow key={o.id} order={o} />)}
        </div>
        <div className="mt-4 flex justify-center">
          {pageInfo?.hasNextPage ? (
            <button onClick={loadMore} disabled={loadingMore} className="px-4 py-2 rounded-full text-sm bg-gray-900 text-white disabled:opacity-60">{loadingMore ? "Loading…" : "Load more"}</button>
          ) : (
            <div className="text-sm text-gray-500">End of list</div>
          )}
        </div>
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


