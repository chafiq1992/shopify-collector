import React, { useEffect, useRef, useState } from "react";
import { CheckCircle, PackageSearch, PackageCheck, Tag, StickyNote, XCircle, ChevronLeft, ChevronRight, Search, Image as ImageIcon, Settings, Boxes } from "lucide-react";

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
  const [selectedOutMap, setSelectedOutMap] = useState({}); // orderId -> Set<variantId>
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfilePicker, setShowProfilePicker] = useState(false);
  const [showConfirm, setShowConfirm] = useState(null); // 'collected' | 'out' | null
  const [confirmNav, setConfirmNav] = useState(false);
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
      limit: 25,
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
    setOrders(ords);
    setTags(data.tags || []);
    setPageInfo(data.pageInfo || { hasNextPage: false });
    setIndex(0);
    setLoading(false);
    setTotalCount(data.totalCount || ords.length);
  }

  useEffect(() => { load(); }, [statusFilter, tagFilter, codDate, excludeOut, profile, stockFilter, store]);

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
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
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
            <span className="text-sm text-gray-600">Orders</span>
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
                  onClick={()=>{ setStatusFilter("collect"); setShowDatePicker(true); setTimeout(()=>load(), 0); }}
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
                <Chip
                  label="Exclude OUT"
                  active={excludeOut}
                  onClick={()=> { setExcludeOut(v => !v); setTimeout(()=>load(), 0); }}
                />
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
          <div className="grid grid-cols-2 gap-3">
            <button onClick={()=>setShowConfirm('collected')} className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-white bg-green-600 hover:bg-green-700 active:scale-[.98] shadow-sm">
              <CheckCircle className="w-5 h-5"/> <span className="font-semibold">Collected</span>
            </button>
            <button onClick={()=>setShowConfirm('out')} className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-white bg-red-600 hover:bg-red-700 active:scale-[.98] shadow-sm">
              <XCircle className="w-5 h-5"/> <span className="font-semibold">OUT</span>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <button onClick={()=>{ if (confirmNav) { setConfirmNav(false); try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {}; gotoPrev(); } else { setConfirmNav(true); setTimeout(()=>setConfirmNav(false), 2000); } }} className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-gray-200 text-gray-900 hover:bg-gray-300 active:scale-[.98] shadow-sm">
              <ChevronLeft className="w-5 h-5"/> <span className="font-semibold">{confirmNav ? "Confirm Prev" : "Prev order"}</span>
            </button>
            <button onClick={()=>{ if (confirmNav) { setConfirmNav(false); try { if (navigator && navigator.vibrate) navigator.vibrate(10); } catch {}; gotoNext(); } else { setConfirmNav(true); setTimeout(()=>setConfirmNav(false), 2000); } }} className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-gray-900 text-white hover:bg:black active:scale-[.98] shadow-sm">
              <ChevronRight className="w-5 h-5"/> <span className="font-semibold">{confirmNav ? "Confirm Next" : "Next order"}</span>
            </button>
          </div>
        </div>
      </div>
      {showConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
            <h3 className="text-lg font-semibold mb-2">Confirm {showConfirm === 'collected' ? 'Collected' : 'OUT'}</h3>
            <p className="text-sm text-gray-600 mb-4">
              {showConfirm === 'collected' ? 'Mark this order as Collected and add tag pc?' : 'Append selected OUT titles to note and add tag out?'}
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={()=>setShowConfirm(null)} className="px-4 py-2 rounded-xl border border-gray-300 text-sm font-medium hover:bg-gray-50">Cancel</button>
              <button
                onClick={()=>{ const act = showConfirm === 'collected' ? ()=>handleMarkCollected(current) : ()=>handleMarkOut(current); setShowConfirm(null); act(); }}
                className={`px-4 py-2 rounded-xl text-white text-sm font-semibold ${showConfirm === 'collected' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
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

function OrderCard({ order, selectedOut, onToggleVariant, onMarkCollected, onMarkOut, onPrev, onNext, position, total }){
  return (
    <div className="rounded-2xl shadow-sm border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-14 border-b bg-gray-50">
        <span className="text-sm font-semibold">{order.number}</span>
        {order.customer && <span className="text-sm text-gray-500">· {order.customer}</span>}
        <div className="ml-auto flex items-center gap-1 overflow-x-auto whitespace-nowrap">
          {(order.tags || []).map(t => (
            <span key={t} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              <Tag className="w-3 h-3"/>{t}
            </span>
          ))}
        </div>
      </div>

      <div className="p-4">
        <div className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-2">
          {order.variants.map((v, i) => {
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
            return (
            <div key={v.id || i} className={`min-w-[260px] snap-start group relative rounded-2xl overflow-hidden border ${selectedOut.has(v.id) ? "border-red-500 ring-2 ring-red-300" : "border-gray-200"}`}>
              <div className="aspect-[4/3] bg-gray-100 flex items-center justify-center overflow-hidden">
                {v.image ? (
                  <img src={v.image} alt={v.sku || ""} className="w-full h-full object-cover" />
                ) : (
                  <div className="flex items-center justify-center w-full h-full text-gray-400"><ImageIcon className="w-8 h-8"/></div>
                )}
              </div>
              {normalizedStatus && (
                <span className={`absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-medium shadow
                  ${normalizedStatus === 'fulfilled' ? 'bg-green-600 text-white' : normalizedStatus === 'removed' ? 'bg-gray-500 text-white' : normalizedStatus === 'unfulfilled' ? 'bg-amber-500 text-white' : 'bg-gray-200 text-gray-800'}`}
                >{normalizedLabel}</span>
              )}
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
            );
          })}
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
        </div>
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1 rounded border text-sm">Cancel</button>
          <button onClick={()=>onSave(local)} className="px-3 py-1 rounded bg-blue-600 text-white text-sm">Save</button>
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


