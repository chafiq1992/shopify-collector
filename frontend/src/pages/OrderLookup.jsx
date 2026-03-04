import React, { useEffect, useMemo, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";

// Minimal API client (mirrors endpoints used elsewhere)
const API = {
  async searchOneByNumber(number, store){
    const params = new URLSearchParams({
      limit: "1",
      search: String(number || "").trim(),
      store: (store || "").trim(),
    }).toString();
    const res = await authFetch(`/api/orders?${params}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch order (${res.status})`);
    const js = await res.json();
    const list = js.orders || [];
    return list.length ? list[0] : null;
  },
  async addTag(orderId, tag, store){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: "POST",
      headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ tag }),
    });
    if (!res.ok) throw new Error("Failed to add tag");
  },
  async removeTag(orderId, tag, store){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/remove-tag${qs}`, {
      method: "POST",
      headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ tag }),
    });
    if (!res.ok) throw new Error("Failed to remove tag");
  },
  async appendNote(orderId, append, store){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: "POST",
      headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ append }),
    });
    if (!res.ok) throw new Error("Failed to update note");
  },
  async fulfill(orderId, store){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/fulfill-tracked${qs}`, {
      method: "POST",
      headers: authHeaders({"Content-Type":"application/json"}),
    });
    if (!res.ok) throw new Error("Failed to fulfill order");
    return res.json();
  },
  async fulfillWithSelection(orderId, store, lineItemsByFulfillmentOrder){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/fulfill-tracked${qs}`, {
      method: "POST",
      headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ lineItemsByFulfillmentOrder }),
    });
    if (!res.ok) throw new Error("Failed to fulfill order");
    return res.json();
  },
  async getFulfillmentOrders(orderId, store){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await authFetch(`/api/orders/${encodeURIComponent(orderId)}/fulfillment-orders${qs}`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to fetch fulfillment orders");
    return res.json();
  },
  async fetchRecentTags(store){
    // Reuse orders endpoint to gather recent tags (approximate suggestions)
    const params = new URLSearchParams({
      limit: "50",
      status_filter: "all",
      store: (store || "").trim(),
    }).toString();
    const res = await authFetch(`/api/orders?${params}`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to fetch tags");
    const js = await res.json();
    return js.tags || [];
  }
};

export default function OrderLookup(){
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

  const [query, setQuery] = useState(() => {
    try {
      const params = new URLSearchParams(location.search);
      return params.get("q") || "";
    } catch { return ""; }
  });
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newTag, setNewTag] = useState("");
  const [noteAppend, setNoteAppend] = useState("");
  const [message, setMessage] = useState(null);
  const [overrideInfo, setOverrideInfo] = useState(null);
  const [fulfillBusy, setFulfillBusy] = useState(false);
  const [fulfillSuccess, setFulfillSuccess] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState([]);
  const [tagQuery, setTagQuery] = useState("");
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [foData, setFoData] = useState({ orders: [], mapByVariant: {}, selectedLineItemIds: new Set() });
  const [agentToday, setAgentToday] = useState({ name: "", fulfilledToday: 0, loading: false });

  const inputRef = useRef(null);
  useEffect(() => { try { inputRef.current?.focus(); } catch {} }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadAgentToday(){
      try {
        if (!cancelled) setAgentToday(prev => ({ ...prev, loading: true }));
        const qs = store ? `?store=${encodeURIComponent(store)}` : "";
        const res = await authFetch(`/api/agent/today-summary${qs}`, { headers: authHeaders({ "Accept": "application/json" }) });
        if (!res.ok) throw new Error("Failed");
        const js = await res.json();
        if (cancelled) return;
        setAgentToday({
          name: String(js?.user?.name || js?.user?.email || ""),
          fulfilledToday: Number(js?.fulfilled_today || 0),
          loading: false,
        });
      } catch {
        if (!cancelled) setAgentToday(prev => ({ ...prev, loading: false }));
      }
    }
    loadAgentToday();
    return () => { cancelled = true; };
  }, [store, order?.id, fulfillSuccess]);

  async function doSearch(number){
    const n = String(number || query || "").trim().replace(/^#/, "");
    if (!n) return;
    setLoading(true);
    setError(null);
    setOrder(null);
    setFulfillSuccess(false);
    try {
      const found = await API.searchOneByNumber(n, store);
      if (!found){
        setError("Order not found");
        setOrder(null);
        setOverrideInfo(null);
      } else {
        setOrder(found);
        // fetch enrichments (shipping/customer) best-effort
        try {
          const r = await authFetch(`/api/overrides?orders=${encodeURIComponent(String(found.number).replace(/^#/, ""))}&store=${encodeURIComponent(store)}`, { headers: authHeaders() });
          const js = await r.json();
          const ov = (js.overrides || {})[String(found.number).replace(/^#/, "")] || null;
          setOverrideInfo(ov || null);
        } catch {
          setOverrideInfo(null);
        }
        // Fetch fulfillment orders and preselect all line items by default
        try {
          const fo = await API.getFulfillmentOrders(found.id, store);
          const byVar = {};
          const sel = new Set();
          (fo.fulfillmentOrders || []).forEach(g => {
            (g.lineItems || []).forEach(li => {
              const vid = (li.variantId || "").trim();
              if (vid) {
                byVar[vid] = byVar[vid] || [];
                byVar[vid].push({ foId: g.id, id: li.id, remainingQuantity: li.remainingQuantity, sku: li.sku, title: li.title });
                if (li.remainingQuantity > 0) sel.add(li.id);
              }
            });
          });
          setFoData({ orders: (fo.fulfillmentOrders || []), mapByVariant: byVar, selectedLineItemIds: sel });
        } catch {
          setFoData({ orders: [], mapByVariant: {}, selectedLineItemIds: new Set() });
        }
        // prefetch tag suggestions
        try {
          const all = await API.fetchRecentTags(store);
          setTagSuggestions(all);
        } catch {
          setTagSuggestions([]);
        }
      }
      // reflect in URL
      try {
        const params = new URLSearchParams(location.search);
        params.set("q", n);
        history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
      } catch {}
    } catch (e){
      setError(e?.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleAddTag(){
    const tag = (newTag || "").trim();
    if (!tag || !order) return;
    try {
      await API.addTag(order.id, tag, store);
      setNewTag("");
      setMessage("Tag added");
      try { setTimeout(()=>setMessage(null), 1400); } catch {}
      // Optimistic update
      setOrder(prev => prev ? ({ ...prev, tags: Array.from(new Set([...(prev.tags || []), tag])) }) : prev);
    } catch (e){
      setError(e?.message || "Failed to add tag");
    }
  }
  async function handleRemoveTag(tag){
    if (!order || !tag) return;
    try {
      await API.removeTag(order.id, tag, store);
      setMessage("Tag removed");
      try { setTimeout(()=>setMessage(null), 1400); } catch {}
      setOrder(prev => prev ? ({ ...prev, tags: (prev.tags || []).filter(t => t !== tag) }) : prev);
    } catch (e){
      setError(e?.message || "Failed to remove tag");
    }
  }
  async function handleAppendNote(){
    const append = (noteAppend || "").trim();
    if (!append || !order) return;
    try {
      await API.appendNote(order.id, append, store);
      setNoteAppend("");
      setMessage("Note updated");
      try { setTimeout(()=>setMessage(null), 1400); } catch {}
      setOrder(prev => prev ? ({ ...prev, note: ((prev.note || "").trim() ? `${(prev.note || "").trim()}\n${append}` : append) }) : prev);
    } catch (e){
      setError(e?.message || "Failed to update note");
    }
  }

  const totalPrice = useMemo(() => {
    try { return Number(order?.total_price || 0).toFixed(2); } catch { return String(order?.total_price || 0); }
  }, [order]);
  const shippingPrice = useMemo(() => {
    try {
      if (order?.shipping_price == null) return null;
      return Number(order.shipping_price).toFixed(2);
    } catch { return null; }
  }, [order]);
  const discountTotal = useMemo(() => {
    try {
      if (order?.discount_total == null) return null;
      return Number(order.discount_total).toFixed(2);
    } catch { return null; }
  }, [order]);
  const currencyCode = useMemo(() => String(order?.currency_code || "").trim() || "", [order]);

  const isOrderFulfilled = useMemo(() => {
    if (!order) return false;
    const byFlag = !!order.considered_fulfilled;
    const variants = Array.isArray(order.variants) ? order.variants : [];
    const byVariants = variants.length > 0 && variants.every((v) => {
      const st = String(v?.status || "").toLowerCase();
      if (st === "fulfilled") return true;
      const uq = Number(v?.unfulfilled_qty);
      return Number.isFinite(uq) ? uq <= 0 : false;
    });
    const byFO = Array.isArray(foData?.orders) && foData.orders.length > 0 && foData.orders.every((g) =>
      ((g?.lineItems || []).every((li) => Number(li?.remainingQuantity || 0) <= 0))
    );
    return byFlag || byVariants || byFO;
  }, [order, foData]);

  const screenshotTimeline = useMemo(() => {
    const text = String(order?.note || "");
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const raw = String(lines[i] || "").trim();
      if (!raw) continue;

      // Legacy marker format: [AGENT_SCREENSHOT] <ts> <url>
      const mLegacy = raw.match(/^\[AGENT_SCREENSHOT\]\s+(\S+)\s+(\S+)$/);
      if (mLegacy) {
        out.push({ ts: String(mLegacy[1] || "").trim(), url: String(mLegacy[2] || "").trim(), agent: "" });
        continue;
      }

      // Human-readable one-line format: Agent screenshot (<ts>): <url>
      const mHuman = raw.match(/^Agent screenshot\s*\(([^)]+)\):\s*(\S+)$/i);
      if (mHuman) {
        out.push({ ts: String(mHuman[1] || "").trim(), url: String(mHuman[2] || "").trim(), agent: "" });
        continue;
      }

      // New multiline format:
      // Snip by <agent>
      // At: <ts>
      // <url> or Link: <url>
      const mSnip = raw.match(/^Snip by\s+(.+)$/i);
      if (mSnip) {
        const agent = String(mSnip[1] || "").trim();
        const atRaw = String(lines[i + 1] || "").trim();
        const urlRaw = String(lines[i + 2] || "").trim();
        const mAt = atRaw.match(/^At:\s*(.+)$/i);
        const mLink = urlRaw.match(/^Link:\s*(\S+)$/i);
        const mUrl = urlRaw.match(/^(https?:\/\/\S+)$/i);
        const finalUrl = mLink ? String(mLink[1] || "").trim() : (mUrl ? String(mUrl[1] || "").trim() : "");
        if (finalUrl) {
          out.push({
            ts: mAt ? String(mAt[1] || "").trim() : "",
            url: finalUrl,
            agent,
          });
          i += 2;
        }
      }
    }
    return out.filter((x) => x && x.url);
  }, [order?.note]);

  const commentLines = useMemo(() => {
    const text = String(order?.note || "").trim();
    if (!text) return [];
    const screenshotUrlSet = new Set((screenshotTimeline || []).map((x) => String(x?.url || "").trim()).filter(Boolean));
    return text
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter((line) => line &&
        !line.startsWith("[AGENT_SCREENSHOT]") &&
        !/^Agent screenshot\s*\(/i.test(line) &&
        !/^Snip by\s+/i.test(line) &&
        !/^At:\s+/i.test(line) &&
        !/^Link:\s+/i.test(line) &&
        !screenshotUrlSet.has(line)
      );
  }, [order?.note, screenshotTimeline]);

  function filteredSuggestions(){
    const q = (tagQuery || newTag || "").trim().toLowerCase();
    if (!q) return tagSuggestions.slice(0, 20);
    return (tagSuggestions || []).filter(t => String(t).toLowerCase().includes(q)).slice(0, 20);
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-2">
          <button
            onClick={()=>{ try { history.back(); } catch {} }}
            className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-100"
          >Back</button>
          <button
            onClick={()=>{ try { location.href = `/my-analytics?store=${encodeURIComponent(store)}`; } catch {} }}
            className="px-3 py-1.5 rounded-lg text-sm border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
          >My Analytics</button>
          <div className="ml-2 inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white">
            <button
              onClick={()=>setStore('irrakids')}
              className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === 'irrakids' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >Irrakids</button>
            <button
              onClick={()=>setStore('irranova')}
              className={`px-2 py-0.5 rounded-lg text-xs font-medium ${store === 'irranova' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >Irranova</button>
          </div>
          <div className="flex-1 flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1 ml-2">
            <span className="text-gray-500 text-xs">#</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e)=>setQuery(e.target.value)}
              onKeyDown={(e)=>{ if (e.key === 'Enter') doSearch(); }}
              placeholder="Enter order number"
              className="bg-transparent outline-none w-full text-sm"
            />
            <button
              onClick={()=>doSearch()}
              className="px-3 py-1 rounded-lg bg-blue-600 text-white text-sm font-semibold active:scale-[.98]"
            >Search</button>
          </div>
        </div>
        <div className="max-w-3xl mx-auto px-4 pb-2">
          <div className="text-[11px] text-gray-600">
            Agent: <span className="font-semibold">{agentToday.name || "—"}</span>
            <span className="mx-2">•</span>
            <span>Fulfilled today: <span className="font-semibold">{agentToday.loading ? "…" : agentToday.fulfilledToday}</span></span>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-4 pb-28">
        {loading && (
          <div className="text-gray-600">Loading…</div>
        )}
        {!loading && error && (
          <div className="text-red-600 mb-3">{error}</div>
        )}
        {!loading && message && (
          <div className="text-green-700 mb-3">{message}</div>
        )}
        {!loading && !order && !error && (
          <div className="text-gray-500">Search an order by number to see details.</div>
        )}
        {!loading && order && (
          <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 pt-4">
              <div className="text-[11px] text-gray-500 flex items-center justify-between">
                <span>Sales channel: {order.sales_channel || "—"}</span>
                <span>{(() => {
                  try {
                    if (!order.created_at) return "—";
                    const d = new Date(order.created_at);
                    return d.toLocaleString();
                  } catch { return order.created_at || "—"; }
                })()}</span>
              </div>
              <div className="mt-1 text-sm text-gray-700">
                <span className="font-medium">{order.customer || "Unknown customer"}</span>
                {order.shipping_city ? <span className="text-gray-500"> • {order.shipping_city}</span> : null}
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-baseline justify-between">
              <div>
                <div className="text-xs text-gray-500">Order</div>
                <div className="text-lg font-semibold">{order.number}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-gray-500">Total</div>
                <div className="text-lg font-semibold">{totalPrice}</div>
              </div>
            </div>
            <div className="px-4 pb-2">
              <div className="text-xs text-gray-500 mb-1">Customer & shipping</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Billing address</div>
                  <div className="font-medium">
                    {order?.billing_name || overrideInfo?.customer?.displayName || order.customer || "Unknown customer"}
                  </div>
                  <div className="text-gray-700">
                    {order?.billing_address1 || "—"}{order?.billing_address2 ? `, ${order.billing_address2}` : ""}
                  </div>
                  <div className="text-gray-700">
                    {[order?.billing_city, order?.billing_zip].filter(Boolean).join(" ") || "—"}
                  </div>
                  {(order?.billing_phone || overrideInfo?.phone || overrideInfo?.customer?.phone) && (
                    <div className="text-gray-700 mt-1">
                      {order?.billing_phone || overrideInfo?.phone || overrideInfo?.customer?.phone}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-green-300 bg-green-50 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-green-700 mb-1 font-semibold">Shipping address</div>
                  <div className="font-semibold text-green-900">
                    {(overrideInfo?.shippingAddress?.name || overrideInfo?.customer?.displayName || order.customer || "Unknown customer")}
                  </div>
                  <div className="text-green-800">
                    {overrideInfo?.shippingAddress?.address1 || order?.shipping_address1 || "—"}{(overrideInfo?.shippingAddress?.address2 || order?.shipping_address2) ? `, ${overrideInfo?.shippingAddress?.address2 || order?.shipping_address2}` : ""}
                  </div>
                  <div className="text-green-800">
                    {[overrideInfo?.shippingAddress?.city || order.shipping_city, overrideInfo?.shippingAddress?.zip || order?.shipping_zip].filter(Boolean).join(" ")}
                  </div>
                  {(overrideInfo?.shippingAddress?.phone || order?.shipping_phone || overrideInfo?.phone || overrideInfo?.customer?.phone) && (
                    <div className="text-green-800 mt-1">
                      {overrideInfo?.shippingAddress?.phone || order?.shipping_phone || overrideInfo?.phone || overrideInfo?.customer?.phone}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-sm font-semibold mb-2">Items</div>
              <ul className="space-y-4">
                {(order.variants || []).map((v, i) => (
                  <li key={i} className="py-2">
                    <div className="rounded-xl overflow-hidden border border-gray-200">
                      {v.image ? (
                        <img src={v.image} alt="" className="w-full max-h-96 object-contain bg-white" />
                      ) : (
                        <div className="w-full h-60 rounded-md bg-gray-100 border-b border-gray-200" />
                      )}
                      <div className="px-3 pt-2 flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center px-3 py-1 rounded-xl bg-purple-100 text-purple-800 border border-purple-200 text-sm font-bold">
                          Qty: {v.unfulfilled_qty ?? v.qty}
                        </span>
                        <span className="inline-flex items-center px-3 py-1 rounded-xl bg-amber-100 text-amber-900 border border-amber-200 text-sm font-bold">
                          Price: {(() => {
                            try {
                              if (v.unit_price == null) return "—";
                              return `${Number(v.unit_price).toFixed(2)}${v.currency_code ? ` ${v.currency_code}` : ""}`;
                            } catch { return "—"; }
                          })()}
                        </span>
                      </div>
                      <div className="p-3 flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{v.title || v.sku || "Item"}</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <span className="px-3 py-1 rounded-xl border-2 border-sky-300 bg-sky-100 text-sky-900 text-sm font-semibold">
                              Color: {v.color || "—"}
                            </span>
                            <span className="px-3 py-1 rounded-xl border-2 border-fuchsia-300 bg-fuchsia-100 text-fuchsia-900 text-sm font-semibold">
                              Size: {v.size || "—"}
                            </span>
                          </div>
                          {(() => {
                            const list = foData.mapByVariant[v.id] || [];
                            if (!list.length) return null;
                            return (
                              <div className="mt-2 border-t border-gray-200 pt-2">
                                <div className="text-xs font-semibold mb-1">Fulfillment</div>
                                <div className="space-y-1">
                                  {list.map((li, idx) => {
                                    const checked = foData.selectedLineItemIds.has(li.id);
                                    return (
                                      <label key={li.id} className="flex items-center gap-2 text-xs">
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={(e)=>{
                                            setFoData(prev => {
                                              const nextSel = new Set(prev.selectedLineItemIds);
                                              if (e.target.checked) nextSel.add(li.id); else nextSel.delete(li.id);
                                              return { ...prev, selectedLineItemIds: nextSel };
                                            });
                                          }}
                                        />
                                        <span className="flex-1 truncate">
                                          {li.title || v.title || v.sku || "Item"} — remaining: {li.remainingQuantity}
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
                          (v.status || "unknown") === "fulfilled" ? "bg-green-50 text-green-700 border-green-200" :
                          (v.status || "unknown") === "unfulfilled" ? "bg-yellow-50 text-yellow-800 border-yellow-200" :
                          "bg-gray-50 text-gray-700 border-gray-200"
                        }`}>{v.status || "unknown"}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="px-4 py-3 border-t border-gray-100">
              <div className="text-sm font-semibold mb-2">Order totals</div>
              <div className="rounded-xl border-2 border-blue-200 bg-blue-50 p-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                  <div className="px-3 py-2 rounded-lg bg-white border border-blue-200">
                    <div className="text-xs text-gray-500">Order total</div>
                    <div className="text-lg font-extrabold text-blue-900">{totalPrice}{currencyCode ? ` ${currencyCode}` : ""}</div>
                  </div>
                  <div className="px-3 py-2 rounded-lg bg-white border border-emerald-200">
                    <div className="text-xs text-gray-500">Shipping</div>
                    <div className="text-lg font-extrabold text-emerald-800">{shippingPrice ?? "—"}{currencyCode && shippingPrice != null ? ` ${currencyCode}` : ""}</div>
                  </div>
                  <div className="px-3 py-2 rounded-lg bg-white border border-rose-200">
                    <div className="text-xs text-gray-500">Discount</div>
                    <div className="text-lg font-extrabold text-rose-800">{discountTotal ?? "—"}{currencyCode && discountTotal != null ? ` ${currencyCode}` : ""}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-100">
              <div className="text-sm font-semibold mb-2">Comments</div>
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm min-h-[44px]">
                {!commentLines.length ? (
                  <span className="text-gray-500">No comments</span>
                ) : (
                  <ul className="list-disc pl-5 space-y-1">
                    {commentLines.map((l, i) => (<li key={i}>{l}</li>))}
                  </ul>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={noteAppend}
                  onChange={(e)=>setNoteAppend(e.target.value)}
                  placeholder="Write a comment"
                  className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2"
                />
                <button
                  onClick={handleAppendNote}
                  className="px-3 py-2 rounded-lg bg-gray-900 text-white text-sm font-semibold active:scale-[.98]"
                >Post</button>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-100">
              <div className="text-sm font-semibold mb-2">Agent screenshots</div>
              {!screenshotTimeline.length ? (
                <div className="text-sm text-gray-500">No screenshots yet.</div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-auto pr-1">
                  {screenshotTimeline.map((entry, idx) => (
                    <div key={`${entry.ts}-${idx}`} className="rounded-lg border border-gray-200 p-2 bg-gray-50">
                      <div className="text-[11px] text-gray-600 mb-2">
                        {entry.agent ? <span className="font-semibold mr-2">{entry.agent}</span> : null}
                        {(() => {
                          try { return new Date(entry.ts).toLocaleString(); } catch { return entry.ts || "—"; }
                        })()}
                      </div>
                      <a href={entry.url} target="_blank" rel="noreferrer" className="block">
                        <img
                          src={entry.url}
                          alt="Agent screenshot"
                          className="w-full max-h-72 object-contain rounded border border-gray-200 bg-white"
                          loading="lazy"
                        />
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-gray-100">
              <div className="text-sm font-semibold mb-2">Timeline</div>
              <div className="text-sm text-gray-700">
                <div className="flex items-center justify-between py-1">
                  <span className="text-gray-500">Created</span>
                  <span>{(() => { try { return order.created_at ? new Date(order.created_at).toLocaleString() : "—"; } catch { return order.created_at || "—"; } })()}</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-gray-500">Current tags</span>
                  <span className="truncate max-w-[60%] text-right">{(order.tags || []).join(", ") || "—"}</span>
                </div>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-100">
              <div className="text-sm font-semibold mb-2">Tags</div>
              <div className="flex items-center gap-2 flex-wrap">
                {(order.tags || []).length === 0 && (
                  <span className="text-xs text-gray-500">No tags</span>
                )}
                {(order.tags || []).map((t, i) => (
                  <span key={`${t}-${i}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 border border-gray-200 text-xs">
                    <span>{t}</span>
                    <button
                      onClick={()=>handleRemoveTag(t)}
                      className="text-gray-500 hover:text-red-600"
                      title="Remove tag"
                    >×</button>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={newTag}
                  onChange={(e)=>{ setNewTag(e.target.value); setTagQuery(e.target.value); setShowTagDropdown(true); }}
                  placeholder="Add a tag"
                  className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2"
                  onFocus={()=>{ setShowTagDropdown(true); }}
                  onBlur={()=>{ setTimeout(()=>setShowTagDropdown(false), 150); }}
                />
                <button
                  onClick={handleAddTag}
                  className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold active:scale-[.98]"
                >Add tag</button>
              </div>
              {showTagDropdown && filteredSuggestions().length > 0 && (
                <div className="mt-1 border border-gray-200 rounded-lg bg-white shadow-sm max-h-56 overflow-auto text-sm">
                  {filteredSuggestions().map((s, i) => (
                    <button
                      key={`${s}-${i}`}
                      onMouseDown={(e)=>{ e.preventDefault(); }}
                      onClick={()=>{ setNewTag(s); setShowTagDropdown(false); }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      {!!order && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t border-gray-200 bg-white/90 backdrop-blur">
          <div className="max-w-3xl mx-auto px-4 py-3">
            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={async ()=>{
                  if (fulfillBusy || isOrderFulfilled) return;
                  setFulfillBusy(true);
                  setError(null);
                  try {
                    // Build selection groups if there are any FO items
                    let res;
                    if (foData.orders && foData.orders.length > 0) {
                      const selIds = foData.selectedLineItemIds;
                      const groups = [];
                      foData.orders.forEach(g => {
                        const items = [];
                        (g.lineItems || []).forEach(li => {
                          if (selIds.has(li.id) && li.remainingQuantity > 0){
                            items.push({ id: li.id, quantity: li.remainingQuantity });
                          }
                        });
                        if (items.length > 0){
                          groups.push({ fulfillmentOrderId: g.id, fulfillmentOrderLineItems: items });
                        }
                      });
                      if (groups.length === 0){
                        setError("Select at least one line item to fulfill.");
                        setFulfillBusy(false);
                        return;
                      }
                      res = await API.fulfillWithSelection(order.id, store, groups);
                    } else {
                      res = await API.fulfill(order.id, store);
                    }
                    if (res && res.ok !== false){
                      // Optimistically flip selected items to fulfilled
                      setOrder(prev => {
                        if (!prev) return prev;
                        if (!foData.orders || foData.orders.length === 0){
                          const next = { ...prev, variants: (prev.variants || []).map(v => ({ ...v, status: "fulfilled", unfulfilled_qty: 0 })) };
                          return next;
                        }
                        // Compute which variant ids were fulfilled from selected FO lines
                        const variantIds = new Set();
                        foData.orders.forEach(g => {
                          (g.lineItems || []).forEach(li => {
                            if (foData.selectedLineItemIds.has(li.id)){
                              const vid = (li.variantId || "").trim();
                              if (vid) variantIds.add(vid);
                            }
                          });
                        });
                        const next = { ...prev, variants: (prev.variants || []).map(v => (variantIds.has(v.id) ? ({ ...v, status: "fulfilled", unfulfilled_qty: 0 }) : v)) };
                        return next;
                      });
                      // Update local FO data (set remainingQuantity=0 for selected ids and unselect)
                      setFoData(prev => {
                        try {
                          const sel = new Set(prev.selectedLineItemIds);
                          const updatedOrders = (prev.orders || []).map(grp => ({
                            ...grp,
                            lineItems: (grp.lineItems || []).map(li => sel.has(li.id) ? ({ ...li, remainingQuantity: 0 }) : li)
                          }));
                          return { ...prev, orders: updatedOrders, selectedLineItemIds: new Set() };
                        } catch {
                          return prev;
                        }
                      });
                      setFulfillSuccess(true);
                      try { setTimeout(()=>setFulfillSuccess(false), 2200); } catch {}
                      setMessage("Fulfilled successfully");
                      try { setTimeout(()=>setMessage(null), 2000); } catch {}
                    } else {
                      setError(`Fulfillment failed: ${((res && res.errors && res.errors[0] && res.errors[0].message) || "Unknown error")}`);
                    }
                  } catch (e){
                    setError(e?.message || "Failed to fulfill");
                  } finally {
                    setFulfillBusy(false);
                  }
                }}
                className={`flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm active:scale-[.98] shadow-sm ${
                  isOrderFulfilled
                    ? 'bg-gray-300 text-gray-700 cursor-not-allowed'
                    : 'bg-green-600 text-white hover:bg-green-700'
                }`}
              >
                <span className="font-semibold">{isOrderFulfilled ? 'Fulfilled' : (fulfillBusy ? 'Fulfilling…' : 'Fulfill')}</span>
              </button>
              {fulfillSuccess && (
                <div className="text-xs text-green-700 text-center">Success: order fulfilled and saved to analytics.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


