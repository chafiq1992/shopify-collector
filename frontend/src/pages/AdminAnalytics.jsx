import React, { useEffect, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export default function AdminAnalytics(){
  const [fromDate, setFromDate] = useState(() => todayISO(-6));
  const [toDate, setToDate] = useState(() => todayISO(0));
  const [store, setStore] = useState("all");
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function load(){
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from_date: fromDate,
        to_date: toDate,
      });
      if (store && store !== "all") params.set("store", store);
      const res = await authFetch(`/api/admin/users/stats?${params.toString()}`, {
        headers: authHeaders({"Accept":"application/json"})
      });
      if (!res.ok) {
        const js = await res.json().catch(()=>({detail:"Failed to load stats"}));
        throw new Error(js.detail || "Failed to load stats");
      }
      const js = await res.json();
      setRows(js.rows || []);
      setSummary(js.summary || {});
    } catch (e){
      setError(e?.message || "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // initial

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-lg font-semibold">Admin Analytics</div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={()=>history.back()} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Back</button>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-3 grid sm:grid-cols-4 gap-3">
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
      <main className="max-w-6xl mx-auto px-4 py-4">
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        {loading ? (
          <div className="text-gray-600">Loading…</div>
        ) : (
          <>
            <section className="mb-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Per-user totals</h3>
              <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
                {Object.entries(summary || {}).map(([uid, row]) => (
                  <div key={uid} className="border border-gray-200 rounded-xl bg-white p-3">
                    <div className="text-sm font-semibold truncate">{row.name || row.email || uid}</div>
                    <div className="text-xs text-gray-500 truncate">{row.email}</div>
                    <div className="mt-2 flex items-center gap-3 text-sm">
                      <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-800 border border-green-200">Collected: {row.collected}</span>
                      <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800 border border-red-200">Out: {row.out}</span>
                      <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-800 border border-gray-200">Total: {row.total}</span>
                    </div>
                  </div>
                ))}
                {Object.keys(summary || {}).length === 0 && (
                  <div className="text-sm text-gray-600">No data for this range.</div>
                )}
              </div>
            </section>
            <section>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">By day</h3>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <thead className="bg-gray-100 text-left">
                    <tr>
                      <th className="px-3 py-2 border-b border-gray-200">Day</th>
                      <th className="px-3 py-2 border-b border-gray-200">User</th>
                      <th className="px-3 py-2 border-b border-gray-200">Store</th>
                      <th className="px-3 py-2 border-b border-gray-200">Collected</th>
                      <th className="px-3 py-2 border-b border-gray-200">Out</th>
                      <th className="px-3 py-2 border-b border-gray-200">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(rows || []).map((r, idx) => (
                      <tr key={idx} className="border-b last:border-b-0">
                        <td className="px-3 py-2">{r.day}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.name || r.email || r.user_id}</div>
                          <div className="text-xs text-gray-500">{r.email}</div>
                        </td>
                        <td className="px-3 py-2">{r.store}</td>
                        <td className="px-3 py-2 text-green-700">{r.collected}</td>
                        <td className="px-3 py-2 text-red-700">{r.out}</td>
                        <td className="px-3 py-2 font-semibold">{r.total}</td>
                      </tr>
                    ))}
                    {(rows || []).length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-500">No data</td></tr>
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

