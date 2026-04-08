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

function computeCodDatesCSV(from, to) {
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
    for (let dt = new Date(a); dt <= b; dt.setDate(dt.getDate() + 1)) {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      out.push(`${d}/${m}/${String(y).slice(-2)}`);
    }
    return out.join(",");
  } catch {
    return "";
  }
}

function fmtShortDate(iso) {
  try {
    if (!iso) return "";
    const d = new Date(String(iso));
    if (isNaN(d.getTime())) return "";
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(-2)}`;
  } catch {
    return "";
  }
}

function compactAddress(order) {
  const parts = [];
  const a1 = String(order?.shipping_address1 || "").trim();
  const a2 = String(order?.shipping_address2 || "").trim();
  const city = String(order?.shipping_city || "").trim();
  const zip = String(order?.shipping_zip || "").trim();
  const province = String(order?.shipping_province || "").trim();
  const country = String(order?.shipping_country || "").trim();
  if (a1) parts.push(a1);
  if (a2) parts.push(a2);
  const cityLine = [zip, city, province].filter(Boolean).join(" ");
  if (cityLine) parts.push(cityLine);
  if (country) parts.push(country);
  return parts.join(", ");
}

function tagClass(tag) {
  const tagLower = String(tag || "").trim().toLowerCase();
  if (!tagLower) return "bg-white text-gray-700 border-gray-200";
  if (tagLower.startsWith("cod ")) return "bg-blue-50 text-blue-800 border-blue-200";
  if (tagLower === "out") return "bg-red-50 text-red-800 border-red-200";
  if (tagLower === "urgent") return "bg-amber-50 text-amber-900 border-amber-200";
  if (tagLower === "pc") return "bg-emerald-50 text-emerald-800 border-emerald-200";
  if (tagLower.includes("print")) return "bg-indigo-50 text-indigo-800 border-indigo-200";
  return "bg-gray-50 text-gray-700 border-gray-200";
}

export default function VariantOrders() {
  const [store, setStore] = useState(() => {
    try {
      const params = new URLSearchParams(location.search);
      const selected = (params.get("store") || sessionStorage.getItem("orderCollectorStore") || "irrakids").trim().toLowerCase();
      return selected === "irranova" ? "irranova" : "irrakids";
    } catch {
      return "irrakids";
    }
  });
  useEffect(() => {
    try { sessionStorage.setItem("orderCollectorStore", store); } catch {}
    try {
      const params = new URLSearchParams(location.search);
      if ((params.get("store") || "").trim().toLowerCase() !== store) {
        params.set("store", store);
        history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
      }
    } catch {}
  }, [store]);

  const [fromDate, setFromDate] = useState(() => {
    try {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    } catch {
      return "";
    }
  });
  const [toDate, setToDate] = useState(() => {
    try {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    } catch {
      return "";
    }
  });
  const [collectPrefix, setCollectPrefix] = useState(() => {
    try {
      const raw = localStorage.getItem("orderCollectorPreset");
      const preset = raw ? JSON.parse(raw) : null;
      return String(preset?.collectPrefix || "cod");
    } catch {
      return "cod";
    }
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState("products");
  const [products, setProducts] = useState([]);
  const [ordersByCod, setOrdersByCod] = useState([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const requestIdRef = useRef(0);
  const cacheRef = useRef(new Map());

  const codDatesCSV = useMemo(() => computeCodDatesCSV(fromDate, toDate), [fromDate, toDate]);
  const codDatesCount = useMemo(() => {
    try { return codDatesCSV ? codDatesCSV.split(",").filter(Boolean).length : 0; } catch { return 0; }
  }, [codDatesCSV]);
  const aggregateMode = viewMode === "products" ? "products" : "cod_date";

  const [expandedCodGroups, setExpandedCodGroups] = useState(() => new Set());
  const [expandedProducts, setExpandedProducts] = useState(() => new Set());
  const [expandedVariants, setExpandedVariants] = useState(() => new Set());

  function toggleCodGroup(label) {
    setExpandedCodGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function toggleProduct(key) {
    setExpandedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleVariant(key) {
    setExpandedVariants((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function loadData({ force = false } = {}) {
    const requestId = ++requestIdRef.current;
    const cacheKey = JSON.stringify({
      mode: aggregateMode,
      store,
      codDatesCSV,
      collectPrefix: String(collectPrefix || "").trim().toLowerCase(),
    });
    if (!force && cacheRef.current.has(cacheKey)) {
      const cached = cacheRef.current.get(cacheKey);
      setError(null);
      setLoading(false);
      setTotalOrders(Number(cached?.totalCount || 0));
      if (aggregateMode === "products") setProducts(Array.isArray(cached?.groups) ? cached.groups : []);
      else setOrdersByCod(Array.isArray(cached?.groups) ? cached.groups : []);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await API.getOrders({
        limit: 250,
        base_query: "status:open fulfillment_status:unfulfilled -tag:pc",
        financial_status: "paid_or_pending",
        cod_date: "",
        cod_dates: codDatesCSV || "",
        collect_prefix: String(collectPrefix || "cod").trim(),
        store,
        aggregate_by: aggregateMode,
      });
      if (requestId !== requestIdRef.current) return;
      if (data?.error) throw new Error(String(data.error));
      cacheRef.current.set(cacheKey, data);
      setTotalOrders(Number(data?.totalCount || 0));
      if (aggregateMode === "products") setProducts(Array.isArray(data?.groups) ? data.groups : []);
      else setOrdersByCod(Array.isArray(data?.groups) ? data.groups : []);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e?.message || "Failed to load grouped orders");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => { loadData(); }, 150);
    return () => clearTimeout(timer);
  }, [store, codDatesCSV, collectPrefix, aggregateMode]);

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-gray-50 text-gray-900">
      <header className="sticky top-0 z-40 bg-white/85 backdrop-blur border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-2">
          <div className="text-sm font-extrabold tracking-tight">Product Orders</div>
          <div className="ml-3 inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white">
            <button onClick={() => setStore("irrakids")} className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === "irrakids" ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"}`}>Irrakids</button>
            <button onClick={() => setStore("irranova")} className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === "irranova" ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"}`}>Irranova</button>
          </div>
          <div className="ml-3 inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white">
            <button onClick={() => setViewMode("products")} className={`px-2 py-0.5 rounded-lg text-xs font-medium ${viewMode === "products" ? "bg-indigo-600 text-white" : "text-gray-700 hover:bg-gray-100"}`}>Products</button>
            <button onClick={() => setViewMode("ordersByCod")} className={`px-2 py-0.5 rounded-lg text-xs font-medium ${viewMode === "ordersByCod" ? "bg-indigo-600 text-white" : "text-gray-700 hover:bg-gray-100"}`}>Orders by COD</button>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-full bg-slate-900 text-white font-medium">{loading ? "..." : totalOrders}</span>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 pb-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2 shadow-sm">
            <div className="text-[11px] text-gray-600 font-semibold">From</div>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" />
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2 shadow-sm">
            <div className="text-[11px] text-gray-600 font-semibold">To</div>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" />
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2 shadow-sm">
            <div className="text-[11px] text-gray-600 font-semibold">COD prefix</div>
            <input value={collectPrefix} onChange={(e) => setCollectPrefix(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" placeholder="cod" />
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2 flex items-center justify-between shadow-sm">
            <div>
              <div className="text-[11px] text-gray-600 font-semibold">Days</div>
              <div className="mt-1 text-sm font-bold">{codDatesCount || 0}</div>
            </div>
            <button
              onClick={() => {
                cacheRef.current.clear();
                loadData({ force: true });
              }}
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

        {viewMode === "products" && (
          <>
            <div className="mt-3 text-xs text-gray-600">
              Showing <span className="font-semibold">products</span> from orders that are <span className="font-semibold">open</span>, <span className="font-semibold">unfulfilled</span>, <span className="font-semibold">paid or pending</span>, and <span className="font-semibold">not tagged pc</span>, filtered by tags: <span className="font-semibold">{(collectPrefix || "cod").trim()} DD/MM/YY</span> in the selected period.
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3">
              {products.map((product) => {
                const isOpen = expandedProducts.has(product.key);
                return (
                  <div key={product.key} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                    <button onClick={() => toggleProduct(product.key)} className="w-full text-left px-4 py-3 hover:bg-gray-50">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-slate-100 to-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center">
                          {product.image ? <img src={product.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">No image</div>}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-extrabold tracking-tight truncate">{product.title}</div>
                          <div className="mt-0.5 text-[11px] text-gray-600 truncate">{product.productId ? <span className="font-semibold">Product ID:</span> : null} {product.productId ? String(product.productId).split("/").pop() : "—"}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-bold">{product.count}</div>
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
                                {(product.variants || []).map((variant) => {
                                  const variantOpen = expandedVariants.has(variant.key);
                                  return (
                                    <div key={variant.key} className="border border-gray-200 rounded-2xl overflow-hidden">
                                      <button onClick={() => toggleVariant(variant.key)} className="w-full text-left px-3 py-2.5 hover:bg-gray-50 bg-white">
                                        <div className="grid grid-cols-12 gap-2 items-center">
                                          <div className="col-span-6 flex items-center gap-2 min-w-0">
                                            <div className="w-10 h-10 rounded-xl bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center shrink-0">
                                              {variant.image ? <img src={variant.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">—</div>}
                                            </div>
                                            <div className="min-w-0">
                                              <div className="text-sm font-extrabold tracking-tight truncate">{variant.title || "Variant"}</div>
                                              <div className="text-[11px] text-gray-600 truncate">Variant ID: {String(variant.variantId || "").split("/").pop()}</div>
                                            </div>
                                          </div>
                                          <div className="col-span-3 text-[12px] text-gray-800 truncate">{variant.sku || "—"}</div>
                                          <div className="col-span-2 text-right">
                                            <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-bold">{variant.count}</span>
                                          </div>
                                          <div className="col-span-1 text-right text-xs text-gray-600">{variantOpen ? "▾" : "▸"}</div>
                                        </div>
                                      </button>

                                      {variantOpen && (
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
                                                {(variant.orders || []).map((order, index) => {
                                                  const created = fmtShortDate(order.created_at);
                                                  const phone = String(order.shipping_phone || "").trim();
                                                  const name = String(order.shipping_name || order.customer || "").trim();
                                                  const addr = compactAddress(order);
                                                  const tags = Array.isArray(order.tags) ? order.tags : [];
                                                  const rowBg = index % 2 === 0 ? "bg-white" : "bg-slate-50/40";
                                                  return (
                                                    <React.Fragment key={order.id}>
                                                      <tr className={`${rowBg} border-b border-gray-100`}>
                                                        <td className="px-3 py-2 whitespace-nowrap font-semibold text-gray-800">{created || "—"}</td>
                                                        <td className="px-3 py-2 whitespace-nowrap">
                                                          <div className="font-extrabold text-gray-900">{order.number || "—"}</div>
                                                          <div className="text-[11px] text-gray-600">{String(order.financial_status || "").replace(/_/g, " ")}</div>
                                                        </td>
                                                        <td className="px-3 py-2"><div className="font-semibold text-gray-900">{name || "—"}</div></td>
                                                        <td className="px-3 py-2 whitespace-nowrap text-gray-800">{phone || "—"}</td>
                                                        <td className="px-3 py-2 whitespace-nowrap text-gray-800">{order.shipping_city || "—"}</td>
                                                        <td className="px-3 py-2 text-gray-800">
                                                          <div className="max-w-[420px] truncate">{addr || "—"}</div>
                                                          {order.note ? <div className="mt-1 text-[11px] text-gray-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 inline-block max-w-[520px] truncate"><span className="font-semibold">Note:</span> {String(order.note)}</div> : null}
                                                        </td>
                                                        <td className="px-3 py-2">
                                                          <div className="flex flex-wrap gap-1 max-w-[420px]">
                                                            {tags.slice(0, 10).map((tag) => (
                                                              <span key={tag} className={`text-[11px] px-2 py-0.5 rounded-full border ${tagClass(tag)}`}>{tag}</span>
                                                            ))}
                                                            {tags.length > 10 ? <span className="text-[11px] px-2 py-0.5 rounded-full border bg-white text-gray-700 border-gray-200">+{tags.length - 10}</span> : null}
                                                          </div>
                                                        </td>
                                                      </tr>
                                                      <tr className={`${rowBg} border-b border-gray-200`}>
                                                        <td className="px-3 pb-3 pt-0" colSpan={7}>
                                                          <div className="mt-2 flex flex-wrap gap-2">
                                                            {(Array.isArray(order.variants) ? order.variants : []).map((lineItem, lineIndex) => (
                                                              <div key={`${order.id}-${lineItem.id || lineIndex}`} className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-2 py-1.5">
                                                                <div className="w-9 h-9 rounded-lg bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center shrink-0">
                                                                  {lineItem.image ? <img src={lineItem.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">—</div>}
                                                                </div>
                                                                <div className="min-w-0">
                                                                  <div className="text-[11px] font-semibold text-gray-900 truncate max-w-[260px]">{lineItem.title || lineItem.sku || "Item"}</div>
                                                                  <div className="text-[10px] text-gray-600">{lineItem.sku ? <span className="font-semibold">SKU:</span> : null} {lineItem.sku || ""} <span className="ml-2 font-semibold">Qty:</span> {Number(lineItem.qty || 0)}</div>
                                                                </div>
                                                              </div>
                                                            ))}
                                                          </div>
                                                        </td>
                                                      </tr>
                                                    </React.Fragment>
                                                  );
                                                })}
                                                {(variant.orders || []).length === 0 ? <tr><td className="px-3 py-3 text-sm text-gray-600" colSpan={7}>No orders.</td></tr> : null}
                                              </tbody>
                                            </table>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                                {(product.variants || []).length === 0 ? <div className="text-sm text-gray-600 px-2 py-3">No variants.</div> : null}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {!loading && products.length === 0 ? <div className="bg-white rounded-2xl border border-gray-200 px-4 py-6 text-sm text-gray-600">No products found for this period.</div> : null}
            </div>
          </>
        )}

        {viewMode === "ordersByCod" && (
          <>
            <div className="mt-3 text-xs text-gray-600">
              Showing <span className="font-semibold">orders</span> grouped by <span className="font-semibold">COD date</span> (oldest first). Within each date, orders with <span className="font-semibold">bigger value</span> appear first.
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4">
              {ordersByCod.map((group) => {
                const isGroupOpen = expandedCodGroups.has(group.label);
                const totalItems = Number(group.totalItems || 0);
                return (
                  <div key={group.label} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                    <button onClick={() => toggleCodGroup(group.label)} className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shadow-sm">
                          {String(group.label || "").replace(/^\w+\s+/, "").split("/")[0]}
                        </div>
                        <div>
                          <div className="font-extrabold tracking-tight text-gray-900">{group.label}</div>
                          <div className="text-[11px] text-gray-600 mt-0.5">{group.orders.length} order{group.orders.length !== 1 ? "s" : ""} · {totalItems} item{totalItems !== 1 ? "s" : ""}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="px-2.5 py-0.5 rounded-full bg-blue-600 text-white text-xs font-bold">{group.orders.length}</span>
                        <span className="text-xs text-gray-600">{isGroupOpen ? "▾" : "▸"}</span>
                      </div>
                    </button>

                    {isGroupOpen && (
                      <div className="border-t border-gray-200">
                        <div className="overflow-x-auto">
                          <table className="min-w-[1200px] w-full text-sm">
                            <thead className="bg-gray-50 text-[11px] text-gray-600">
                              <tr>
                                <th className="text-left px-3 py-2 border-b border-gray-200">Date</th>
                                <th className="text-left px-3 py-2 border-b border-gray-200">Order</th>
                                <th className="text-left px-3 py-2 border-b border-gray-200">Customer</th>
                                <th className="text-left px-3 py-2 border-b border-gray-200">Phone</th>
                                <th className="text-left px-3 py-2 border-b border-gray-200">City</th>
                                <th className="text-left px-3 py-2 border-b border-gray-200">Items</th>
                                <th className="text-left px-3 py-2 border-b border-gray-200">Total</th>
                                <th className="text-left px-3 py-2 border-b border-gray-200">Tags</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(group.orders || []).map((order, index) => {
                                const created = fmtShortDate(order.created_at);
                                const phone = String(order.shipping_phone || "").trim();
                                const name = String(order.shipping_name || order.customer || "").trim();
                                const addr = compactAddress(order);
                                const tags = Array.isArray(order.tags) ? order.tags : [];
                                const rowBg = index % 2 === 0 ? "bg-white" : "bg-slate-50/40";
                                const itemCount = Number(order.itemCount || 0);
                                const totalPrice = Number(order.totalPrice || 0);
                                return (
                                  <React.Fragment key={order.id}>
                                    <tr className={`${rowBg} border-b border-gray-100`}>
                                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-gray-800">{created || "—"}</td>
                                      <td className="px-3 py-2 whitespace-nowrap">
                                        <div className="font-extrabold text-gray-900">{order.number || "—"}</div>
                                        <div className="text-[11px] text-gray-600">{String(order.financial_status || "").replace(/_/g, " ")}</div>
                                      </td>
                                      <td className="px-3 py-2"><div className="font-semibold text-gray-900">{name || "—"}</div></td>
                                      <td className="px-3 py-2 whitespace-nowrap text-gray-800">{phone || "—"}</td>
                                      <td className="px-3 py-2 whitespace-nowrap text-gray-800">{order.shipping_city || "—"}</td>
                                      <td className="px-3 py-2 whitespace-nowrap"><span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-bold ${itemCount >= 3 ? "bg-amber-100 text-amber-900 border border-amber-300" : "bg-gray-100 text-gray-800 border border-gray-200"}`}>{itemCount}</span></td>
                                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-gray-900">{totalPrice > 0 ? `${totalPrice.toLocaleString()} DZD` : "—"}</td>
                                      <td className="px-3 py-2">
                                        <div className="flex flex-wrap gap-1 max-w-[350px]">
                                          {tags.slice(0, 8).map((tag) => (
                                            <span key={tag} className={`text-[11px] px-2 py-0.5 rounded-full border ${tagClass(tag)}`}>{tag}</span>
                                          ))}
                                          {tags.length > 8 ? <span className="text-[11px] px-2 py-0.5 rounded-full border bg-white text-gray-700 border-gray-200">+{tags.length - 8}</span> : null}
                                        </div>
                                      </td>
                                    </tr>
                                    <tr className={`${rowBg} border-b border-gray-200`}>
                                      <td className="px-3 pb-3 pt-0" colSpan={8}>
                                        {order.note ? <div className="mt-1 mb-1 text-[11px] text-gray-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 inline-block max-w-[520px] truncate"><span className="font-semibold">Note:</span> {String(order.note)}</div> : null}
                                        <div className="mt-1 text-[11px] text-gray-500 truncate max-w-[600px]">{addr || ""}</div>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                          {(Array.isArray(order.variants) ? order.variants : []).map((lineItem, lineIndex) => (
                                            <div key={`${order.id}-${lineItem.id || lineIndex}`} className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-2 py-1.5">
                                              <div className="w-9 h-9 rounded-lg bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center shrink-0">
                                                {lineItem.image ? <img src={lineItem.image} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px] text-gray-500">—</div>}
                                              </div>
                                              <div className="min-w-0">
                                                <div className="text-[11px] font-semibold text-gray-900 truncate max-w-[260px]">{lineItem.title || lineItem.sku || "Item"}</div>
                                                <div className="text-[10px] text-gray-600">{lineItem.sku ? <span className="font-semibold">SKU:</span> : null} {lineItem.sku || ""} <span className="ml-2 font-semibold">Qty:</span> {Number(lineItem.qty || 0)}</div>
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      </td>
                                    </tr>
                                  </React.Fragment>
                                );
                              })}
                              {group.orders.length === 0 ? <tr><td className="px-3 py-3 text-sm text-gray-600" colSpan={8}>No orders.</td></tr> : null}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {!loading && ordersByCod.length === 0 ? <div className="bg-white rounded-2xl border border-gray-200 px-4 py-6 text-sm text-gray-600">No orders with COD date tags found for this period.</div> : null}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
