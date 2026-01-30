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

function _normText(s) {
  try {
    return String(s || "")
      .trim()
      .toLowerCase()
      // remove accents
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ");
  } catch {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  }
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

// Dev-only sanity checks for ambiguous (crbt, fees, total) triples like [-3, 15, 18]
// where both equations 15-18=-3 and 15-(-3)=18 are possible.
// We must always treat FEES as non-negative and allow TOTAL to be negative.
try {
  // eslint-disable-next-line no-undef
  if (typeof import.meta !== "undefined" && import.meta?.env?.DEV) {
    // eslint-disable-next-line no-undef
    if (typeof window !== "undefined" && !window.__invoiceVerifierSelfTestRan) {
      // eslint-disable-next-line no-undef
      window.__invoiceVerifierSelfTestRan = true;
      const picked = pickCrbtFeesTotal([-3, 15, 18]);
      if (!(picked.crbt === 15 && picked.fees === 18 && picked.total === -3)) {
        // eslint-disable-next-line no-console
        console.warn("[InvoicesVerifier] self-test failed for [-3,15,18]:", picked);
      }
    }
  }
} catch {}

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
  const commonFees = [10, 15, 18, 20, 25, 30, 35, 40, 45, 50];
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
        // Fees are almost always non-negative; a negative "fees" is usually the NET total (CRBT-fees) on invoices like 12Livery.
        if (fees < 0) score += 5;
        if (Math.abs(fees) <= 120) score -= 0.25;
        // Prefer fee values close to typical fee buckets (18/25/30...) but keep it weak.
        const feeAbs = Math.abs(fees);
        const feeDist = commonFees.reduce((acc, x) => Math.min(acc, Math.abs(feeAbs - x)), Infinity);
        if (Number.isFinite(feeDist)) score += (feeDist * 0.01);
        // With non-negative fees, total should not exceed CRBT.
        if (fees >= 0 && total > (crbt + EPS)) score += 1.5;
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
        // Computed fallback assumes fees is a (small) positive value
        if (fees < 0) continue;
        if (Math.abs(fees) > 120) continue;
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

function pickCrbtFeesPackagingTotal(monies) {
  // IBEX: can have an extra "Emballage" amount column.
  // Try to satisfy: total = crbt - fees - packaging (packaging default 0).
  const vals = (monies || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  const EPS = 0.6;
  if (vals.length < 3) {
    const base = pickCrbtFeesTotal(vals);
    return { ...base, packaging: 0, method: `fallback:${base.method || "none"}` };
  }
  // Try all 4-tuples first
  if (vals.length >= 4) {
    let best = null;
    for (let i = 0; i < vals.length; i++) {
      for (let j = 0; j < vals.length; j++) {
        if (j === i) continue;
        for (let k = 0; k < vals.length; k++) {
          if (k === i || k === j) continue;
          for (let t = 0; t < vals.length; t++) {
            if (t === i || t === j || t === k) continue;
            const crbt = vals[i];
            const fees = vals[j];
            const packaging = vals[k];
            const total = vals[t];
            const err = Math.abs((crbt - fees - packaging) - total);
            if (err > EPS) continue;
            let score = err;
            if (Math.abs(fees) <= 80) score -= 0.2;
            if (Math.abs(packaging) <= 80) score -= 0.1;
            if (best == null || score < best.score) best = { crbt, fees, packaging, total, score };
          }
        }
      }
    }
    if (best) return { crbt: best.crbt, fees: best.fees, packaging: best.packaging, total: best.total, method: "identity4" };
  }
  // Fallback to 3-value identity: total = crbt - fees
  const base = pickCrbtFeesTotal(vals);
  return { ...base, packaging: 0, method: `fallback:${base.method || "none"}` };
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

async function extractPdfPagesTextItems(file) {
  const buf = await file.arrayBuffer();
  const pdf = await getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items || []).map((it) => {
      const tr = it.transform || [];
      const x = tr[4] || 0;
      const y = tr[5] || 0;
      return { str: String(it.str || ""), x: Number(x), y: Number(y) };
    });
    pages.push({ page: p, items });
  }
  return pages;
}

function extractRowsByAnchorsInColumns({ pages, anchorRe, headerLabels }) {
  // headerLabels: [{ key, label }], e.g. { key:"ville", label:"Ville" }
  // We infer x column boundaries from header label positions on the first page.
  const first = pages?.[0]?.items || [];
  const labelXs = [];
  const headerLabelNorms = (headerLabels || []).map((hl) => ({ key: hl.key, label: hl.label, norm: _normText(hl.label) }));
  for (const hl of (headerLabels || [])) {
    const want = _normText(hl.label);
    let best = null;
    for (const it of first) {
      const t = _normText(it.str);
      if (!t) continue;
      // Be tolerant: sometimes header labels have extra spaces/words.
      // Prefer exact match, else substring match.
      if (t === want || (want && t.includes(want))) {
        if (!best || it.y > best.y) best = it; // pick highest occurrence
      }
    }
    if (best) labelXs.push({ key: hl.key, x: best.x, y: best.y });
  }
  labelXs.sort((a, b) => a.x - b.x);
  if (labelXs.length < 2) {
    // Can't infer columns; return empty (caller can fallback to older parsing)
    return [];
  }
  const headerY = Math.max(...labelXs.map((x) => x.y));

  // Build x ranges per label key
  const ranges = {};
  for (let i = 0; i < labelXs.length; i++) {
    const cur = labelXs[i];
    const prev = labelXs[i - 1] || null;
    const next = labelXs[i + 1] || null;
    const left = prev ? (prev.x + cur.x) / 2 : -Infinity;
    const right = next ? (cur.x + next.x) / 2 : Infinity;
    ranges[cur.key] = { left, right };
  }

  const outRows = [];
  const Y_TOL = 6.0;

  for (const pg of (pages || [])) {
    const items = (pg.items || []).filter((it) => String(it.str || "").trim());
    // Determine header Y on THIS page (tables repeat headers per page).
    // If we don't do this, the first few rows on page 2 can be wrongly treated as "header" and dropped.
    let headerYThisPage = headerY;
    let headerYFound = false;
    try {
      let bestY = null;
      for (const it of items) {
        const t = _normText(it.str);
        if (!t) continue;
        for (const hl of headerLabelNorms) {
          if (!hl.norm) continue;
          if (t === hl.norm || t.includes(hl.norm)) {
            if (bestY == null || it.y > bestY) bestY = it.y;
          }
        }
      }
      if (bestY != null) headerYThisPage = bestY;
      headerYFound = (bestY != null);
    } catch {}

    // Find anchor occurrences (e.g. "7-123456")
    const anchors = items
      .filter((it) => anchorRe.test(String(it.str || "").trim()))
      .map((it) => ({ ...it, code: String(it.str || "").trim() }))
      // ignore anchors that are in the header region
      // If we can't confidently detect the header on this page (common when header labels are split),
      // do NOT filter anchors; otherwise we risk dropping all rows on page 2.
      .filter((a) => !headerYFound || a.y < (headerYThisPage - 5))
      .sort((a, b) => b.y - a.y);

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const next = anchors[i + 1] || null;
      const yTop = a.y + Y_TOL;
      // IMPORTANT: prevent bleed into the next row.
      // Other cells in the next row can have y slightly ABOVE the anchor y, so we set the bottom bound ABOVE next.y.
      const yBottom = next ? (next.y + Y_TOL) : -Infinity;
      const band = items.filter((it) => it.y <= yTop && it.y >= yBottom);

      const byKey = {};
      for (const [key, rg] of Object.entries(ranges)) {
        const colItems = band
          .filter((it) => it.x >= rg.left && it.x < rg.right)
          .sort((aa, bb) => (bb.y - aa.y) || (aa.x - bb.x));
        // Join preserving vertical flow (top->bottom) but stable within line
        const txt = colItems.map((x) => String(x.str || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        byKey[key] = txt;
      }
      outRows.push({ page: pg.page, anchor: a.code, columns: byKey });
    }
  }

  return outRows;
}

function parseInvoiceHeader(lines) {
  const all = (lines || []).join("\n");
  const invoiceNumber = (() => {
    // Lionex/12Livery/Metalivraison/PalExpress style
    const m = all.match(/Facture\s*:\s*([A-Z0-9-]+)/i);
    if (m) return m[1];
    // YFD/Livré24 style: "# FC-...."
    const m2 = all.match(/#\s*(FC-[0-9-]+)/i);
    if (m2) return m2[1];
    // "Facture client N°: # FC-..."
    const m3 = all.match(/Facture\s*client\s*N°\s*:\s*#?\s*(FC-[0-9-]+)/i);
    return m3 ? m3[1] : "";
  })();
  const invoiceDate = (() => {
    // ISO style
    const m = all.match(/Date\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[^\n]*)/i);
    if (m) return m[1].trim();
    // dd/mm/yyyy style (YFD/Livré24)
    const m2 = all.match(/\bDate\s*:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})\b/i);
    return m2 ? m2[1].trim() : "";
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
    // Prefer TTC when present (YFD/Livré24)
    const mTtc = all.match(/\bFrais\s*TTC\s*([\d.,-]+)\s*DH/i);
    if (mTtc) return safeNum(mTtc[1]);
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
      if (/^(Total\b|Total\s+Brut\b|Total\s+Net\b|Sauf\b|Facture\b|Colis\b|Statut\s*:|Vous\s+remerci)/i.test(next)) break;
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
  // IMPORTANT: avoid matching invoice-number suffixes like "55-125" from "FCT-...-55-125".
  // Real shipment codes in these PDFs are like "7-127429" or "7-127295_RMB" (>= 4 digits after dash).
  const codeRe = /\b\d{1,2}-\d{4,}(?:_[A-Z0-9]+)?\b/i;
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

function parseMetalivraisonInvoice(lines) {
  // Same table structure as Lionex but includes a dedicated phone column.
  return parseLionexInvoice(lines);
}

function parseIbexInvoice(lines) {
  const hdr = parseInvoiceHeader(lines);
  const rows = [];
  // IBEX "Code d'envoi" is like "7-58537". Avoid matching invoice suffixes like "23-296"
  // from "FCT-...-23-296" in the header.
  const codeRe = /\b7-\d{4,}(?:_[A-Z0-9]+)?\b/i;
  const dateRe = /\b\d{4}-\d{2}-\d{2}\b/g;
  const phoneRe = /\b0\d{9}\b/;

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
      // Stop at footer/summary/other tables (e.g. "N° | Désignation ...", "ecart ...")
      if (/^(?:\|?\s*)?(Total\b|Total\s+Brut\b|Total\s+Net\b|Sauf\b|Facture\b|Colis\b|Statut\s*:|Vous\s+remerci|N°\b|D[ée]signation\b|ecart\b)/i.test(next)) break;
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
    const phone = (combined.match(phoneRe) || [])[0] || "";

    const metaFinal = statusMeta || findStatusInText(combined);
    const status = statusFound || metaFinal?.label || "";

    // IBEX invoices can contain other tables/lines with a send code (e.g. "ecart 7-58567").
    // Only consider a row valid if we have a recognizable delivery status.
    if (!status) continue;

    const picked = pickCrbtFeesPackagingTotal(monies);
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
        const cutIdx = firstNumberIdx;
        city = (cutIdx >= 0 ? afterStatus.slice(0, cutIdx) : afterStatus).replace(/\s+/g, " ").trim();
        city = city.replace(/^\|+/, "").replace(/^(?:Ã©|é)\s+/i, "").replace(/^[^A-Za-z0-9\u00C0-\u017F]+/, "").trim();
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

function parsePalExpressInvoice(lines) {
  const hdr = parseInvoiceHeader(lines);
  const rows = [];
  // PalExpress "Code d'envoi" is always like "7-126771". Avoid matching invoice-number suffixes like "22-223".
  const codeRe = /\b7-\d{4,}(?:_[A-Z0-9]+)?\b/i;
  const dateRe = /\b\d{4}-\d{2}-\d{2}\b/g;
  const phoneRe = /\b0\d{9}\b/;

  const list = (lines || []);
  // First pass: collect per-row money candidates so we can learn the most common fee value for this invoice.
  const temps = [];
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
      if (/^(Total\b|Total\s+Brut\b|Total\s+Net\b|Sauf\b|Facture\b|Colis\b|Statut\s*:|Vous\s+remerci)/i.test(next)) break;
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
      // Do NOT break early here. PalExpress cities are often split across lines ("DAR" then "BOUAZZA"),
      // and the money/status can be present before the city continuation line. We'll stop by max merges or next row.
      j++;
    }

    // If the city is split across multiple PDF lines, merge 1-2 extra ALL-CAPS-only lines (no digits/DH/phone/date),
    // so we can capture "SIDI BENNOUR", "HAD SOUALEM", "DAR BOUAZZA".
    try {
      let extra = 0;
      while (extra < 2 && j < list.length) {
        const nxt = String(list[j] || "").trim();
        if (!nxt) { j++; continue; }
        if (codeRe.test(nxt)) break;
        if (/^(Total\b|Total\s+Brut\b|Total\s+Net\b|Sauf\b|Facture\b|Colis\b|Statut\s*:|Vous\s+remerci)/i.test(nxt)) break;
        // Reject anything that clearly belongs to other columns
        if (/\bDH\b/i.test(nxt)) break;
        if (phoneRe.test(nxt)) break;
        if (dateRe.test(nxt)) break;
        if (findStatusInText(nxt)) break;
        // Accept only all-caps latin tokens/spaces/dashes (multi-word city continuation)
        if (/[a-z]/.test(nxt)) break;
        if (!/[A-Z]/.test(nxt)) break;
        if (/\d/.test(nxt)) break;
        combined = `${combined} ${nxt}`.replace(/\s+/g, " ").trim();
        extra += 1;
        j += 1;
      }
    } catch {}

    i = j - 1;

    // PalExpress layout: city is right after sendCode and before customer/phone/date.
    let city = "";
    try {
      const afterCode = combined.split(sendCode).slice(1).join(sendCode).trim();
      // Best-effort: the Ville column is usually the very first segment, before the first "|" separator.
      // This preserves full names like "SIDI BENNOUR", "HAD SOUALEM", "DAR BOUAZZA".
      let seg = afterCode;
      if (seg.includes("|")) {
        seg = seg.split("|")[0];
      } else {
        // Fallback: cut at first phone or first date
        const phoneIdx = seg.search(phoneRe);
        const dateIdx = seg.search(dateRe);
        let cut = -1;
        if (phoneIdx >= 0 && dateIdx >= 0) cut = Math.min(phoneIdx, dateIdx);
        else cut = (phoneIdx >= 0 ? phoneIdx : dateIdx);
        seg = (cut >= 0 ? seg.slice(0, cut) : seg);
      }
      seg = String(seg || "").replace(/\s+/g, " ").trim();
      // Clean common junk and keep only ALL-CAPS tokens to avoid swallowing customer names (e.g. "Elmoufid").
      // IMPORTANT: sometimes the second line of the city (e.g. "BOUAZZA") appears later in the extracted text,
      // so we collect ALL eligible ALL-CAPS tokens (not necessarily contiguous).
      seg = seg.replace(/^[^A-Za-z0-9\u00C0-\u017F\u0600-\u06FF]+/, "").trim();
      const toks = seg.split(/\s+/).filter(Boolean);
      const out = [];
      for (const t of toks) {
        if (!t) continue;
        // Stop when token starts with a digit/phone
        if (/^\d/.test(t)) break;
        // Ignore Arabic (destinataire), keep city in latin/uppercase
        if (/[\u0600-\u06FF]/.test(t)) continue;
        // Ignore status words if they accidentally appear
        if (/^livr/i.test(t) || /^refus/i.test(t)) continue;
        // Only accept ALL-CAPS (no lowercase latin)
        if (/[a-z]/.test(t)) continue;
        // Must contain at least one uppercase A-Z (avoid weird symbols)
        if (!/[A-Z]/.test(t)) continue;
        out.push(t);
        if (out.length >= 6) break;
      }
      city = (out.length ? out.join(" ") : (toks[0] || "")).trim();
    } catch {}

    const dates = (combined.match(dateRe) || []).slice(0, 2);
    const pickupDate = dates[0] || "";
    const deliveryDate = dates[1] || "";
    const phone = (combined.match(phoneRe) || [])[0] || "";

    const metaFinal = statusMeta || findStatusInText(combined);
    const status = statusFound || metaFinal?.label || "";

    // Extract DH amounts; ignore bogus "Total" column values (very large IDs like 659829 DH)
    const vals = (monies || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
    const filtered = vals.filter((n) => Math.abs(n) <= 5000);
    const small = filtered.filter((n) => Math.abs(n) <= 80);
    const large = filtered.filter((n) => Math.abs(n) > 80);

    const orderNumber = extractOrderNumberFromSendCode(sendCode);
    temps.push({
      sendCode,
      orderNumber,
      pickupDate,
      deliveryDate,
      phone,
      status,
      city,
      // temporary candidates
      _moneySmall: small,
      _moneyLarge: large,
      raw: combined,
    });
  }

  // Learn the most common "fees" value in this invoice (often 20 or 25).
  const feeCounts = {};
  for (const t of temps) {
    for (const n of (t._moneySmall || [])) {
      const key = String(Number(n).toFixed(2));
      feeCounts[key] = (feeCounts[key] || 0) + 1;
    }
  }
  let feeMode = null;
  try {
    const entries = Object.entries(feeCounts);
    entries.sort((a, b) => (b[1] - a[1]) || (Number(a[0]) - Number(b[0])));
    if (entries.length) feeMode = Number(entries[0][0]);
  } catch {}

  function pickFeesCrbtFromCandidates(small, large) {
    const sm = Array.isArray(small) ? small.slice() : [];
    const lg = Array.isArray(large) ? large.slice() : [];
    const picked = { fees: null, crbt: null, total: null };

    // Typical case: CRBT is large, fees is small.
    if (lg.length) {
      picked.crbt = Math.max(...lg);
      if (sm.length) {
        if (feeMode != null) {
          // choose small closest to feeMode
          let best = sm[0];
          let bestD = Math.abs(sm[0] - feeMode);
          for (const x of sm) {
            const d = Math.abs(x - feeMode);
            if (d < bestD) { best = x; bestD = d; }
          }
          picked.fees = best;
        } else {
          // fallback: choose max small as fees (e.g. 25 over 15)
          picked.fees = Math.max(...sm);
        }
      }
      if (picked.crbt != null && picked.fees != null) picked.total = picked.crbt - picked.fees;
      return picked;
    }

    // Edge case: both values are "small" (e.g. CRBT=15, fees=25)
    if (sm.length >= 2) {
      const a = sm[0];
      const b = sm[1];
      if (feeMode != null) {
        const da = Math.abs(a - feeMode);
        const db = Math.abs(b - feeMode);
        picked.fees = da <= db ? a : b;
        picked.crbt = da <= db ? b : a;
      } else {
        // fallback: fees is the larger, CRBT is the smaller
        picked.fees = Math.max(a, b);
        picked.crbt = Math.min(a, b);
      }
      picked.total = picked.crbt - picked.fees;
      return picked;
    }

    // If only one small value, assume it's fees when it matches feeMode; otherwise treat as crbt.
    if (sm.length === 1) {
      const x = sm[0];
      if (feeMode != null && Math.abs(x - feeMode) < 0.01) {
        picked.fees = x;
      } else {
        picked.crbt = x;
      }
      if (picked.crbt != null && picked.fees != null) picked.total = picked.crbt - picked.fees;
      return picked;
    }

    return picked;
  }

  for (const t of temps) {
    const chosen = pickFeesCrbtFromCandidates(t._moneySmall, t._moneyLarge);
    rows.push({
      sendCode: t.sendCode,
      orderNumber: t.orderNumber,
      pickupDate: t.pickupDate,
      deliveryDate: t.deliveryDate,
      phone: t.phone,
      status: t.status,
      city: t.city,
      fees: (chosen.fees != null ? chosen.fees : null),
      crbt: (chosen.crbt != null ? chosen.crbt : null),
      total: (chosen.total != null ? chosen.total : null),
      raw: t.raw,
    });
  }

  return { ...hdr, rows };
}

function parseCrbtFeesOnly(monies) {
  const vals = (monies || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  const filtered = vals.filter((n) => Math.abs(n) <= 20000);
  const fees = filtered.find((n) => Math.abs(n) <= 120) ?? null;
  const crbtCandidates = filtered.filter((n) => (fees == null ? true : n !== fees));
  const crbt = crbtCandidates.length ? Math.max(...crbtCandidates) : null;
  return { crbt, fees, total: (crbt != null && fees != null) ? (crbt - fees) : null };
}

function parseYfdInvoice(lines) {
  const hdr = parseInvoiceHeader(lines);
  const rows = [];
  const sendCodeRe = /\b7-\d{4,}\b/;
  const phoneRe = /\b0\d{9}\b/;

  const list = (lines || []);
  for (let i = 0; i < list.length; i++) {
    const base = String(list[i] || "").trim();
    if (!sendCodeRe.test(base)) continue;
    // Merge a couple of lines because YFD sometimes splits "YFD-... \n 7-xxxxx"
    let combined = base;
    let j = i + 1;
    let merges = 0;
    while (j < list.length) {
      const next = String(list[j] || "").trim();
      if (!next) { j++; continue; }
      if (sendCodeRe.test(next)) break;
      if (/^(Total\b|Total\s+Brut\b|Total\s+Net\b|Frais\b|Charges\b|Cachet\b|Note\b)/i.test(next)) break;
      if (merges >= 3) break;
      combined = `${combined} ${next}`.replace(/\s+/g, " ").trim();
      merges += 1;
      j++;
    }

    const sendCode = (combined.match(sendCodeRe) || [])[0] || "";
    if (!sendCode) continue;

    const phone = (combined.match(phoneRe) || [])[0] || "";
    const metaFinal = findStatusInText(combined);
    const status = metaFinal?.label || "";

    // City sits between phone and status in this layout.
    let city = "";
    try {
      if (phone) {
        const idxPhone = combined.indexOf(phone);
        const afterPhone = idxPhone >= 0 ? combined.slice(idxPhone + phone.length).trim() : combined;
        const st = findStatusInText(afterPhone);
        if (st && st.index >= 0) city = afterPhone.slice(0, st.index).trim();
        else city = afterPhone.trim();
        // trim at first number (CRBT/Frais)
        const numIdx = city.search(/-?\d+(?:[.,]\d+)?/);
        if (numIdx >= 0) city = city.slice(0, numIdx).trim();
        // only first 3 tokens
        city = city.replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
      }
    } catch {}

    const monies = parseDhAmounts(combined);
    const picked = parseCrbtFeesOnly(monies);
    rows.push({
      sendCode,
      orderNumber: extractOrderNumberFromSendCode(sendCode),
      pickupDate: "",
      deliveryDate: "",
      phone,
      status,
      city,
      crbt: picked.crbt,
      fees: picked.fees,
      total: picked.total,
      raw: combined,
    });
  }

  return { ...hdr, rows };
}

function parseLivre24Invoice(lines) {
  const hdr = parseInvoiceHeader(lines);
  const rows = [];
  const sendCodeRe = /\b7-\d{4,}\b/;
  const phoneRe = /\b0\d{9}\b/;
  const dateRe = /\b\d{2}\/\d{2}\/\d{4}\b/;

  const list = (lines || []);
  for (let i = 0; i < list.length; i++) {
    const base = String(list[i] || "").trim();
    if (!sendCodeRe.test(base)) continue;
    let combined = base;
    let j = i + 1;
    let merges = 0;
    while (j < list.length) {
      const next = String(list[j] || "").trim();
      if (!next) { j++; continue; }
      if (sendCodeRe.test(next)) break;
      if (/^(Total\b|Total\s+Brut\b|Total\s+Net\b|Frais\b|Charges\b|Cachet\b|Note\b)/i.test(next)) break;
      if (merges >= 3) break;
      combined = `${combined} ${next}`.replace(/\s+/g, " ").trim();
      merges += 1;
      j++;
    }

    const sendCode = (combined.match(sendCodeRe) || [])[0] || "";
    if (!sendCode) continue;

    const phone = (combined.match(phoneRe) || [])[0] || "";
    const deliveryDate = (combined.match(dateRe) || [])[0] || "";
    const metaFinal = findStatusInText(combined);
    const status = metaFinal?.label || "";

    // City between phone and delivery date
    let city = "";
    try {
      if (phone) {
        const idxPhone = combined.indexOf(phone);
        const afterPhone = idxPhone >= 0 ? combined.slice(idxPhone + phone.length).trim() : combined;
        const idxDate = deliveryDate ? afterPhone.indexOf(deliveryDate) : -1;
        city = (idxDate >= 0 ? afterPhone.slice(0, idxDate) : afterPhone).trim();
        // trim at first number
        const numIdx = city.search(/-?\d+(?:[.,]\d+)?/);
        if (numIdx >= 0) city = city.slice(0, numIdx).trim();
        city = city.replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
      }
    } catch {}

    const monies = parseDhAmounts(combined);
    const picked = parseCrbtFeesOnly(monies);
    rows.push({
      sendCode,
      orderNumber: extractOrderNumberFromSendCode(sendCode),
      pickupDate: "",
      deliveryDate,
      phone,
      status,
      city,
      crbt: picked.crbt,
      fees: picked.fees,
      total: picked.total,
      raw: combined,
    });
  }

  return { ...hdr, rows };
}

function parseOscarioInvoice(lines) {
  // Fallback parser: treat any row with a "7-xxxxx" and DH amounts as a shipment row.
  const hdr = parseInvoiceHeader(lines);
  const rows = [];
  const sendCodeRe = /\b7-\d{4,}(?:_[A-Z0-9]+)?\b/i;
  const phoneRe = /\b0\d{9}\b/;
  const isoDateRe = /\b\d{4}-\d{2}-\d{2}\b/g;
  const frDateRe = /\b\d{2}\/\d{2}\/\d{4}\b/g;

  const list = (lines || []);
  for (let i = 0; i < list.length; i++) {
    const base = String(list[i] || "").trim();
    if (!sendCodeRe.test(base)) continue;
    const monies0 = parseDhAmounts(base);
    if (monies0.length < 2) continue;
    const sendCode = (base.match(sendCodeRe) || [])[0] || "";
    if (!sendCode) continue;
    const phone = (base.match(phoneRe) || [])[0] || "";
    const metaFinal = findStatusInText(base);
    const status = metaFinal?.label || "";
    const datesIso = (base.match(isoDateRe) || []);
    const datesFr = (base.match(frDateRe) || []);
    const deliveryDate = (datesIso[0] || datesFr[0] || "");
    const picked = parseCrbtFeesOnly(monies0);
    rows.push({
      sendCode,
      orderNumber: extractOrderNumberFromSendCode(sendCode),
      pickupDate: "",
      deliveryDate,
      phone,
      status,
      city: "",
      crbt: picked.crbt,
      fees: picked.fees,
      total: picked.total,
      raw: base,
    });
  }
  return { ...hdr, rows };
}

function parseByCompany(lines, company) {
  const key = String(company || "lionex").trim().toLowerCase();
  if (key === "12livery" || key === "12-livery" || key === "12_livery") return parse12LiveryInvoice(lines);
  if (key === "metalivraison") return parseMetalivraisonInvoice(lines);
  if (key === "ibex") return parseIbexInvoice(lines);
  if (key === "palexpress" || key === "pal-express" || key === "pal_express") return parsePalExpressInvoice(lines);
  if (key === "yfd" || key === "yourfast" || key === "your-fast") return parseYfdInvoice(lines);
  if (key === "livre24" || key === "livre-24" || key === "livr\u00e924") return parseLivre24Invoice(lines);
  if (key === "oscario") return parseOscarioInvoice(lines);
  return parseLionexInvoice(lines);
}

function parsePalExpressFromPages(pages) {
  const allLines = [];
  for (const pg of (pages || [])) {
    try { allLines.push(...normalizePdfLines(pg.items || [])); } catch {}
  }
  const hdr = parseInvoiceHeader(allLines);

  const rows = [];
  const extracted = (() => {
    // Pal Express page 2 sometimes splits the code "7-128062" into multiple PDF text items.
    // So we detect rows by reconstructing the code from the Code d'envoi column (x/y based), not by regex on single items.
    const headerLabels = [
      { key: "code", label: "Code d'envoi" },
      { key: "ville", label: "Ville" },
      { key: "destinataire", label: "Destinataire" },
      { key: "date_livraison", label: "Date de livraison" },
      { key: "status", label: "Status" },
      { key: "crbt", label: "Crbt" },
      { key: "frais", label: "Frais" },
    ];
    // Don't use strict word-boundaries here because codes can be split into multiple PDF text items
    // (e.g. "7-" and "128062") which we later normalize by removing whitespace.
    const anchorRe = /7-\d{4,}(?:_[A-Z0-9]+)?/i;

    function inferRangesFromItems(items) {
      // Infer x column boundaries from header labels on THIS page.
      const labelXs = [];
      for (const hl of headerLabels) {
        const want = _normText(hl.label);
        let best = null;
        for (const it of (items || [])) {
          const t = _normText(it.str);
          if (!t) continue;
          if (t === want || (want && t.includes(want))) {
            if (!best || it.y > best.y) best = it;
          }
        }
        if (best) labelXs.push({ key: hl.key, x: best.x, y: best.y });
      }
      labelXs.sort((a, b) => a.x - b.x);
      if (labelXs.length < 2) return null;
      const ranges = {};
      for (let i = 0; i < labelXs.length; i++) {
        const cur = labelXs[i];
        const prev = labelXs[i - 1] || null;
        const next = labelXs[i + 1] || null;
        const left = prev ? (prev.x + cur.x) / 2 : -Infinity;
        const right = next ? (cur.x + next.x) / 2 : Infinity;
        ranges[cur.key] = { left, right };
      }
      return ranges;
    }

    // Build column x-ranges from first page header labels
    const first = pages?.[0]?.items || [];
    const labelXs = [];
    for (const hl of headerLabels) {
      const want = _normText(hl.label);
      let best = null;
      for (const it of first) {
        const t = _normText(it.str);
        if (!t) continue;
        if (t === want || (want && t.includes(want))) {
          if (!best || it.y > best.y) best = it;
        }
      }
      if (best) labelXs.push({ key: hl.key, x: best.x, y: best.y });
    }
    labelXs.sort((a, b) => a.x - b.x);
    if (labelXs.length < 2) {
      // fallback to generic extractor if we can't infer columns
      return extractRowsByAnchorsInColumns({ pages, anchorRe, headerLabels });
    }
    const headerY0 = Math.max(...labelXs.map((x) => x.y));
    const ranges = {};
    for (let i = 0; i < labelXs.length; i++) {
      const cur = labelXs[i];
      const prev = labelXs[i - 1] || null;
      const next = labelXs[i + 1] || null;
      const left = prev ? (prev.x + cur.x) / 2 : -Infinity;
      const right = next ? (cur.x + next.x) / 2 : Infinity;
      ranges[cur.key] = { left, right };
    }

    const outRows = [];
    const Y_LINE_TOL = 4.5;
    const Y_BAND_TOL = 6.0;

    function groupByLines(items) {
      const sorted = (items || []).slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
      const lines = [];
      let cur = [];
      let curY = null;
      for (const it of sorted) {
        if (curY == null) { curY = it.y; cur = [it]; continue; }
        if (Math.abs(it.y - curY) <= Y_LINE_TOL) cur.push(it);
        else { lines.push(cur); curY = it.y; cur = [it]; }
      }
      if (cur.length) lines.push(cur);
      // normalize each line by x asc
      return lines.map((ln) => ln.slice().sort((a, b) => a.x - b.x));
    }

    for (const pg of (pages || [])) {
      const items = (pg.items || []).filter((it) => String(it.str || "").trim());

      // Per-page header detection (optional). If it fails, don't filter.
      let headerYThis = headerY0;
      let headerFound = false;
      try {
        let bestY = null;
        for (const it of items) {
          const t = _normText(it.str);
          if (!t) continue;
          for (const hl of headerLabels) {
            const wn = _normText(hl.label);
            if (!wn) continue;
            if (t === wn || t.includes(wn)) {
              if (bestY == null || it.y > bestY) bestY = it.y;
            }
          }
        }
        if (bestY != null) { headerYThis = bestY; headerFound = true; }
      } catch {}

      const belowHeader = headerFound ? items.filter((it) => it.y < (headerYThis - 5)) : items;

      // IMPORTANT: columns can shift slightly on page 2, so infer x ranges per page when possible.
      const rangesThisPage = inferRangesFromItems(items) || ranges;
      const codeRange = rangesThisPage?.code || null;
      const codeItems = codeRange
        ? belowHeader.filter((it) => it.x >= codeRange.left && it.x < codeRange.right)
        : [];

      // Detect anchors by line reconstruction in code column
      const anchorLines = groupByLines(codeItems.length ? codeItems : belowHeader);
      const anchors = [];
      for (const ln of anchorLines) {
        const txt = ln.map((x) => String(x.str || "").trim()).join(" ").replace(/\s+/g, " ").trim();
        const compact = txt.replace(/\s+/g, "");
        const m = compact.match(anchorRe) || txt.match(anchorRe);
        if (!m) continue;
        anchors.push({ code: m[0], y: ln[0]?.y ?? 0, x: ln[0]?.x ?? 0 });
      }
      anchors.sort((a, b) => b.y - a.y);

      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const next = anchors[i + 1] || null;
        const yTop = a.y + Y_BAND_TOL;
        const yBottom = next ? (next.y + Y_BAND_TOL) : -Infinity;
        const band = belowHeader.filter((it) => it.y <= yTop && it.y >= yBottom);
        const columns = {};
        for (const [key, rg] of Object.entries(rangesThisPage || ranges)) {
          const colItems = band.filter((it) => it.x >= rg.left && it.x < rg.right);
          const lines = groupByLines(colItems);
          const txt = lines
            .map((ln) => ln.map((x) => String(x.str || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          columns[key] = txt;
        }
        outRows.push({ page: pg.page, anchor: a.code, columns });
      }
    }

    return outRows;
  })();

  for (const r of extracted) {
    const sendCode = String(r.anchor || "").trim();
    if (!/^7-\d{4,}/.test(sendCode)) continue;
    const c = r.columns || {};
    let city = String(c.ville || "").replace(/\s+/g, " ").trim();
    // Cleanup: sometimes we still get stray row numbers / codes due to PDF quirks.
    // Remove shipment codes and standalone integers.
    try {
      city = city.replace(/\b7-\d{4,}(?:_[A-Z0-9]+)?\b/gi, " ");
      city = city.replace(/\b\d{1,3}\b/g, " "); // row numbers
      city = city.replace(/\s+/g, " ").trim();
    } catch {}
    const status = normalizeStatusLabel(c.status || "");
    const deliveryDate = (() => {
      // Prefer the date column; fallback to any ISO date in all extracted columns
      const m = String(c.date_livraison || "").match(/\b\d{4}-\d{2}-\d{2}\b/);
      if (m) return m[0];
      try {
        const all = Object.values(c).join(" ");
        const m2 = String(all).match(/\b\d{4}-\d{2}-\d{2}\b/);
        return m2 ? m2[0] : "";
      } catch {
        return "";
      }
    })();
    const phone = (() => {
      const m = String(c.destinataire || "").match(/\b0\d{9}\b/);
      return m ? m[0] : "";
    })();
    const crbt = (() => {
      const xs = parseDhAmounts(c.crbt || "").filter((n) => Math.abs(n) <= 5000);
      return xs.length ? xs[0] : null;
    })();
    const fees = (() => {
      const xs = parseDhAmounts(c.frais || "").filter((n) => Math.abs(n) <= 5000);
      return xs.length ? xs[0] : null;
    })();

    rows.push({
      sendCode,
      orderNumber: extractOrderNumberFromSendCode(sendCode),
      pickupDate: "",
      deliveryDate,
      phone,
      status,
      city,
      crbt,
      fees,
      total: (crbt != null && fees != null) ? (crbt - fees) : null,
      raw: JSON.stringify(c),
    });
  }

  return { ...hdr, rows };
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
        const key = company.trim().toLowerCase();
        let parsedDoc = null;
        if (key === "palexpress" || key === "pal-express" || key === "pal_express") {
          const pages = await extractPdfPagesTextItems(f);
          parsedDoc = parsePalExpressFromPages(pages);
        } else {
          const lines = await extractPdfLines(f);
          parsedDoc = parseByCompany(lines, company);
        }
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
            <div className="text-[11px] text-gray-500">Upload delivery invoice PDF(s) and compare CRBT vs Shopify total</div>
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
              <option value="metalivraison">Metalivraison</option>
              <option value="ibex">IBEX</option>
              <option value="palexpress">Pal Express</option>
              <option value="yfd">YFD (Your Fast)</option>
              <option value="livre24">Livré24</option>
              <option value="oscario">Oscario</option>
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
                        <option value="metalivraison">Metalivraison</option>
                        <option value="ibex">IBEX</option>
                        <option value="palexpress">Pal Express</option>
                        <option value="yfd">YFD (Your Fast)</option>
                        <option value="livre24">Livré24</option>
                        <option value="oscario">Oscario</option>
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


