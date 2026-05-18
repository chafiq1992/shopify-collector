import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch, authHeaders, clearAuth } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import { persistStoreSelection, readCurrentStore } from "../lib/stores";
import { enqueueTagWrite, useSyncQueueLength } from "../lib/syncQueue";
import {
  PHONE_TAGS, WHATSAPP_TAGS, nextInCycle, tagsInCycle,
  moroccoInternational, copyToClipboard,
  todayDDMMYY, todayISO, isoToDDMMYY, isCodTag,
} from "../lib/confirmationActions";

// ---------- API helpers ----------
const API = {
  async me() {
    const res = await authFetch("/api/auth/me", { headers: authHeaders() });
    if (!res.ok) throw new Error("auth required");
    return res.json();
  },
  async agentMe() {
    const res = await authFetch("/api/agent/me", { headers: authHeaders() });
    if (!res.ok) throw new Error("agent/me failed");
    return res.json();
  },
  async getQueue(store, { limit = 50, cursor = null } = {}) {
    const qs = new URLSearchParams({ store, limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    const res = await authFetch(`/api/agent/queue?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const js = await res.json().catch(() => ({ detail: "Failed to load queue" }));
      throw new Error(js.detail || `Failed to load queue (${res.status})`);
    }
    return res.json();
  },
  async listAgents() {
    const res = await authFetch("/api/admin/agents", { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to load agents");
    return res.json();
  },
  async createAgent(body) {
    const res = await authFetch("/api/admin/agents", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const js = await res.json().catch(() => ({ detail: "Failed to create agent" }));
    if (!res.ok) throw new Error(js.detail || "Failed to create agent");
    return js;
  },
  async updateAgent(id, body) {
    const res = await authFetch(`/api/admin/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const js = await res.json().catch(() => ({ detail: "Failed to update agent" }));
    if (!res.ok) throw new Error(js.detail || "Failed to update agent");
    return js;
  },
  async deleteAgent(id) {
    const res = await authFetch(`/api/admin/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error("Failed to delete agent");
    return res.json();
  },
  async teamStats(store) {
    const qs = new URLSearchParams({ store });
    const res = await authFetch(`/api/agent/team-stats?${qs}`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Failed to load team stats");
    return res.json();
  },
};

function genPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function goto(path, store) {
  try {
    const s = (store && store !== "all") ? String(store) : "";
    const url = s ? `${path}?store=${encodeURIComponent(s)}` : path;
    history.pushState(null, "", url);
    try { window.dispatchEvent(new PopStateEvent("popstate")); } catch {}
  } catch { try { location.href = path; } catch {} }
}

// ---------- Top-level page ----------
export default function Confirmation() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await API.me();
        if (cancelled) return;
        setMe(data);
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load user");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center text-gray-700 px-4 text-center">
        {error}. <a className="ml-2 underline" href="/login">Sign in</a>
      </div>
    );
  }
  if (!me) {
    return <div className="min-h-screen w-full flex items-center justify-center text-gray-500">Loading…</div>;
  }

  if (me.role === "admin") return <AdminView me={me} />;
  if (me.role === "agent") return <AgentView me={me} />;
  return (
    <div className="min-h-screen w-full flex items-center justify-center text-gray-700">
      Your account does not have access to the Confirmation page.
    </div>
  );
}

// ---------- Header ----------
function Header({ title, store, setStore, rightSlot, me }) {
  return (
    <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="text-lg font-semibold">{title}</div>
        <div className="hidden md:flex items-center gap-2">
          {me?.role === "admin" && (
            <>
              <button onClick={() => goto("/", store)} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Collector</button>
              <button onClick={() => goto("/order-browser", store)} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Order Browser</button>
              <button onClick={() => goto("/admin", store)} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">Admin</button>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {rightSlot}
          <StorePicker value={store} onChange={(v) => setStore(v)} />
          <button
            onClick={() => { clearAuth(); try { location.href = "/login"; } catch {} }}
            className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50"
          >Logout</button>
        </div>
      </div>
    </header>
  );
}

// ---------- Admin view ----------
function AdminView({ me }) {
  const [store, setStore] = useState(() => readCurrentStore());
  useEffect(() => { persistStoreSelection(store); }, [store]);

  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);

  // Create form
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  const loadAgents = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const js = await API.listAgents();
      setAgents(js.agents || []);
    } catch (e) {
      setError(e?.message || "Failed to load agents");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  async function handleCreate(e) {
    e?.preventDefault?.();
    setStatusMsg(null);
    try {
      const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
      await API.createAgent({ email, password, name: name || null, tags });
      setStatusMsg(`Created agent ${email}`);
      setEmail(""); setName(""); setPassword(""); setTagsInput("");
      await loadAgents();
    } catch (e2) {
      setStatusMsg(e2?.message || "Failed to create agent");
    }
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <Header title="Confirmation · Admin" store={store} setStore={setStore} me={me} />
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {statusMsg && <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{statusMsg}</div>}
        {error && <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}

        <section className="bg-white border border-gray-200 rounded-2xl p-5">
          <div className="text-sm font-semibold mb-3">Create agent</div>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
            <input
              required
              type="email"
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
            />
            <input
              type="text"
              placeholder="Display name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
            />
            <div className="flex gap-2">
              <input
                required
                type="text"
                placeholder="Temporary password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
              />
              <button
                type="button"
                onClick={() => setPassword(genPassword())}
                className="text-xs px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50"
              >Generate</button>
            </div>
            <input
              type="text"
              placeholder="Shopify tags (comma-separated) e.g. agent_yasmine, vip"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
            />
            <div className="md:col-span-2">
              <button type="submit" className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">
                Create agent
              </button>
            </div>
          </form>
        </section>

        <section className="bg-white border border-gray-200 rounded-2xl p-5">
          <div className="flex items-center mb-3">
            <div className="text-sm font-semibold">Agents</div>
            <button onClick={loadAgents} className="ml-auto text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
          {agents.length === 0 ? (
            <div className="text-sm text-gray-500">No agents yet.</div>
          ) : (
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-2 py-2">Name</th>
                    <th className="px-2 py-2">Email</th>
                    <th className="px-2 py-2">Tags</th>
                    <th className="px-2 py-2">Active</th>
                    <th className="px-2 py-2">Last login</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <AgentRow key={a.id} agent={a} onChanged={loadAgents} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function AgentRow({ agent, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name || "");
  const [tagsInput, setTagsInput] = useState((agent.tags || []).join(", "));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const body = {
        name: name || null,
        tags: tagsInput.split(",").map((t) => t.trim()).filter(Boolean),
      };
      if (password.trim()) body.password = password.trim();
      await API.updateAgent(agent.id, body);
      setEditing(false);
      setPassword("");
      onChanged?.();
    } catch (e) {
      setMsg(e?.message || "Failed to save");
    } finally { setBusy(false); }
  }

  async function deactivate() {
    if (!confirm(`Delete agent ${agent.email}? They will no longer be able to log in.`)) return;
    setBusy(true);
    try {
      await API.deleteAgent(agent.id);
      onChanged?.();
    } catch (e) {
      setMsg(e?.message || "Failed to delete");
    } finally { setBusy(false); }
  }

  if (!editing) {
    return (
      <tr className="border-t border-gray-100">
        <td className="px-2 py-2">{agent.name || <span className="text-gray-400">—</span>}</td>
        <td className="px-2 py-2">{agent.email}</td>
        <td className="px-2 py-2">
          {(agent.tags || []).length === 0 ? (
            <span className="text-gray-400 text-xs">no tags</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {(agent.tags || []).map((t) => (
                <span key={t} className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full">{t}</span>
              ))}
            </div>
          )}
        </td>
        <td className="px-2 py-2">{agent.is_active ? "✓" : "—"}</td>
        <td className="px-2 py-2 text-xs text-gray-500">
          {agent.last_login_at ? new Date(agent.last_login_at).toLocaleString() : "never"}
        </td>
        <td className="px-2 py-2 text-right">
          <button onClick={() => setEditing(true)} className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 mr-1">Edit</button>
          <button onClick={deactivate} disabled={busy} className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50">Delete</button>
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-t border-gray-100 bg-gray-50">
      <td className="px-2 py-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full text-sm border border-gray-300 rounded px-2 py-1" />
      </td>
      <td className="px-2 py-2 text-xs text-gray-500">{agent.email}</td>
      <td className="px-2 py-2">
        <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="tag1, tag2" className="w-full text-sm border border-gray-300 rounded px-2 py-1" />
      </td>
      <td className="px-2 py-2 text-xs">
        <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" className="w-full text-sm border border-gray-300 rounded px-2 py-1" />
      </td>
      <td className="px-2 py-2 text-xs text-gray-500" colSpan={1}>
        {msg && <div className="text-rose-700">{msg}</div>}
      </td>
      <td className="px-2 py-2 text-right">
        <button onClick={save} disabled={busy} className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 mr-1 disabled:opacity-50">Save</button>
        <button onClick={() => { setEditing(false); setName(agent.name || ""); setTagsInput((agent.tags || []).join(", ")); setPassword(""); }} className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Cancel</button>
      </td>
    </tr>
  );
}

// ---------- Agent view ----------
function AgentView({ me }) {
  const [store, setStore] = useState(() => readCurrentStore());
  useEffect(() => { persistStoreSelection(store); }, [store]);

  const [agentInfo, setAgentInfo] = useState(null); // /api/agent/me (includes tags)
  const [data, setData] = useState({ orders: [], assigned_total: 0, today_label: "", nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastLoadedAt, setLastLoadedAt] = useState(null);
  const [nowTick, setNowTick] = useState(0);
  const [expanded, setExpanded] = useState(() => new Set());
  const [datePickerFor, setDatePickerFor] = useState(null);
  const [chosenDate, setChosenDate] = useState(() => todayISO());
  const [teamStats, setTeamStats] = useState([]);
  const requestIdRef = useRef(0);
  const teamRequestIdRef = useRef(0);
  const syncCount = useSyncQueueLength();

  const loadAgentMe = useCallback(async () => {
    try {
      const js = await API.agentMe();
      setAgentInfo(js);
    } catch {}
  }, []);
  useEffect(() => { loadAgentMe(); }, [loadAgentMe]);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true); setError(null);
    try {
      const js = await API.getQueue(store, { limit: 50 });
      if (reqId !== requestIdRef.current) return;
      setData({
        orders: js.orders || [],
        assigned_total: js.assigned_total || 0,
        today_label: js.today_label || "",
        nextCursor: js.nextCursor || null,
      });
      setLastLoadedAt(Date.now());
    } catch (e) {
      if (reqId !== requestIdRef.current) return;
      setError(e?.message || "Failed to load queue");
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [store]);

  const loadTeam = useCallback(async () => {
    const reqId = ++teamRequestIdRef.current;
    try {
      const js = await API.teamStats(store);
      if (reqId !== teamRequestIdRef.current) return;
      setTeamStats(js.agents || []);
    } catch {}
  }, [store]);

  useEffect(() => { load(); loadTeam(); }, [load, loadTeam]);

  // 15-second polling
  useEffect(() => {
    const t = setInterval(() => { load(); loadTeam(); }, 15_000);
    return () => clearInterval(t);
  }, [load, loadTeam]);

  // 1s freshness ticker
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // ---------- Optimistic local mutations ----------
  function updateLocalOrderTags(orderId, mutate) {
    setData((prev) => ({
      ...prev,
      orders: prev.orders.map((o) =>
        o.id === orderId ? { ...o, tags: mutate([...(o.tags || [])]) } : o
      ),
    }));
  }

  function removeLocalOrder(orderId) {
    setData((prev) => ({
      ...prev,
      orders: prev.orders.filter((o) => o.id !== orderId),
      assigned_total: Math.max(0, (prev.assigned_total || 0) - 1),
    }));
  }

  function dedupTags(tags) {
    const seen = new Set();
    const out = [];
    for (const t of tags) {
      const k = String(t || "").toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(t);
    }
    return out;
  }

  function cyclePhone(order, cycle, kind /* "phone" | "wtp" */) {
    const next = nextInCycle(order.tags || [], cycle);
    const cycleSet = new Set(cycle.map((t) => t.toLowerCase()));
    // Optimistically remove any existing in-cycle tag and add the next one.
    const present = (order.tags || []).filter((t) => cycleSet.has(String(t || "").toLowerCase()));
    updateLocalOrderTags(order.id, (tags) => {
      const filtered = tags.filter((t) => !cycleSet.has(String(t || "").toLowerCase()));
      return dedupTags([...filtered, next]);
    });
    // Enqueue: remove existing cycle tags first, then add the next one.
    for (const old of present) {
      if (String(old).toLowerCase() === next.toLowerCase()) continue;
      enqueueTagWrite({ orderId: order.id, action: "remove", tag: old, store });
    }
    enqueueTagWrite({ orderId: order.id, action: "add", tag: next, store });
    return next;
  }

  async function handlePhone(order) {
    await copyToClipboard(order.phone || "");
    cyclePhone(order, PHONE_TAGS, "phone");
  }

  async function handleWhatsApp(order) {
    const intl = moroccoInternational(order.phone || "");
    await copyToClipboard(intl);
    cyclePhone(order, WHATSAPP_TAGS, "wtp");
  }

  function openDatePicker(order) {
    setChosenDate(todayISO());
    setDatePickerFor(order.id);
  }

  function submitConfirm(order) {
    const dd = isoToDDMMYY(chosenDate);
    if (!dd) return;
    const tag = `cod ${dd}`;
    // If choosing today, remove from queue immediately (matches server filter).
    if (dd === todayDDMMYY()) {
      removeLocalOrder(order.id);
    } else {
      updateLocalOrderTags(order.id, (tags) => dedupTags([...tags, tag]));
    }
    enqueueTagWrite({ orderId: order.id, action: "add", tag, store });
    setDatePickerFor(null);
  }

  function removeTagOptimistic(order, tag) {
    updateLocalOrderTags(order.id, (tags) => tags.filter((t) => String(t || "").toLowerCase() !== String(tag || "").toLowerCase()));
    enqueueTagWrite({ orderId: order.id, action: "remove", tag, store });
  }

  // ---------- Stats ----------
  const stats = useMemo(() => {
    const orders = data.orders || [];
    let n1 = 0, n2 = 0, n3 = 0, notCalled = 0, contacted = 0;
    for (const o of orders) {
      const tags = (o.tags || []).map((t) => String(t || "").toLowerCase());
      const has1 = tags.includes("n1");
      const has2 = tags.includes("n2");
      const has3 = tags.includes("n3");
      if (has3) n3++;
      else if (has2) n2++;
      else if (has1) n1++;
      else notCalled++;
      if (has1 || has2 || has3) contacted++;
    }
    return { n1, n2, n3, notCalled, contacted };
  }, [data.orders]);

  const confirmedToday = useMemo(() => {
    const mine = teamStats.find((a) => a.id === me.id);
    return mine?.confirmed_today || 0;
  }, [teamStats, me?.id]);

  const updatedAgoSec = useMemo(() => {
    if (!lastLoadedAt) return null;
    return Math.max(0, Math.floor((Date.now() - lastLoadedAt) / 1000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLoadedAt, nowTick]);

  const tagsAssigned = agentInfo?.tags || me?.tags || [];

  // Hide the order completely while a "cod today" write is pending if the row was removed locally.
  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <Header
        title="Confirmation"
        store={store}
        setStore={setStore}
        me={me}
        rightSlot={
          <div className="flex items-center gap-2">
            {syncCount > 0 && (
              <span className="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                Syncing {syncCount}
              </span>
            )}
            <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700 border border-gray-200">
              {updatedAgoSec == null ? "Updating…" : `Updated ${updatedAgoSec}s ago`}
            </span>
            <button onClick={() => { load(); loadTeam(); }} className="text-xs px-3 py-1 rounded-full border border-gray-300 bg-white hover:bg-gray-50">
              Refresh
            </button>
          </div>
        }
      />
      <main className="max-w-7xl mx-auto px-4 py-4 space-y-4">
        {/* Stats pills */}
        <div className="flex flex-wrap gap-2">
          <StatPill label="Assigned" value={data.assigned_total} />
          <StatPill label="In view" value={(data.orders || []).length} />
          <StatPill label="Not called" value={stats.notCalled} accent="indigo" />
          <StatPill label="N1" value={stats.n1} />
          <StatPill label="N2" value={stats.n2} />
          <StatPill label="N3" value={stats.n3} />
          <StatPill label="Total contacted" value={stats.contacted} />
          <StatPill label="Confirmed today" value={confirmedToday} accent="emerald" />
        </div>
        {data.assigned_total > (data.orders || []).length && (
          <div className="text-xs text-gray-500">
            Showing {(data.orders || []).length} of {data.assigned_total} — paginate to see the rest.
          </div>
        )}
        {tagsAssigned.length === 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No tags assigned to your account yet. Ask your admin to add at least one Shopify tag.
          </div>
        )}
        {error && <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}

        {/* Order table */}
        <section className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">Address</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Tags</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(data.orders || []).length === 0 && !loading && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500">No orders in your queue.</td></tr>
                )}
                {(data.orders || []).map((o) => {
                  const isOpen = expanded.has(o.id);
                  const pickerOpen = datePickerFor === o.id;
                  return (
                    <React.Fragment key={o.id}>
                      <tr
                        className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
                        onClick={(e) => {
                          // Don't toggle when clicking on inputs/buttons inside the row.
                          const tag = (e.target?.tagName || "").toLowerCase();
                          if (["button", "input", "select", "a", "svg", "path"].includes(tag)) return;
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(o.id)) next.delete(o.id); else next.add(o.id);
                            return next;
                          });
                        }}
                      >
                        <td className="px-3 py-2 font-medium">{o.name || `#${o.number}`}</td>
                        <td className="px-3 py-2">{o.customer_name || <span className="text-gray-400">—</span>}</td>
                        <td className="px-3 py-2 font-mono text-xs">{o.phone || <span className="text-gray-400">—</span>}</td>
                        <td className="px-3 py-2 text-xs text-gray-700">
                          {[o.shipping_address1, o.shipping_city].filter(Boolean).join(", ") || <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{o.total_price} {o.currency}</td>
                        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                          {o.created_at ? new Date(o.created_at).toLocaleString() : ""}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {(o.tags || []).map((t) => (
                              <span key={t} className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border ${isCodTag(t) ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-50 text-gray-700 border-gray-200"}`}>
                                {t}
                                <button
                                  onClick={(ev) => { ev.stopPropagation(); removeTagOptimistic(o, t); }}
                                  className="ml-1 text-gray-400 hover:text-rose-600"
                                  title="Remove tag"
                                >×</button>
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <div className="inline-flex gap-1">
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handlePhone(o); }}
                              className="text-xs px-3 py-1 rounded-lg bg-sky-600 text-white hover:bg-sky-700"
                              title="Copy phone + advance n1/n2/n3"
                            >
                              📞 {tagsInCycle(o.tags || [], PHONE_TAGS).slice(-1)[0] || ""}
                            </button>
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handleWhatsApp(o); }}
                              className="text-xs px-3 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                              title="Copy international phone + advance wtp1/wtp2/wtp3"
                            >
                              💬 {tagsInCycle(o.tags || [], WHATSAPP_TAGS).slice(-1)[0] || ""}
                            </button>
                            <button
                              onClick={(ev) => { ev.stopPropagation(); openDatePicker(o); }}
                              className="text-xs px-3 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                              title="Confirm for a delivery date"
                            >✅</button>
                          </div>
                        </td>
                      </tr>
                      {pickerOpen && (
                        <tr className="bg-indigo-50/40">
                          <td colSpan={8} className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-700">Confirm delivery for:</span>
                              <input
                                type="date"
                                value={chosenDate}
                                onChange={(e) => setChosenDate(e.target.value)}
                                className="text-sm border border-gray-300 rounded px-2 py-1"
                              />
                              <button
                                onClick={(ev) => { ev.stopPropagation(); submitConfirm(o); }}
                                className="text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                              >Confirm</button>
                              <button
                                onClick={(ev) => { ev.stopPropagation(); setDatePickerFor(null); }}
                                className="text-xs px-3 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50"
                              >Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {isOpen && (
                        <tr className="bg-gray-50/60">
                          <td colSpan={8} className="px-3 py-3">
                            <LineItemsGrid order={o} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Team panel */}
        <section className="bg-white border border-gray-200 rounded-2xl p-4">
          <div className="text-sm font-semibold mb-2">Team confirmations today {data.today_label && <span className="text-xs text-gray-500 font-normal">({data.today_label})</span>}</div>
          {teamStats.length === 0 ? (
            <div className="text-xs text-gray-500">No team data yet.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {teamStats.map((a) => (
                <div key={a.id} className={`text-xs rounded-lg border px-3 py-2 ${a.id === me.id ? "border-indigo-300 bg-indigo-50" : "border-gray-200 bg-gray-50"}`}>
                  <div className="font-medium">{a.name || a.email}</div>
                  <div className="text-gray-600">{a.confirmed_today} confirmed</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function StatPill({ label, value, accent }) {
  const palette = accent === "indigo"
    ? "bg-indigo-50 text-indigo-700 border-indigo-200"
    : accent === "emerald"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : "bg-white text-gray-700 border-gray-200";
  return (
    <div className={`rounded-xl border px-3 py-2 min-w-[88px] ${palette}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-lg font-semibold leading-tight">{value}</div>
    </div>
  );
}

function LineItemsGrid({ order }) {
  const items = order.line_items || [];
  if (items.length === 0) return <div className="text-xs text-gray-500">No line items.</div>;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {items.map((li, idx) => (
        <div key={idx} className="bg-white border border-gray-200 rounded-xl p-3">
          <div className="w-full h-32 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center mb-2">
            {li.image ? (
              <img src={li.image} alt={li.title} className="w-full h-full object-cover" />
            ) : <span className="text-xs text-gray-400">no image</span>}
          </div>
          <div className="text-sm font-medium leading-tight line-clamp-2">{li.title}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {(li.options || []).map((opt, i) => (
              <span key={i} className="text-[10px] bg-gray-100 text-gray-700 border border-gray-200 px-2 py-0.5 rounded-full">
                {opt.name} {opt.value}
              </span>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
            <div className="bg-gray-50 rounded p-1">
              <div className="text-[10px] uppercase text-gray-500">Qty</div>
              <div className="font-semibold">{li.quantity}</div>
            </div>
            <div className="bg-gray-50 rounded p-1">
              <div className="text-[10px] uppercase text-gray-500">Unit</div>
              <div className="font-semibold">{li.unit_price}</div>
            </div>
            <div className="bg-gray-50 rounded p-1">
              <div className="text-[10px] uppercase text-gray-500">Total</div>
              <div className="font-semibold">{(Number(li.unit_price || 0) * Number(li.quantity || 0)).toFixed(2)}</div>
            </div>
          </div>
          {li.sku && <div className="mt-1 text-[10px] text-gray-500 truncate" title={li.sku}>SKU: {li.sku}</div>}
        </div>
      ))}
    </div>
  );
}
