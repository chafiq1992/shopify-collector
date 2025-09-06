import React, { useEffect, useRef, useState } from "react";
import { CheckCircle, PackageSearch, PackageCheck, StickyNote, XCircle, ChevronLeft, ChevronRight, Search, Image as ImageIcon, Settings, Boxes, Printer } from "lucide-react";
import { printOrdersLocally } from "./lib/localPrintClient";
import { enqueueOrdersToRelay, isRelayConfigured } from "./lib/printRelayClient";

// Types (JSDoc only)
/**
 * @typedef {{ id?: string, image?: string|null, sku?: string|null, title?: string|null, qty: number, status?: ('fulfilled'|'unfulfilled'|'removed'|'unknown') }} Variant
 * @typedef {{ id: string, number: string, customer?: string|null, shipping_city?: string|null, variants: Variant[], note?: string|null, tags: string[], considered_fulfilled?: boolean }} Order
 */

const API = {
  async getOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`/api/orders?${q}`);
    return res.json();
  },
  async addTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/add-tag${qs}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ tag })
    });
  },
  async removeTag(orderId, tag, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/remove-tag${qs}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ tag })
    });
  },
  async appendNote(orderId, append, store) {
    const qs = store ? `?store=${encodeURIComponent(store)}` : "";
    await fetch(`/api/orders/${encodeURIComponent(orderId)}/append-note${qs}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ append })
    });
  }
};

// Profiles configuration
const PROFILES = {
  stock: {
    id: "stock",
    label: "Stock",
  },
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
  const [excludeOut, setExcludeOut] = useState(false);
  const [excludeStockTags, setExcludeStockTags] = useState(false);
  const [selectedOutMap, setSelectedOutMap] = useState({}); // orderId -> Set<variantId>
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfilePicker, setShowProfilePicker] = useState(false);
  const [showConfirm, setShowConfirm] = useState(null); // 'collected' | 'out' | 'print' | null
  const [store, setStore] = useState(() => {
    try { return localStorage.getItem("orderCollectorStore") || "irrakids"; } catch { return "irrakids"; }
  });
  const [profile, setProfile] = useState(() => {
    try {
      const raw = localStorage.getItem("orderCollectorProfile");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  // Subfilter for Stock profile: 'btis' or 'en att b'
  const [stockFilter, setStockFilter] = useState(() => {
    try {
      return localStorage.getItem("orderCollectorStockFilter") || "btis";
    } catch { return "btis"; }
  });
  const [preset, setPreset] = useState(() => {
    try {
      const raw = localStorage.getItem("orderCollectorPreset");
      return raw ? JSON.parse(raw) : { collectPrefix: "cod", collectExcludeTag: "pc", verificationIncludeTag: "pc" };
    } catch { return { collectPrefix: "cod", collectExcludeTag: "pc", verificationIncludeTag: "pc" }; }
  });
  const [selectedOrderNumbers, setSelectedOrderNumbers] = useState(() => new Set());
  const [printBusy, setPrintBusy] = useState(false);
  const [printMsg, setPrintMsg] = useState(null);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorPreset", JSON.stringify(preset)); } catch {}
  }, [preset]);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorProfile", JSON.stringify(profile)); } catch {}
  }, [profile]);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorStockFilter", stockFilter); } catch {}
  }, [stockFilter]);
  useEffect(()=>{
    try { localStorage.setItem("orderCollectorStore", store); } catch {}
  }, [store]);

  const wsRef = useRef(null);
  const requestIdRef = useRef(0);

  function vibrate(ms = 20){
    try { if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate(ms); } catch {}
  }

  async function load(){
    const reqId = ++requestIdRef.current;
    setLoading(true);
    // convert selected date to DD/MM/YY for tag
    const ddmmyy = codDate ? (()=>{
      const [y,m,d] = codDate.split("-");
      if (!y||!m||!d) return "";
      return `${d}/${m}/${y.slice(-2)}`;
    })() : "";
    const usingStockProfile = !!(profile && profile.id === 'stock');
    // Build base query from Stock subfilter, else empty
    const baseQuery = usingStockProfile
      ? (stockFilter === 'btis'
          ? 'status:open fulfillment_status:unfulfilled tag:btis'
          : 'status:open fulfillment_status:unfulfilled tag:"en att b"')
      : '';
    const data = await API.getOrders({
      limit: 100,
      status_filter: (usingStockProfile ? "all" : statusFilter),
      tag_filter: tagFilter || "",
      search: search || "",
      cod_date: (!usingStockProfile && statusFilter === "collect") ? (ddmmyy || "") : "",
      collect_prefix: preset.collectPrefix,
      collect_exclude_tag: preset.collectExcludeTag,
      verification_include_tag: preset.verificationIncludeTag,
      exclude_out: usingStockProfile ? false : excludeOut,
      base_query: baseQuery,
      store,
    });
    if (reqId !== requestIdRef.current) return; // stale response
    let ords = data.orders || [];
    // Client-side exclusion for specific tags when enabled (non-Stock profile)
    if (!usingStockProfile && excludeStockTags){
      const disallowed = new Set(["btis", "en att b"]);
      ords = ords.filter(o => !((o.tags || []).some(t => disallowed.has(String(t).toLowerCase()))));
    }
    setOrders(ords);
    setTags(data.tags || []);
    setPageInfo(data.pageInfo || { hasNextPage: false });
    setIndex(0);
    setLoading(false);
    setTotalCount(data.totalCount || ords.length);
  }

  useEffect(() => { load(); }, [statusFilter, tagFilter, codDate, excludeOut, excludeStockTags, profile, stockFilter, store]);

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

  const [totalCount, setTotalCount] = useState(0);
  const total = orders.length;
  const current = orders[index] || null;

  function gotoNext(){
    setIndex(i => (i + 1) % Math.max(1, total || 1));
    vibrate(10);
  }
  function gotoPrev(){
    setIndex(i => (i - 1 + Math.max(1, total || 1)) % Math.max(1, total || 1));
    vibrate(10);
  }

  function toggleOrderSelected(orderNumber){
    setSelectedOrderNumbers(prev => {
      const next = new Set(prev);
      if (next.has(orderNumber)) next.delete(orderNumber); else next.add(orderNumber);
      return next;
    });
  }

  async function handlePrintOrders(orderNumbers){
    const list = orderNumbers.map(n => String(n));
    setPrintBusy(true);
    setPrintMsg(null);
    if (isRelayConfigured()){
      const r = await enqueueOrdersToRelay(list, 1);
      setPrintBusy(false);
      if (r.ok){
        setPrintMsg(`Queued ${r.queued ?? list.length} order(s) for printing`);
      } else {
        setPrintMsg(`Print queue failed: ${r.error || 'unknown error'}`);
      }
    } else {
      const res = await printOrdersLocally(list, 1);
      setPrintBusy(false);
      if (res.ok){
        setPrintMsg(`Printed ${res.results?.length ?? list.length} order(s)`);
      } else {
        setPrintMsg(`Print failed: ${res.error || 'unknown error'}`);
      }
    }
  }

  function toggleVariantOut(orderId, variantId){
    setSelectedOutMap(prev => {
      const set = new Set(prev[orderId] || []);
      if (set.has(variantId)) set.delete(variantId); else set.add(variantId);
      return { ...prev, [orderId]: set };
    });
  }

  async function handleMarkCollected(order){
    await API.addTag(order.id, "pc", store);
    vibrate(20);
    gotoNext();
  }

  async function handleMarkOut(order){
    const selected = Array.from(selectedOutMap[order.id] || []);
    if (selected.length === 0){
      alert("Select the missing variant(s) before marking OUT.");
      return;
    }
    const titles = order.variants
      .filter(v => selected.includes(v.id))
      .map(v => v.title || v.sku || "")
      .join(", ");
    await Promise.all([
      API.appendNote(order.id, `OUT: ${titles}`, store),
      API.addTag(order.id, "out", store),
    ]);
    setSelectedOutMap(prev => ({ ...prev, [order.id]: new Set() }));
    vibrate(30);
    gotoNext();
  }

  // Swipe navigation removed; use buttons below instead

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900 overflow-hidden">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <PackageSearch className="w-6 h-6" />
          <div className="ml-4 inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white">
            <button
              onClick={()=>setStore('irrakids')}
              className={`px-3 py-1 rounded-lg text-sm font-medium ${store === 'irrakids' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >Irrakids</button>
            <button
              onClick={()=>setStore('irranova')}
              className={`px-3 py-1 rounded-lg text-sm font-medium ${store === 'irranova' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >Irranova</button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button aria-label="Choose profile" onClick={()=>setShowProfilePicker(true)} className="p-2 rounded-full hover:bg-gray-100">
              <Boxes className={`w-5 h-5 ${profile?.id === 'stock' ? 'text-blue-600' : 'text-gray-700'}`} />
            </button>
            <button aria-label="Settings" onClick={()=>setShowSettings(true)} className="p-2 rounded-full hover:bg-gray-100">
              <Settings className="w-5 h-5" />
            </button>
            <PackageCheck className="w-4 h-4 text-gray-600" />
            <span className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-sm font-medium">{loading ? "…" : totalCount}</span>
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
            {profile && profile.id === 'stock' ? (
              <>
                <Chip
                  label="btis"
                  active={stockFilter === 'btis'}
                  onClick={()=>{ setStockFilter('btis'); setShowDatePicker(false); }}
                />
                <Chip
                  label="en att b"
                  active={stockFilter === 'en att b'}
                  onClick={()=>{ setStockFilter('en att b'); setShowDatePicker(false); }}
                />
              </>
            ) : (
              <>
                <Chip
                  label="Collect"
                  active={statusFilter === "collect"}
                  onClick={()=>{
                    setStatusFilter("collect");
                    setShowDatePicker(true);
                    if (!codDate) {
                      try {
                        const now = new Date();
                        const yyyy = now.getFullYear();
                        const mm = String(now.getMonth()+1).padStart(2,'0');
                        const dd = String(now.getDate()).padStart(2,'0');
                        setCodDate(`${yyyy}-${mm}-${dd}`);
                      } catch {}
                    }
                    setTimeout(()=>load(), 0);
                  }}
                />
                <Chip
                  label="Verification"
                  active={statusFilter === "verification"}
                  onClick={()=>{ setStatusFilter("verification"); setShowDatePicker(true); setTimeout(()=>load(), 0); }}
                />
                <Chip
                  label="Urgent"
                  active={statusFilter === "urgent"}
                  onClick={()=>{ setStatusFilter("urgent"); setShowDatePicker(false); setTimeout(()=>load(), 0); }}
                />
                <div className="flex flex-col gap-1">
                  <SmallChip
                    label="Exclude OUT"
                    active={excludeOut}
                    onClick={()=> { setExcludeOut(v => !v); setTimeout(()=>load(), 0); }}
                  />
                  <SmallChip
                    label="Exclude btis/en att b"
                    active={excludeStockTags}
                    onClick={()=> { setExcludeStockTags(v => !v); setTimeout(()=>load(), 0); }}
                  />
                </div>
              </>
            )}
          </div>
          {showDatePicker && (!profile || profile.id !== 'stock') && (
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

      <main className="max-w-5xl mx-auto px-4 py-4 pb-36">
        {current ? (
          <div className="relative">
            <OrderCard
              key={current.id}
              order={current}
              selectedOut={selectedOutMap[current.id] || new Set()}
              onToggleVariant={(vid)=>toggleVariantOut(current.id, vid)}
              onMarkCollected={()=>handleMarkCollected(current)}
              onMarkOut={()=>handleMarkOut(current)}
              onPrev={gotoPrev}
              onNext={gotoNext}
              position={index + 1}
              total={total}
              selectedForPrint={selectedOrderNumbers.has(current.number)}
              onToggleSelectOrder={()=>toggleOrderSelected(current.number)}
            />
          </div>
        ) : (
          <div className="text-center py-24 text-gray-500">
            <PackageCheck className="w-10 h-10 mx-auto mb-3"/>
            <p>No orders match these filters.</p>
          </div>
        )}
      </main>
      <div className="fixed bottom-0 inset-x-0 z-40 border-t border-gray-200 bg-white/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="grid grid-cols-1 gap-2 mb-2">
            <button onClick={()=>setShowConfirm('print')} disabled={printBusy} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl text-white text-sm bg-indigo-600 hover:bg-indigo-700 active:scale-[.98] shadow-sm disabled:opacity-60">
              <Printer className="w-4 h-4"/> <span className="font-semibold">{printBusy ? 'Printing…' : `Print${selectedOrderNumbers.size ? ` (${selectedOrderNumbers.size})` : ''}`}</span>
            </button>
            {printMsg && <div className="text-sm text-gray-600 text-center">{printMsg}</div>}
            {selectedOrderNumbers.size > 0 && (
              <div className="text-xs text-gray-700 text-center">
                <span className="font-medium">Selected:</span> {selectedOrderNumbers.size} order{selectedOrderNumbers.size>1?'s':''}
                <div className="mt-1 flex gap-1 flex-wrap justify-center">
                  {Array.from(selectedOrderNumbers).map(n => (
                    <span key={n} className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">{n}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={()=>setShowConfirm('collected')} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl text-white text-sm bg-green-600 hover:bg-green-700 active:scale-[.98] shadow-sm">
              <CheckCircle className="w-4 h-4"/> <span className="font-semibold">{`Collected${selectedOrderNumbers.size ? ` (${selectedOrderNumbers.size})` : ''}`}</span>
            </button>
            <button onClick={()=>setShowConfirm('out')} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl text-white text-sm bg-red-600 hover:bg-red-700 active:scale-[.98] shadow-sm">
              <XCircle className="w-4 h-4"/> <span className="font-semibold">{`OUT${selectedOrderNumbers.size ? ` (${selectedOrderNumbers.size})` : ''}`}</span>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <button onClick={()=>{ try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {}; gotoPrev(); }} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl bg-gray-200 text-gray-900 text-sm hover:bg-gray-300 active:scale-[.98] shadow-sm">
              <ChevronLeft className="w-4 h-4"/> <span className="font-semibold">Prev order</span>
            </button>
            <button onClick={()=>{ try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {}; gotoNext(); }} className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-xl bg-gray-900 text-white text-sm hover:bg:black active:scale-[.98] shadow-sm">
              <ChevronRight className="w-4 h-4"/> <span className="font-semibold">Next order</span>
            </button>
          </div>
        </div>
      </div>
      {showConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
            <h3 className="text-lg font-semibold mb-2">{showConfirm === 'collected' ? 'Confirm Collected' : showConfirm === 'out' ? 'Confirm OUT' : 'Confirm Print'}</h3>
            {(() => {
              const selected = Array.from(selectedOrderNumbers || []);
              const targets = selected.length > 0 ? orders.filter(o => selected.includes(o.number)) : (current ? [current] : []);
              const targetNumbers = targets.map(o => o.number);
              const missingOut = showConfirm === 'out' ? targets.filter(o => !(selectedOutMap[o.id] && selectedOutMap[o.id].size > 0)).map(o => o.number) : [];
              return (
                <div className="text-sm text-gray-600 mb-4">
                  {showConfirm === 'collected' && (
                    <p>{`Mark ${targetNumbers.length} order${targetNumbers.length>1?'s':''} as Collected and add tag pc?`}</p>
                  )}
                  {showConfirm === 'out' && (
                    <p>{`Append selected OUT titles to note and add tag out for ${targetNumbers.length} order${targetNumbers.length>1?'s':''}?`}</p>
                  )}
                  {showConfirm === 'print' && (
                    <p>{`Print ${targetNumbers.length} order${targetNumbers.length>1?'s':''}?`}</p>
                  )}
                  {targetNumbers.length > 0 && (
                    <div className="mt-2 flex gap-1 flex-wrap">
                      {targetNumbers.map(n => (
                        <span key={n} className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">{n}</span>
                      ))}
                    </div>
                  )}
                  {showConfirm === 'out' && missingOut.length > 0 && (
                    <div className="mt-3 text-xs text-red-600">
                      No OUT variants selected for: {missingOut.join(', ')}
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="flex justify-end gap-3">
              <button onClick={()=>setShowConfirm(null)} className="px-4 py-2 rounded-xl border border-gray-300 text-sm font-medium hover:bg-gray-50">Cancel</button>
              <button
                onClick={async ()=>{
                  const selected = Array.from(selectedOrderNumbers || []);
                  const targets = selected.length > 0 ? orders.filter(o => selected.includes(o.number)) : (current ? [current] : []);
                  setShowConfirm(null);
                  if (showConfirm === 'collected'){
                    await Promise.all(targets.map(o => API.addTag(o.id, 'pc', store)));
                    vibrate(20);
                    if (selected.length === 0) gotoNext();
                    if (selected.length > 0) setSelectedOrderNumbers(new Set());
                  } else if (showConfirm === 'out'){
                    // Only process orders with at least one selected variant
                    const processable = targets.filter(o => (selectedOutMap[o.id] && selectedOutMap[o.id].size > 0));
                    for (const o of processable){
                      const sel = Array.from(selectedOutMap[o.id] || []);
                      const titles = (o.variants || [])
                        .filter(v => sel.includes(v.id))
                        .map(v => v.title || v.sku || "")
                        .join(", ");
                      await Promise.all([
                        API.appendNote(o.id, `OUT: ${titles}`, store),
                        API.addTag(o.id, 'out', store),
                      ]);
                      setSelectedOutMap(prev => ({ ...prev, [o.id]: new Set() }));
                    }
                    vibrate(30);
                    if (selected.length === 0) gotoNext();
                    if (selected.length > 0) setSelectedOrderNumbers(new Set());
                  } else if (showConfirm === 'print'){
                    const nums = targets.map(o => o.number);
                    await handlePrintOrders(nums);
                    if (selected.length > 0) setSelectedOrderNumbers(new Set());
                  }
                }}
                className={`px-4 py-2 rounded-xl text-white text-sm font-semibold ${showConfirm === 'collected' ? 'bg-green-600 hover:bg-green-700' : showConfirm === 'out' ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
              >Confirm</button>
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <PresetSettingsModal
          preset={preset}
          onClose={()=>setShowSettings(false)}
          onSave={(p)=>{ setPreset(p); setShowSettings(false); load(); }}
        />
      )}
      {showProfilePicker && (
        <ProfilePickerModal
          profiles={PROFILES}
          current={profile}
          onClose={()=>setShowProfilePicker(false)}
          onSelect={(p)=>{ setProfile(p); setShowProfilePicker(false); }}
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

function SmallChip({ label, active, onClick }){
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${active ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  );
}

function tagPillClasses(tag){
  const t = String(tag || '').toLowerCase();
  if (t === 'out') return 'bg-red-100 text-red-700 ring-red-200';
  if (t === 'pc' || t === 'collected') return 'bg-green-100 text-green-700 ring-green-200';
  if (t === 'urgent') return 'bg-amber-100 text-amber-700 ring-amber-200';
  if (t === 'btis') return 'bg-purple-100 text-purple-700 ring-purple-200';
  if (t === 'en att b') return 'bg-amber-100 text-amber-700 ring-amber-200';
  return 'bg-gray-100 text-gray-700 ring-gray-200';
}

function OrderCard({ order, selectedOut, onToggleVariant, onMarkCollected, onMarkOut, onPrev, onNext, position, total, selectedForPrint, onToggleSelectOrder }){
  return (
    <div className="rounded-2xl shadow-sm border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-gray-50">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" className="w-4 h-4 accent-blue-600" checked={!!selectedForPrint} onChange={onToggleSelectOrder} />
          <span className="text-sm font-semibold">{order.number}</span>
        </label>
        {order.customer && <span className="text-sm text-gray-500">· {order.customer}</span>}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {(order.tags || []).map(t => (
            <span key={t} className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset ${tagPillClasses(t)}`}>{t}</span>
          ))}
        </div>
      </div>

      <div className="p-4">
        <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2">
          {(() => {
            const normalizedVariants = (order.variants || []).map(v => {
              const rawStatus = (v.status ?? '').toString();
              const statusLower = rawStatus.toLowerCase();
              const normalizedStatus = statusLower.includes('removed')
                ? 'removed'
                : statusLower.includes('unfulfilled')
                  ? 'unfulfilled'
                  : statusLower.includes('fulfilled')
                    ? 'fulfilled'
                    : (rawStatus ? statusLower : '');
              const normalizedLabel = normalizedStatus
                ? normalizedStatus.slice(0,1).toUpperCase() + normalizedStatus.slice(1)
                : '';
              return { ...v, __normalizedStatus: normalizedStatus, __normalizedLabel: normalizedLabel };
            });
            const variantsForDisplay = (normalizedVariants.length === 2 && normalizedVariants.some(v => v.__normalizedStatus === 'removed'))
              ? normalizedVariants.filter(v => v.__normalizedStatus !== 'removed')
              : normalizedVariants;
            return variantsForDisplay.map((v, i) => (
              <div key={v.id || i} className={`min-w-[220px] sm:min-w-[260px] snap-start group relative rounded-2xl overflow-hidden border ${selectedOut.has(v.id) ? "border-red-500 ring-2 ring-red-300" : "border-gray-200"}`}>
                <div className="aspect-[3/2] sm:aspect-[4/3] bg-gray-100 flex items-center justify-center overflow-hidden">
                  {v.image ? (
                    <img src={v.image} alt={v.sku || ""} className="w-full h-full object-cover" />
                  ) : (
                    <div className="flex items-center justify-center w-full h-full text-gray-400"><ImageIcon className="w-8 h-8"/></div>
                  )}
                </div>
                {v.__normalizedStatus && (
                  <span className={`absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-medium shadow
                    ${v.__normalizedStatus === 'fulfilled' ? 'bg-green-600 text-white' : v.__normalizedStatus === 'removed' ? 'bg-gray-500 text-white' : v.__normalizedStatus === 'unfulfilled' ? 'bg-amber-500 text-white' : 'bg-gray-200 text-gray-800'}`}
                  >{v.__normalizedLabel}</span>
                )}
                <div className="p-2 flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-gray-500">SKU</span>
                  <span className="font-mono text-xs bg-gray-50 px-2 py-1 rounded border border-gray-200">{v.sku}</span>
                  {v.title && <span className="text-xs text-gray-700 truncate">· {v.title}</span>}
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-500">Qty</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-red-600 text-white text-sm font-semibold">{v.qty}</span>
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
            ));
          })()}
        </div>
      </div>

      <div className="px-4 pb-2 flex items-center gap-2 text-sm text-gray-600">
        <StickyNote className="w-4 h-4"/>
        {order.shipping_city && <span>{order.shipping_city}</span>}
        <span className="truncate">{order.note || "No notes"}</span>
        <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-semibold">
          {position}/{total}
        </span>
      </div>
    </div>
  );
}

function PresetSettingsModal({ preset, onClose, onSave }){
  const [local, setLocal] = useState(preset);
  const [relayApiKey, setRelayApiKey] = useState(() => {
    try { return localStorage.getItem('relayApiKey') || '' } catch { return '' }
  });
  const [relayPcId, setRelayPcId] = useState(() => {
    try { return localStorage.getItem('relayPcId') || '' } catch { return '' }
  });
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
        <div className="flex items-center mb-3">
          <h2 className="text-lg font-semibold">Preset Settings</h2>
          <button onClick={onClose} className="ml-auto text-sm text-gray-600 underline">Close</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-gray-700 mb-1">Collect: Tag prefix before date</label>
            <input value={local.collectPrefix} onChange={(e)=>setLocal({...local, collectPrefix: e.target.value})} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
            <p className="text-xs text-gray-500 mt-1">Resulting tag: "{local.collectPrefix || 'cod'} DD/MM/YY"</p>
          </div>
          <div>
            <label className="block text-sm text-gray-700 mb-1">Collect: Exclude tag</label>
            <input value={local.collectExcludeTag} onChange={(e)=>setLocal({...local, collectExcludeTag: e.target.value})} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
          </div>
          <div>
            <label className="block text-sm text-gray-700 mb-1">Verification: Include tag</label>
            <input value={local.verificationIncludeTag} onChange={(e)=>setLocal({...local, verificationIncludeTag: e.target.value})} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
          </div>
          <div className="pt-2 border-t border-gray-200">
            <label className="block text-sm font-semibold text-gray-800 mb-1">Relay settings (browser only)</label>
            <label className="block text-xs text-gray-600 mb-1">API Key</label>
            <input value={relayApiKey} onChange={(e)=>setRelayApiKey(e.target.value)} placeholder="Set to your Cloud Run API_KEY" className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
            <label className="block text-xs text-gray-600 mt-2 mb-1">PC ID</label>
            <input value={relayPcId} onChange={(e)=>setRelayPcId(e.target.value)} placeholder="pc-lab-1" className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
            <p className="text-xs text-gray-500 mt-1">Saved privately in this browser. Used if app wasn’t rebuilt with keys.</p>
          </div>
        </div>
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1 rounded border text-sm">Cancel</button>
          <button onClick={() => { try { localStorage.setItem('relayApiKey', relayApiKey || ''); localStorage.setItem('relayPcId', relayPcId || ''); } catch {} onSave(local); }} className="px-3 py-1 rounded bg-blue-600 text-white text-sm">Save</button>
        </div>
      </div>
    </div>
  );
}

function ProfileBadge({ profile, onClick }){
  return (
    <button onClick={onClick} className="flex items-center gap-2 px-2 py-1 rounded-xl border border-gray-300 text-sm hover:bg-gray-50">
      <span className="inline-flex w-6 h-6 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-semibold">
        {(profile?.label || "?").slice(0,1).toUpperCase()}
      </span>
      <span className="text-gray-800">{profile?.label || "Choose profile"}</span>
    </button>
  );
}

function ProfilePickerModal({ profiles, current, onClose, onSelect }){
  const keys = Object.keys(profiles);
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
        <div className="flex items-center mb-3">
          <h2 className="text-lg font-semibold">Choose profile</h2>
          <button onClick={onClose} className="ml-auto text-sm text-gray-600 underline">Close</button>
        </div>
        <div className="space-y-2">
          {keys.map(k => {
            const p = profiles[k];
            const active = current && current.id === p.id;
            return (
              <button key={k} onClick={()=>onSelect(p)} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl border ${active ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                <span className="inline-flex w-8 h-8 items-center justify-center rounded-full bg-blue-600 text-white text-sm font-semibold">{p.label.slice(0,1).toUpperCase()}</span>
                <div className="text-left">
                  <div className="text-sm font-semibold">{p.label}</div>
                  <div className="text-xs text-gray-500 truncate">Custom filter applied</div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={()=>onSelect(null)} className="px-3 py-1 rounded-xl border border-gray-300 text-sm">Use default view</button>
        </div>
      </div>
    </div>
  );
}


