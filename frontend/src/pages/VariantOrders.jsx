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

  function tagClass(t){
    const tl = String(t || "").trim().toLowerCase();
    if (!tl) return "bg-white text-gray-700 border-gray-200";
    if (tl.startsWith("cod ")) return "bg-blue-50 text-blue-800 border-blue-200";
    if (tl === "out") return "bg-red-50 text-red-800 border-red-200";
    if (tl === "urgent") return "bg-amber-50 text-amber-900 border-amber-200";
    if (tl === "pc") return "bg-emerald-50 text-emerald-800 border-emerald-200";
    if (tl.includes("print")) return "bg-indigo-50 text-indigo-800 border-indigo-200";
    return "bg-gray-50 text-gray-700 border-gray-200";
  }

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

  const products = useMemo(() => {
    /**
     * productKey -> {
     *   key, productId, title, image,
     *   orderIds:Set, variants: Map<variantId, { key, variantId, title, sku, image, orderIds:Set, orders:any[] }>
     * }
     */
    const pm = new Map();

    for (const o of (orders || [])) {
      const vs = Array.isArray(o?.variants) ? o.variants : [];
      for (const v of vs) {
        // Only count unfulfilled line items (variant must still be needed)
        const st = String(v?.status || "").toLowerCase();
        const uq = (v?.unfulfilled_qty != null ? Number(v.unfulfilled_qty) : null);
        const isUnfulfilled = (st === "unfulfilled") || (uq != null && uq > 0);
        if (!isUnfulfilled) continue;

        const productId = String(v?.product_id || "").trim();
        const productKey = productId || "__unknown_product__";
        const productTitle = String(v?.product_title || "").trim();
        const variantId = String(v?.id || "").trim();
        if (!variantId) continue;

        if (!pm.has(productKey)) {
          pm.set(productKey, {
            key: productKey,
            productId,
            title: productTitle || (productId ? `Product ${productId.split("/").pop()}` : "Unknown product"),
            image: v?.image || null,
            orderIds: new Set(),
            variants: new Map(),
          });
        }
        const pg = pm.get(productKey);
        pg.orderIds.add(o.id);
        if (!pg.image && v?.image) pg.image = v.image;
        if ((pg.title || "").startsWith("Product ") && productTitle) pg.title = productTitle;

        if (!pg.variants.has(variantId)) {
          pg.variants.set(variantId, {
            key: `${productKey}::${variantId}`,
            variantId,
            title: String(v?.title || v?.sku || "Variant").trim(),
            sku: String(v?.sku || "").trim(),
            image: v?.image || null,
            orderIds: new Set(),
            orders: [],
          });
        }
        const vg = pg.variants.get(variantId);
        if (!vg.orderIds.has(o.id)) {
          vg.orderIds.add(o.id);
          vg.orders.push(o);
        }
        if (!vg.image && v?.image) vg.image = v.image;
        if ((!vg.title || vg.title === "Variant") && v?.title) vg.title = String(v.title);
        if (!vg.sku && v?.sku) vg.sku = String(v.sku);
      }
    }

    const out = Array.from(pm.values()).map(p => {
      const variants = Array.from(p.variants.values()).map(v => ({
        ...v,
        count: v.orderIds.size,
        // Orders old -> new for variant drilldown
        orders: (v.orders || []).slice().sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))),
      }));
      variants.sort((a, b) => (b.count - a.count) || String(a.title).localeCompare(String(b.title)));
      return {
        ...p,
        count: p.orderIds.size,
        variants,
      };
    });
    out.sort((a, b) => (b.count - a.count) || String(a.title).localeCompare(String(b.title)));
    return out;
  }, [orders]);

  const [expandedProducts, setExpandedProducts] = useState(() => new Set());
  const [expandedVariants, setExpandedVariants] = useState(() => new Set()); // productKey::variantId

  function toggleProduct(key){
    setExpandedProducts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function toggleVariant(key){
    setExpandedVariants(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-gray-50 text-gray-900">
      <header className="sticky top-0 z-40 bg-white/85 backdrop-blur border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-2">
          <div className="text-sm font-extrabold tracking-tight">Product Orders</div>
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
            <span className="px-2 py-0.5 rounded-full bg-slate-900 text-white font-medium">{loading ? "…" : orders.length}</span>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 pb-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2 shadow-sm">
            <div className="text-[11px] text-gray-600 font-semibold">From</div>
            <input type="date" value={fromDate} onChange={(e)=>setFromDate(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" />
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2 shadow-sm">
            <div className="text-[11px] text-gray-600 font-semibold">To</div>
            <input type="date" value={toDate} onChange={(e)=>setToDate(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" />
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2 shadow-sm">
            <div className="text-[11px] text-gray-600 font-semibold">COD prefix</div>
            <input value={collectPrefix} onChange={(e)=>setCollectPrefix(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" placeholder="cod" />
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2 flex items-center justify-between shadow-sm">
            <div>
              <div className="text-[11px] text-gray-600 font-semibold">Days</div>
              <div className="mt-1 text-sm font-bold">{codDatesCount || 0}</div>
            </div>
            <button
              onClick={()=>loadAll()}
              className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-100 active:scale-[.98]"
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4">
        {error && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-3 py-2 text-xs">
            <div className="font-semibold">Error</div>
            <div className="mt-0.5">{error}</div>
          </div>
        )}

        <div className="mt-3 text-xs text-gray-600">
          Showing <span className="font-semibold">products</span> from orders that are <span className="font-semibold">open</span>, <span className="font-semibold">unfulfilled</span>, and <span className="font-semibold">paid or pending</span>, filtered by tags: <span className="font-semibold">{(collectPrefix || "cod").trim()} DD/MM/YY</span> in the selected period.
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3">
          {(products || []).map(p => {
            const isOpen = expandedProducts.has(p.key);
            return (
              <div key={p.key} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <button onClick={()=>toggleProduct(p.key)} className="w-full text-left px-4 py-3 hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-slate-100 to-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center">
                      {p.image ? <img src={p.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">No image</div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-extrabold tracking-tight truncate">{p.title}</div>
                      <div className="mt-0.5 text-[11px] text-gray-600 truncate">{p.productId ? <span className="font-semibold">Product ID:</span> : null} {p.productId ? p.productId.split("/").pop() : "—"}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-bold">{p.count}</div>
                      <div className="text-xs text-gray-600">{isOpen ? "Hide" : "Show"}</div>
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-200">
                    <div className="px-4 py-3 bg-gradient-to-r from-gray-50 to-white border-b border-gray-200">
                      <div className="text-xs font-bold text-gray-800">Variants (sorted by orders)</div>
                      <div className="text-[11px] text-gray-600 mt-0.5">Click a variant to see its orders (oldest → newest).</div>
                    </div>

                    <div className="px-4 py-3">
                      <div className="overflow-x-auto">
                        <div className="min-w-[980px]">
                          <div className="grid grid-cols-12 gap-2 text-[11px] font-semibold text-gray-600 px-2 py-2 bg-gray-50 border border-gray-200 rounded-xl">
                            <div className="col-span-6">Variant</div>
                            <div className="col-span-3">SKU</div>
                            <div className="col-span-2 text-right">Orders</div>
                            <div className="col-span-1 text-right">Open</div>
                          </div>

                          <div className="mt-2 space-y-2">
                            {(p.variants || []).map(v => {
                              const openV = expandedVariants.has(v.key);
                              return (
                                <div key={v.key} className="border border-gray-200 rounded-2xl overflow-hidden">
                                  <button
                                    onClick={()=>toggleVariant(v.key)}
                                    className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 ${openV ? "bg-white" : "bg-white"}`}
                                  >
                                    <div className="grid grid-cols-12 gap-2 items-center">
                                      <div className="col-span-6 flex items-center gap-2 min-w-0">
                                        <div className="w-10 h-10 rounded-xl bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center shrink-0">
                                          {v.image ? <img src={v.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">—</div>}
                                        </div>
                                        <div className="min-w-0">
                                          <div className="text-sm font-extrabold tracking-tight truncate">{v.title || "Variant"}</div>
                                          <div className="text-[11px] text-gray-600 truncate">Variant ID: {String(v.variantId || "").split("/").pop()}</div>
                                        </div>
                                      </div>
                                      <div className="col-span-3 text-[12px] text-gray-800 truncate">{v.sku || "—"}</div>
                                      <div className="col-span-2 text-right">
                                        <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-bold">
                                          {v.count}
                                        </span>
                                      </div>
                                      <div className="col-span-1 text-right text-xs text-gray-600">{openV ? "▾" : "▸"}</div>
                                    </div>
                                  </button>

                                  {openV && (
                                    <div className="border-t border-gray-200 bg-white">
                                      <div className="px-3 py-2 bg-gradient-to-r from-indigo-50 to-white border-b border-gray-200">
                                        <div className="text-xs font-bold text-gray-900">Orders for this variant</div>
                                        <div className="text-[11px] text-gray-600 mt-0.5">Sorted from <span className="font-semibold">old</span> to <span className="font-semibold">new</span>.</div>
                                      </div>

                                      <div className="overflow-x-auto">
                                        <table className="min-w-[1200px] w-full text-sm">
                                          <thead className="bg-gray-50 text-[11px] text-gray-600">
                                            <tr>
                                              <th className="text-left px-3 py-2 border-b border-gray-200">Date</th>
                                              <th className="text-left px-3 py-2 border-b border-gray-200">Order</th>
                                              <th className="text-left px-3 py-2 border-b border-gray-200">Customer</th>
                                              <th className="text-left px-3 py-2 border-b border-gray-200">Phone</th>
                                              <th className="text-left px-3 py-2 border-b border-gray-200">City</th>
                                              <th className="text-left px-3 py-2 border-b border-gray-200">Address</th>
                                              <th className="text-left px-3 py-2 border-b border-gray-200">Tags</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {(v.orders || []).map((o, idx) => {
                                              const created = fmtShortDate(o.created_at);
                                              const phone = (o.shipping_phone || "").trim();
                                              const name = (o.shipping_name || o.customer || "").trim();
                                              const addr = compactAddress(o);
                                              const tags = Array.isArray(o.tags) ? o.tags : [];
                                              const rowBg = (idx % 2 === 0) ? "bg-white" : "bg-slate-50/40";
                                              return (
                                                <React.Fragment key={o.id}>
                                                  <tr className={`${rowBg} border-b border-gray-100`}>
                                                    <td className="px-3 py-2 whitespace-nowrap font-semibold text-gray-800">{created || "—"}</td>
                                                    <td className="px-3 py-2 whitespace-nowrap">
                                                      <div className="font-extrabold text-gray-900">{o.number || "—"}</div>
                                                      <div className="text-[11px] text-gray-600">{String(o.financial_status || "").replace(/_/g," ")}</div>
                                                    </td>
                                                    <td className="px-3 py-2">
                                                      <div className="font-semibold text-gray-900">{name || "—"}</div>
                                                    </td>
                                                    <td className="px-3 py-2 whitespace-nowrap text-gray-800">{phone || "—"}</td>
                                                    <td className="px-3 py-2 whitespace-nowrap text-gray-800">{o.shipping_city || "—"}</td>
                                                    <td className="px-3 py-2 text-gray-800">
                                                      <div className="max-w-[420px] truncate">{addr || "—"}</div>
                                                      {o.note ? (
                                                        <div className="mt-1 text-[11px] text-gray-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 inline-block max-w-[520px] truncate">
                                                          <span className="font-semibold">Note:</span> {String(o.note)}
                                                        </div>
                                                      ) : null}
                                                    </td>
                                                    <td className="px-3 py-2">
                                                      <div className="flex flex-wrap gap-1 max-w-[420px]">
                                                        {tags.slice(0, 10).map(t => (
                                                          <span key={t} className={`text-[11px] px-2 py-0.5 rounded-full border ${tagClass(t)}`}>{t}</span>
                                                        ))}
                                                        {tags.length > 10 ? (
                                                          <span className="text-[11px] px-2 py-0.5 rounded-full border bg-white text-gray-700 border-gray-200">+{tags.length - 10}</span>
                                                        ) : null}
                                                      </div>
                                                    </td>
                                                  </tr>
                                                  <tr className={`${rowBg} border-b border-gray-200`}>
                                                    <td className="px-3 pb-3 pt-0" colSpan={7}>
                                                      <div className="mt-2 flex flex-wrap gap-2">
                                                        {(Array.isArray(o.variants) ? o.variants : []).map((li, liIdx) => (
                                                          <div key={`${o.id}-${li.id || liIdx}`} className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-2 py-1.5">
                                                            <div className="w-9 h-9 rounded-lg bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center shrink-0">
                                                              {li.image ? <img src={li.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">—</div>}
                                                            </div>
                                                            <div className="min-w-0">
                                                              <div className="text-[11px] font-semibold text-gray-900 truncate max-w-[260px]">{li.title || li.sku || "Item"}</div>
                                                              <div className="text-[10px] text-gray-600">
                                                                {li.sku ? <span className="font-semibold">SKU:</span> : null} {li.sku || ""}{" "}
                                                                <span className="ml-2 font-semibold">Qty:</span> {Number(li.qty || 0)}
                                                              </div>
                                                            </div>
                                                          </div>
                                                        ))}
                                                      </div>
                                                    </td>
                                                  </tr>
                                                </React.Fragment>
                                              );
                                            })}
                                            {(v.orders || []).length === 0 ? (
                                              <tr><td className="px-3 py-3 text-sm text-gray-600" colSpan={7}>No orders.</td></tr>
                                            ) : null}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            {(p.variants || []).length === 0 ? (
                              <div className="text-sm text-gray-600 px-2 py-3">No variants.</div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {!loading && (!products || products.length === 0) ? (
            <div className="bg-white rounded-2xl border border-gray-200 px-4 py-6 text-sm text-gray-600">
              No products found for this period.
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}


