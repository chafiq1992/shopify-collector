import React, { useCallback, useEffect, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";

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
function isDigitsOnly(value) { return /^\d+$/.test(String(value || "").trim()); }
function normalizeLookupValue(value) { return String(value || "").trim().replace(/^#/, ""); }
function parseMerchantOrderReference(value) {
  const m = String(value || "").trim().match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  return { merchantId: Number(m[1]), orderNumber: m[2] };
}
function normalizeCompanyName(value) { return String(value || "").trim().toLowerCase(); }
function normalizeCityName(value) { return String(value || "").trim().toLowerCase(); }
function getCompanyCities(company) {
  const set = new Set();
  for (const city of (company?.cities || [])) {
    const text = String(city || "").trim();
    if (text) set.add(text);
  }
  for (const city of Object.values(company?.aliases || {})) {
    const text = String(city || "").trim();
    if (text) set.add(text);
  }
  return Array.from(set);
}

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
  const [cities, setCities] = useState([]);
  const [deliveryOrderId, setDeliveryOrderId] = useState(null);
  const [envoyCode, setEnvoyCode] = useState(null);
  const [companyId, setCompanyId] = useState("");
  const [partnerSendState, setPartnerSendState] = useState({ ok: null, message: "", sentAt: null });
  const [cityName, setCityName] = useState(order?.shipping_city || "");
  const [manualId, setManualId] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);
  const [queueRow, setQueueRow] = useState(null);
  const [showEdit, setShowEdit] = useState(false);
  const [printStatus, setPrintStatus] = useState(null);
  const logEndRef = useRef(null);
  const initRan = useRef(false);

  const [editFields, setEditFields] = useState({
    orderName: "",
    customerName: "",
    customerPhone: "",
    city: "",
    address: "",
    cashAmount: "",
    description: "",
    notes: "",
    allowOpen: "",
    isChange: "",
  });

  const setField = useCallback((k, v) => setEditFields(prev => ({ ...prev, [k]: v })), []);

  const addLog = useCallback((msg) => setLog(prev => [...prev, msg]), []);
  const refreshPartnerSendState = useCallback(async (envCode, orderId) => {
    const code = String(envCode || "").trim();
    const oid = Number(orderId || 0);
    if (!code || !oid) {
      setPartnerSendState({ ok: null, message: "", sentAt: null });
      return null;
    }
    try {
      const env = await dlvApi(`admin/envoy-notes/${encodeURIComponent(code)}`);
      const items = Array.isArray(env?.items) ? env.items : [];
      const item = items.find(x => Number(x?.orderId || x?.order_id) === oid) || null;
      const next = {
        ok: item?.sentOk === true ? true : (item?.sentOk === false ? false : null),
        message: String(item?.sentMsg || "").trim(),
        sentAt: item?.sentAt || null,
      };
      setPartnerSendState(next);
      return next;
    } catch {
      setPartnerSendState({ ok: null, message: "", sentAt: null });
      return null;
    }
  }, []);
  const applyResolvedCompany = useCallback((companyName) => {
    const wanted = normalizeCompanyName(companyName);
    if (!wanted) return false;
    const match = companies.find(c =>
      normalizeCompanyName(c?.name) === wanted ||
      normalizeCompanyName(c?.short) === wanted
    );
    if (!match?.id) return false;
    setCompanyId(String(match.id));
    return true;
  }, [companies]);
  const applyCompanyByCity = useCallback((city) => {
    const wanted = normalizeCityName(city);
    if (!wanted) return false;
    const match = companies.find(c =>
      getCompanyCities(c).some(name => normalizeCityName(name) === wanted)
    );
    if (!match?.id) return false;
    setCompanyId(String(match.id));
    return true;
  }, [companies]);
  useEffect(() => { try { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); } catch {} }, [log]);

  useEffect(() => {
    if (initRan.current) return;
    initRan.current = true;
    init();
  }, []);

  useEffect(() => {
    if (phase !== "manual") return;
    setManualId(prev => {
      const current = String(prev || "").trim();
      if (current) return prev;
      if (merchantId && orderNum) return `${merchantId}-${orderNum}`;
      return orderNum || prev;
    });
  }, [phase, merchantId, orderNum]);

  useEffect(() => {
    if (!companies.length) return;
    if (!companyId || companyId === "unassigned") return;
    const current = companies.find(c => String(c?.id) === String(companyId));
    if (!current?.id) setCompanyId("");
  }, [companies, companyId]);

  useEffect(() => {
    if (phase !== "company_select") return;
    if (!companies.length || companyId || !envoyCode) return;
    let cancelled = false;
    (async () => {
      try {
        const env = await dlvApi(`admin/envoy-notes/${encodeURIComponent(envoyCode)}`);
        if (cancelled) return;
        const applied = applyResolvedCompany(env?.company || env?.companyShort || env?.partnerSlug);
        if (!applied) applyCompanyByCity(cityName || editFields.city || order?.shipping_city || "");
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [phase, companies, companyId, envoyCode, applyResolvedCompany, applyCompanyByCity, cityName, editFields.city, order?.shipping_city]);

  useEffect(() => {
    if (phase !== "company_select") return;
    if (!companies.length || companyId) return;
    applyCompanyByCity(cityName || editFields.city || order?.shipping_city || "");
  }, [phase, companies, companyId, cityName, editFields.city, order?.shipping_city, applyCompanyByCity]);

  useEffect(() => {
    if (!envoyCode || !deliveryOrderId) {
      setPartnerSendState({ ok: null, message: "", sentAt: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const next = await refreshPartnerSendState(envoyCode, deliveryOrderId);
        if (cancelled || !next) return;
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [envoyCode, deliveryOrderId, refreshPartnerSendState]);

  function populateEditFromRow(row) {
    setEditFields({
      orderName: row.orderName || orderName,
      customerName: row.customerName || order?.customer || "",
      customerPhone: row.customerPhone || order?.shipping_phone || "",
      city: row.city || order?.shipping_city || "",
      address: row.address || order?.shipping_address1 || "",
      cashAmount: row.cashAmount ?? order?.total_price ?? "",
      description: row.description || "",
      notes: row.specialNote || "",
      allowOpen: "",
      isChange: "",
    });
    setCityName(row.city || order?.shipping_city || "");
  }

  function populateEditFromOrder() {
    setEditFields({
      orderName: orderName,
      customerName: order?.customer || "",
      customerPhone: order?.shipping_phone || "",
      city: order?.shipping_city || "",
      address: order?.shipping_address1 || "",
      cashAmount: order?.total_price ?? "",
      description: "",
      notes: "",
      allowOpen: "",
      isChange: "",
    });
  }

  async function lookupExistingDeliveryOrder({ merchant, query }) {
    if (!merchant || !query) return null;
    const res = await dlvApi("admin/orders", {
      query: {
        merchant_id: Number(merchant),
        q: String(query),
        limit: 10,
        include_total: true,
      },
    });
    const rows = Array.isArray(res?.rows) ? res.rows : [];
    const wantedOrder = normalizeLookupValue(query);
    const matched = rows.find(row => normalizeLookupValue(row?.orderName) === wantedOrder) || rows[0] || null;
    if (!matched?.id) return null;
    return {
      deliveryOrderId: Number(matched.id),
      envoyCode: String(matched.envoyCode || "").trim() || null,
      companyAssigned: Boolean(matched.envoyCompany),
      companyName: String(matched.envoyCompany || "").trim(),
    };
  }

  async function resolveManualReference(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) throw new Error("Enter a delivery order ID or envoy code.");

    const merchantOrderRef = parseMerchantOrderReference(value);
    if (merchantOrderRef) {
      const existing = await lookupExistingDeliveryOrder({
        merchant: merchantOrderRef.merchantId,
        query: merchantOrderRef.orderNumber,
      });
      if (existing) return existing;
    }

    if (isDigitsOnly(value) && normalizeLookupValue(value) === normalizeLookupValue(orderNum) && merchantId) {
      const existing = await lookupExistingDeliveryOrder({
        merchant: merchantId,
        query: value,
      });
      if (existing) return existing;
    }

    if (isDigitsOnly(value)) {
      return {
        deliveryOrderId: Number(value),
        envoyCode: null,
        companyAssigned: false,
        companyName: "",
      };
    }

    if (merchantId) {
      const existing = await lookupExistingDeliveryOrder({
        merchant: merchantId,
        query: orderNum,
      });
      if (existing) return existing;
    }

    try {
      const envDet = await dlvApi(`admin/envoy-notes/${encodeURIComponent(value)}`);
      const items = Array.isArray(envDet?.items) ? envDet.items : [];
      const wantedCode = normalizeLookupValue(value);
      const wantedOrder = normalizeLookupValue(orderNum);
      const matchedItem = items.find(item => {
        const itemCode = normalizeLookupValue(item?.code);
        const itemOrderName = normalizeLookupValue(item?.order_name || item?.orderName);
        return itemCode === wantedCode || itemOrderName === wantedOrder;
      }) || items[0] || null;

      const deliveryOrderId = Number(matchedItem?.orderId || matchedItem?.order_id || 0);
      if (!deliveryOrderId) {
        throw new Error("Envoy note found, but no delivery order is attached to it.");
      }

      return {
        deliveryOrderId,
        envoyCode: String(envDet?.code || value).trim(),
        companyAssigned: Boolean(envDet?.company),
        companyName: String(envDet?.company || "").trim(),
      };
    } catch (e) {
      if (e?.status === 404) {
        throw new Error("Order not found in delivery records.");
      }
      throw e;
    }
  }

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

      addLog("Loading companies & cities...");
      try { const c = await dlvApi("admin/envoy-companies"); setCompanies(Array.isArray(c) ? c : (c.items || [])); } catch { setCompanies([]); }
      try { const c = await dlvApi("ext/admin/cities"); setCities((c && c.items) || []); } catch { setCities([]); }

      if (!mid) { setPhase("merchant_select"); setBusy(false); return; }

      const cached = getCachedOrderId(orderNum);
      if (cached) {
        addLog(`Cached delivery ID: ${cached}`);
        setDeliveryOrderId(cached);
        populateEditFromOrder();
        try {
          const env = await dlvApi(`ext/admin/envoy-notes/for-order/${cached}`);
          if (env?.code) {
            setEnvoyCode(env.code);
            applyResolvedCompany(env.company);
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
        addLog(`Found in queue (row #${row.id})${row.hasError ? ` — HAS ERROR: ${row.errorType || "unknown"}` : ""}`);
        setQueueRow(row);
        populateEditFromRow(row);

        if (row.hasError) {
          addLog("Fix the error fields below, then click Create.");
          setShowEdit(true);
          setPhase("fix_errors");
        } else {
          await createNote(mid, row);
        }
      } else {
        addLog("Not found in queue.");
        populateEditFromOrder();
        const cached = getCachedOrderId(orderNum);
        if (cached) {
          setDeliveryOrderId(cached);
          try {
            const env = await dlvApi(`ext/admin/envoy-notes/assign-order/${cached}`, { method: "POST" });
            if (env?.code) { setEnvoyCode(env.code); applyResolvedCompany(env.company); addLog(`Envoy: ${env.code}`); setPhase("company_select"); return; }
          } catch {}
        }
        setPhase("manual");
      }
    } catch (e) {
      setError(e?.message || "Queue search failed");
      setPhase("error");
    }
  }

  async function handleFixAndCreate() {
    if (!queueRow || !merchantId) return;
    setBusy(true);
    setError(null);
    addLog("Saving fixes...");
    try {
      const updated = {
        ...queueRow,
        orderName: editFields.orderName || queueRow.orderName,
        customerName: editFields.customerName || queueRow.customerName,
        customerPhone: editFields.customerPhone || queueRow.customerPhone,
        city: editFields.city || queueRow.city,
        address: editFields.address || queueRow.address,
        cashAmount: editFields.cashAmount !== "" ? editFields.cashAmount : queueRow.cashAmount,
        description: editFields.description || queueRow.description,
        specialNote: editFields.notes || queueRow.specialNote,
      };
      const fixRes = await dlvApi(`ext/admin/merchant-queue/${merchantId}/update`, {
        method: "POST",
        body: { rows: [{ id: queueRow.id, orderName: updated.orderName, customerName: updated.customerName, customerPhone: updated.customerPhone, address: updated.address, city: updated.city, cashAmount: updated.cashAmount, description: updated.description, specialNote: updated.specialNote }] },
      });
      if (fixRes.errors) {
        setError("Order still has errors. Check the fields and try again.");
        setBusy(false);
        return;
      }
      addLog("Fixes saved.");
      setQueueRow(updated);
      setCityName(updated.city || cityName);
      await createNote(merchantId, updated);
    } catch (e) {
      setError(e?.message || "Fix failed");
    } finally {
      setBusy(false);
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
        applyResolvedCompany(env.company);
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

  async function handleSaveEdit() {
    if (!deliveryOrderId) return;
    setBusy(true);
    setError(null);
    addLog("Saving order changes...");
    try {
      const payload = {};
      if (editFields.orderName) payload.order_name = editFields.orderName;
      if (editFields.customerName) payload.customer_name = editFields.customerName;
      if (editFields.customerPhone) payload.customer_phone = editFields.customerPhone;
      if (editFields.city) payload.city = editFields.city;
      if (editFields.address) payload.address = editFields.address;
      if (editFields.description) payload.description = editFields.description;
      if (editFields.notes) payload.notes = editFields.notes;
      if (editFields.cashAmount !== "") payload.cash_amount = editFields.cashAmount;
      if (editFields.allowOpen === "1") payload.allow_open = true;
      if (editFields.allowOpen === "0") payload.allow_open = false;
      if (editFields.isChange === "1") payload.is_change = true;
      if (editFields.isChange === "0") payload.is_change = false;

      await dlvApi(`admin/verify/${deliveryOrderId}`, { method: "PUT", body: payload });
      setCityName(editFields.city || cityName);
      addLog("Order updated.");
      setShowEdit(false);
    } catch (e) {
      setError(e?.message || "Save failed");
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
        order_name: editFields.orderName || orderName,
        code: (item?.code || "").trim() || orderNum,
        fullname: (item?.fullname || editFields.customerName || order?.customer || "").trim(),
        phone: (item?.phone || editFields.customerPhone || order?.shipping_phone || "").trim(),
        partner_id: envDet?.partnerId || undefined,
        city: cityName || editFields.city || order?.shipping_city || "",
        address: (editFields.address || order?.shipping_address1 || cityName || "").trim(),
        price: Number(item?.price || editFields.cashAmount || order?.total_price || 0),
        product: (item?.product || editFields.description || `Order ${orderName}`).trim(),
        qty: Number(item?.qty || 1),
        note: (item?.note || editFields.notes || "").trim() || "no",
        change: Number(item?.change || 0),
        openpackage: item?.openpackage != null ? Number(item.openpackage) : 1,
      };

      await dlvApi(`admin/envoy-notes/items/${deliveryOrderId}/send`, { method: "POST", body: payload });
      addLog("Sent! Ready to print.");
      await refreshPartnerSendState(envoyCode, deliveryOrderId);
      setPhase("ready_print");
    } catch (e) {
      setPartnerSendState({ ok: false, message: e?.message || "Send failed", sentAt: null });
      setError(e?.message || "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function enqueueLabelToRelay(dlvOrderId, storeName, envoyLabelCode) {
    const apiKey = localStorage.getItem("relay_api_key") || "";
    const res = await authFetch("/api/enqueue-label", {
      method: "POST",
      headers: {
        ...authHeaders({ "Content-Type": "application/json" }),
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        delivery_order_id: String(dlvOrderId),
        store: storeName || null,
        envoy_code: envoyLabelCode || null,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try { const j = JSON.parse(text); detail = j.detail || text; } catch {}
      throw new Error(detail || `Enqueue failed (${res.status})`);
    }
    return res.json();
  }

  async function handlePrint(oid) {
    const id = oid || deliveryOrderId;
    if (!id) return;
    const labelUrl = `/api/delivery-label/${encodeURIComponent(id)}${envoyCode ? `?envoy_code=${encodeURIComponent(envoyCode)}` : ""}`;

    setBusy(true);
    setPrintStatus(null);
    try {
      addLog("Sending label to print relay...");
      const result = await enqueueLabelToRelay(id, store, envoyCode);
      addLog(`Queued! Job: ${result.job_id || "ok"} — printer agent will pick it up.`);
      setPrintStatus("success");
      setPhase("done");
    } catch (e) {
      addLog(`Relay failed: ${e.message} — opening in browser instead.`);
      window.open(labelUrl, "_blank", "width=450,height=600,scrollbars=yes");
      setPrintStatus("fallback");
      setPhase("done");
    } finally {
      setBusy(false);
    }
  }

  async function handleManualPrint() {
    const raw = String(manualId).trim();
    if (!raw) return;

    setBusy(true);
    setError(null);
    try {
      const resolved = await resolveManualReference(raw);
      setDeliveryOrderId(resolved.deliveryOrderId);
      setOrderMap(orderNum, resolved.deliveryOrderId);
      if (resolved.envoyCode) {
        setEnvoyCode(resolved.envoyCode);
        applyResolvedCompany(resolved.companyName);
        addLog(`Envoy: ${resolved.envoyCode}${resolved.companyName ? ` (${resolved.companyName})` : ""}`);
      }
      addLog(`Using order ID: ${resolved.deliveryOrderId}`);
      setBusy(false);
      await handlePrint(String(resolved.deliveryOrderId));
      return;
    } catch (e) {
      setError(e?.message || "Failed to resolve manual reference");
    } finally {
      setBusy(false);
    }
  }

  async function handleManualContinue() {
    const raw = String(manualId).trim();
    if (!raw) return;
    populateEditFromOrder();
    setBusy(true);
    setError(null);
    try {
      const resolved = await resolveManualReference(raw);
      const id = String(resolved.deliveryOrderId);
      setDeliveryOrderId(resolved.deliveryOrderId);
      setOrderMap(orderNum, resolved.deliveryOrderId);
      addLog(`Using order ID: ${id}`);

      if (resolved.envoyCode) {
        setEnvoyCode(resolved.envoyCode);
        applyResolvedCompany(resolved.companyName);
        addLog(`Envoy: ${resolved.envoyCode}${resolved.companyName ? ` (${resolved.companyName})` : ""}`);
        setPhase(resolved.companyAssigned ? "ready_print" : "company_select");
        return;
      }

      try {
        const env = await dlvApi(`ext/admin/envoy-notes/for-order/${id}`);
        if (env?.code) { setEnvoyCode(env.code); applyResolvedCompany(env.company); addLog(`Envoy: ${env.code}`); setPhase(env.company ? "ready_print" : "company_select"); return; }
      } catch {}
      try {
        const env = await dlvApi(`ext/admin/envoy-notes/assign-order/${id}`, { method: "POST" });
        if (env?.code) { setEnvoyCode(env.code); applyResolvedCompany(env.company); addLog(`Envoy: ${env.code}`); setPhase("company_select"); return; }
      } catch {}
      addLog("No envoy note found. You can print directly.");
      setPhase("ready_print");
    } catch (e) {
      setError(e?.message || "Manual lookup failed");
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
    setQueueRow(null);
    setShowEdit(false);
    setPartnerSendState({ ok: null, message: "", sentAt: null });
    initRan.current = false;
    init();
  }

  const selectedCompany = companyId && companyId !== "unassigned"
    ? companies.find(c => String(c?.id) === String(companyId)) || null
    : null;
  const companyCities = selectedCompany ? getCompanyCities(selectedCompany) : [];
  const cityOptions = companyCities.length ? companyCities : cities;
  const filteredCities = cityName
    ? cityOptions.filter(c => String(c).toLowerCase().includes(cityName.toLowerCase())).slice(0, 15)
    : cityOptions.slice(0, 15);
  const companyStepDone = partnerSendState.ok === true;
  const companyStepActive = phase === "company_select" || ((phase === "ready_print" || phase === "done") && !companyStepDone);
  const companyStepCls = companyStepDone
    ? "border-green-300 bg-green-50"
    : companyStepActive
      ? "border-blue-300 bg-blue-50 ring-2 ring-blue-200"
      : "border-gray-200 bg-gray-50 opacity-60";
  const showPartnerSendControls = Boolean(deliveryOrderId) && (phase === "company_select" || phase === "ready_print" || phase === "done");
  const showPartnerSendButton = showPartnerSendControls && Boolean(envoyCode) && partnerSendState.ok !== true;
  const partnerSendLabel = partnerSendState.ok === false ? "Resend to Partner" : "Send to Partner";
  const partnerSendStatusText = partnerSendState.ok === true
    ? `Sent successfully${partnerSendState.sentAt ? ` at ${partnerSendState.sentAt}` : ""}`
    : partnerSendState.ok === false
      ? (partnerSendState.message || "Last send failed")
      : (envoyCode ? "Not sent to partner yet" : "Create or assign an envoy note first");

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

  const stepOrder = ["init", "searching", "fix_errors", "creating", "company_select", "ready_print", "done"];
  const stepDone = (s) => stepOrder.indexOf(phase) > stepOrder.indexOf(s);
  const stepActive = (s) => phase === s;
  const stepCls = (s) => stepDone(s) ? "border-green-300 bg-green-50" : stepActive(s) ? "border-blue-300 bg-blue-50 ring-2 ring-blue-200" : "border-gray-200 bg-gray-50 opacity-60";

  const editSection = (
    <div className={`rounded-xl border p-3 transition-all ${showEdit ? "border-indigo-300 bg-indigo-50" : "border-gray-200 bg-gray-50"}`}>
      <button
        onClick={() => setShowEdit(!showEdit)}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-800"
      >
        <span className="flex items-center gap-2">
          <span className="text-base">&#9998;</span> Edit Order Info
          {queueRow?.hasError && <span className="text-[10px] font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded-full border border-red-200">ERROR: {queueRow.errorType || "fix needed"}</span>}
        </span>
        <span className="text-gray-400">{showEdit ? "▲" : "▼"}</span>
      </button>
      {showEdit && (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase">Order #</label>
              <input value={editFields.orderName} onChange={e => setField("orderName", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase">Customer</label>
              <input value={editFields.customerName} onChange={e => setField("customerName", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase">Phone</label>
              <input value={editFields.customerPhone} onChange={e => setField("customerPhone", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase">City</label>
              <input
                value={editFields.city}
                onChange={e => { setField("city", e.target.value); setCityName(e.target.value); }}
                list="dlv-city-list"
                className={`w-full text-sm border rounded-lg px-2 py-1.5 ${queueRow?.hasError && queueRow?.errorType === "city" ? "border-red-400 bg-red-50" : "border-gray-300"}`}
              />
              <datalist id="dlv-city-list">
                {filteredCities.map((c, i) => <option key={i} value={c} />)}
              </datalist>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase">Address</label>
            <input value={editFields.address} onChange={e => setField("address", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase">Cash Amount</label>
              <input type="number" value={editFields.cashAmount} onChange={e => setField("cashAmount", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase">Description</label>
              <input value={editFields.description} onChange={e => setField("description", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase">Notes</label>
            <input value={editFields.notes} onChange={e => setField("notes", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase">Allow Open</label>
              <select value={editFields.allowOpen} onChange={e => setField("allowOpen", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">
                <option value="">Unchanged</option>
                <option value="1">Yes</option>
                <option value="0">No</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase">Is Change</label>
              <select value={editFields.isChange} onChange={e => setField("isChange", e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">
                <option value="">Unchanged</option>
                <option value="1">Yes</option>
                <option value="0">No</option>
              </select>
            </div>
          </div>
          {phase === "fix_errors" ? (
            <button onClick={handleFixAndCreate} disabled={busy} className="w-full px-3 py-2.5 rounded-xl bg-green-600 text-white text-sm font-bold hover:bg-green-700 disabled:opacity-50 active:scale-[.98] shadow-md">
              {busy ? "Working..." : "Apply Fixes & Create"}
            </button>
          ) : deliveryOrderId ? (
            <button onClick={handleSaveEdit} disabled={busy} className="w-full px-3 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 active:scale-[.98]">
              {busy ? "Saving..." : "Save Changes"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );

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
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
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
            {phase === "fix_errors" && (
              <div className="ml-8 mt-2">
                <div className="text-xs text-red-700 mb-2">This order has errors in the queue. Fix the fields below then create.</div>
                <button onClick={handleFixAndCreate} disabled={busy} className="w-full px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50 active:scale-[.98]">
                  {busy ? "Working..." : "Fix & Create"}
                </button>
              </div>
            )}
          </div>

          {/* Edit Order Info (collapsible) */}
          {(phase === "fix_errors" || phase === "company_select" || phase === "ready_print" || phase === "done") && editSection}

          {/* Step 2: Company & Send */}
          <div className={`rounded-xl border p-3 transition-all ${companyStepCls}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${companyStepDone ? "bg-green-500 text-white" : "bg-gray-300 text-white"}`}>
                {companyStepDone ? "✓" : "2"}
              </span>
              <span className="text-sm font-semibold text-gray-800">Send to Partner</span>
            </div>
            {showPartnerSendControls && (
              <div className="ml-8 mt-2 space-y-2">
                <select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5">
                  <option value="">Select company...</option>
                  <option value="unassigned">Unassigned</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name} ({c.short})</option>)}
                </select>
                {selectedCompany && (
                  <div className="text-[11px] text-gray-600">
                    Using saved envoy company: <span className="font-semibold">{selectedCompany.name}</span>. Change it only if needed.
                  </div>
                )}
                <input
                  value={cityName}
                  onChange={e => setCityName(e.target.value)}
                  placeholder="City"
                  list="dlv-send-city-list"
                  className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5"
                />
                <datalist id="dlv-send-city-list">
                  {filteredCities.map((c, i) => <option key={i} value={c} />)}
                </datalist>
                {showPartnerSendButton && (
                  <button
                    onClick={handleSend}
                    disabled={busy || !envoyCode}
                    className="w-full px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50 active:scale-[.98] shadow-md"
                  >
                    {busy ? "Sending..." : partnerSendLabel}
                  </button>
                )}
                <div className={`text-xs ${partnerSendState.ok === true ? "text-green-700" : partnerSendState.ok === false ? "text-red-700" : "text-amber-700"}`}>
                  {partnerSendStatusText}
                </div>
              </div>
            )}
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
                  className="w-full px-4 py-2.5 rounded-xl bg-green-600 text-white text-sm font-bold hover:bg-green-700 disabled:opacity-50 active:scale-[.98] shadow-md flex items-center justify-center gap-2"
                >
                  {busy ? (
                    <><span className="animate-spin">⏳</span> Sending to printer...</>
                  ) : (
                    <><span className="text-lg">&#128424;</span> Print Label</>
                  )}
                </button>
                {printStatus === "success" && (
                  <div className="text-xs text-green-700 mt-1 text-center font-semibold">
                    Sent to printer agent! The label will print automatically. You can print again or close.
                  </div>
                )}
                {printStatus === "fallback" && (
                  <div className="text-xs text-amber-700 mt-1 text-center">
                    Relay unavailable — label opened in browser. Use Ctrl+P to print.
                  </div>
                )}
                <button
                  onClick={() => {
                    const id = deliveryOrderId;
                    if (id) {
                      const labelUrl = `/api/delivery-label/${encodeURIComponent(id)}${envoyCode ? `?envoy_code=${encodeURIComponent(envoyCode)}` : ""}`;
                      window.open(labelUrl, "_blank", "width=450,height=600,scrollbars=yes");
                    }
                  }}
                  className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Open label in browser
                </button>
              </div>
            )}
          </div>

          {/* Manual ID fallback */}
          {phase === "manual" && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <div className="text-sm font-semibold text-amber-900 mb-2">Order not found in queue</div>
              <div className="text-xs text-amber-800 mb-3">
                The order may have already been processed. Enter the delivery order ID, or an envoy code like {merchantId ? `${merchantId}-${orderNum}` : `7-${orderNum}`}, to reopen the normal print flow.
              </div>
              <input
                value={manualId}
                onChange={e => setManualId(e.target.value)}
                placeholder="Delivery Order ID or Envoy Code"
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
