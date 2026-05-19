import React, { useEffect, useRef, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";
import StorePicker from "../components/StorePicker";

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

  // Confirmation team metrics (n1..n4, nowtp, enatt, confirmed, cancelled per user/day-range)
  const [confStatsRows, setConfStatsRows] = useState([]);
  const [confStatsSummary, setConfStatsSummary] = useState({});
  const [confStatsLoading, setConfStatsLoading] = useState(false);
  const confStatsRequestIdRef = useRef(0);

  // Inline user edit (name, tags, password, role)
  const [editingUserId, setEditingUserId] = useState(null);
  const [editUserName, setEditUserName] = useState("");
  const [editUserTags, setEditUserTags] = useState("");
  const [editUserPassword, setEditUserPassword] = useState("");
  const [editUserRole, setEditUserRole] = useState("collector");
  const [usersBusy, setUsersBusy] = useState(false);
  const [usersEditMsg, setUsersEditMsg] = useState(null);

  const [orderSearch, setOrderSearch] = useState("");
  const [orderSearchResults, setOrderSearchResults] = useState([]);
  const [orderSearchLoading, setOrderSearchLoading] = useState(false);
  const [orderSearchError, setOrderSearchError] = useState(null);
  const statsRequestIdRef = useRef(0);
  const outRequestIdRef = useRef(0);
  const usersRequestIdRef = useRef(0);
  const orderSearchRequestIdRef = useRef(0);
  const returnStatsRequestIdRef = useRef(0);
  const returnEventsRequestIdRef = useRef(0);

  const [returnStatsSummary, setReturnStatsSummary] = useState({});
  const [returnStatsRows, setReturnStatsRows] = useState([]);
  const [returnStatsLoading, setReturnStatsLoading] = useState(false);
  const [returnEventRows, setReturnEventRows] = useState([]);
  const [returnEventsLoading, setReturnEventsLoading] = useState(false);

  async function searchOrderEvents(){
    const requestId = ++orderSearchRequestIdRef.current;
    const num = (orderSearch || "").trim().replace(/^#/, "");
    if (!num) {
      setOrderSearchError("Enter an order number");
      return;
    }
    setOrderSearchLoading(true);
    setOrderSearchError(null);
    setOrderSearchResults([]);
    try {
      const res = await authFetch(`/api/admin/order-events?order_number=${encodeURIComponent(num)}`, {
        headers: authHeaders({"Accept": "application/json"})
      });
      if (!res.ok) {
        const js = await res.json().catch(() => ({ detail: "Failed to search" }));
        throw new Error(js.detail || "Failed to search");
      }
      const js = await res.json();
      if (requestId !== orderSearchRequestIdRef.current) return;
      setOrderSearchResults(js.rows || []);
      if ((js.rows || []).length === 0) setOrderSearchError(`No events found for order #${num}`);
    } catch (e) {
      if (requestId !== orderSearchRequestIdRef.current) return;
      setOrderSearchError(e?.message || "Failed to search");
    } finally {
      if (requestId === orderSearchRequestIdRef.current) setOrderSearchLoading(false);
    }
  }

  async function load(){
    const requestId = ++statsRequestIdRef.current;
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
      if (requestId !== statsRequestIdRef.current) return;
      setRows(js.rows || []);
      setSummary(js.summary || {});
    } catch (e){
      if (requestId !== statsRequestIdRef.current) return;
      setError(e?.message || "Failed to load stats");
    } finally {
      if (requestId === statsRequestIdRef.current) setLoading(false);
    }
  }

  async function loadOutEvents(){
    const requestId = ++outRequestIdRef.current;
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
      if (requestId !== outRequestIdRef.current) return;
      setOutRows(js.rows || []);
    } catch (e){
      if (requestId !== outRequestIdRef.current) return;
      setAdminMsg(e?.message || "Failed to load OUT orders");
    } finally {
      if (requestId === outRequestIdRef.current) setOutLoading(false);
    }
  }

  async function loadUsers(){
    const requestId = ++usersRequestIdRef.current;
    try {
      const res = await authFetch(`/api/admin/users`, {
        headers: authHeaders({"Accept":"application/json"})
      });
      if (!res.ok) {
        const js = await res.json().catch(()=>({detail:"Failed to load users"}));
        throw new Error(js.detail || "Failed to load users");
      }
      const js = await res.json();
      if (requestId !== usersRequestIdRef.current) return;
      setUsers(js.users || []);
    } catch (e){
      if (requestId !== usersRequestIdRef.current) return;
      // Keep stats visible even if this fails
      setAdminMsg(e?.message || "Failed to load users");
    }
  }

  async function loadReturnStats(){
    const requestId = ++returnStatsRequestIdRef.current;
    setReturnStatsLoading(true);
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      const res = await authFetch(`/api/admin/return-scan-stats?${params.toString()}`, {
        headers: authHeaders({"Accept":"application/json"})
      });
      if (!res.ok) {
        const js = await res.json().catch(()=>({detail:"Failed to load return stats"}));
        throw new Error(js.detail || "Failed to load return stats");
      }
      const js = await res.json();
      if (requestId !== returnStatsRequestIdRef.current) return;
      setReturnStatsSummary(js.summary || {});
      setReturnStatsRows(js.rows || []);
    } catch (e){
      if (requestId !== returnStatsRequestIdRef.current) return;
      setAdminMsg(e?.message || "Failed to load return stats");
    } finally {
      if (requestId === returnStatsRequestIdRef.current) setReturnStatsLoading(false);
    }
  }

  async function loadConfirmationStats(){
    const requestId = ++confStatsRequestIdRef.current;
    setConfStatsLoading(true);
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (store && store !== "all") params.set("store", store);
      const res = await authFetch(`/api/admin/confirmation-stats?${params.toString()}`, {
        headers: authHeaders({"Accept":"application/json"})
      });
      if (!res.ok) {
        const js = await res.json().catch(()=>({detail:"Failed to load confirmation stats"}));
        throw new Error(js.detail || "Failed to load confirmation stats");
      }
      const js = await res.json();
      if (requestId !== confStatsRequestIdRef.current) return;
      setConfStatsRows(js.rows || []);
      setConfStatsSummary(js.summary || {});
    } catch (e){
      if (requestId !== confStatsRequestIdRef.current) return;
      setAdminMsg(e?.message || "Failed to load confirmation stats");
    } finally {
      if (requestId === confStatsRequestIdRef.current) setConfStatsLoading(false);
    }
  }

  async function loadReturnEvents(){
    const requestId = ++returnEventsRequestIdRef.current;
    setReturnEventsLoading(true);
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      const res = await authFetch(`/api/admin/return-scan-events?${params.toString()}`, {
        headers: authHeaders({"Accept":"application/json"})
      });
      if (!res.ok) {
        const js = await res.json().catch(()=>({detail:"Failed to load return events"}));
        throw new Error(js.detail || "Failed to load return events");
      }
      const js = await res.json();
      if (requestId !== returnEventsRequestIdRef.current) return;
      setReturnEventRows(js.rows || []);
    } catch (e){
      if (requestId !== returnEventsRequestIdRef.current) return;
      setAdminMsg(e?.message || "Failed to load return events");
    } finally {
      if (requestId === returnEventsRequestIdRef.current) setReturnEventsLoading(false);
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

  function parseTagsInput(raw){
    return String(raw || "").split(",").map(t => t.trim()).filter(Boolean);
  }

  function startEditUser(u){
    setEditingUserId(u.id);
    setEditUserName(u.name || "");
    setEditUserTags((u.tags || []).join(", "));
    setEditUserPassword("");
    setEditUserRole(u.role || "collector");
    setUsersEditMsg(null);
  }

  function cancelEditUser(){
    setEditingUserId(null);
    setEditUserName(""); setEditUserTags(""); setEditUserPassword(""); setEditUserRole("collector");
  }

  async function saveEditUser(u){
    setUsersBusy(true); setUsersEditMsg(null);
    try {
      const body = {
        name: editUserName || null,
        tags: parseTagsInput(editUserTags),
        role: editUserRole,
      };
      if ((editUserPassword || "").trim()) body.password = editUserPassword.trim();
      const res = await authFetch(`/api/admin/users/${encodeURIComponent(u.id)}`, {
        method: "PATCH",
        headers: authHeaders({"Content-Type":"application/json"}),
        body: JSON.stringify(body),
      });
      const js = await res.json().catch(()=>({detail:"Failed to save user"}));
      if (!res.ok) throw new Error(js.detail || "Failed to save user");
      cancelEditUser();
      setUsersEditMsg(`Updated: ${u.email}`);
      await loadUsers();
    } catch (e){
      setUsersEditMsg(e?.message || "Failed to save user");
    } finally {
      setUsersBusy(false);
    }
  }

  async function removeUserTag(u, tag){
    setUsersBusy(true); setUsersEditMsg(null);
    try {
      const nextTags = (u.tags || []).filter(t => String(t).toLowerCase() !== String(tag).toLowerCase());
      const res = await authFetch(`/api/admin/users/${encodeURIComponent(u.id)}`, {
        method: "PATCH",
        headers: authHeaders({"Content-Type":"application/json"}),
        body: JSON.stringify({ tags: nextTags }),
      });
      if (!res.ok){
        const js = await res.json().catch(()=>({detail:"Failed to remove tag"}));
        throw new Error(js.detail || "Failed to remove tag");
      }
      await loadUsers();
    } catch (e){
      setUsersEditMsg(e?.message || "Failed to remove tag");
    } finally {
      setUsersBusy(false);
    }
  }

  async function deleteUser(u){
    if (!confirm(`Delete user ${u.email}? They will no longer be able to log in.`)) return;
    setUsersBusy(true); setUsersEditMsg(null);
    try {
      const res = await authFetch(`/api/admin/users/${encodeURIComponent(u.id)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok){
        const js = await res.json().catch(()=>({detail:`Failed to delete (${res.status})`}));
        throw new Error(js.detail || `Failed to delete (${res.status})`);
      }
      setUsersEditMsg(`Deleted ${u.email}`);
      await loadUsers();
    } catch (e){
      setUsersEditMsg(e?.message || "Failed to delete user");
    } finally {
      setUsersBusy(false);
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
  useEffect(() => { loadConfirmationStats(); }, []); // initial

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
            <button onClick={()=>goto("/return-scanner")} className="text-xs px-3 py-1 rounded-full border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100">Return Scanner</button>
            <button onClick={()=>goto("/confirmation")} className="text-xs px-3 py-1 rounded-full border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Confirmation</button>
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
            <button onClick={()=>goto("/return-scanner")} className="text-xs px-3 py-1 rounded-full border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100">Returns</button>
            <button onClick={()=>goto("/confirmation")} className="text-xs px-3 py-1 rounded-full border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Confirm</button>
            <button onClick={()=>goto("/shopify-connect")} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Connect</button>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-3 flex flex-wrap items-end gap-3">
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex-1 min-w-[200px]">
            <div className="text-[11px] uppercase tracking-wide text-amber-700 mb-1">Search order</div>
            <div className="flex gap-2">
              <input
                type="text"
                value={orderSearch}
                onChange={(e) => { setOrderSearch(e.target.value); setOrderSearchError(null); }}
                onKeyDown={(e) => e.key === "Enter" && searchOrderEvents()}
                placeholder="e.g. 1001 or #1001"
                className="flex-1 text-sm border border-amber-300 rounded-lg px-2 py-1 bg-white"
              />
              <button
                onClick={searchOrderEvents}
                disabled={orderSearchLoading}
                className="text-sm px-3 py-1 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-60"
              >
                {orderSearchLoading ? "Searching…" : "Search"}
              </button>
            </div>
            {orderSearchError && <div className="mt-1 text-xs text-amber-800">{orderSearchError}</div>}
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-3 grid sm:grid-cols-4 gap-3">
          <div className="bg-gray-100 rounded-xl px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Store</div>
            <StorePicker value={store} onChange={setStore} includeAll allowCustom={false} />
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
            <button onClick={() => { load(); loadConfirmationStats(); }} className="w-full text-sm px-3 py-2 rounded-lg bg-gray-900 text-white font-semibold active:scale-[.98]">Apply</button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-4">
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        {adminMsg && <div className="mb-3 text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">{adminMsg}</div>}
        {orderSearchResults.length > 0 && (
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Order #{orderSearchResults[0]?.order_number || orderSearch.replace(/^#/, "")} — who collected / fulfilled</h3>
            <div className="overflow-x-auto border border-gray-200 rounded-xl bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100 text-left">
                  <tr>
                    <th className="px-3 py-2 border-b border-gray-200">Action</th>
                    <th className="px-3 py-2 border-b border-gray-200">User</th>
                    <th className="px-3 py-2 border-b border-gray-200">Store</th>
                    <th className="px-3 py-2 border-b border-gray-200">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {orderSearchResults.map((r, idx) => (
                    <tr key={idx} className="border-b last:border-b-0">
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          r.action === "collected" ? "bg-green-100 text-green-800 border border-green-200" :
                          r.action === "fulfilled" ? "bg-blue-100 text-blue-800 border border-blue-200" :
                          "bg-red-100 text-red-800 border border-red-200"
                        }`}>
                          {r.action}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r?.user?.name || r?.user?.email || r?.user?.id || "—"}</div>
                        <div className="text-xs text-gray-500">{r?.user?.email || ""}</div>
                      </td>
                      <td className="px-3 py-2">{r.store}</td>
                      <td className="px-3 py-2 text-gray-600">{(r.created_at || "").replace("T", " ").slice(0, 19)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {loading ? (
          <div className="text-gray-600">Loading…</div>
        ) : (
          <>
            <section className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">User management</h3>
              <div className="grid lg:grid-cols-2 gap-3 mb-3">
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
                      <div className="mt-1 text-[11px] text-gray-500">Tokens expire in 12 hours. Add Shopify tags after creation to route confirmation orders to this user.</div>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Role</label>
                      <select value={newUserRole} onChange={(e)=>setNewUserRole(e.target.value)} className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white">
                        <option value="collector">collector</option>
                        <option value="admin">admin</option>
                        <option value="agent">agent (confirmation)</option>
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
              </div>

              <div className="border border-gray-200 rounded-xl bg-white p-3">
                <div className="flex items-center mb-2">
                  <div className="text-sm font-semibold">Users ({(users || []).length})</div>
                  <span className="ml-3 text-xs text-gray-500">Assign Shopify tags to route COD orders to this user's <a className="underline" href="/confirmation">/confirmation</a> queue.</span>
                  <button onClick={loadUsers} className="ml-auto text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Refresh</button>
                </div>
                {usersEditMsg && (
                  <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{usersEditMsg}</div>
                )}
                <div className="overflow-auto border border-gray-200 rounded-lg">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-100 sticky top-0">
                      <tr>
                        <th className="text-left px-2 py-2 border-b border-gray-200">User</th>
                        <th className="text-left px-2 py-2 border-b border-gray-200">Role</th>
                        <th className="text-left px-2 py-2 border-b border-gray-200">Shopify tags</th>
                        <th className="text-left px-2 py-2 border-b border-gray-200">Last login</th>
                        <th className="text-left px-2 py-2 border-b border-gray-200">Active</th>
                        <th className="text-right px-2 py-2 border-b border-gray-200">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(users || []).length === 0 && (
                        <tr><td colSpan={6} className="px-2 py-3 text-center text-gray-500">No users</td></tr>
                      )}
                      {(users || []).map(u => editingUserId === u.id ? (
                        <tr key={u.id} className="bg-indigo-50/40 border-b last:border-b-0 align-top">
                          <td className="px-2 py-2 min-w-[180px]">
                            <input value={editUserName} onChange={e=>setEditUserName(e.target.value)} placeholder="Name" className="w-full text-sm border border-gray-300 rounded px-2 py-1" />
                            <div className="text-xs text-gray-500 mt-1">{u.email}</div>
                            <input value={editUserPassword} onChange={e=>setEditUserPassword(e.target.value)} placeholder="(optional) new password" className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
                          </td>
                          <td className="px-2 py-2">
                            <select value={editUserRole} onChange={e=>setEditUserRole(e.target.value)} className="text-sm border border-gray-300 rounded px-2 py-1 bg-white">
                              <option value="collector">collector</option>
                              <option value="admin">admin</option>
                              <option value="agent">agent</option>
                            </select>
                          </td>
                          <td className="px-2 py-2 min-w-[220px]">
                            <input value={editUserTags} onChange={e=>setEditUserTags(e.target.value)} placeholder="tag1, tag2" className="w-full text-sm border border-gray-300 rounded px-2 py-1" />
                            <div className="text-[11px] text-gray-500 mt-1">Comma-separated. e.g. agent_yasmine, vip</div>
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-500">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "never"}</td>
                          <td className="px-2 py-2 text-xs">{u.is_active ? "yes" : "no"}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap">
                            <button onClick={()=>saveEditUser(u)} disabled={usersBusy} className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 mr-1 disabled:opacity-50">Save</button>
                            <button onClick={cancelEditUser} className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Cancel</button>
                          </td>
                        </tr>
                      ) : (
                        <tr key={u.id} className="border-b last:border-b-0">
                          <td className="px-2 py-2">
                            <div className="font-medium">{u.email}</div>
                            <div className="text-xs text-gray-500">{u.name || ""}</div>
                          </td>
                          <td className="px-2 py-2 text-xs">{u.role}</td>
                          <td className="px-2 py-2">
                            {(u.tags || []).length === 0 ? (
                              <span className="text-xs text-gray-400">no tags</span>
                            ) : (
                              <div className="flex flex-wrap gap-1 max-w-md">
                                {(u.tags || []).map(t => (
                                  <span key={t} className="inline-flex items-center text-[11px] bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full">
                                    {t}
                                    <button title="Remove tag" onClick={()=>removeUserTag(u, t)} className="ml-1 text-indigo-400 hover:text-rose-600">×</button>
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-500">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "never"}</td>
                          <td className="px-2 py-2 text-xs">{u.is_active ? "yes" : "no"}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap">
                            <button onClick={()=>startEditUser(u)} className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 mr-1">Edit</button>
                            <button onClick={()=>deleteUser(u)} disabled={usersBusy} className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50">Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="mb-6">
              <div className="flex items-center mb-2">
                <h3 className="text-sm font-semibold text-gray-700">Confirmation team metrics</h3>
                <span className="ml-2 text-xs text-gray-500">
                  Counts of each call-center action (N1..N4, NoWTP, Enatt, Confirmed, Cancelled) per agent in the selected date range.
                </span>
                <button onClick={loadConfirmationStats} className="ml-auto text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">
                  {confStatsLoading ? "Loading…" : "Refresh"}
                </button>
              </div>
              <div className="overflow-x-auto bg-white border border-gray-200 rounded-xl">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-600">
                    <tr>
                      <th className="px-3 py-2">Agent</th>
                      <th className="px-3 py-2 text-right">N1</th>
                      <th className="px-3 py-2 text-right">N2</th>
                      <th className="px-3 py-2 text-right">N3</th>
                      <th className="px-3 py-2 text-right">N4</th>
                      <th className="px-3 py-2 text-right">NoWTP</th>
                      <th className="px-3 py-2 text-right">Enatt</th>
                      <th className="px-3 py-2 text-right">Confirmed</th>
                      <th className="px-3 py-2 text-right">Cancelled</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(confStatsRows || []).length === 0 && !confStatsLoading && (
                      <tr><td colSpan={10} className="px-3 py-4 text-center text-gray-500">No confirmation activity in this range.</td></tr>
                    )}
                    {(confStatsRows || []).map((r) => (
                      <tr key={r.user_id} className="border-t border-gray-100">
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.name || r.email || r.user_id}</div>
                          <div className="text-[11px] text-gray-500">{r.email}{r.role ? ` · ${r.role}` : ""}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="inline-block min-w-[28px] px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">{r.n1}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="inline-block min-w-[28px] px-2 py-0.5 rounded bg-orange-50 text-orange-800 border border-orange-200">{r.n2}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="inline-block min-w-[28px] px-2 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200">{r.n3}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="inline-block min-w-[28px] px-2 py-0.5 rounded bg-red-50 text-red-800 border border-red-200">{r.n4}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="inline-block min-w-[28px] px-2 py-0.5 rounded bg-violet-50 text-violet-800 border border-violet-200">{r.nowtp}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="inline-block min-w-[28px] px-2 py-0.5 rounded bg-fuchsia-50 text-fuchsia-800 border border-fuchsia-200">{r.enatt}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="inline-block min-w-[28px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 font-semibold">{r.confirmed}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="inline-block min-w-[28px] px-2 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200">{r.cancelled}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{r.total_attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                  {(confStatsRows || []).length > 0 && (
                    <tfoot className="bg-gray-50">
                      <tr className="border-t border-gray-200 font-semibold text-gray-800">
                        <td className="px-3 py-2 text-right">Total</td>
                        <td className="px-3 py-2 text-right tabular-nums">{confStatsSummary?.n1 || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{confStatsSummary?.n2 || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{confStatsSummary?.n3 || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{confStatsSummary?.n4 || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{confStatsSummary?.nowtp || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{confStatsSummary?.enatt || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{confStatsSummary?.confirmed || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{confStatsSummary?.cancelled || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{confStatsSummary?.total_attempts || 0}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              <div className="text-[11px] text-gray-500 mt-1">
                Computed live from the order audit log (every Phone/Nowtp/Enatt/Confirm/Cancel click).
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
                      <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200">Fulfilled: {row.fulfilled || 0}</span>
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
                      <th className="px-3 py-2 border-b border-gray-200">Fulfilled</th>
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
                        <td className="px-3 py-2 text-blue-700">{r.fulfilled || 0}</td>
                        <td className="px-3 py-2 font-semibold">{r.total}</td>
                      </tr>
                    ))}
                    {(rows || []).length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-500">No data</td></tr>
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
            {/* Return Scan Analytics */}
            <section className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-700">↩️ Return Scan Analytics</h3>
                <div className="flex gap-2">
                  <button
                    onClick={loadReturnStats}
                    className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
                    disabled={returnStatsLoading}
                  >
                    {returnStatsLoading ? "Loading…" : "Load Return Stats"}
                  </button>
                  <button
                    onClick={loadReturnEvents}
                    className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
                    disabled={returnEventsLoading}
                  >
                    {returnEventsLoading ? "Loading…" : "Load Return Events"}
                  </button>
                </div>
              </div>
              {/* Per-user return scan totals */}
              {Object.keys(returnStatsSummary || {}).length > 0 && (
                <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3 mb-4">
                  {Object.entries(returnStatsSummary).map(([uid, row]) => (
                    <div key={uid} className="border border-amber-200 rounded-xl bg-white p-3">
                      <div className="text-sm font-semibold truncate">{row.name || row.email || uid}</div>
                      <div className="text-xs text-gray-500 truncate">{row.email}</div>
                      <div className="mt-2 flex items-center gap-3 text-sm">
                        <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">Return Scans: {row.return_scans || 0}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* Daily breakdown */}
              {(returnStatsRows || []).length > 0 && (
                <div className="overflow-x-auto mb-4">
                  <table className="min-w-full text-sm bg-white border border-gray-200 rounded-xl overflow-hidden">
                    <thead className="bg-gray-100 text-left">
                      <tr>
                        <th className="px-3 py-2 border-b border-gray-200">Day</th>
                        <th className="px-3 py-2 border-b border-gray-200">User</th>
                        <th className="px-3 py-2 border-b border-gray-200">Return Scans</th>
                      </tr>
                    </thead>
                    <tbody>
                      {returnStatsRows.map((r, idx) => (
                        <tr key={idx} className="border-b last:border-b-0">
                          <td className="px-3 py-2">{r.day}</td>
                          <td className="px-3 py-2">
                            <div className="font-medium">{r.name || r.email || r.user_id}</div>
                            <div className="text-xs text-gray-500">{r.email}</div>
                          </td>
                          <td className="px-3 py-2 text-amber-700 font-semibold">{r.return_scans || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {/* Detailed return events */}
              {(returnEventRows || []).length > 0 && (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm bg-white border border-gray-200 rounded-xl overflow-hidden">
                    <thead className="bg-gray-100 text-left">
                      <tr>
                        <th className="px-3 py-2 border-b border-gray-200">Time</th>
                        <th className="px-3 py-2 border-b border-gray-200">Order</th>
                        <th className="px-3 py-2 border-b border-gray-200">Scanner</th>
                        <th className="px-3 py-2 border-b border-gray-200">Store</th>
                        <th className="px-3 py-2 border-b border-gray-200">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {returnEventRows.map((r, idx) => (
                        <tr key={idx} className="border-b last:border-b-0">
                          <td className="px-3 py-2 text-gray-600">{(r.ts || "").replace("T"," ").slice(0,19)}</td>
                          <td className="px-3 py-2 font-semibold">{r.order_name}</td>
                          <td className="px-3 py-2">
                            <div className="font-medium">{r?.user?.name || r?.user?.email || "—"}</div>
                            <div className="text-xs text-gray-500">{r?.user?.email || ""}</div>
                          </td>
                          <td className="px-3 py-2">{(r.store || "").toUpperCase()}</td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              (r.result || "").includes("✅") ? "bg-green-100 text-green-800 border border-green-200" :
                              (r.result || "").includes("❌") ? "bg-red-100 text-red-800 border border-red-200" :
                              "bg-amber-100 text-amber-800 border border-amber-200"
                            }`}>
                              {r.result}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {Object.keys(returnStatsSummary || {}).length === 0 && (returnEventRows || []).length === 0 && (
                <div className="text-sm text-gray-500">Click "Load Return Stats" or "Load Return Events" to see return scan analytics for the selected date range.</div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

