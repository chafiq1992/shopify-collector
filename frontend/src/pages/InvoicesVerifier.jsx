import React, { useMemo, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";

// PDF.js
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function safeNum(x) {
  const n = Number(String(x ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractOrderNumberFromSendCode(sendCode) {
  const s = String(sendCode || "").trim();
  if (!s) return "";
  const m = s.match(/-(\d+)/);
  if (m) return m[1];
  const m2 = s.match(/(\d+)/);
  return m2 ? m2[1] : "";
}

function parseDhAmounts(text) {
  // Accept "290 DH", "290DH", "-10 DH", "299.50 DH", "299,50 DH"
  const re = /(-?\d+(?:[.,]\d+)?)\s*DH\b/gi;
  const out = [];
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const raw = String(m[1] || "").replace(",", ".");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function normalizeStatusLabel(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return "";
  if (v.includes("refus")) return "Refusé";
  if (v.includes("livr")) return "Livré";
  return "";
}

function findStatusInText(text) {
  // PDF extraction can mangle accents ("Livré" -> "LivrÃ©" etc). So match on stems.
  // Use [^\\s|]* instead of \\w* so we capture "Livré" and also mangled "LivrÃ©".
  const re = /\b(livr[^\s|]*|refus[^\s|]*)\b/i;
  const m = re.exec(String(text || ""));
  if (!m) return null;
  return {
    raw: m[0],
    label: normalizeStatusLabel(m[0]),
    index: typeof m.index === "number" ? m.index : -1,
    length: String(m[0] || "").length,
  };
}

function pickCrbtFeesTotal(monies) {
  const vals = (monies || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (vals.length < 2) return { crbt: null, fees: null, total: null, method: "none" };

  // Helper: prefer realistic fees (often 10–40) and prefer exact arithmetic match:
  // total = crbt - fees
  const EPS = 0.6; // allow minor float noise / OCR quirks
  let best = null;
  for (let i = 0; i < vals.length; i++) {
    for (let j = 0; j < vals.length; j++) {
      if (j === i) continue;
      for (let k = 0; k < vals.length; k++) {
        if (k === i || k === j) continue;
        const crbt = vals[i];
        const fees = vals[j];
        const total = vals[k];
        const err = Math.abs((crbt - fees) - total);
        if (err > EPS) continue;
        // scoring: smaller err, fees within common range, crbt typically >= fees in abs
        let score = err;
        if (Math.abs(fees) <= 80) score -= 0.25;
        if (Math.abs(crbt) >= Math.abs(fees)) score -= 0.05;
        if (best == null || score < best.score) best = { crbt, fees, total, score, method: "identity" };
      }
    }
  }
  if (best) return { crbt: best.crbt, fees: best.fees, total: best.total, method: best.method };

  // Fallback: if we only have 2 meaningful values and one looks like fees, compute crbt = total + fees.
  // This helps when the "CRBT DH" token breaks and we only catch fees + total.
  if (vals.length >= 2) {
    // try all pairs
    let best2 = null;
    for (let a = 0; a < vals.length; a++) {
      for (let b = 0; b < vals.length; b++) {
        if (a === b) continue;
        const fees = vals[a];
        const total = vals[b];
        if (Math.abs(fees) > 80) continue;
        const crbt = total + fees;
        // basic sanity: CRBT should be in a reasonable range
        if (!Number.isFinite(crbt)) continue;
        if (crbt < -100 || crbt > 20000) continue;
        // prefer totals that are not tiny (avoid picking fees as total)
        let score = Math.abs(total) < 50 ? 10 : 0;
        score += Math.abs(fees) <= 40 ? -0.2 : 0;
        if (best2 == null || score < best2.score) best2 = { crbt, fees, total, score, method: "computed" };
      }
    }
    if (best2) return { crbt: best2.crbt, fees: best2.fees, total: best2.total, method: best2.method };
  }

  // Last resort: keep previous heuristic (last 3)
  if (vals.length >= 3) {
    const last3 = vals.slice(-3);
    return { crbt: last3[0], fees: last3[1], total: last3[2], method: "last3" };
  }
  return { crbt: null, fees: null, total: null, method: "none" };
}

function normalizePdfLines(textItems) {
  // textItems: [{str, x, y}]
  const items = (textItems || [])
    .filter((t) => t && String(t.str || "").trim())
    .map((t) => ({ str: String(t.str || "").trim(), x: Number(t.x || 0), y: Number(t.y || 0) }))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let current = [];
  let currentY = null;
  // Some PDFs place the numeric columns on a slightly different baseline than text,
  // so a looser tolerance helps keep a full row on the same "line".
  const Y_TOL = 4.5;

  for (const it of items) {
    if (currentY === null) {
      currentY = it.y;
      current = [it];
      continue;
    }
    if (Math.abs(it.y - currentY) <= Y_TOL) {
      current.push(it);
    } else {
      current.sort((a, b) => a.x - b.x);
      lines.push(current.map((x) => x.str).join(" ").replace(/\s+/g, " ").trim());
      currentY = it.y;
      current = [it];
    }
  }
  if (current.length) {
    current.sort((a, b) => a.x - b.x);
    lines.push(current.map((x) => x.str).join(" ").replace(/\s+/g, " ").trim());
  }
  return lines.filter(Boolean);
}

function parseInvoiceHeader(lines) {
  const all = (lines || []).join("\n");
  const invoiceNumber = (() => {
    const m = all.match(/Facture\s*:\s*([A-Z0-9-]+)/i);
    return m ? m[1] : "";
  })();
  const invoiceDate = (() => {
    const m = all.match(/Date\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[^\n]*)/i);
    return m ? m[1].trim() : "";
  })();
  const invoiceTotalNet = (() => {
    // Prefer explicit "Total Net"
    const m = all.match(/Total\s*Net\s*([\d.,-]+)\s*DH/i);
    if (m) return safeNum(m[1]);
    // Fallback: header "Total : 9752 DH" (first occurrence)
    const m2 = all.match(/\bTotal\s*:\s*([\d.,-]+)\s*DH/i);
    return m2 ? safeNum(m2[1]) : null;
  })();
  const invoiceTotalBrut = (() => {
    const m = all.match(/Total\s*Brut\s*([\d.,-]+)\s*DH/i);
    return m ? safeNum(m[1]) : null;
  })();
  const invoiceFeesTotal = (() => {
    const m = all.match(/\bFrais\s*([\d.,-]+)\s*DH/i);
    return m ? safeNum(m[1]) : null;
  })();
  return { invoiceNumber, invoiceDate, invoiceTotalNet, invoiceTotalBrut, invoiceFeesTotal };
}

function parseLionexInvoice(lines) {
  const hdr = parseInvoiceHeader(lines);

  const rows = [];
  // A delivery row contains "Code d'envoi" like "7-127130".
  // IMPORTANT: don't match invoice header patterns like "280126-062670" (too many digits before dash).
  const codeRe = /\b\d{1,2}-\d{4,}\b/;
  const dateRe = /\b\d{4}-\d{2}-\d{2}\b/g;
  const phoneRe = /\b0\d{9}\b/;

  const list = (lines || []);
  for (let i = 0; i < list.length; i++) {
    const base = String(list[i] || "").trim();
    if (!codeRe.test(base)) continue;
    const sendCode = (base.match(codeRe) || [])[0] || "";
    if (!sendCode) continue;

    // Some PDFs wrap the last columns (DH amounts) to a continuation line.
    // Merge following lines until we capture:
    // - status (Livré/Refusé) and
    // - at least 3 DH amounts (CRBT/Frais/Total),
    // or until the next row begins.
    let combined = base;
    const pieces = [base];
    let monies = parseDhAmounts(combined);
    let statusMeta = findStatusInText(combined);
    let statusFound = statusMeta?.label || "";
    let hasStatus = !!statusFound;
    let j = i + 1;
    let merges = 0;
    while (j < list.length) {
      const next = String(list[j] || "").trim();
      if (!next) { j++; continue; }
      if (codeRe.test(next)) break; // next row
      // Stop at footer/summary sections to avoid accidentally merging totals into the last shipment row
      if (/^(Total\b|Total\s+Brut\b|Total\s+Net\b|Sauf\b|Lionex\b|Facture\b|Colis\b|Statut\s*:)/i.test(next)) break;
      // Merge a small number of continuation lines even if they don't contain digits,
      // because some PDFs put "Livré | City" on a separate line.
      if (merges >= 4) break;
      pieces.push(next);
      combined = `${combined} ${next}`.replace(/\s+/g, " ").trim();
      monies = parseDhAmounts(combined);
      if (!statusFound) {
        const m2 = findStatusInText(next) || findStatusInText(combined);
        statusFound = m2?.label || statusFound;
        statusMeta = statusMeta || m2 || null;
      }
      hasStatus = hasStatus || !!statusFound;
      merges += 1;
      // Stop early when we have what we need
      if (hasStatus && monies.length >= 3) break;
      j++;
    }
    // Skip merged continuation lines
    i = j - 1;

    const dates = (combined.match(dateRe) || []).slice(0, 2);
    const pickupDate = dates[0] || "";
    const deliveryDate = dates[1] || "";

    const phone = (combined.match(phoneRe) || [])[0] || "";
    const metaFinal = statusMeta || findStatusInText(combined);
    const status = statusFound || metaFinal?.label || "";

    // Collect all DH amounts, take last 3 as (crbt, fees, total) — consistent with PDF example.
    const picked = pickCrbtFeesTotal(monies);
    const crbt = picked.crbt != null ? picked.crbt : null;
    const fees = picked.fees != null ? picked.fees : null;
    const total = picked.total != null ? picked.total : null;

    // City is “whatever is between status and the first money amount”
    let city = "";
    try {
      const meta = metaFinal;
      const idxStatus = meta && meta.index >= 0 ? meta.index : -1;
      if (idxStatus >= 0) {
        const afterStatus = combined.slice(idxStatus + (meta?.length || status.length)).trim();
        // In these PDFs, the CRBT number often appears *before* "DH" on the next visual line,
        // so cut city at the first numeric token, not only at "DH".
        const firstNumberIdx = afterStatus.search(/-?\d+(?:[.,]\d+)?/);
        const firstMoneyIdx = afterStatus.search(/-?\d+(?:[.,]\d+)?\s*DH\b/i);
        const cutIdx = (firstNumberIdx >= 0 ? firstNumberIdx : firstMoneyIdx);
        city = (cutIdx >= 0 ? afterStatus.slice(0, cutIdx) : afterStatus)
          .replace(/\s+/g, " ")
          .trim();
        // Clean common encoding artifacts and separators
        city = city
          .replace(/^\|+/, "")
          .replace(/^(?:Ã©|é)\s+/i, "")
          .replace(/^[^A-Za-z0-9\u00C0-\u017F]+/, "")
          .replace(/\s+$/, "")
          .trim();
      }
    } catch {}

    const orderNumber = extractOrderNumberFromSendCode(sendCode);
    rows.push({
      sendCode,
      orderNumber,
      pickupDate,
      deliveryDate,
      phone,
      status,
      city,
      crbt,
      fees,
      total,
      raw: combined,
    });
  }

  return { ...hdr, rows };
}

function parse12LiveryInvoice(lines) {
  const hdr = parseInvoiceHeader(lines);
  const rows = [];
  // 12Livery can include suffixes like "7-127295_RMB"
  const codeRe = /\b\d{1,2}-[0-9A-Z_]{3,}\b/i;
  const dateRe = /\b\d{4}-\d{2}-\d{2}\b/g;

  const list = (lines || []);
  for (let i = 0; i < list.length; i++) {
    const base = String(list[i] || "").trim();
    if (!codeRe.test(base)) continue;
    const sendCode = (base.match(codeRe) || [])[0] || "";
    if (!sendCode) continue;

    let combined = base;
    let monies = parseDhAmounts(combined);
    let statusMeta = findStatusInText(combined);
    let statusFound = statusMeta?.label || "";
    let hasStatus = !!statusFound;
    let j = i + 1;
    let merges = 0;
    while (j < list.length) {
      const next = String(list[j] || "").trim();
      if (!next) { j++; continue; }
      if (codeRe.test(next)) break;
      if (/^(Total\b|Total\s+Brut\b|Total\s+Net\b|Sauf\b|12Livery\b|Facture\b|Colis\b|Statut\s*:)/i.test(next)) break;
      if (merges >= 4) break;
      combined = `${combined} ${next}`.replace(/\s+/g, " ").trim();
      monies = parseDhAmounts(combined);
      if (!statusFound) {
        const m2 = findStatusInText(next) || findStatusInText(combined);
        statusFound = m2?.label || statusFound;
        statusMeta = statusMeta || m2 || null;
      }
      hasStatus = hasStatus || !!statusFound;
      merges += 1;
      if (hasStatus && monies.length >= 3) break;
      j++;
    }
    i = j - 1;

    const dates = (combined.match(dateRe) || []).slice(0, 2);
    const pickupDate = dates[0] || "";
    const deliveryDate = dates[1] || "";

    const metaFinal = statusMeta || findStatusInText(combined);
    const status = statusFound || metaFinal?.label || "";

    const picked = pickCrbtFeesTotal(monies);
    const crbt = picked.crbt != null ? picked.crbt : null;
    const fees = picked.fees != null ? picked.fees : null;
    const total = picked.total != null ? picked.total : null;

    let city = "";
    try {
      const meta = metaFinal;
      const idxStatus = meta && meta.index >= 0 ? meta.index : -1;
      if (idxStatus >= 0) {
        const afterStatus = combined.slice(idxStatus + (meta?.length || status.length)).trim();
        const firstNumberIdx = afterStatus.search(/-?\d+(?:[.,]\d+)?/);
        const firstMoneyIdx = afterStatus.search(/-?\d+(?:[.,]\d+)?\s*DH\b/i);
        const cutIdx = (firstNumberIdx >= 0 ? firstNumberIdx : firstMoneyIdx);
        city = (cutIdx >= 0 ? afterStatus.slice(0, cutIdx) : afterStatus)
          .replace(/\s+/g, " ")
          .trim();
        city = city
          .replace(/^\|+/, "")
          .replace(/^(?:Ã©|é)\s+/i, "")
          .replace(/^[^A-Za-z0-9\u00C0-\u017F]+/, "")
          .replace(/\s+$/, "")
          .trim();
      }
    } catch {}

    const orderNumber = extractOrderNumberFromSendCode(sendCode);
    rows.push({
      sendCode,
      orderNumber,
      pickupDate,
      deliveryDate,
      phone: "",
      status,
      city,
      crbt,
      fees,
      total,
      raw: combined,
    });
  }

  return { ...hdr, rows };
}

function parseByCompany(lines, company) {
  const key = String(company || "lionex").trim().toLowerCase();
  if (key === "12livery" || key === "12-livery" || key === "12_livery") return parse12LiveryInvoice(lines);
  return parseLionexInvoice(lines);
}

async function extractPdfLines(file) {
  const buf = await file.arrayBuffer();
  const pdf = await getDocument({ data: buf }).promise;
  const outLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items || []).map((it) => {
      const tr = it.transform || [];
      const x = tr[4] || 0;
      const y = tr[5] || 0;
      return { str: it.str, x, y };
    });
    outLines.push(...normalizePdfLines(items));
  }
  return outLines;
}

export default function InvoicesVerifier() {
  const [defaultCompany, setDefaultCompany] = useState("lionex");
  const [fileEntries, setFileEntries] = useState([]); // [{ file, company }]
  const [parsed, setParsed] = useState([]); // [{fileName, invoiceNumber, invoiceDate, rows:[]}]
  const [lookup, setLookup] = useState({}); // orderNumber -> {found, store, order_gid, total_price, financial_status}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [paidBusy, setPaidBusy] = useState(false);
  const [paidMsg, setPaidMsg] = useState(null);
  const inputRef = useRef(null);

  const flatRows = useMemo(() => {
    const out = [];
    for (const doc of parsed) {
      (doc.rows || []).forEach((r, idx) => {
        out.push({ ...r, _doc: doc, _idx: idx + 1 });
      });
    }
    return out;
  }, [parsed]);

  const rowsWithShopify = useMemo(() => {
    return flatRows.map((r) => {
      const info = lookup[String(r.orderNumber || "").trim()] || null;
      const shopTotal = info && info.found ? Number(info.total_price || 0) : null;
      // We verify against CRBT (cash to collect) for Lionex invoices.
      const isRefused = String(r.status || "").trim().toLowerCase().startsWith("refus");
      const inv = (r.crbt != null ? Number(r.crbt) : null);
      const invComparable = isRefused ? 0 : inv;
      const shopComparable = isRefused ? 0 : shopTotal;
      const diff = (invComparable != null && shopComparable != null) ? (shopComparable - invComparable) : null;
      const absDiff = diff != null ? Math.abs(diff) : null;
      return {
        ...r,
        shopify: info,
        shopTotal,
        invAmount: invComparable,
        isRefused,
        diff,
        absDiff,
      };
    });
  }, [flatRows, lookup]);

  const summary = useMemo(() => {
    const ok = rowsWithShopify.filter((r) => r.shopify?.found);
    const green = ok.filter((r) => (r.absDiff != null && r.absDiff < 3));
    const red = ok.filter((r) => (r.absDiff != null && r.absDiff >= 3));
    const missing = rowsWithShopify.filter((r) => !r.shopify?.found);
    return { total: rowsWithShopify.length, ok: ok.length, green: green.length, red: red.length, missing: missing.length };
  }, [rowsWithShopify]);

  async function parseSelectedFiles(entries) {
    setBusy(true);
    setError(null);
    setPaidMsg(null);
    try {
      const docs = [];
      for (const ent of (entries || [])) {
        const f = ent?.file;
        if (!f) continue;
        const company = String(ent?.company || defaultCompany || "lionex");
        const lines = await extractPdfLines(f);
        const parsedDoc = parseByCompany(lines, company);
        docs.push({
          fileName: f.name,
          company,
          invoiceNumber: parsedDoc.invoiceNumber,
          invoiceDate: parsedDoc.invoiceDate,
          invoiceTotalNet: parsedDoc.invoiceTotalNet,
          invoiceTotalBrut: parsedDoc.invoiceTotalBrut,
          invoiceFeesTotal: parsedDoc.invoiceFeesTotal,
          rows: parsedDoc.rows,
        });
      }
      setParsed(docs);

      // Lookup Shopify orders in one request
      const orderNumbers = Array.from(new Set(docs.flatMap((d) => (d.rows || []).map((r) => String(r.orderNumber || "").trim()).filter(Boolean))));
      if (orderNumbers.length) {
        const res = await authFetch("/api/invoices/lookup-orders", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ order_numbers: orderNumbers }),
        });
        const js = await res.json().catch(() => ({}));
        if (!res.ok || js.ok !== true) throw new Error(js?.detail || js?.error || "Lookup failed");
        const map = {};
        for (const row of (js.rows || [])) {
          map[String(row.order_number || "").trim()] = row;
        }
        setLookup(map);
      } else {
        setLookup({});
      }
    } catch (e) {
      setError(e?.message || "Failed to parse PDF");
      setParsed([]);
      setLookup({});
    } finally {
      setBusy(false);
    }
  }

  async function markAllPaid() {
    setPaidBusy(true);
    setPaidMsg(null);
    setError(null);
    try {
      const toPay = [];
      for (const r of rowsWithShopify) {
        if (!r.shopify?.found) continue;
        if (!r.shopify?.order_gid) continue;
        if (!r.shopify?.store) continue;
        toPay.push({ order_gid: r.shopify.order_gid, store: r.shopify.store });
      }
      if (!toPay.length) {
        setPaidMsg("No matched orders to mark as paid.");
        setPaidBusy(false);
        return;
      }
      const res = await authFetch("/api/invoices/mark-paid", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ orders: toPay }),
      });
      const js = await res.json().catch(() => ({}));
      if (!res.ok || js.ok !== true) throw new Error(js?.detail || js?.error || "Mark paid failed");
      setPaidMsg(`Marked paid: ${js.updated || 0}/${toPay.length}`);
      // Refresh lookup to show new financial status
      try {
        const orderNumbers = Array.from(new Set(rowsWithShopify.map((r) => String(r.orderNumber || "").trim()).filter(Boolean)));
        const r2 = await authFetch("/api/invoices/lookup-orders", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ order_numbers: orderNumbers }),
        });
        const js2 = await r2.json().catch(() => ({}));
        if (r2.ok && js2.ok === true) {
          const map = {};
          for (const row of (js2.rows || [])) map[String(row.order_number || "").trim()] = row;
          setLookup(map);
        }
      } catch {}
    } catch (e) {
      setError(e?.message || "Failed to mark paid");
    } finally {
      setPaidBusy(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-2">
          <button
            onClick={() => { try { history.back(); } catch {} }}
            className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-100"
          >Back</button>
          <div className="ml-2">
            <div className="text-sm font-semibold">Invoices Verifier</div>
            <div className="text-[11px] text-gray-500">Upload Lionex invoice PDF(s) and compare CRBT vs Shopify total</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={defaultCompany}
              onChange={(e) => setDefaultCompany(e.target.value)}
              className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
              title="Default delivery company for newly added PDFs"
            >
              <option value="lionex">Lionex</option>
              <option value="12livery">12Livery</option>
            </select>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              multiple
              onChange={(e) => {
                const list = Array.from(e.target.files || []);
                const entries = list.map((f) => ({ file: f, company: defaultCompany }));
                setFileEntries(entries);
                setParsed([]);
                setLookup({});
              }}
              className="text-xs"
            />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4 pb-28">
        {busy && <div className="text-gray-600">Parsing PDF…</div>}
        {!busy && error && <div className="text-red-600 mb-3">{error}</div>}
        {!busy && paidMsg && <div className="text-green-700 mb-3">{paidMsg}</div>}

        {parsed.length > 0 && (
          <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <div className="text-sm font-semibold">Summary</div>
                <div className="mt-1 text-xs text-gray-700 flex flex-wrap gap-2">
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">Rows: {summary.total}</span>
                  <span className="px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700">Matched: {summary.ok}</span>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">Green (&lt; 3 DH): {summary.green}</span>
                  <span className="px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700">Red (≥ 3 DH): {summary.red}</span>
                  <span className="px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800">Missing: {summary.missing}</span>
                </div>
                <div className="mt-2 text-[11px] text-gray-500">
                  {parsed.map((d) => (
                    <div key={d.fileName}>
                      <span className="font-medium">{d.fileName}</span>
                      {d.company ? <span> • {String(d.company)}</span> : null}
                      {d.invoiceNumber ? <span> • {d.invoiceNumber}</span> : null}
                      {d.invoiceDate ? <span> • {d.invoiceDate}</span> : null}
                      <span> • rows: {(d.rows || []).length}</span>
                      {(d.invoiceTotalBrut != null || d.invoiceTotalNet != null) ? (
                        <span>
                          {" "}• PDF totals:
                          {d.invoiceTotalBrut != null ? <span> brut {Number(d.invoiceTotalBrut).toFixed(2)} DH</span> : null}
                          {d.invoiceFeesTotal != null ? <span> / frais {Number(d.invoiceFeesTotal).toFixed(2)} DH</span> : null}
                          {d.invoiceTotalNet != null ? <span> / net {Number(d.invoiceTotalNet).toFixed(2)} DH</span> : null}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div className="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-700">
                  {(() => {
                    const rows = rowsWithShopify || [];
                    const delivered = rows.filter(x => x.shopify?.found && !x.isRefused);
                    const refused = rows.filter(x => x.shopify?.found && x.isRefused);
                    const sumShop = delivered.reduce((acc, x) => acc + Number(x.shopTotal || 0), 0);
                    const sumInvCrbt = delivered.reduce((acc, x) => acc + Number(x.crbt || 0), 0);
                    const sumInvNet = delivered.reduce((acc, x) => {
                      // Prefer explicit total column if present; else compute from CRBT-fees
                      if (x.total != null) return acc + Number(x.total || 0);
                      if (x.crbt != null && x.fees != null) return acc + (Number(x.crbt || 0) - Number(x.fees || 0));
                      return acc;
                    }, 0);
                    const doc = parsed[0] || {};
                    const pdfBrut = doc.invoiceTotalBrut;
                    const pdfNet = doc.invoiceTotalNet;
                    return (
                      <div className="flex flex-wrap gap-2 items-center">
                        <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">
                          Delivered matched: {delivered.length}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200">
                          Refused matched (counted 0): {refused.length}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700">
                          Σ Shopify (delivered): {sumShop.toFixed(2)} DH
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700">
                          Σ Invoice CRBT (delivered): {sumInvCrbt.toFixed(2)} DH
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">
                          Σ Invoice Net (delivered): {sumInvNet.toFixed(2)} DH
                        </span>
                        {pdfBrut != null ? (
                          <span className="px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-purple-700">
                            PDF Total Brut: {Number(pdfBrut).toFixed(2)} DH (Δ { (sumShop - Number(pdfBrut)).toFixed(2) })
                          </span>
                        ) : null}
                        {pdfNet != null ? (
                          <span className="px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-purple-700">
                            PDF Total Net: {Number(pdfNet).toFixed(2)} DH (Δ { (sumInvNet - Number(pdfNet)).toFixed(2) })
                          </span>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
              </div>

              <button
                onClick={markAllPaid}
                disabled={paidBusy || busy || rowsWithShopify.length === 0}
                className="px-4 py-2 rounded-xl text-white text-sm font-semibold bg-green-600 hover:bg-green-700 disabled:opacity-60 active:scale-[.98]"
              >
                {paidBusy ? "Marking paid…" : "Mark all orders as paid"}
              </button>
            </div>
          </div>
        )}

        {parsed.length === 0 && !busy && (
          <>
            {fileEntries.length === 0 ? (
              <div className="text-gray-500">Choose one or more PDF invoices to start.</div>
            ) : (
              <div className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="text-sm font-semibold">PDFs to parse</div>
                <div className="mt-2 space-y-2">
                  {fileEntries.map((ent, idx) => (
                    <div key={`${ent.file?.name || "file"}-${idx}`} className="flex items-center gap-2">
                      <div className="flex-1 text-xs text-gray-800 truncate">{ent.file?.name}</div>
                      <select
                        value={String(ent.company || defaultCompany)}
                        onChange={(e) => {
                          const val = e.target.value;
                          setFileEntries((prev) => prev.map((x, i) => (i === idx ? ({ ...x, company: val }) : x)));
                        }}
                        className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
                      >
                        <option value="lionex">Lionex</option>
                        <option value="12livery">12Livery</option>
                      </select>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => parseSelectedFiles(fileEntries)}
                    className="px-4 py-2 rounded-xl text-white text-sm font-semibold bg-blue-600 hover:bg-blue-700 active:scale-[.98]"
                  >
                    Parse PDFs
                  </button>
                  <button
                    onClick={() => { setFileEntries([]); setParsed([]); setLookup({}); }}
                    className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-300 bg-white hover:bg-gray-50 active:scale-[.98]"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {rowsWithShopify.length > 0 && (
          <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            <div className="overflow-auto">
              <table className="min-w-[1200px] w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">Invoice</th>
                    <th className="text-left px-3 py-2">Code d'envoi</th>
                    <th className="text-left px-3 py-2">Order #</th>
                    <th className="text-left px-3 py-2">Store</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">City</th>
                    <th className="text-right px-3 py-2">Frais (DH)</th>
                    <th className="text-right px-3 py-2">Invoice CRBT (DH)</th>
                    <th className="text-right px-3 py-2">Shopify total (DH)</th>
                    <th className="text-right px-3 py-2">Diff (Shopify - CRBT)</th>
                    <th className="text-left px-3 py-2">Payment</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsWithShopify.map((r, i) => {
                    const isMatched = !!r.shopify?.found;
                    const isGreen = isMatched && r.absDiff != null && r.absDiff < 3;
                    const isRed = isMatched && r.absDiff != null && r.absDiff >= 3;
                    const bg = isGreen ? "bg-emerald-50" : isRed ? "bg-red-50" : (!isMatched ? "bg-gray-50" : "bg-white");
                    const border = isGreen ? "border-emerald-200" : isRed ? "border-red-200" : "border-gray-200";
                    return (
                      <tr key={`${r._doc?.fileName || "doc"}-${i}`} className={`${bg} border-b ${border}`}>
                        <td className="px-3 py-2">{r._idx}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r._doc?.invoiceNumber || r._doc?.fileName}</div>
                          <div className="text-[11px] text-gray-500">{r._doc?.invoiceDate || ""}</div>
                        </td>
                        <td className="px-3 py-2 font-mono">{r.sendCode}</td>
                        <td className="px-3 py-2 font-mono">{r.orderNumber || "—"}</td>
                        <td className="px-3 py-2">{r.shopify?.store || "—"}</td>
                        <td className="px-3 py-2">{r.status || "—"}</td>
                        <td className="px-3 py-2">{r.city || "—"}</td>
                        <td className="px-3 py-2 text-right font-semibold">{r.fees != null ? Number(r.fees).toFixed(2) : "—"}</td>
                        <td className="px-3 py-2 text-right font-semibold">{r.isRefused ? "0.00" : (r.crbt != null ? Number(r.crbt).toFixed(2) : "—")}</td>
                        <td className="px-3 py-2 text-right font-semibold">{r.shopTotal != null ? Number(r.shopTotal).toFixed(2) : (r.shopify?.error ? "not found" : "—")}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${isGreen ? "text-emerald-700" : isRed ? "text-red-700" : "text-gray-700"}`}>
                          {r.diff != null ? Number(r.diff).toFixed(2) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          {r.shopify?.financial_status ? String(r.shopify.financial_status) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  {(() => {
                    const rows = rowsWithShopify || [];
                    const delivered = rows.filter(x => x.shopify?.found && !x.isRefused);
                    const sumFees = delivered.reduce((acc, x) => acc + Number(x.fees || 0), 0);
                    const sumCrbt = delivered.reduce((acc, x) => acc + Number(x.crbt || 0), 0);
                    const sumShop = delivered.reduce((acc, x) => acc + Number(x.shopTotal || 0), 0);
                    const sumDiff = delivered.reduce((acc, x) => acc + Number(x.diff || 0), 0);
                    return (
                      <tr className="bg-gray-900 text-white">
                        <td className="px-3 py-2 font-extrabold" colSpan={7}>TOTALS (delivered only)</td>
                        <td className="px-3 py-2 text-right font-extrabold">{sumFees.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right font-extrabold">{sumCrbt.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right font-extrabold">{sumShop.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right font-extrabold">{sumDiff.toFixed(2)}</td>
                        <td className="px-3 py-2 font-extrabold">—</td>
                      </tr>
                    );
                  })()}
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}


