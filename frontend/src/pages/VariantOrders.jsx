import React, { useEffect, useMemo, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";

const API = {
  async getOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await authFetch(`/api/orders?${q}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch orders (${res.status})`);
    return res.json();
  },
};

function computeCodDatesCSV(from, to){
  try {
    if (!from && !to) return "";
    const [fy, fm, fd] = (from || to || "").split("-");
    const [ty, tm, td] = (to || from || "").split("-");
    const start = new Date(parseInt(fy, 10), parseInt(fm, 10) - 1, parseInt(fd, 10));
    const end = new Date(parseInt(ty, 10), parseInt(tm, 10) - 1, parseInt(td, 10));
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return "";
    const a = start <= end ? start : end;
    const b = start <= end ? end : start;
    const out = [];
    for (let dt = new Date(a); dt <= b; dt.setDate(dt.getDate() + 1)){
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      out.push(`${d}/${m}/${String(y).slice(-2)}`);
    }
    return out.join(",");
  } catch { return ""; }
}

function fmtShortDate(iso){
  try {
    if (!iso) return "";
    const d = new Date(String(iso));
    if (isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  } catch { return ""; }
}

function compactAddress(o){
  const parts = [];
  const a1 = (o.shipping_address1 || "").trim();
  const a2 = (o.shipping_address2 || "").trim();
  const c = (o.shipping_city || "").trim();
  const z = (o.shipping_zip || "").trim();
  const p = (o.shipping_province || "").trim();
  const co = (o.shipping_country || "").trim();
  if (a1) parts.push(a1);
  if (a2) parts.push(a2);
  const cityLine = [z, c, p].filter(Boolean).join(" ");
  if (cityLine) parts.push(cityLine);
  if (co) parts.push(co);
  return parts.join(", ");
}

export default function VariantOrders(){
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

  const [fromDate, setFromDate] = useState(() => {
    try {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    } catch { return ""; }
  });
  const [toDate, setToDate] = useState(() => {
    try {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    } catch { return ""; }
  });
  const [collectPrefix, setCollectPrefix] = useState(() => {
    try {
      const raw = localStorage.getItem("orderCollectorPreset");
      const preset = raw ? JSON.parse(raw) : null;
      return String(preset?.collectPrefix || "cod");
    } catch { return "cod"; }
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [orders, setOrders] = useState([]);
  const requestIdRef = useRef(0);

  const codDatesCSV = useMemo(() => computeCodDatesCSV(fromDate, toDate), [fromDate, toDate]);
  const codDatesCount = useMemo(() => {
    try { return codDatesCSV ? codDatesCSV.split(",").filter(Boolean).length : 0; } catch { return 0; }
  }, [codDatesCSV]);

  async function loadAll(){
    const reqId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setOrders([]);
    try {
      const baseParams = {
        limit: 250,
        // Only: open + unfulfilled + paid or pending
        base_query: "status:open fulfillment_status:unfulfilled",
        financial_status: "paid_or_pending",
        cod_date: "",
        cod_dates: codDatesCSV || "",
        collect_prefix: (collectPrefix || "cod").trim(),
        store,
      };
      let data = await API.getOrders(baseParams);
      if (reqId !== requestIdRef.current) return;
      if (data?.error) throw new Error(String(data.error));
      let out = Array.isArray(data?.orders) ? data.orders : [];
      let next = data?.nextCursor || null;
      let hasNext = !!(data?.pageInfo || {}).hasNextPage;
      // Auto-paginate to fetch ALL matching orders in the chosen period
      while (hasNext && next) {
        const page = await API.getOrders({ ...baseParams, cursor: next });
        if (reqId !== requestIdRef.current) return;
        const ords = Array.isArray(page?.orders) ? page.orders : [];
        out = out.concat(ords);
        next = page?.nextCursor || null;
        hasNext = !!(page?.pageInfo || {}).hasNextPage;
      }
      // Safety: in case backend didn't enforce (older deployments), filter here too.
      out = out.filter(o => {
        const fs = String(o?.financial_status || "").toLowerCase();
        const okPaid = fs.includes("paid");
        const okPending = fs.includes("pending") || fs.includes("authorized") || fs.includes("partially");
        return okPaid || okPending;
      });
      setOrders(out);
    } catch (e){
      setError(e?.message || "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Always reload when period/prefix/store changes
    const t = setTimeout(() => { loadAll(); }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, codDatesCSV, collectPrefix]);

  const groups = useMemo(() => {
    /** @type {Map<string, { key: string, variantId: string, title: string, sku: string, image: string|null, orderIds: Set<string>, orders: any[] }>} */
    const m = new Map();
    for (const o of (orders || [])) {
      const vs = Array.isArray(o?.variants) ? o.variants : [];
      for (const v of vs) {
        // Only count unfulfilled line items (variant must still be needed)
        const st = String(v?.status || "").toLowerCase();
        const uq = (v?.unfulfilled_qty != null ? Number(v.unfulfilled_qty) : null);
        const isUnfulfilled = (st === "unfulfilled") || (uq != null && uq > 0);
        if (!isUnfulfilled) continue;
        const vid = String(v?.id || "").trim();
        const title = String(v?.title || v?.sku || "Variant").trim();
        if (!vid) continue;
        const key = vid;
        if (!m.has(key)) {
          m.set(key, {
            key,
            variantId: vid,
            title,
            sku: String(v?.sku || "").trim(),
            image: v?.image || null,
            orderIds: new Set(),
            orders: [],
          });
        }
        const g = m.get(key);
        if (!g.orderIds.has(o.id)) {
          g.orderIds.add(o.id);
          g.orders.push(o);
        }
        // Prefer first non-empty image/title
        if (!g.image && v?.image) g.image = v.image;
        if ((!g.title || g.title === "Variant") && title) g.title = title;
        if (!g.sku && v?.sku) g.sku = String(v.sku);
      }
    }
    const arr = Array.from(m.values()).map(g => ({
      ...g,
      count: g.orderIds.size,
      orders: (g.orders || []).slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))),
    }));
    arr.sort((a, b) => (b.count - a.count) || String(a.title).localeCompare(String(b.title)));
    return arr;
  }, [orders]);

  const [expanded, setExpanded] = useState(() => new Set());
  function toggle(key){
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-2">
          <div className="text-sm font-extrabold tracking-tight">Variant Orders</div>
          <div className="ml-3 inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white">
            <button
              onClick={()=>setStore("irrakids")}
              className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === "irrakids" ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"}`}
            >Irrakids</button>
            <button
              onClick={()=>setStore("irranova")}
              className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === "irranova" ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"}`}
            >Irranova</button>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-full bg-blue-600 text-white font-medium">{loading ? "…" : orders.length}</span>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 pb-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div className="bg-white rounded-xl border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-600 font-semibold">From</div>
            <input type="date" value={fromDate} onChange={(e)=>setFromDate(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" />
          </div>
          <div className="bg-white rounded-xl border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-600 font-semibold">To</div>
            <input type="date" value={toDate} onChange={(e)=>setToDate(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" />
          </div>
          <div className="bg-white rounded-xl border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-600 font-semibold">COD prefix</div>
            <input value={collectPrefix} onChange={(e)=>setCollectPrefix(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" placeholder="cod" />
          </div>
          <div className="bg-white rounded-xl border border-gray-200 px-3 py-2 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-gray-600 font-semibold">Days</div>
              <div className="mt-1 text-sm font-bold">{codDatesCount || 0}</div>
            </div>
            <button
              onClick={()=>loadAll()}
              className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-100"
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-4">
        {error && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-3 py-2 text-xs">
            <div className="font-semibold">Error</div>
            <div className="mt-0.5">{error}</div>
          </div>
        )}

        <div className="mt-3 text-xs text-gray-600">
          Showing variants from orders that are <span className="font-semibold">open</span>, <span className="font-semibold">unfulfilled</span>, and <span className="font-semibold">paid or pending</span>, filtered by tags: <span className="font-semibold">{(collectPrefix || "cod").trim()} DD/MM/YY</span> in the selected period.
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3">
          {(groups || []).map(g => {
            const isOpen = expanded.has(g.key);
            return (
              <div key={g.key} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <button onClick={()=>toggle(g.key)} className="w-full text-left px-4 py-3 hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center">
                      {g.image ? <img src={g.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">No image</div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-extrabold tracking-tight truncate">{g.title}</div>
                      <div className="mt-0.5 text-[11px] text-gray-600 truncate">
                        {g.sku ? <span className="font-semibold">SKU:</span> : null} {g.sku || ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-bold">{g.count}</div>
                      <div className="text-xs text-gray-600">{isOpen ? "Hide" : "Show"}</div>
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-200">
                    {(g.orders || []).map(o => {
                      const phone = (o.shipping_phone || "").trim();
                      const name = (o.shipping_name || o.customer || "").trim();
                      const addr = compactAddress(o);
                      const created = fmtShortDate(o.created_at);
                      const tags = Array.isArray(o.tags) ? o.tags : [];
                      const lineItems = Array.isArray(o.variants) ? o.variants : [];
                      return (
                        <div key={o.id} className="px-4 py-3 border-b border-gray-100">
                          <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                            <div className="sm:w-40 shrink-0">
                              <div className="text-xs font-extrabold">{created || "—"}</div>
                              <div className="text-[11px] text-gray-700 font-semibold">{o.number || ""}</div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs">
                                <span className="font-semibold">{name || "—"}</span>
                                {o.shipping_city ? <span className="text-gray-600"> · {o.shipping_city}</span> : null}
                              </div>
                              {phone ? <div className="text-[11px] text-gray-700 mt-0.5"><span className="font-semibold">Phone:</span> {phone}</div> : null}
                              {addr ? <div className="text-[11px] text-gray-700 mt-0.5 truncate"><span className="font-semibold">Address:</span> {addr}</div> : null}
                              {o.note ? (
                                <div className="mt-2 text-[11px] text-gray-800 bg-gray-50 border border-gray-200 rounded-xl px-2 py-1 whitespace-pre-wrap">
                                  <span className="font-semibold">Note:</span> {o.note}
                                </div>
                              ) : null}
                              {tags.length ? (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {tags.map(t => (
                                    <span key={t} className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 bg-white text-gray-700">{t}</span>
                                  ))}
                                </div>
                              ) : null}
                              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {lineItems.map((li, idx) => (
                                  <div key={`${o.id}-${li.id || idx}`} className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-2 py-1.5">
                                    <div className="w-10 h-10 rounded-lg bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center shrink-0">
                                      {li.image ? <img src={li.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">—</div>}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[11px] font-semibold truncate">{li.title || li.sku || "Item"}</div>
                                      <div className="text-[10px] text-gray-600">
                                        {li.sku ? <span className="font-semibold">SKU:</span> : null} {li.sku || ""}{" "}
                                        <span className="ml-2 font-semibold">Qty:</span> {Number(li.qty || 0)}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {(g.orders || []).length === 0 ? (
                      <div className="px-4 py-4 text-sm text-gray-600">No orders.</div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}

          {!loading && (!groups || groups.length === 0) ? (
            <div className="bg-white rounded-2xl border border-gray-200 px-4 py-6 text-sm text-gray-600">
              No variants found for this period.
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}


