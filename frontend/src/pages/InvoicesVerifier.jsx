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

function normalizePdfLines(textItems) {
  // textItems: [{str, x, y}]
  const items = (textItems || [])
    .filter((t) => t && String(t.str || "").trim())
    .map((t) => ({ str: String(t.str || "").trim(), x: Number(t.x || 0), y: Number(t.y || 0) }))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let current = [];
  let currentY = null;
  const Y_TOL = 2.2; // works well for typical table PDFs

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

function parseLionexInvoice(lines) {
  const all = (lines || []).join("\n");
  const invoiceNumber = (() => {
    const m = all.match(/Facture\s*:\s*([A-Z0-9-]+)/i);
    return m ? m[1] : "";
  })();
  const invoiceDate = (() => {
    const m = all.match(/Date\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[^\n]*)/i);
    return m ? m[1].trim() : "";
  })();

  const rows = [];
  // A row typically contains code like "7-127130" and multiple "... DH" amounts.
  const codeRe = /\b\d+-\d+\b/;
  const moneyRe = /(-?\d+)\s*DH\b/gi;
  const dateRe = /\b\d{4}-\d{2}-\d{2}\b/g;
  const phoneRe = /\b0\d{9}\b/;

  for (const line of (lines || [])) {
    if (!codeRe.test(line)) continue;
    const sendCode = (line.match(codeRe) || [])[0] || "";
    if (!sendCode) continue;

    const dates = (line.match(dateRe) || []).slice(0, 2);
    const pickupDate = dates[0] || "";
    const deliveryDate = dates[1] || "";

    const phone = (line.match(phoneRe) || [])[0] || "";
    const status = (line.match(/\b(Livré|Refusé)\b/i) || [])[0] || "";

    // Collect all DH amounts, take last 3 as (crbt, fees, total) — consistent with PDF example.
    const monies = [];
    let mm;
    while ((mm = moneyRe.exec(line)) !== null) {
      monies.push(Number(mm[1]));
    }
    const last3 = monies.slice(-3);
    const crbt = last3.length >= 3 ? last3[0] : null;
    const fees = last3.length >= 3 ? last3[1] : null;
    const total = last3.length >= 3 ? last3[2] : null;

    // City is “whatever is between status and the first money amount”
    let city = "";
    try {
      const idxStatus = status ? line.toLowerCase().indexOf(status.toLowerCase()) : -1;
      if (idxStatus >= 0) {
        const afterStatus = line.slice(idxStatus + status.length).trim();
        const firstMoneyIdx = afterStatus.search(/-?\d+\s*DH\b/i);
        city = (firstMoneyIdx >= 0 ? afterStatus.slice(0, firstMoneyIdx) : afterStatus)
          .replace(/\s+/g, " ")
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
      raw: line,
    });
  }

  return { invoiceNumber, invoiceDate, rows };
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
  const [files, setFiles] = useState([]);
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
      const inv = r.crbt != null ? Number(r.crbt) : (r.total != null ? Number(r.total) : null);
      const diff = (inv != null && shopTotal != null) ? (shopTotal - inv) : null;
      const absDiff = diff != null ? Math.abs(diff) : null;
      return {
        ...r,
        shopify: info,
        shopTotal,
        invAmount: inv,
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

  async function parseSelectedFiles(nextFiles) {
    setBusy(true);
    setError(null);
    setPaidMsg(null);
    try {
      const docs = [];
      for (const f of nextFiles) {
        const lines = await extractPdfLines(f);
        const parsedDoc = parseLionexInvoice(lines);
        docs.push({
          fileName: f.name,
          invoiceNumber: parsedDoc.invoiceNumber,
          invoiceDate: parsedDoc.invoiceDate,
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
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              multiple
              onChange={(e) => {
                const list = Array.from(e.target.files || []);
                setFiles(list);
                if (list.length) parseSelectedFiles(list);
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
                      {d.invoiceNumber ? <span> • {d.invoiceNumber}</span> : null}
                      {d.invoiceDate ? <span> • {d.invoiceDate}</span> : null}
                      <span> • rows: {(d.rows || []).length}</span>
                    </div>
                  ))}
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
          <div className="text-gray-500">Choose one or more PDF invoices to start.</div>
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
                        <td className="px-3 py-2 text-right font-semibold">{r.crbt != null ? Number(r.crbt).toFixed(2) : "—"}</td>
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
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}


