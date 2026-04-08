import React, { useEffect, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export default function MyAnalytics(){
  const [fromDate, setFromDate] = useState(() => todayISO(-6));
  const [toDate, setToDate] = useState(() => todayISO(0));
  const [store, setStore] = useState(() => {
    try {
      const params = new URLSearchParams(location.search);
      const s = (params.get("store") || "all").trim().toLowerCase();
      return (s === "irrakids" || s === "irranova") ? s : "all";
    } catch {
      return "all";
    }
  });
  const [user, setUser] = useState(null);
  const [summary, setSummary] = useState({ collected: 0, out: 0, fulfilled: 0, total: 0 });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  async function load(){
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from_date: fromDate,
        to_date: toDate,
      });
      if (store && store !== "all") params.set("store", store);
      const res = await authFetch(`/api/agent/my-stats?${params.toString()}`, {
        headers: authHeaders({ "Accept": "application/json" }),
      });
      if (!res.ok) {
        const js = await res.json().catch(() => ({ detail: "Failed to load analytics" }));
        throw new Error(js.detail || "Failed to load analytics");
      }
      const js = await res.json();
      if (requestId !== requestIdRef.current) return;
      setUser(js.user || null);
      setSummary(js.summary || { collected: 0, out: 0, fulfilled: 0, total: 0 });
      setRows(js.rows || []);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e?.message || "Failed to load analytics");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <div>
            <div className="text-lg font-semibold">My Analytics</div>
            <div className="text-xs text-gray-500">{user?.name || user?.email || "Agent"}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => { try { history.back(); } catch {} }}
              className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50"
            >
              Back
            </button>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 pb-3 grid sm:grid-cols-4 gap-3">
          <div className="bg-gray-100 rounded-xl px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Store</div>
            <div className="inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white">
              <button onClick={()=>setStore("all")} className={`px-3 py-1 rounded-lg text-xs font-medium ${store === 'all' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}>All</button>
              <button onClick={()=>setStore("irrakids")} className={`px-3 py-1 rounded-lg text-xs font-medium ${store === 'irrakids' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}>Irrakids</button>
              <button onClick={()=>setStore("irranova")} className={`px-3 py-1 rounded-lg text-xs font-medium ${store === 'irranova' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}>Irranova</button>
            </div>
          </div>
          <div className="bg-gray-100 rounded-xl px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">From</div>
            <input type="date" value={fromDate} onChange={(e)=>setFromDate(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" />
          </div>
          <div className="bg-gray-100 rounded-xl px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">To</div>
            <input type="date" value={toDate} onChange={(e)=>setToDate(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white" />
          </div>
          <div className="bg-gray-100 rounded-xl px-3 py-2 flex items-end">
            <button onClick={load} className="w-full text-sm px-3 py-2 rounded-lg bg-gray-900 text-white font-semibold active:scale-[.98]">Apply</button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-4">
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        {loading ? (
          <div className="text-gray-600">Loading…</div>
        ) : (
          <>
            <section className="mb-4 grid sm:grid-cols-2 md:grid-cols-4 gap-3">
              <div className="border border-green-200 rounded-xl bg-white p-3">
                <div className="text-xs text-gray-500">Collected</div>
                <div className="text-2xl font-semibold text-green-700">{summary.collected || 0}</div>
              </div>
              <div className="border border-red-200 rounded-xl bg-white p-3">
                <div className="text-xs text-gray-500">Out</div>
                <div className="text-2xl font-semibold text-red-700">{summary.out || 0}</div>
              </div>
              <div className="border border-blue-200 rounded-xl bg-white p-3">
                <div className="text-xs text-gray-500">Fulfilled</div>
                <div className="text-2xl font-semibold text-blue-700">{summary.fulfilled || 0}</div>
              </div>
              <div className="border border-gray-200 rounded-xl bg-white p-3">
                <div className="text-xs text-gray-500">Total actions</div>
                <div className="text-2xl font-semibold">{summary.total || 0}</div>
              </div>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">By day</h3>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <thead className="bg-gray-100 text-left">
                    <tr>
                      <th className="px-3 py-2 border-b border-gray-200">Day</th>
                      <th className="px-3 py-2 border-b border-gray-200">Store</th>
                      <th className="px-3 py-2 border-b border-gray-200">Collected</th>
                      <th className="px-3 py-2 border-b border-gray-200">Out</th>
                      <th className="px-3 py-2 border-b border-gray-200">Fulfilled</th>
                      <th className="px-3 py-2 border-b border-gray-200">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(rows || []).map((r, idx) => (
                      <tr key={idx} className="border-b last:border-b-0">
                        <td className="px-3 py-2">{r.day}</td>
                        <td className="px-3 py-2">{r.store}</td>
                        <td className="px-3 py-2 text-green-700">{r.collected}</td>
                        <td className="px-3 py-2 text-red-700">{r.out}</td>
                        <td className="px-3 py-2 text-blue-700">{r.fulfilled || 0}</td>
                        <td className="px-3 py-2 font-semibold">{r.total}</td>
                      </tr>
                    ))}
                    {(rows || []).length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-500">No data in this range.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
