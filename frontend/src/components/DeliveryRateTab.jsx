import React, { useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";
import { DELIVERY_COMPANIES } from "../lib/deliveryCompanies";

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const COMPANY_LABELS = {
  ibex: "Ibex",
  l24: "L24",
  oscario: "Oscario",
  meta: "Meta",
  pal: "Pal",
  "12livery": "12Livery",
  lx: "Lx",
  k: "K",
  fast: "Fast",
};

function rateBadge(rate) {
  if (rate === null || rate === undefined) {
    return { label: "No data", className: "bg-gray-100 text-gray-500 border-gray-200" };
  }
  if (rate >= 75) return { label: `${rate}%`, className: "bg-green-100 text-green-700 border-green-200" };
  if (rate >= 65) return { label: `${rate}%`, className: "bg-orange-100 text-orange-700 border-orange-200" };
  return { label: `${rate}%`, className: "bg-red-100 text-red-700 border-red-200" };
}

async function fetchDeliveryRate({ store, dateFrom, dateTo }) {
  const params = new URLSearchParams({
    date_from: dateFrom || "",
    date_to: dateTo || "",
    store: store || "",
    companies: DELIVERY_COMPANIES.join(","),
  });
  const res = await authFetch(`/api/delivery-rate?${params.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch delivery rate (${res.status})`);
  return res.json();
}

export default function DeliveryRateTab({ store, onDrillDown }) {
  const [dateFrom, setDateFrom] = useState(() => todayISO(-6));
  const [dateTo, setDateTo] = useState(() => todayISO(0));
  const [rows, setRows] = useState(null);
  const [overall, setOverall] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function calculate() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDeliveryRate({ store, dateFrom, dateTo });
      setRows(data.companies || []);
      setOverall(data.overall || null);
    } catch (e) {
      setError(e?.message || "Failed to calculate delivery rate");
      setRows(null);
      setOverall(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-gray-100 rounded-xl px-3 py-2">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Fulfilled between</div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          />
          <span className="text-[11px] uppercase tracking-wide text-gray-400">to</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          />
          <button
            onClick={calculate}
            disabled={loading || !dateFrom || !dateTo}
            className="ml-2 inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold bg-blue-600 text-white active:scale-[.98] disabled:opacity-50"
          >
            {loading ? "Calculating..." : "Calculate"}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3 font-medium flex items-center gap-2">
          <span>⚠️</span> {error}
        </div>
      )}

      {rows === null && !loading && !error && (
        <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-gray-300">
          <div className="text-gray-400 mb-2 text-4xl">📊</div>
          <div className="text-gray-500 font-medium">Pick a date range and click Calculate</div>
          <div className="text-sm text-gray-400 mt-1">Rates are computed from orders fulfilled in that window</div>
        </div>
      )}

      {rows !== null && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2 text-right">Fulfilled</th>
                <th className="px-4 py-2 text-right">Delivered</th>
                <th className="px-4 py-2 text-right">Returned</th>
                <th className="px-4 py-2 text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const badge = rateBadge(r.rate);
                return (
                  <tr
                    key={r.company}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer"
                    onClick={() => onDrillDown && onDrillDown(r.company, dateFrom, dateTo)}
                  >
                    <td className="px-4 py-2 font-medium">{COMPANY_LABELS[r.company] || r.company}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.fulfilled}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.delivered}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.returned}</td>
                    <td className="px-4 py-2 text-right">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${badge.className}`}>
                        {badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {overall && (
              <tfoot>
                <tr className="bg-gray-50 border-t border-gray-200 font-semibold">
                  <td className="px-4 py-2">Overall</td>
                  <td className="px-4 py-2 text-right tabular-nums">{overall.fulfilled}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{overall.delivered}</td>
                  <td className="px-4 py-2 text-right tabular-nums"></td>
                  <td className="px-4 py-2 text-right">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${rateBadge(overall.rate).className}`}>
                      {rateBadge(overall.rate).label}
                    </span>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
