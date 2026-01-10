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
  const [outRows, setOutRows] = useState([]);
  const [outLoading, setOutLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [adminMsg, setAdminMsg] = useState(null);

  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState("collector");

  const [resetEmail, setResetEmail] = useState("");
  const [resetPassword, setResetPassword] = useState("");

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

  async function loadOutEvents(){
    setOutLoading(true);
    setAdminMsg(null);
    try {
      const params = new URLSearchParams({
        from_date: fromDate,
        to_date: toDate,
      });
      if (store && store !== "all") params.set("store", store);
      const res = await authFetch(`/api/admin/out-events?${params.toString()}`, {
        headers: authHeaders({"Accept":"application/json"})
      });
      if (!res.ok) {
        const js = await res.json().catch(()=>({detail:"Failed to load OUT orders"}));
        throw new Error(js.detail || "Failed to load OUT orders");
      }
      const js = await res.json();
      setOutRows(js.rows || []);
    } catch (e){
      setAdminMsg(e?.message || "Failed to load OUT orders");
    } finally {
      setOutLoading(false);
    }
  }

  async function loadUsers(){
    try {
      const res = await authFetch(`/api/admin/users`, {
        headers: authHeaders({"Accept":"application/json"})
      });
      if (!res.ok) {
        const js = await res.json().catch(()=>({detail:"Failed to load users"}));
        throw new Error(js.detail || "Failed to load users");
      }
      const js = await res.json();
      setUsers(js.users || []);
    } catch (e){
      // Keep stats visible even if this fails
      setAdminMsg(e?.message || "Failed to load users");
    }
  }

  function genPassword(){
    // Simple, readable random password (no ambiguous chars)
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < 12; i++){
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  async function handleCreateUser(e){
    e?.preventDefault?.();
    setAdminMsg(null);
    try {
      const res = await authFetch(`/api/admin/users/create`, {
        method: "POST",
        headers: authHeaders({"Content-Type":"application/json"}),
        body: JSON.stringify({
          email: newUserEmail,
          password: newUserPassword,
          name: newUserName || null,
          role: newUserRole,
        })
      });
      const js = await res.json().catch(()=>({detail:"Failed to create user"}));
      if (!res.ok) throw new Error(js.detail || "Failed to create user");
      setAdminMsg(`User created: ${js?.user?.email || newUserEmail}`);
      setNewUserEmail(""); setNewUserName(""); setNewUserPassword(""); setNewUserRole("collector");
      await loadUsers();
    } catch (e2){
      setAdminMsg(e2?.message || "Failed to create user");
    }
  }

  async function handleResetPassword(e){
    e?.preventDefault?.();
    setAdminMsg(null);
    try {
      const res = await authFetch(`/api/admin/users/reset-password`, {
        method: "POST",
        headers: authHeaders({"Content-Type":"application/json"}),
        body: JSON.stringify({
          email: resetEmail,
          new_password: resetPassword,
        })
      });
      const js = await res.json().catch(()=>({detail:"Failed to reset password"}));
      if (!res.ok) throw new Error(js.detail || "Failed to reset password");
      setAdminMsg(`Password reset for: ${resetEmail}`);
      setResetEmail(""); setResetPassword("");
      await loadUsers();
    } catch (e2){
      setAdminMsg(e2?.message || "Failed to reset password");
    }
  }

  useEffect(() => { load(); }, []); // initial
  useEffect(() => { loadUsers(); }, []); // initial

  function goto(path){
    try {
      const s = (store && store !== "all") ? String(store) : "";
      const url = s ? `${path}?store=${encodeURIComponent(s)}` : path;
      history.pushState(null, "", url);
      // Ensure the lightweight router in App.jsx re-renders
      try { window.dispatchEvent(new PopStateEvent("popstate")); } catch {}
    } catch {
      try { location.href = path; } catch {}
    }
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-lg font-semibold">Admin Analytics</div>
          <div className="ml-4 hidden md:flex flex-wrap items-center gap-2">
            <button onClick={()=>goto("/")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Collector</button>
            <button onClick={()=>goto("/order-browser")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Order Browser</button>
            <button onClick={()=>goto("/order-tagger")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Order Tagger</button>
            <button onClick={()=>goto("/order-lookup")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Order Lookup</button>
            <button onClick={()=>goto("/variant-orders")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Product Orders</button>
            <button onClick={()=>goto("/shopify-connect")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Shopify Connect</button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={()=>history.back()} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Back</button>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-2 md:hidden">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={()=>goto("/")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Collector</button>
            <button onClick={()=>goto("/order-browser")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Order Browser</button>
            <button onClick={()=>goto("/order-tagger")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Tagger</button>
            <button onClick={()=>goto("/order-lookup")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Lookup</button>
            <button onClick={()=>goto("/variant-orders")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Products</button>
            <button onClick={()=>goto("/shopify-connect")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Connect</button>
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
        {adminMsg && <div className="mb-3 text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">{adminMsg}</div>}
        {loading ? (
          <div className="text-gray-600">Loading…</div>
        ) : (
          <>
            <section className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">User management</h3>
              <div className="grid lg:grid-cols-3 gap-3">
                <div className="border border-gray-200 rounded-xl bg-white p-3">
                  <div className="text-sm font-semibold mb-2">Create user</div>
                  <form onSubmit={handleCreateUser} className="space-y-2">
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Email (username)</label>
                      <input value={newUserEmail} onChange={(e)=>setNewUserEmail(e.target.value)} type="email" className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm" placeholder="user@example.com" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Name (optional)</label>
                      <input value={newUserName} onChange={(e)=>setNewUserName(e.target.value)} type="text" className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm" placeholder="Full name" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Password</label>
                      <div className="flex gap-2">
                        <input value={newUserPassword} onChange={(e)=>setNewUserPassword(e.target.value)} type="text" className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm" placeholder="Set password" />
                        <button type="button" onClick={()=>setNewUserPassword(genPassword())} className="shrink-0 text-xs px-3 py-1 rounded-lg border border-gray-300 bg-white hover:bg-gray-50">Generate</button>
                      </div>
                      <div className="mt-1 text-[11px] text-gray-500">Tokens expire in 12 hours (server setting).</div>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Role</label>
                      <select value={newUserRole} onChange={(e)=>setNewUserRole(e.target.value)} className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white">
                        <option value="collector">collector</option>
                        <option value="admin">admin</option>
                      </select>
                    </div>
                    <button type="submit" className="w-full text-sm px-3 py-2 rounded-lg bg-gray-900 text-white font-semibold active:scale-[.98]">Create user</button>
                  </form>
                </div>

                <div className="border border-gray-200 rounded-xl bg-white p-3">
                  <div className="text-sm font-semibold mb-2">Reset password</div>
                  <form onSubmit={handleResetPassword} className="space-y-2">
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">User email</label>
                      <input value={resetEmail} onChange={(e)=>setResetEmail(e.target.value)} type="email" className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm" placeholder="user@example.com" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">New password</label>
                      <div className="flex gap-2">
                        <input value={resetPassword} onChange={(e)=>setResetPassword(e.target.value)} type="text" className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm" placeholder="New password" />
                        <button type="button" onClick={()=>setResetPassword(genPassword())} className="shrink-0 text-xs px-3 py-1 rounded-lg border border-gray-300 bg-white hover:bg-gray-50">Generate</button>
                      </div>
                    </div>
                    <button type="submit" className="w-full text-sm px-3 py-2 rounded-lg bg-blue-600 text-white font-semibold active:scale-[.98]">Reset password</button>
                  </form>
                </div>

                <div className="border border-gray-200 rounded-xl bg-white p-3">
                  <div className="text-sm font-semibold mb-2">Users</div>
                  <div className="text-xs text-gray-500 mb-2">Email is the login username.</div>
                  <div className="max-h-[320px] overflow-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-100 sticky top-0">
                        <tr>
                          <th className="text-left px-2 py-2 border-b border-gray-200">Email</th>
                          <th className="text-left px-2 py-2 border-b border-gray-200">Role</th>
                          <th className="text-left px-2 py-2 border-b border-gray-200">Active</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(users || []).map(u => (
                          <tr key={u.id} className="border-b last:border-b-0">
                            <td className="px-2 py-2">
                              <div className="font-medium">{u.email}</div>
                              <div className="text-xs text-gray-500">{u.name || ""}</div>
                            </td>
                            <td className="px-2 py-2">{u.role}</td>
                            <td className="px-2 py-2">{u.is_active ? "yes" : "no"}</td>
                          </tr>
                        ))}
                        {(users || []).length === 0 && (
                          <tr><td colSpan={3} className="px-2 py-3 text-center text-gray-500">No users</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <button onClick={loadUsers} className="mt-2 w-full text-sm px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50">Refresh</button>
                </div>
              </div>
            </section>
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
            <section className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-700">OUT orders (details)</h3>
                <button
                  onClick={loadOutEvents}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50"
                  disabled={outLoading}
                >
                  {outLoading ? "Loading…" : "Load OUT orders"}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <thead className="bg-gray-100 text-left">
                    <tr>
                      <th className="px-3 py-2 border-b border-gray-200">Time</th>
                      <th className="px-3 py-2 border-b border-gray-200">Order</th>
                      <th className="px-3 py-2 border-b border-gray-200">Collector</th>
                      <th className="px-3 py-2 border-b border-gray-200">Store</th>
                      <th className="px-3 py-2 border-b border-gray-200">Titles (optional)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(outRows || []).map((r, idx) => (
                      <tr key={idx} className="border-b last:border-b-0">
                        <td className="px-3 py-2 text-gray-600">{(r.created_at || "").replace("T"," ").slice(0,19)}</td>
                        <td className="px-3 py-2 font-semibold">{r.order_number}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r?.user?.name || r?.user?.email || r?.user?.id || "—"}</div>
                          <div className="text-xs text-gray-500">{r?.user?.email || ""}</div>
                        </td>
                        <td className="px-3 py-2">{r.store}</td>
                        <td className="px-3 py-2 text-gray-700">{r.titles || "—"}</td>
                      </tr>
                    ))}
                    {(outRows || []).length === 0 && (
                      <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-500">No OUT orders loaded (or none in range).</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 text-[11px] text-gray-500">
                Tip: this list comes from collector actions (not Shopify tag history). If your database is not persistent, you may see missing rows.
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

