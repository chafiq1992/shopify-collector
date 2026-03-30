import React, { useMemo, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";


export default function InvoicesVerifier() {
  const [fileList, setFileList] = useState([]);       // File[]
  const [parsed, setParsed] = useState([]);            // [{fileName, company, invoiceNumber, invoiceDate, rows:[]}]
  const [lookup, setLookup] = useState({});            // orderNumber -> {found, store, order_gid, total_price, financial_status}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [paidBusy, setPaidBusy] = useState(false);
  const [paidMsg, setPaidMsg] = useState(null);
  const inputRef = useRef(null);

  // Flatten all rows across all documents
  const flatRows = useMemo(() => {
    const out = [];
    for (const doc of parsed) {
      (doc.rows || []).forEach((r, idx) => {
        out.push({ ...r, _doc: doc, _idx: idx + 1 });
      });
    }
    return out;
  }, [parsed]);

  // Enrich rows with Shopify lookup data + compute diff
  const rowsWithShopify = useMemo(() => {
    return flatRows.map((r) => {
      const info = lookup[String(r.orderNumber || "").trim()] || null;
      const shopTotal = info && info.found ? Number(info.total_price || 0) : null;
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

  // Summary stats
  const summary = useMemo(() => {
    const ok = rowsWithShopify.filter((r) => r.shopify?.found);
    const green = ok.filter((r) => (r.absDiff != null && r.absDiff < 3));
    const red = ok.filter((r) => (r.absDiff != null && r.absDiff >= 3));
    const missing = rowsWithShopify.filter((r) => !r.shopify?.found);
    return { total: rowsWithShopify.length, ok: ok.length, green: green.length, red: red.length, missing: missing.length };
  }, [rowsWithShopify]);

  // Upload PDFs to backend for LLM-based parsing + Shopify lookup
  async function parseSelectedFiles() {
    if (!fileList.length) return;
    setBusy(true);
    setError(null);
    setPaidMsg(null);
    try {
      const formData = new FormData();
      for (const f of fileList) {
        formData.append("files", f);
      }

      // Long timeout — LLM parsing can take 30-60s for large invoices (with retries, up to 5 min)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000);

      const res = await authFetch("/api/invoices/parse-pdf", {
        method: "POST",
        headers: authHeaders(),  // No Content-Type — browser sets multipart boundary
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const js = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(js?.detail || js?.error || `Server error ${res.status}`);
      if (js.ok !== true) throw new Error(js?.error || "Parse failed");

      setParsed(js.docs || []);
      setLookup(js.lookup || {});

      // Check for per-file errors
      const errors = (js.docs || []).filter(d => d.error);
      if (errors.length) {
        setError(`Warnings: ${errors.map(d => `${d.fileName}: ${d.error}`).join("; ")}`);
      }
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Request timed out — the PDF may be too large. Try a smaller invoice." : (e?.message || "Failed to parse PDFs");
      setError(msg);
      setParsed([]);
      setLookup({});
    } finally {
      setBusy(false);
    }
  }

  // Mark all matched orders as paid in Shopify
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
            <div className="text-[11px] text-gray-500">Upload delivery invoice PDF(s) — company auto-detected by AI</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              multiple
              onChange={(e) => {
                const list = Array.from(e.target.files || []);
                setFileList(list);
                setParsed([]);
                setLookup({});
                setError(null);
                setPaidMsg(null);
              }}
              className="text-xs"
            />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4 pb-28">
        {busy && (
          <div className="text-gray-600 flex items-center gap-2">
            <svg className="animate-spin h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Parsing PDF with AI… this may take 10-30 seconds</span>
          </div>
        )}
        {!busy && error && <div className="text-red-600 mb-3">{error}</div>}
        {!busy && paidMsg && <div className="text-green-700 mb-3">{paidMsg}</div>}

        {/* Summary section */}
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
                      {d.company ? <span> • <span className="text-indigo-600 font-medium">{d.company}</span> (auto-detected)</span> : null}
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
                      {d.error ? <span className="text-amber-600"> • ⚠ {d.error}</span> : null}
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

        {/* Upload prompt */}
        {parsed.length === 0 && !busy && (
          <>
            {fileList.length === 0 ? (
              <div className="text-gray-500">Choose one or more PDF invoices to start.</div>
            ) : (
              <div className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="text-sm font-semibold">PDFs to parse</div>
                <div className="mt-2 space-y-2">
                  {fileList.map((f, idx) => (
                    <div key={`${f.name}-${idx}`} className="flex items-center gap-2">
                      <div className="flex-1 text-xs text-gray-800 truncate">{f.name}</div>
                      <div className="text-[11px] text-gray-400">Company auto-detected by AI</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={parseSelectedFiles}
                    className="px-4 py-2 rounded-xl text-white text-sm font-semibold bg-blue-600 hover:bg-blue-700 active:scale-[.98]"
                  >
                    Parse PDFs
                  </button>
                  <button
                    onClick={() => { setFileList([]); setParsed([]); setLookup({}); setError(null); }}
                    className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-300 bg-white hover:bg-gray-50 active:scale-[.98]"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Results table */}
        {rowsWithShopify.length > 0 && (
          <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            <div className="overflow-auto">
              <table className="min-w-[1200px] w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">Invoice</th>
                    <th className="text-left px-3 py-2">Code d&apos;envoi</th>
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
