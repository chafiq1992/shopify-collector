import React, { useEffect, useMemo, useRef, useState } from "react";

// Minimal API client (mirrors endpoints used elsewhere)
const API = {
  async searchOneByNumber(number, store){
    const params = new URLSearchParams({
      limit: "1",
      search: String(number || "").trim(),
      store: (store || "").trim(),
    }).toString();
    const res = await fetch(`/api/orders?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch order (${res.status})`);
    const js = await res.json();
    const list = js.orders || [];
    return list.length ? list[0] : null;
  },
  async addTag(orderId, tag, store){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ tag }),
    });
    if (!res.ok) throw new Error("Failed to add tag");
  },
  async removeTag(orderId, tag, store){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/remove-tag${qs}`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ tag }),
    });
    if (!res.ok) throw new Error("Failed to remove tag");
  },
  async appendNote(orderId, append, store){
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ append }),
    });
    if (!res.ok) throw new Error("Failed to update note");
  },
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

  const inputRef = useRef(null);
  useEffect(() => { try { inputRef.current?.focus(); } catch {} }, []);

  async function doSearch(number){
    const n = String(number || query || "").trim().replace(/^#/, "");
    if (!n) return;
    setLoading(true);
    setError(null);
    setOrder(null);
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
          const r = await fetch(`/api/overrides?orders=${encodeURIComponent(String(found.number).replace(/^#/, ""))}&store=${encodeURIComponent(store)}`);
          const js = await r.json();
          const ov = (js.overrides || {})[String(found.number).replace(/^#/, "")] || null;
          setOverrideInfo(ov || null);
        } catch {
          setOverrideInfo(null);
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
      // refresh
      await doSearch(order.number);
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
      await doSearch(order.number);
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
      await doSearch(order.number);
    } catch (e){
      setError(e?.message || "Failed to update note");
    }
  }

  const totalPrice = useMemo(() => {
    try { return Number(order?.total_price || 0).toFixed(2); } catch { return String(order?.total_price || 0); }
  }, [order]);

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-2">
          <button
            onClick={()=>{ try { history.back(); } catch {} }}
            className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-100"
          >Back</button>
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
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                <div className="font-medium">
                  {(overrideInfo?.shippingAddress?.name || overrideInfo?.customer?.displayName || order.customer || "Unknown customer")}
                </div>
                <div className="text-gray-700">
                  {overrideInfo?.shippingAddress?.address1 || null}{overrideInfo?.shippingAddress?.address2 ? `, ${overrideInfo?.shippingAddress?.address2}` : ""}
                </div>
                <div className="text-gray-700">
                  {[overrideInfo?.shippingAddress?.city || order.shipping_city, overrideInfo?.shippingAddress?.zip].filter(Boolean).join(" ")}
                </div>
                {(overrideInfo?.shippingAddress?.phone || overrideInfo?.phone || overrideInfo?.customer?.phone) && (
                  <div className="text-gray-700 mt-1">
                    {overrideInfo?.shippingAddress?.phone || overrideInfo?.phone || overrideInfo?.customer?.phone}
                  </div>
                )}
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
                      <div className="p-3 flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{v.title || v.sku || "Item"}</div>
                          <div className="text-xs text-gray-500">Qty: {v.unfulfilled_qty ?? v.qty}</div>
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
                  onChange={(e)=>setNewTag(e.target.value)}
                  placeholder="Add a tag"
                  className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2"
                />
                <button
                  onClick={handleAddTag}
                  className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold active:scale-[.98]"
                >Add tag</button>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-100">
              <div className="text-sm font-semibold mb-2">Comments</div>
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm min-h-[44px]">
                {(() => {
                  const text = (order.note || "").trim();
                  if (!text) return <span className="text-gray-500">No comments</span>;
                  const lines = text.split(/\r?\n/).filter(l => l && l.trim());
                  return (
                    <ul className="list-disc pl-5 space-y-1">
                      {lines.map((l, i) => (<li key={i}>{l}</li>))}
                    </ul>
                  );
                })()}
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
          </div>
        )}
      </main>
      {!!order && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t border-gray-200 bg-white/90 backdrop-blur">
          <div className="max-w-3xl mx-auto px-4 py-3">
            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={async ()=>{
                  try {
                    await API.addTag(order.id, "pc", store);
                    setMessage("Marked as fulfilled (pc)");
                    try { setTimeout(()=>setMessage(null), 1500); } catch {}
                    await doSearch(order.number);
                  } catch (e){
                    setError(e?.message || "Failed to mark fulfilled");
                  }
                }}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-white text-sm bg-green-600 hover:bg-green-700 active:scale-[.98] shadow-sm"
              >
                <span className="font-semibold">Fulfill</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


