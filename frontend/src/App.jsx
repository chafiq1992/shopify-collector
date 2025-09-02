import React, { useEffect, useRef, useState } from "react";
import { CheckCircle, PackageSearch, PackageCheck, Tag, StickyNote, XCircle, ChevronUp, ChevronDown, Search, Image as ImageIcon } from "lucide-react";

// Types (JSDoc only)
/**
 * @typedef {{ id?: string, image?: string|null, sku?: string|null, qty: number }} Variant
 * @typedef {{ id: string, number: string, customer?: string|null, variants: Variant[], note?: string|null, tags: string[] }} Order
 */

const API = {
  async getOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`/api/orders?${q}`);
    return res.json();
  },
  async addTag(orderId, tag) {
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ tag })
    });
  },
  async appendNote(orderId, append) {
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/append-note`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ append })
    });
  }
};

export default function App(){
  const [orders, setOrders] = useState([]);
  const [tags, setTags] = useState([]);
  const [index, setIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all"); // all|untagged|tagged_pc
  const [tagFilter, setTagFilter] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false });
  const [selectedOutMap, setSelectedOutMap] = useState({}); // orderId -> Set<variantId>

  const wsRef = useRef(null);

  async function load(){
    setLoading(true);
    const data = await API.getOrders({
      limit: 25,
      status_filter: statusFilter === "all" ? "" : statusFilter,
      tag_filter: tagFilter || "",
      search: search || ""
    });
    setOrders(data.orders || []);
    setTags(data.tags || []);
    setPageInfo(data.pageInfo || { hasNextPage: false });
    setIndex(0);
    setLoading(false);
  }

  useEffect(() => { load(); }, [statusFilter, tagFilter]);

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
        if (msg.type === "order.tag_added" || msg.type === "order.note_updated"){
          load();
        }
      } catch {}
    };
    ws.onclose = () => {
      setTimeout(() => { if (wsRef.current === ws) wsRef.current = null; }, 1000);
    };
    return () => ws.close();
  }, []);

  const total = orders.length;
  const current = orders[index] || null;

  function gotoNext(){
    setIndex(i => (i + 1) % Math.max(1, total || 1));
  }

  function toggleVariantOut(orderId, variantId){
    setSelectedOutMap(prev => {
      const set = new Set(prev[orderId] || []);
      if (set.has(variantId)) set.delete(variantId); else set.add(variantId);
      return { ...prev, [orderId]: set };
    });
  }

  async function handleMarkCollected(order){
    await API.addTag(order.id, "pc");
    gotoNext();
  }

  async function handleMarkOut(order){
    const selected = Array.from(selectedOutMap[order.id] || []);
    if (selected.length === 0){
      alert("Select the missing variant(s) before marking OUT.");
      return;
    }
    const skus = order.variants.filter(v => selected.includes(v.id)).map(v => v.sku).join(", ");
    await API.appendNote(order.id, `OUT: ${skus}`);
    setSelectedOutMap(prev => ({ ...prev, [order.id]: new Set() }));
    gotoNext();
  }

  // Swipe handling
  const startY = useRef(null);
  const deltaY = useRef(0);
  const onTouchStart = (e) => { startY.current = e.touches[0].clientY; deltaY.current = 0; };
  const onTouchMove  = (e) => { if (startY.current !== null) deltaY.current = e.touches[0].clientY - startY.current; };
  const onTouchEnd   = () => { if (startY.current !== null && deltaY.current < -80) gotoNext(); startY.current = null; deltaY.current = 0; };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <PackageSearch className="w-6 h-6" />
          <h1 className="text-xl font-semibold">Order Collector</h1>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-gray-600">Orders</span>
            <span className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-sm font-medium">{loading ? "…" : total}</span>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 pb-3 grid grid-cols-1 md:grid-cols-4 gap-2">
          <div className="flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-2">
            <Search className="w-4 h-4 text-gray-500" />
            <input
              value={search}
              onChange={(e)=>setSearch(e.target.value)}
              placeholder="Search order # or SKU"
              className="bg-transparent outline-none w-full text-sm"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap md:col-span-3">
            <Chip label="All" active={statusFilter === "all"} onClick={()=>setStatusFilter("all")} />
            <Chip label="Untagged" active={statusFilter === "untagged"} onClick={()=>setStatusFilter("untagged")} />
            <Chip label="Tagged PC" active={statusFilter === "tagged_pc"} onClick={()=>setStatusFilter("tagged_pc")} />
            <span className="mx-2 text-xs uppercase tracking-wide text-gray-400">Tags</span>
            {tags.map(t => (
              <Chip key={t} label={t} active={tagFilter === t} onClick={()=>setTagFilter(tagFilter === t ? null : t)} />
            ))}
            {tagFilter && (
              <button onClick={()=>setTagFilter(null)} className="text-xs text-blue-600 underline">Clear tag filter</button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {current ? (
          <div className="relative" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
            <OrderCard
              key={current.id}
              order={current}
              selectedOut={selectedOutMap[current.id] || new Set()}
              onToggleVariant={(vid)=>toggleVariantOut(current.id, vid)}
              onMarkCollected={()=>handleMarkCollected(current)}
              onMarkOut={()=>handleMarkOut(current)}
              onNext={gotoNext}
            />
            <div className="mt-3 flex justify-center items-center text-gray-500 text-xs">
              <ChevronUp className="w-4 h-4" />
              <span>Swipe up for next order</span>
            </div>
          </div>
        ) : (
          <div className="text-center py-24 text-gray-500">
            <PackageCheck className="w-10 h-10 mx-auto mb-3"/>
            <p>No orders match these filters.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function Chip({ label, active, onClick }){
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-sm border transition-colors ${active ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  );
}

function OrderCard({ order, selectedOut, onToggleVariant, onMarkCollected, onMarkOut, onNext }){
  return (
    <div className="rounded-2xl shadow-sm border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-gray-50">
        <span className="text-sm font-semibold">{order.number}</span>
        {order.customer && <span className="text-sm text-gray-500">· {order.customer}</span>}
        <div className="ml-auto flex items-center gap-1 flex-wrap">
          {(order.tags || []).map(t => (
            <span key={t} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              <Tag className="w-3 h-3"/>{t}
            </span>
          ))}
        </div>
      </div>

      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {order.variants.map((v, i) => (
          <div key={v.id || i} className={`group relative rounded-2xl overflow-hidden border ${selectedOut.has(v.id) ? "border-red-500 ring-2 ring-red-300" : "border-gray-200"}`}>
            <div className="aspect-[4/3] bg-gray-100 flex items-center justify-center overflow-hidden">
              {v.image ? (
                <img src={v.image} alt={v.sku || ""} className="w-full h-full object-cover" />
              ) : (
                <div className="flex items-center justify-center w-full h-full text-gray-400"><ImageIcon className="w-8 h-8"/></div>
              )}
            </div>
            <div className="p-3 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">SKU</span>
              <span className="font-mono text-xs bg-gray-50 px-2 py-1 rounded border border-gray-200">{v.sku}</span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-500">Qty</span>
              <span className="text-lg font-bold">{v.qty}</span>
            </div>
            <button
              onClick={()=>onToggleVariant(v.id)}
              className={`absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-medium shadow ${selectedOut.has(v.id) ? "bg-red-600 text-white" : "bg-white text-gray-800"}`}
              aria-pressed={selectedOut.has(v.id)}
              title={selectedOut.has(v.id) ? "Selected as OUT" : "Mark this variant as missing"}
            >
              {selectedOut.has(v.id) ? "OUT" : "Select OUT"}
            </button>
          </div>
        ))}
      </div>

      <div className="px-4 pb-2 flex items-center gap-2 text-sm text-gray-600">
        <StickyNote className="w-4 h-4"/>
        <span className="truncate">{order.note || "No notes"}</span>
      </div>

      <div className="px-4 pb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button onClick={onMarkCollected} className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-white bg-green-600 hover:bg-green-700 active:scale-[.98] shadow-sm">
            <CheckCircle className="w-5 h-5"/> <span className="font-semibold">Collected (Add tag pc)</span>
          </button>
          <button onClick={onMarkOut} className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-white bg-red-600 hover:bg-red-700 active:scale-[.98] shadow-sm">
            <XCircle className="w-5 h-5"/> <span className="font-semibold">OUT (append SKUs to note)</span>
          </button>
          <button onClick={onNext} className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-gray-900 text-white hover:bg:black active:scale-[.98] shadow-sm">
            <ChevronDown className="w-5 h-5"/> <span className="font-semibold">Next order</span>
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">Tip: swipe up on the card to advance.</p>
      </div>
    </div>
  );
}


