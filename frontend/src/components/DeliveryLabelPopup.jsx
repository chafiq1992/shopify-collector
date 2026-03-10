import React, { useCallback, useEffect, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";
import { enqueueLabelToRelay } from "../lib/printRelayClient";

const LS_MERCHANT = "dlvMerchantId";
const LS_ORDER_MAP = "dlvOrderIdMap";

async function dlvApi(path, { method = "GET", body, query } = {}) {
  let url = `/api/delivery/${path.replace(/^\/+/, "")}`;
  if (query && typeof query === "object") {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  const opts = { method, headers: authHeaders({ "Content-Type": "application/json" }) };
  if (body) opts.body = JSON.stringify(body);
  const res = await authFetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try { const j = JSON.parse(text); detail = j.detail || j.message || text; } catch {}
    const err = new Error(String(detail || `Request failed (${res.status})`));
    err.status = res.status;
    throw err;
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) return res.json();
  return { raw: await res.text() };
}

function savedMerchant() { try { return Number(localStorage.getItem(LS_MERCHANT)) || null; } catch { return null; } }
function saveMerchant(id) { try { localStorage.setItem(LS_MERCHANT, String(id)); } catch {} }
function getOrderMap() { try { return JSON.parse(localStorage.getItem(LS_ORDER_MAP) || "{}"); } catch { return {}; } }
function setOrderMap(num, id) { try { const m = getOrderMap(); m[String(num)] = id; localStorage.setItem(LS_ORDER_MAP, JSON.stringify(m)); } catch {} }
function getCachedOrderId(num) { return getOrderMap()[String(num)] || null; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default function DeliveryLabelPopup({ order, store, onClose }) {
  const orderNum = String(order?.number || "").replace(/^#/, "").trim();
  const orderName = `#${orderNum}`;

  const [phase, setPhase] = useState("init");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [log, setLog] = useState([]);
  const [merchants, setMerchants] = useState([]);
  const [merchantId, setMerchantId] = useState(savedMerchant);
  const [companies, setCompanies] = useState([]);
  const [deliveryOrderId, setDeliveryOrderId] = useState(null);
  const [envoyCode, setEnvoyCode] = useState(null);
  const [companyId, setCompanyId] = useState("");
  const [cityName, setCityName] = useState(order?.shipping_city || "");
  const [manualId, setManualId] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);
  const logEndRef = useRef(null);
  const initRan = useRef(false);

  const addLog = useCallback((msg) => setLog(prev => [...prev, msg]), []);
  useEffect(() => { try { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); } catch {} }, [log]);

  useEffect(() => {
    if (initRan.current) return;
    initRan.current = true;
    init();
  }, []);

  async function init() {
    setBusy(true);
    setError(null);
    try {
      const cfg = await authFetch("/api/delivery-config", { headers: authHeaders() });
      if (!cfg.ok) { setNotConfigured(true); setBusy(false); return; }
      const cfgJ = await cfg.json();
      if (!cfgJ.configured) { setNotConfigured(true); setBusy(false); return; }

      addLog("Loading merchants...");
      const m = await dlvApi("ext/admin/merchants");
      const list = (m && m.items) || [];
      setMerchants(list);

      let mid = savedMerchant();
      if (!mid || !list.some(x => Number(x.id) === Number(mid))) {
        mid = list.some(x => Number(x.id) === 7) ? 7 : (list.length ? Number(list[0].id) : null);
      }
      if (mid) { setMerchantId(mid); saveMerchant(mid); }

      addLog("Loading companies...");
      try { const c = await dlvApi("admin/envoy-companies"); setCompanies(Array.isArray(c) ? c : (c.items || [])); } catch { setCompanies([]); }

      if (!mid) { setPhase("merchant_select"); setBusy(false); return; }

      const cached = getCachedOrderId(orderNum);
      if (cached) {
        addLog(`Cached delivery ID: ${cached}`);
        setDeliveryOrderId(cached);
        try {
          const env = await dlvApi(`ext/admin/envoy-notes/for-order/${cached}`);
          if (env?.code) {
            setEnvoyCode(env.code);
            addLog(`Envoy: ${env.code} (${env.company || "no company"})`);
            setPhase(env.company ? "ready_print" : "company_select");
            setBusy(false);
            return;
          }
        } catch {}
      }

      await searchQueue(mid);
    } catch (e) {
      if (e?.status === 503) { setNotConfigured(true); setBusy(false); return; }
      setError(e?.message || "Init failed");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }

  async function searchQueue(mid) {
    setPhase("searching");
    addLog(`Searching queue for ${orderName}...`);
    try {
      const q = await dlvApi(`ext/admin/merchant-queue/${mid}`, { query: { limit: 500 } });
      const items = (q?.items) || [];
      const row = items.find(r => String(r.orderName || "").replace(/^#/, "").trim() === orderNum);

      if (row) {
        addLog(`Found in queue (row #${row.id})`);
        await createNote(mid, row);
      } else {
        addLog("Not found in queue.");
        const cached = getCachedOrderId(orderNum);
        if (cached) {
          setDeliveryOrderId(cached);
          try {
            const env = await dlvApi(`ext/admin/envoy-notes/assign-order/${cached}`, { method: "POST" });
            if (env?.code) { setEnvoyCode(env.code); addLog(`Envoy: ${env.code}`); setPhase("company_select"); return; }
          } catch {}
        }
        setPhase("manual");
      }
    } catch (e) {
      setError(e?.message || "Queue search failed");
      setPhase("error");
    }
  }

  async function createNote(mid, row) {
    setPhase("creating");
    setBusy(true);
    addLog("Creating delivery note...");
    try {
      if (row.hasError) {
        await dlvApi(`ext/admin/merchant-queue/${mid}/update`, {
          method: "POST",
          body: { rows: [{ id: row.id, orderName: row.orderName, customerName: row.customerName, customerPhone: row.customerPhone, address: row.address, city: row.city, cashAmount: row.cashAmount }] },
        });
      }

      const note = await dlvApi("ext/admin/merchant-notes/create", { method: "POST", query: { merchant_id: mid, force_new: true } });
      addLog(`Note #${note.id} created`);

      const addRes = await dlvApi(`ext/admin/merchant-notes/${note.id}/items`, { method: "POST", query: { merchant_id: mid }, body: { ids: [row.id] } });
      const r0 = ((addRes?.results) || []).find(x => Number(x.queueRowId) === Number(row.id) && x.status === "added");
      if (!r0?.orderId) throw new Error("Could not add order (duplicate or already processed)");

      const oid = r0.orderId;
      setDeliveryOrderId(oid);
      setOrderMap(orderNum, oid);
      addLog(`Order ID: ${oid}`);

      addLog("Assigning envoy note...");
      let env = null;
      try {
        env = await dlvApi(`ext/admin/envoy-notes/assign-order/${oid}`, { method: "POST" });
      } catch {
        try { await dlvApi(`ext/admin/merchant-notes/${note.id}/approve`, { method: "POST" }); } catch {}
        try { await dlvApi(`admin/merchant-notes/${note.id}/receive`, { method: "POST", body: { order_ids: [oid] } }); } catch {}
        for (let i = 0; i < 15; i++) {
          await sleep(800);
          try { env = await dlvApi(`ext/admin/envoy-notes/for-order/${oid}`); if (env?.code) break; env = null; } catch { env = null; }
        }
      }

      if (env?.code) {
        setEnvoyCode(env.code);
        addLog(`Envoy: ${env.code} (${env.company || "unassigned"})`);
        setPhase("company_select");
      } else {
        throw new Error("Envoy note not ready. Try again.");
      }
    } catch (e) {
      setError(e?.message || "Failed to create note");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!deliveryOrderId) return;
    setBusy(true);
    setError(null);
    addLog("Sending to partner...");
    try {
      if (companyId && companyId !== "unassigned") {
        await dlvApi(`admin/envoy-notes/items/${deliveryOrderId}/company`, { method: "PUT", body: { company_id: Number(companyId) } });
        addLog("Company set");
      } else if (companyId === "unassigned") {
        await dlvApi(`admin/envoy-notes/items/${deliveryOrderId}/company`, { method: "PUT", body: { unassigned: true } });
      }

      let envDet = null;
      try { if (envoyCode) envDet = await dlvApi(`admin/envoy-notes/${encodeURIComponent(envoyCode)}`); } catch {}
      const item = envDet?.items?.find(x => Number(x.orderId) === Number(deliveryOrderId)) || null;

      const payload = {
        order_name: orderName,
        code: (item?.code || "").trim() || orderNum,
        fullname: (item?.fullname || order?.customer || "").trim(),
        phone: (item?.phone || order?.shipping_phone || "").trim(),
        partner_id: envDet?.partnerId || undefined,
        city: cityName || order?.shipping_city || "",
        address: (order?.shipping_address1 || cityName || "").trim(),
        price: Number(item?.price || order?.total_price || 0),
        product: (item?.product || `Order ${orderName}`).trim(),
        qty: Number(item?.qty || 1),
        note: (item?.note || "").trim() || "no",
        change: Number(item?.change || 0),
        openpackage: item?.openpackage != null ? Number(item.openpackage) : 1,
      };

      await dlvApi(`admin/envoy-notes/items/${deliveryOrderId}/send`, { method: "POST", body: payload });
      addLog("Sent! Ready to print.");
      setPhase("ready_print");
    } catch (e) {
      setError(e?.message || "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function handlePrint(oid) {
    const id = oid || deliveryOrderId;
    if (!id) return;
    setBusy(true);
    try {
      const result = await enqueueLabelToRelay(String(id), store);
      if (result.ok) {
        addLog("Label sent to printer queue!");
        setPhase("done");
      } else {
        addLog(`Queue failed: ${result.error || "unknown"} — opening in browser`);
        window.open(`/api/delivery-label/${encodeURIComponent(id)}`, "_blank", "width=450,height=600,scrollbars=yes");
        setPhase("done");
      }
    } catch (e) {
      addLog(`Error: ${e?.message || e} — opening in browser`);
      window.open(`/api/delivery-label/${encodeURIComponent(id)}`, "_blank", "width=450,height=600,scrollbars=yes");
      setPhase("done");
    } finally {
      setBusy(false);
    }
  }

  function handlePrintInBrowser(oid) {
    const id = oid || deliveryOrderId;
    if (!id) return;
    window.open(`/api/delivery-label/${encodeURIComponent(id)}`, "_blank", "width=450,height=600,scrollbars=yes");
    addLog("Opened in browser");
  }

  async function handleManualPrint() {
    const id = String(manualId).trim();
    if (!id) return;
    setDeliveryOrderId(id);
    setOrderMap(orderNum, id);
    await handlePrint(id);
  }

  async function handleManualContinue() {
    const id = String(manualId).trim();
    if (!id) return;
    setDeliveryOrderId(Number(id));
    setOrderMap(orderNum, Number(id));
    addLog(`Using order ID: ${id}`);
    setBusy(true);
    try {
      try {
        const env = await dlvApi(`ext/admin/envoy-notes/for-order/${id}`);
        if (env?.code) { setEnvoyCode(env.code); addLog(`Envoy: ${env.code}`); setPhase(env.company ? "ready_print" : "company_select"); return; }
      } catch {}
      try {
        const env = await dlvApi(`ext/admin/envoy-notes/assign-order/${id}`, { method: "POST" });
        if (env?.code) { setEnvoyCode(env.code); addLog(`Envoy: ${env.code}`); setPhase("company_select"); return; }
      } catch {}
      addLog("No envoy note found. You can print directly.");
      setPhase("ready_print");
    } finally {
      setBusy(false);
    }
  }

  function selectMerchant(mid) {
    setMerchantId(Number(mid));
    saveMerchant(Number(mid));
    setBusy(true);
    searchQueue(Number(mid)).finally(() => setBusy(false));
  }

  async function handleRetry() {
    setError(null);
    setLog([]);
    setPhase("init");
    initRan.current = false;
    init();
  }

  if (notConfigured) {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4 border border-gray-200" onClick={e => e.stopPropagation()}>
          <div className="text-center mb-4">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-amber-100 flex items-center justify-center text-2xl">&#9888;</div>
            <div className="text-lg font-bold text-gray-900">Delivery Backend Not Configured</div>
          </div>
          <div className="text-sm text-gray-600 text-center mb-4">
            Set the <code className="px-1 py-0.5 bg-gray-100 rounded text-xs">DELVERY_BACKEND_URL</code> and <code className="px-1 py-0.5 bg-gray-100 rounded text-xs">DELVERY_ADMIN_TOKEN</code> environment variables on the server.
          </div>
          <button onClick={onClose} className="w-full px-4 py-2.5 rounded-xl bg-gray-200 text-gray-800 text-sm font-semibold hover:bg-gray-300">Close</button>
        </div>
      </div>
    );
  }

  const stepDone = (s) => {
    const order = ["init", "searching", "creating", "company_select", "ready_print", "done"];
    return order.indexOf(phase) > order.indexOf(s);
  };
  const stepActive = (s) => phase === s;
  const stepCls = (s) => stepDone(s) ? "border-green-300 bg-green-50" : stepActive(s) ? "border-blue-300 bg-blue-50 ring-2 ring-blue-200" : "border-gray-200 bg-gray-50 opacity-60";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full mx-4 border border-gray-200 max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div>
            <div className="text-lg font-bold text-gray-900">Delivery Label</div>
            <div className="text-sm text-gray-500">Order {orderName}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-500 text-lg">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Merchant selector */}
          {(phase === "merchant_select" || (merchants.length > 1 && !busy)) && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-600">Merchant:</span>
              <select
                value={merchantId || ""}
                onChange={e => selectMerchant(e.target.value)}
                className="flex-1 text-sm border border-gray-300 rounded-lg px-2 py-1.5"
              >
                <option value="">Select merchant...</option>
                {merchants.map(m => <option key={m.id} value={m.id}>{m.name} (#{m.id})</option>)}
              </select>
            </div>
          )}

          {/* Step 1: Search & Create */}
          <div className={`rounded-xl border p-3 transition-all ${stepCls("creating")}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${stepDone("creating") ? "bg-green-500 text-white" : "bg-gray-300 text-white"}`}>
                {stepDone("creating") ? "✓" : "1"}
              </span>
              <span className="text-sm font-semibold text-gray-800">Find &amp; Create</span>
              {(phase === "searching" || phase === "creating") && busy && <span className="text-xs text-blue-600 animate-pulse">Working...</span>}
            </div>
            {stepDone("creating") && deliveryOrderId && (
              <div className="text-xs text-green-700 ml-8">Order ID: {deliveryOrderId} &middot; Envoy: {envoyCode || "—"}</div>
            )}
          </div>

          {/* Step 2: Company & Send */}
          <div className={`rounded-xl border p-3 transition-all ${stepCls("company_select")}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${stepDone("company_select") ? "bg-green-500 text-white" : "bg-gray-300 text-white"}`}>
                {stepDone("company_select") ? "✓" : "2"}
              </span>
              <span className="text-sm font-semibold text-gray-800">Send to Partner</span>
            </div>
            {phase === "company_select" && (
              <div className="ml-8 mt-2 space-y-2">
                <select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">
                  <option value="">Select company...</option>
                  <option value="unassigned">Unassigned</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name} ({c.short})</option>)}
                </select>
                <input
                  value={cityName}
                  onChange={e => setCityName(e.target.value)}
                  placeholder="City"
                  className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"
                />
                <button
                  onClick={handleSend}
                  disabled={busy}
                  className="w-full px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50 active:scale-[.98] shadow-md"
                >
                  {busy ? "Sending..." : "Send to Partner"}
                </button>
              </div>
            )}
            {stepDone("company_select") && <div className="text-xs text-green-700 ml-8">Sent successfully</div>}
          </div>

          {/* Step 3: Print */}
          <div className={`rounded-xl border p-3 transition-all ${stepCls("ready_print")}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${stepDone("ready_print") ? "bg-green-500 text-white" : "bg-gray-300 text-white"}`}>
                {stepDone("ready_print") ? "✓" : "3"}
              </span>
              <span className="text-sm font-semibold text-gray-800">Print Label</span>
            </div>
            {(phase === "ready_print" || phase === "done") && (
              <div className="ml-8 mt-2 space-y-2">
                <button
                  onClick={() => handlePrint()}
                  disabled={busy}
                  className="w-full px-4 py-2.5 rounded-xl bg-green-600 text-white text-sm font-bold hover:bg-green-700 active:scale-[.98] shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <span className="text-lg">&#128424;</span> {busy ? "Sending..." : "Print Label"}
                </button>
                <button
                  onClick={() => handlePrintInBrowser()}
                  className="w-full px-3 py-1.5 rounded-xl border border-gray-300 text-gray-600 text-xs font-semibold hover:bg-gray-50 flex items-center justify-center gap-1.5"
                >
                  Open in Browser
                </button>
                {phase === "done" && <div className="text-xs text-green-700 mt-1 text-center">Label sent to printer queue. You can print again or close.</div>}
              </div>
            )}
          </div>

          {/* Manual ID fallback */}
          {phase === "manual" && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <div className="text-sm font-semibold text-amber-900 mb-2">Order not found in queue</div>
              <div className="text-xs text-amber-800 mb-3">
                The order may have already been processed. Enter the delivery system order ID manually, or print directly.
              </div>
              <input
                value={manualId}
                onChange={e => setManualId(e.target.value)}
                placeholder="Delivery Order ID"
                className="w-full text-sm border border-amber-300 rounded-lg px-3 py-2 mb-2"
              />
              <div className="flex gap-2">
                <button onClick={handleManualContinue} disabled={!manualId.trim() || busy} className="flex-1 px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50">
                  {busy ? "Loading..." : "Continue Flow"}
                </button>
                <button onClick={handleManualPrint} disabled={!manualId.trim()} className="flex-1 px-3 py-2 rounded-xl bg-green-600 text-white text-sm font-semibold disabled:opacity-50">
                  Print Directly
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3">
              <div className="text-sm text-red-800 font-semibold mb-1">Error</div>
              <div className="text-xs text-red-700">{error}</div>
              <button onClick={handleRetry} className="mt-2 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700">Retry</button>
            </div>
          )}

          {/* Log */}
          {log.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 max-h-32 overflow-y-auto">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Activity Log</div>
              {log.map((msg, i) => (
                <div key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                  <span className="text-gray-400 mt-0.5 flex-shrink-0">&#8226;</span>
                  <span>{msg}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
