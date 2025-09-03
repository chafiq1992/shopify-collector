import React, { useEffect, useRef, useState } from "react";
import { CheckCircle, PackageSearch, PackageCheck, Tag, StickyNote, XCircle, ChevronLeft, ChevronRight, Search, Image as ImageIcon, Settings } from "lucide-react";

// Types (JSDoc only)
/**
 * @typedef {{ id?: string, image?: string|null, sku?: string|null, title?: string|null, qty: number }} Variant
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
  async removeTag(orderId, tag) {
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/remove-tag`, {
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
  const [statusFilter, setStatusFilter] = useState("collect"); // collect|verification
  const [codDate, setCodDate] = useState(""); // format YYYY-MM-DD from input
  const [tagFilter, setTagFilter] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false });
  const [selectedOutMap, setSelectedOutMap] = useState({}); // orderId -> Set<variantId>
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTagEditor, setShowTagEditor] = useState(false);

  const wsRef = useRef(null);

  async function load(){
    setLoading(true);
    // convert selected date to DD/MM/YY for tag
    const ddmmyy = codDate ? (()=>{
      const [y,m,d] = codDate.split("-");
      if (!y||!m||!d) return "";
      return `${d}/${m}/${y.slice(-2)}`;
    })() : "";
    const data = await API.getOrders({
      limit: 25,
      status_filter: statusFilter,
      tag_filter: tagFilter || "",
      search: search || "",
      cod_date: statusFilter === "collect" ? (ddmmyy || "") : ""
    });
    setOrders(data.orders || []);
    setTags(data.tags || []);
    setPageInfo(data.pageInfo || { hasNextPage: false });
    setIndex(0);
    setLoading(false);
  }

  useEffect(() => { load(); }, [statusFilter, tagFilter, codDate]);

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

  const total = orders.length;
  const current = orders[index] || null;

  function gotoNext(){
    setIndex(i => (i + 1) % Math.max(1, total || 1));
  }
  function gotoPrev(){
    setIndex(i => (i - 1 + Math.max(1, total || 1)) % Math.max(1, total || 1));
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

  // Swipe handling (left/right for prev/next)
  const startX = useRef(null);
  const startY = useRef(null);
  const deltaX = useRef(0);
  const deltaY = useRef(0);
  const onTouchStart = (e) => { startX.current = e.touches[0].clientX; startY.current = e.touches[0].clientY; deltaX.current = 0; deltaY.current = 0; };
  const onTouchMove  = (e) => { if (startX.current !== null) { deltaX.current = e.touches[0].clientX - startX.current; deltaY.current = e.touches[0].clientY - startY.current; } };
  const onTouchEnd   = () => {
    if (startX.current !== null) {
      const absX = Math.abs(deltaX.current);
      const absY = Math.abs(deltaY.current);
      if (absX > 80 && absX > absY * 1.5) {
        if (deltaX.current < 0) gotoNext(); else gotoPrev();
      }
    }
    startX.current = null; startY.current = null; deltaX.current = 0; deltaY.current = 0;
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <PackageSearch className="w-6 h-6" />
          <h1 className="text-xl font-semibold">Order Collector</h1>
          <div className="ml-auto flex items-center gap-2">
            <button aria-label="Settings" onClick={()=>setShowTagEditor(true)} disabled={!current} className="p-2 rounded-full hover:bg-gray-100 disabled:opacity-50">
              <Settings className="w-5 h-5" />
            </button>
            <span className="text-sm text-gray-600">Orders</span>
            <span className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-sm font-medium">{loading ? "…" : total}</span>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 pb-3 flex flex-col gap-2">
          <div className="flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-2">
            <Search className="w-4 h-4 text-gray-500" />
            <input
              value={search}
              onChange={(e)=>setSearch(e.target.value)}
              placeholder="Search order # or SKU"
              className="bg-transparent outline-none w-full text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <Chip
              label="Collect"
              active={statusFilter === "collect"}
              onClick={()=>{ setStatusFilter("collect"); setShowDatePicker(true); }}
            />
            <Chip
              label="Verification"
              active={statusFilter === "verification"}
              onClick={()=>{ setStatusFilter("verification"); setShowDatePicker(true); }}
            />
          </div>
          {showDatePicker && (
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-gray-400">Date</span>
              <input
                type="date"
                value={codDate}
                onChange={(e)=>{ setCodDate(e.target.value); setShowDatePicker(false); }}
                className="text-sm border border-gray-300 rounded px-2 py-1"
              />
              <button
                className="text-xs text-gray-500 underline"
                onClick={()=>{ setCodDate(""); setShowDatePicker(false); }}
              >Clear</button>
            </div>
          )}
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
              onPrev={gotoPrev}
              onNext={gotoNext}
            />
            <div className="mt-3 flex justify-center items-center gap-2 text-gray-500 text-xs">
              <ChevronLeft className="w-4 h-4" />
              <span>Swipe left/right to change order</span>
              <ChevronRight className="w-4 h-4" />
            </div>
          </div>
        ) : (
          <div className="text-center py-24 text-gray-500">
            <PackageCheck className="w-10 h-10 mx-auto mb-3"/>
            <p>No orders match these filters.</p>
          </div>
        )}
      </main>
      {showTagEditor && current && (
        <TagEditorModal
          order={current}
          onClose={()=>setShowTagEditor(false)}
          onAdd={async (tag)=>{ await API.addTag(current.id, tag); load(); }}
          onRemove={async (tag)=>{ await API.removeTag(current.id, tag); load(); }}
        />
      )}
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

function OrderCard({ order, selectedOut, onToggleVariant, onMarkCollected, onMarkOut, onPrev, onNext }){
  const [confirmCollected, setConfirmCollected] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [confirmNext, setConfirmNext] = useState(false);

  function twoTap(confirmFlag, setConfirmFlag, action){
    if (confirmFlag){ setConfirmFlag(false); action(); }
    else { setConfirmFlag(true); setTimeout(()=>setConfirmFlag(false), 2000); }
  }
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

      <div className="p-4">
        <div className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-2">
          {order.variants.map((v, i) => (
            <div key={v.id || i} className={`min-w-[260px] snap-start group relative rounded-2xl overflow-hidden border ${selectedOut.has(v.id) ? "border-red-500 ring-2 ring-red-300" : "border-gray-200"}`}>
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
                {v.title && <span className="text-xs text-gray-700 truncate">· {v.title}</span>}
                <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-500">Qty</span>
                <span className="text-2xl font-bold">{v.qty}</span>
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
      </div>

      <div className="px-4 pb-2 flex items-center gap-2 text-sm text-gray-600">
        <StickyNote className="w-4 h-4"/>
        <span className="truncate">{order.note || "No notes"}</span>
      </div>

      <div className="px-4 pb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button onClick={()=>twoTap(confirmCollected, setConfirmCollected, onMarkCollected)} className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-white bg-green-600 hover:bg-green-700 active:scale-[.98] shadow-sm">
            <CheckCircle className="w-5 h-5"/> <span className="font-semibold">{confirmCollected ? "Confirm Collected" : "Collected (Add tag pc)"}</span>
          </button>
          <button onClick={()=>twoTap(confirmOut, setConfirmOut, onMarkOut)} className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-white bg-red-600 hover:bg-red-700 active:scale-[.98] shadow-sm">
            <XCircle className="w-5 h-5"/> <span className="font-semibold">{confirmOut ? "Confirm OUT" : "OUT (append SKUs to note)"}</span>
          </button>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={()=>twoTap(confirmNext, setConfirmNext, onPrev)} className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-gray-200 text-gray-900 hover:bg-gray-300 active:scale-[.98] shadow-sm">
              <ChevronLeft className="w-5 h-5"/> <span className="font-semibold">{confirmNext ? "Confirm Prev" : "Prev order"}</span>
            </button>
            <button onClick={()=>twoTap(confirmNext, setConfirmNext, onNext)} className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-gray-900 text-white hover:bg:black active:scale-[.98] shadow-sm">
              <ChevronRight className="w-5 h-5"/> <span className="font-semibold">{confirmNext ? "Confirm Next" : "Next order"}</span>
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2">Tip: swipe left/right or use buttons to navigate.</p>
      </div>
    </div>
  );
}

function TagEditorModal({ order, onClose, onAdd, onRemove }){
  const [newTag, setNewTag] = useState("");
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
        <div className="flex items-center mb-3">
          <h2 className="text-lg font-semibold">Edit Tags · {order.number}</h2>
          <button onClick={onClose} className="ml-auto text-sm text-gray-600 underline">Close</button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {(order.tags || []).map(t => (
            <span key={t} className="inline-flex items-center gap-2 text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              <Tag className="w-3 h-3"/>{t}
              <button className="text-red-600" onClick={()=>onRemove(t)}>×</button>
            </span>
          ))}
          {(!order.tags || order.tags.length === 0) && (
            <span className="text-xs text-gray-500">No tags</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input value={newTag} onChange={(e)=>setNewTag(e.target.value)} placeholder="Add tag" className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm" />
          <button onClick={()=>{ if(newTag.trim()){ onAdd(newTag.trim()); setNewTag(""); } }} className="px-3 py-1 rounded bg-blue-600 text-white text-sm">Add</button>
        </div>
      </div>
    </div>
  );
}


