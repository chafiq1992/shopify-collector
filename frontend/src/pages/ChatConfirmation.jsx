import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowRightLeft,
  Ban,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  Ellipsis,
  ExternalLink,
  Hand,
  History,
  Hourglass,
  Inbox,
  MessageCircle,
  MessageSquareText,
  Phone,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  RotateCcw,
  Search,
  ShoppingBag,
  Sparkles,
  StickyNote,
  Plus,
  Tag,
  Trophy,
  Undo2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { authFetch, authHeaders } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import { useToasts, ToastStack } from "../components/Toast";
import { AnimatedNumber, useDepartingList, useFlipList } from "../components/Motion";
import {
  ACTION_BTN, ACTION_THEMES, BTN, CARD, TONES,
  KpiCard, Modal, ModalHeader, PreviewAge, SkeletonCards, SkeletonRows, SourceOption, Spinner, TopBar,
  initialOf, isInteractiveTarget, timeAgo,
} from "../components/ConfirmationUi";
import { copyToClipboard, moroccoInternational } from "../lib/confirmationActions";
import ChatCreateOrderModal from "../components/ChatCreateOrderModal";

// Chat confirmation: customers who asked for a chat on the storefront leave a phone
// number instead of opening WhatsApp, and agents call them back from here. Works
// like the Orders tab: call attempts N1 → N4, en attente, then an outcome.

const PER_PAGE = 50;

const CHAT_LEVELS = [
  { key: "",       label: "All open",   tone: "slate",   count: "total", title: "Open requests, plus today's orders in green" },
  { key: "new",    label: "New",        tone: "indigo",  count: "new" },
  { key: "n1",     label: "N1",         tone: "amber",   count: "n1" },
  { key: "n2",     label: "N2",         tone: "orange",  count: "n2" },
  { key: "n3",     label: "N3",         tone: "rose",    count: "n3" },
  { key: "n4",     label: "N4",         tone: "red",     count: "n4" },
  { key: "enatt",  label: "En attente", tone: "fuchsia", count: "enatt" },
  { key: "closed", label: "Closed",     tone: "slate",   count: "closed" },
  { key: "ordered", label: "Ordered",   tone: "emerald", count: "ordered" },
  { key: "cancelled", label: "Cancelled", tone: "red",   count: "cancelled" },
];

const SCOPES = [
  { key: "mine",       label: "My requests", count: "mine" },
  { key: "unassigned", label: "Unassigned",  count: "unassigned" },
  { key: "all",        label: "All team",    count: "all" },
];

const LEVEL_TONE = { 1: "amber", 2: "orange", 3: "rose", 4: "red" };

const OUTCOMES = {
  ordered:        { label: "Ordered",        tone: "emerald" },
  not_interested: { label: "Not interested", tone: "slate" },
  wrong_number:   { label: "Wrong number",   tone: "rose" },
  cancelled:      { label: "Cancelled",      tone: "red" },
};
// "Closed" lists requests that ended without an order; ordered and cancelled ones have their own pill.
const CLOSED_VIEW = new Set(["not_interested", "wrong_number"]);
const CLOSED = new Set(Object.keys(OUTCOMES));

const SCOPE_STORAGE_KEY = "chatConfirmationScope";
const SUBVIEW_STORAGE_KEY = "chatConfirmationSubview";

// ---------- API ----------
async function jsonOrThrow(res, fallback) {
  if (res.ok) return res.json();
  const js = await res.json().catch(() => ({}));
  throw new Error(js.detail || `${fallback} (${res.status})`);
}

const CHAT_API = {
  async list(store, { scope, level, q, offset, label }) {
    const qs = new URLSearchParams({ store, scope, limit: String(PER_PAGE), offset: String(offset || 0) });
    if (level) qs.set("level", level);
    if (q) qs.set("q", q);
    if (label) qs.set("label", String(label));
    return jsonOrThrow(await authFetch(`/api/chat-requests?${qs}`, { headers: authHeaders() }), "Failed to load chat requests");
  },
  async summary(store) {
    const qs = new URLSearchParams({ store });
    return jsonOrThrow(await authFetch(`/api/chat-requests/summary?${qs}`, { headers: authHeaders() }), "Failed to load summary");
  },
  async action(id, payload) {
    return jsonOrThrow(await authFetch(`/api/chat-requests/${encodeURIComponent(id)}/action`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    }), "Action failed");
  },
  async pullPreview({ store, level, include_assigned, source_agent_id, target_agent_id }) {
    return jsonOrThrow(await authFetch(`/api/chat-requests/pull/preview`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        store, level, include_assigned: !!include_assigned,
        source_agent_id: source_agent_id || null, target_agent_id: target_agent_id || null,
      }),
    }), "Preview failed");
  },
  async pullExecute({ store, level, include_assigned, source_agent_id, target_agent_id, limit }) {
    return jsonOrThrow(await authFetch(`/api/chat-requests/pull/execute`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        store, level, limit, include_assigned: !!include_assigned,
        source_agent_id: source_agent_id || null, target_agent_id: target_agent_id || null,
      }),
    }), "Could not move requests");
  },
  async history(id) {
    return jsonOrThrow(await authFetch(`/api/chat-requests/${encodeURIComponent(id)}/history`, { headers: authHeaders() }), "Failed to load history");
  },
  // Signed, short-lived link to the read-only website chat (null when the request has none).
  async conversation(id) {
    const res = await authFetch(`/api/chat-requests/${encodeURIComponent(id)}/conversation`, { headers: authHeaders() });
    if (res.status === 404) return null;
    return jsonOrThrow(res, "Failed to load the conversation");
  },
  async labels(store) {
    return jsonOrThrow(await authFetch(`/api/chat-labels?${new URLSearchParams({ store })}`, { headers: authHeaders() }), "Failed to load labels");
  },
  async createLabel(store, name) {
    return jsonOrThrow(await authFetch(`/api/chat-labels`, {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ store, name }),
    }), "Could not add the label");
  },
  async updateLabel(id, patch) {
    return jsonOrThrow(await authFetch(`/api/chat-labels/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(patch),
    }), "Could not update the label");
  },
  async reasons(store, days) {
    return jsonOrThrow(await authFetch(`/api/chat-requests/reasons?${new URLSearchParams({ store, days: String(days) })}`, { headers: authHeaders() }), "Failed to load reasons");
  },
  async teamStats(store) {
    const qs = new URLSearchParams({ store });
    return jsonOrThrow(await authFetch(`/api/chat-requests/team-stats?${qs}`, { headers: authHeaders() }), "Failed to load team stats");
  },
  async shopifyOrders(store, phone) {
    const qs = new URLSearchParams({ store, q: phone });
    return jsonOrThrow(await authFetch(`/api/agent/search?${qs}`, { headers: authHeaders() }), "Shopify search failed");
  },
};

// Polls the number of chat requests nobody has picked up yet, for the tab badge.
export function useChatWaitingCount(store) {
  const [count, setCount] = useState(0);
  const reqRef = useRef(0);
  const refresh = useCallback(async () => {
    const reqId = ++reqRef.current;
    try {
      const js = await CHAT_API.summary(store);
      if (reqId === reqRef.current) setCount(Number(js.unassigned_new || 0));
    } catch {}
  }, [store]);
  useEffect(() => {
    refresh();
    const tick = () => { if (document.visibilityState === "visible") refresh(); };
    const t = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);
  return { count, refresh };
}

// ---------- Helpers ----------
function localPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("212") && digits.length === 12) return `0${digits.slice(3)}`;
  return String(phone || "");
}

function prettyPhone(phone) {
  const local = localPhone(phone);
  return /^0\d{9}$/.test(local) ? local.replace(/(\d{2})(?=\d)/g, "$1 ").trim() : local;
}

function newActionId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {}
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function agentName(user) {
  if (!user) return "";
  return user.name || String(user.email || "").split("@")[0] || "agent";
}

function orderedToday(r) {
  if (r.status !== "ordered" || !r.closed_at) return false;
  return new Date(r.closed_at).toDateString() === new Date().toDateString();
}

function matchesView(r, { scope, level, meId, labelId }) {
  if (labelId && !(r.labels || []).some((l) => l.id === labelId)) return false;
  if (level === "ordered") return r.status === "ordered";
  if (scope === "mine" && r.assigned_to?.id !== meId) return false;
  if (scope === "unassigned" && r.assigned_to) return false;
  const closed = CLOSED.has(r.status);
  if (level === "closed") return CLOSED_VIEW.has(r.status);
  if (level === "cancelled") return r.status === "cancelled";
  // The main list keeps today's orders, in green; other closed requests leave it.
  if (closed) return !level && orderedToday(r);
  if (level === "new") return r.status === "new";
  if (level === "enatt") return r.status === "enatt";
  if (/^n[1-4]$/.test(level)) return r.status === "calling" && Number(r.attempts) === Number(level.slice(1));
  return true;
}

function shopifyAdminUrl(shopDomain, path) {
  const domain = String(shopDomain || "").trim().replace(/^https?:\/\//, "");
  return domain ? `https://${domain}/admin/${path}` : null;
}

function readSavedScope() {
  try {
    const v = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (SCOPES.some((s) => s.key === v)) return v;
  } catch {}
  return "mine";
}

// ---------- View ----------
export default function ChatConfirmationView({ me, store, setStore, view, onViewChange, chatBadge, onWaitingChanged }) {
  const [toasts, pushToast, dismissToast] = useToasts();
  const [scope, setScope] = useState(readSavedScope);
  const [level, setLevel] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [data, setData] = useState({ requests: [], total: 0, level_counts: null, scope_counts: null, shop_domain: "" });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastLoadedAt, setLastLoadedAt] = useState(null);
  const [team, setTeam] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [menuFor, setMenuFor] = useState(null);
  // The request whose "Create order" window is open.
  const [createOrderFor, setCreateOrderFor] = useState(null);
  // Reason labels (size, price, later, other...) chosen in the ⋯ popup.
  const [labels, setLabels] = useState([]);
  // Label pill filter (a label id), combined with the level pills.
  const [labelFilter, setLabelFilter] = useState(null);
  const [canManageLabels, setCanManageLabels] = useState(false);
  const [subView, setSubView] = useState(() => { try { return localStorage.getItem(SUBVIEW_STORAGE_KEY) === "reasons" ? "reasons" : "queue"; } catch { return "queue"; } });
  // Get-more / move dialog: `{ mode, includeAssigned }`, null = closed.
  const [pullMode, setPullMode] = useState(null);
  const requestIdRef = useRef(0);
  const teamRequestIdRef = useRef(0);
  const searchInputRef = useRef(null);
  const isAdmin = me?.role === "admin";

  useEffect(() => { try { localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch {} }, [scope]);
  useEffect(() => { try { localStorage.setItem(SUBVIEW_STORAGE_KEY, subView); } catch {} }, [subView]);

  const loadLabels = useCallback(async () => {
    try {
      const js = await CHAT_API.labels(store);
      setLabels(js.labels || []);
      setCanManageLabels(Boolean(js.can_manage));
    } catch {}
  }, [store]);
  useEffect(() => { loadLabels(); }, [loadLabels]);

  // Removing a label archives it: it disappears from the pills and the picker,
  // and stays on past requests and in the Reasons analysis.
  async function removeLabel(label) {
    if (!window.confirm(`Remove the label “${label.name}”? Requests that already have it keep it.`)) return;
    try {
      await CHAT_API.updateLabel(label.id, { archived: true });
      if (labelFilter === label.id) setLabelFilter(null);
      await loadLabels();
      pushToast(`Label “${label.name}” removed`, "success", 2400);
    } catch (e) {
      pushToast(e?.message || "Could not remove the label", "error", 5000);
    }
  }

  async function addLabel(name) {
    try {
      const js = await CHAT_API.createLabel(store, name);
      await loadLabels();
      if (!js.existing) pushToast(`Label “${js.label.name}” added`, "success", 2400);
      return js.label;
    } catch (e) {
      pushToast(e?.message || "Could not add the label", "error", 5000);
      return null;
    }
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim().length >= 2 ? query.trim() : ""), 250);
    return () => clearTimeout(t);
  }, [query]);

  // A new filter, search or store starts again from the first page.
  useEffect(() => { setPageIndex(0); }, [store, scope, level, debouncedQuery, labelFilter]);
  useEffect(() => { setLabelFilter(null); }, [store]);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true); setError(null);
    try {
      const js = await CHAT_API.list(store, { scope, level, q: debouncedQuery, offset: pageIndex * PER_PAGE, label: labelFilter });
      if (reqId !== requestIdRef.current) return;
      setData({
        requests: js.requests || [],
        total: Number(js.total || 0),
        level_counts: js.level_counts || null,
        scope_counts: js.scope_counts || null,
        label_counts: js.label_counts || {},
        shop_domain: js.shop_domain || "",
      });
      setLoaded(true);
      setLastLoadedAt(Date.now());
    } catch (e) {
      if (reqId !== requestIdRef.current) return;
      setError(e?.message || "Failed to load chat requests");
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [store, scope, level, debouncedQuery, pageIndex, labelFilter]);

  const loadTeam = useCallback(async () => {
    const reqId = ++teamRequestIdRef.current;
    try {
      const js = await CHAT_API.teamStats(store);
      if (reqId === teamRequestIdRef.current) setTeam(js.agents || []);
    } catch {}
  }, [store]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTeam(); }, [loadTeam]);

  // Poll while visible, like the Orders tab. Skip while an action is in flight so a
  // refresh cannot briefly undo what the agent just clicked.
  const busyRef = useRef(0);
  busyRef.current = busyIds.size;
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== "visible" || busyRef.current > 0) return;
      load();
      loadTeam();
    };
    const t = setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [load, loadTeam]);

  const refreshAll = useCallback(() => { load(); loadTeam(); onWaitingChanged?.(); }, [load, loadTeam, onWaitingChanged]);


  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || e.target?.isContentEditable) return;
      if (pullMode || createOrderFor) return;
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "r" || e.key === "R") {
        refreshAll();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshAll, pullMode, createOrderFor]);

  function changeStore(next) {
    if (!next || next === store) return;
    setStore(next);
    setExpanded(new Set());
  }

  // ---------- Actions ----------
  function setBusy(id, on) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  function applyUpdated(updated) {
    const stillVisible = matchesView(updated, { scope, level, meId: me.id, labelId: labelFilter });
    setData((prev) => {
      const requests = stillVisible
        ? prev.requests.map((r) => (r.id === updated.id ? updated : r))
        : prev.requests.filter((r) => r.id !== updated.id);
      return { ...prev, requests, total: stillVisible ? prev.total : Math.max(0, prev.total - 1) };
    });
    if (!stillVisible) {
      setExpanded((prev) => {
        if (!prev.has(updated.id)) return prev;
        const next = new Set(prev);
        next.delete(updated.id);
        return next;
      });
    }
  }

  async function runAction(r, payload, { success, silent = false } = {}) {
    if (busyIds.has(r.id)) return null;
    setBusy(r.id, true);
    try {
      const js = await CHAT_API.action(r.id, { client_action_id: newActionId(), ...payload });
      applyUpdated(js.request);
      if (success && !silent) pushToast(typeof success === "function" ? success(js.request) : success, "success", 2600);
      // Counts, the tab badge and the team board all depend on this click.
      load();
      loadTeam();
      onWaitingChanged?.();
      return js.request;
    } catch (e) {
      pushToast(e?.message || "Action failed", "error", 6000);
      return null;
    } finally {
      setBusy(r.id, false);
    }
  }

  async function handleCall(r) {
    const local = localPhone(r.phone);
    const copied = await copyToClipboard(local);
    const next = Math.min(Number(r.attempts || 0) + 1, 4);
    pushToast(copied ? `Copied ${local} · saving N${next}…` : `Saving N${next} · phone copy blocked`, copied ? "info" : "warn");
    await runAction(r, { action: "call" }, { success: (u) => `N${u.attempts} saved for ${u.customer_name || prettyPhone(u.phone)}` });
  }

  function handleEnatt(r) {
    return runAction(r, { action: "enatt" }, { success: (u) => `En attente · EA${u.enatt} saved` });
  }

  function openCreateOrder(r) {
    setCreateOrderFor(r);
  }

  // The order was created in Shopify and the request closed as ordered.
  function onOrderCreated(js) {
    applyUpdated(js.request);
    pushToast(`Order ${js.order?.name || ""} created in Shopify`, "success", 5000);
    load();
    loadTeam();
    onWaitingChanged?.();
  }

  // The customer already ordered on the website: close the request with that order.
  function linkExistingOrder(r, ref) {
    return runAction(r, { action: "ordered", order_ref: ref }, {
      success: `${r.customer_name || prettyPhone(r.phone)} linked to order ${ref}`,
    });
  }


  // The ⋯ popup: reasons, an optional note, and possibly closing the request, in that order.
  async function submitPopup(r, { ids, note, outcome }) {
    const current = (r.labels || []).map((l) => l.id);
    const changed = ids.length !== current.length || ids.some((id) => !current.includes(id));
    if (changed && !(await runAction(r, { action: "labels", labels: ids }, { silent: true }))) return false;
    if (note) {
      const names = labels.filter((l) => ids.includes(l.id)).map((l) => l.name);
      if (!(await runAction(r, { action: "note", note: names.length ? `${names.join(", ")} — ${note}` : note }, { silent: true }))) return false;
    }
    if (outcome && !(await runAction(r, { action: outcome }, { silent: true }))) return false;
    pushToast(outcome ? `Closed as ${OUTCOMES[outcome].label.toLowerCase()}` : changed || note ? "Saved" : "Nothing changed", "success", 2600);
    setMenuFor(null);
    return true;
  }

  async function handleCopyIntl(r) {
    const intl = moroccoInternational(localPhone(r.phone));
    const ok = await copyToClipboard(intl);
    pushToast(ok ? `Copied ${intl}` : "Clipboard blocked", ok ? "success" : "warn");
  }

  async function handleCopyLocal(r) {
    const local = localPhone(r.phone);
    const ok = await copyToClipboard(local);
    pushToast(ok ? `Copied ${local}` : "Clipboard blocked", ok ? "success" : "warn");
  }

  function openPull(mode, opts = {}) {
    setPullMode({ mode, includeAssigned: !!opts.includeAssigned });
  }

  function onPulled(result, summary) {
    setPullMode(null);
    const pulled = Number(result.pulled || 0);
    if (pulled === 0) {
      pushToast("No requests were left to take — someone may have just taken them.", "warn", 5000);
    } else {
      const took = Number(result.reassigned || 0);
      pushToast(
        summary?.message
          || (`Took ${pulled} chat request${pulled === 1 ? "" : "s"} into your queue`
            + (took ? ` (${took} taken over from another agent)` : "")),
        "success",
        4500,
      );
    }
    const intoMyQueue = !result.unassigned && (!result.target_agent_id || result.target_agent_id === me.id);
    if (pulled > 0 && intoMyQueue && (scope !== "mine" || level)) {
      setScope("mine");
      setLevel("");
    } else {
      load();
    }
    loadTeam();
    onWaitingChanged?.();
  }

  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ---------- Derived ----------
  const levelCounts = data.level_counts || {};
  const scopeCounts = data.scope_counts || {};
  const activeLevel = CHAT_LEVELS.find((l) => l.key === level) || CHAT_LEVELS[0];
  const firstLoad = loading && !loaded;
  const mine = team.find((a) => a.id === me.id);
  const sortedTeam = useMemo(
    () => [...team].filter((a) => a.role === "agent" || a.calls_today || a.ordered_today || a.open_assigned),
    [team],
  );
  const myRank = useMemo(() => {
    const idx = sortedTeam.findIndex((a) => a.id === me.id);
    return idx >= 0 ? { rank: idx + 1, of: sortedTeam.length } : null;
  }, [sortedTeam, me?.id]);
  const teamMax = useMemo(() => Math.max(1, ...sortedTeam.map((a) => Number(a.ordered_today || 0))), [sortedTeam]);
  const assignableAgents = useMemo(
    () => [...team].sort((a, b) => agentName(a).localeCompare(agentName(b))),
    [team],
  );

  const pageCount = Math.max(1, Math.ceil(data.total / PER_PAGE));
  const hasPrevPage = pageIndex > 0;
  const hasNextPage = pageIndex + 1 < pageCount;

  const listResetKey = `${store}|${scope}|${level}|${debouncedQuery}|${pageIndex}|${labelFilter || ""}`;
  const displayRows = useDepartingList(data.requests, (r) => r.id, { resetKey: listResetKey });
  const flipSignature = displayRows.map((r) => r.item.id).join(",");
  const tableBodyRef = useRef(null);
  const cardListRef = useRef(null);
  useFlipList(tableBodyRef, flipSignature, listResetKey);
  useFlipList(cardListRef, flipSignature, listResetKey);

  // ---------- Row pieces ----------
  function renderPhone(r, { big = false } = {}) {
    return (
      <span className="inline-flex items-center gap-1 rounded-lg bg-sky-50 py-0.5 pl-2 pr-0.5 ring-1 ring-inset ring-sky-200">
        <a
          href={`tel:${localPhone(r.phone)}`}
          onClick={(ev) => ev.stopPropagation()}
          className={`font-mono font-semibold tracking-tight text-sky-900 hover:underline ${big ? "text-[15px]" : "text-[13px]"}`}
          title="Call from this device"
        >{prettyPhone(r.phone)}</a>
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); handleCopyLocal(r); }}
          title={`Copy ${localPhone(r.phone)}`}
          aria-label="Copy phone number"
          className="rounded-md p-1 text-sky-500 hover:bg-sky-100 hover:text-sky-700 active:scale-90 transition"
        ><Copy className="h-3.5 w-3.5" aria-hidden /></button>
      </span>
    );
  }

  function chip(label, tone, key, extra = "") {
    const t = TONES[tone] || TONES.slate;
    return (
      <span key={key || label} className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${t.soft} ${extra}`}>
        {label}
      </span>
    );
  }

  function renderStatus(r) {
    const chips = [];
    if (r.status === "ordered") {
      chips.push(
        <span key="outcome" className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
          <Check className="h-3 w-3" aria-hidden />Ordered{r.order_ref ? ` · ${r.order_ref}` : ""}
        </span>,
      );
    } else if (CLOSED.has(r.status)) {
      const o = OUTCOMES[r.status];
      chips.push(chip(`${o.label}${r.status === "cancelled" && r.order_ref ? ` · ${r.order_ref}` : ""}`, o.tone, "outcome"));
    } else if (r.status === "new") {
      chips.push(chip("New", "indigo", "new"));
    }
    if (Number(r.attempts) > 0) chips.push(chip(`N${r.attempts}`, LEVEL_TONE[Math.min(4, Number(r.attempts))], "attempts"));
    if (Number(r.enatt) > 0) chips.push(chip(`EA${r.enatt}`, "fuchsia", "enatt"));
    if (Number(r.request_count) > 1) chips.push(chip(`Asked ×${r.request_count}`, "amber", "repeat"));
    (r.labels || []).forEach((l) => chips.push(
      <span key={`label-${l.id}`} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${(TONES[l.color] || TONES.slate).soft}`}>
        <Tag className="h-3 w-3" aria-hidden />{l.name}
      </span>,
    ));
    if (scope !== "mine") {
      chips.push(r.assigned_to
        ? chip(r.assigned_to.id === me.id ? "You" : agentName(r.assigned_to), "sky", "agent")
        : chip("Unassigned", "slate", "agent", "border border-dashed border-slate-300 !ring-0"));
    }
    return <div className="flex flex-wrap gap-1">{chips}</div>;
  }

  function renderProduct(r, { compact = false } = {}) {
    if (!r.product_title && !r.message) {
      return <span className="text-xs text-slate-400">{r.page_url ? "No product · from the store" : "—"}</span>;
    }
    return (
      <div className="flex min-w-0 items-center gap-2">
        {r.product_image && (
          <img src={r.product_image} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-slate-200" />
        )}
        <div className="min-w-0">
          {r.product_title && (
            r.product_url ? (
              <a
                href={r.product_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(ev) => ev.stopPropagation()}
                className="block truncate text-[13px] font-medium text-slate-800 hover:text-indigo-700 hover:underline"
                title={r.product_title}
              >{r.product_title}</a>
            ) : (
              <div className="truncate text-[13px] font-medium text-slate-800" title={r.product_title}>{r.product_title}</div>
            )
          )}
          {(r.variant_title || (!compact && r.message)) && (
            <div className="truncate text-xs text-slate-500" title={r.message || r.variant_title}>
              {r.variant_title}{r.variant_title && r.message && !compact ? " · " : ""}{!compact && r.message ? `“${r.message}”` : ""}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderActions(r, { stretch = false } = {}) {
    const busy = busyIds.has(r.id);
    const grow = stretch ? "flex-1" : "";
    const menuOpen = menuFor === r.id;
    const moreButton = (
      <button
        type="button"
        onClick={(ev) => { ev.stopPropagation(); setMenuFor(r.id); }}
        className={`${ACTION_BTN} ${ACTION_THEMES.more} w-8 !px-0`}
        title="Reason, note and more actions"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-label="More actions"
      >
        <Ellipsis className="h-4 w-4" aria-hidden />
      </button>
    );
    if (CLOSED.has(r.status)) {
      return (
        <div className={`flex items-center gap-1.5 ${stretch ? "w-full" : "justify-end"}`}>
          <button
            type="button"
            disabled={busy}
            onClick={(ev) => { ev.stopPropagation(); runAction(r, { action: "reopen" }, { success: "Request reopened" }); }}
            className={`${ACTION_BTN} ${ACTION_THEMES.more} ${grow}`}
            title="Put this request back in the open queue"
          >
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            <span>Reopen</span>
          </button>
          {moreButton}
        </div>
      );
    }
    return (
      <div className={`flex items-center gap-1.5 ${stretch ? "w-full" : ""}`}>
        <button
          type="button"
          disabled={busy}
          onClick={(ev) => { ev.stopPropagation(); handleCall(r); }}
          className={`${ACTION_BTN} ${ACTION_THEMES.call} ${grow} min-w-[64px]`}
          title="Copy the phone + record the next call attempt (N1 → N4)"
        >
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" aria-hidden />}
          <span>{Number(r.attempts) > 0 ? `N${r.attempts}` : "Call"}</span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={(ev) => { ev.stopPropagation(); handleEnatt(r); }}
          className={`${ACTION_BTN} ${ACTION_THEMES.enatt} ${grow}`}
          title="En attente — customer asked to be called back later (EA1 → EA4)"
        >
          <Hourglass className="h-3.5 w-3.5" aria-hidden />
          <span>{Number(r.enatt) > 0 ? `EA${r.enatt}` : "EA"}</span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={(ev) => { ev.stopPropagation(); openCreateOrder(r); }}
          data-testid="create-order"
          className={`${ACTION_BTN} ${ACTION_THEMES.confirm} ${grow}`}
          title="Create the customer's order in Shopify"
        >
          <ShoppingBag className="h-3.5 w-3.5" aria-hidden />
          <span className={stretch ? "" : "hidden 2xl:inline"}>Create order</span>
        </button>
        {moreButton}
      </div>
    );
  }

  function renderDetails(r) {
    return (
      <ChatRequestDetails
        request={r}
        store={store}
        shopDomain={data.shop_domain}
        isAdmin={isAdmin}
        agents={assignableAgents}
        busy={busyIds.has(r.id)}
        onNote={(note) => runAction(r, { action: "note", note }, { success: "Note saved" })}
        onAssign={(agentId) => runAction(r, { action: "assign", assign_to: agentId || null }, {
          success: agentId ? "Request reassigned" : "Request unassigned",
        })}
      />
    );
  }

  function renderCard(r, { leaving = false } = {}) {
    const isOpen = expanded.has(r.id);
    const pickerOpen = createOrderFor?.id === r.id;
    const busy = busyIds.has(r.id);
    return (
      <div
        key={r.id}
        data-flip-key={r.id}
        className={`relative p-3.5 transition-colors ${leaving ? "cf-leave" : ""} ${isOpen || pickerOpen ? "bg-indigo-50/60" : r.status === "ordered" ? "bg-emerald-50/80" : "bg-white"}`}
        onClick={(e) => { if (!leaving && !isInteractiveTarget(e)) toggleExpanded(r.id); }}
      >
        {(isOpen || pickerOpen || r.status === "ordered") && <span aria-hidden className={`absolute left-0 inset-y-0 w-1 ${isOpen || pickerOpen ? "bg-indigo-500" : "bg-emerald-500"}`} />}
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-200">
            <MessageCircle className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="text-[15px] font-bold text-slate-900">#{r.id}</span>
          <span className="text-[11px] text-slate-400" title={r.created_at ? new Date(r.created_at).toLocaleString() : ""}>{timeAgo(r.created_at)}</span>
          {busy && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
              <Spinner className="h-3 w-3" /> Saving
            </span>
          )}
        </div>
        <div className="mt-2 truncate text-[15px] font-semibold text-slate-900">
          {r.customer_name || <span className="font-normal text-slate-400">No name</span>}
        </div>
        <div className="mt-1.5">{renderPhone(r, { big: true })}</div>
        <div className="mt-2">{renderProduct(r)}</div>
        <div className="mt-2">{renderStatus(r)}</div>
        <div className="mt-3">{renderActions(r, { stretch: true })}</div>
        {isOpen && (
          <div className="cf-collapse-in mt-3" onClick={(ev) => ev.stopPropagation()}>{renderDetails(r)}</div>
        )}
      </div>
    );
  }

  function renderRow({ item: r, leaving }) {
    const isOpen = expanded.has(r.id);
    const pickerOpen = createOrderFor?.id === r.id;
    const active = isOpen || pickerOpen;
    const ordered = r.status === "ordered";
    const rowBg = active ? "bg-indigo-50/70" : ordered ? "bg-emerald-50/80" : "bg-white";
    return (
      <React.Fragment key={r.id}>
        <tr
          data-flip-key={r.id}
          className={`group border-t border-slate-100 cursor-pointer transition-colors ${rowBg} ${active ? "" : ordered ? "hover:bg-emerald-50" : "hover:bg-slate-50/80"} ${leaving ? "cf-leave" : ""}`}
          onClick={(e) => { if (!leaving && !isInteractiveTarget(e)) toggleExpanded(r.id); }}
        >
          <td className={`relative px-4 py-3 whitespace-nowrap ${active ? "shadow-[inset_3px_0_0_rgb(99_102_241)]" : ordered ? "shadow-[inset_3px_0_0_rgb(16_185_129)]" : ""}`}>
            <div className="font-semibold text-slate-900">#{r.id}</div>
            <div className="text-[11px] text-slate-400" title={r.created_at ? new Date(r.created_at).toLocaleString() : ""}>{timeAgo(r.created_at)}</div>
          </td>
          <td className="px-2 py-3 max-w-[200px]">
            <div className="truncate font-medium text-slate-900">{r.customer_name || <span className="text-slate-400">—</span>}</div>
            {r.last_action_at && (
              <div className="truncate text-xs text-slate-500">Last action {timeAgo(r.last_action_at)}</div>
            )}
          </td>
          <td className="px-2 py-3 whitespace-nowrap">{renderPhone(r)}</td>
          <td className="px-2 py-3 max-w-[300px]">{renderProduct(r, { compact: false })}</td>
          <td className="px-3 py-3">
            <div className="flex items-center gap-2 max-w-[240px]">
              {renderStatus(r)}
              {busyIds.has(r.id) && <Spinner className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
            </div>
          </td>
          <td className={`sticky right-0 px-3 py-3 ${menuFor === r.id ? "z-20" : "z-[1]"} ${rowBg} ${active ? "" : "group-hover:bg-slate-50"} shadow-[-8px_0_12px_-10px_rgba(15,23,42,0.18)]`}>
            <div className="flex justify-end">{renderActions(r)}</div>
          </td>
        </tr>
        {isOpen && !leaving && (
          <tr className="bg-slate-50/70">
            <td colSpan={6} className="px-4 py-4"><div className="cf-collapse-in">{renderDetails(r)}</div></td>
          </tr>
        )}
      </React.Fragment>
    );
  }

  const waitingNew = Number(scopeCounts.unassigned_new || 0);
  const emptyState = !loading && displayRows.length === 0 && (
    <div className="cf-fade-in flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
        <Inbox className="h-6 w-6" aria-hidden />
      </div>
      {debouncedQuery ? (
        <>
          <div className="text-sm font-semibold text-slate-900">No chat request matches “{debouncedQuery}”</div>
          <button type="button" onClick={() => setQuery("")} className={`${BTN.secondary} mt-4 h-9`}>Clear search</button>
        </>
      ) : level ? (
        <>
          <div className="text-sm font-semibold text-slate-900">No {activeLevel.label} requests here</div>
          <button type="button" onClick={() => setLevel("")} className={`${BTN.secondary} mt-4 h-9`}>Show all open requests</button>
        </>
      ) : scope === "mine" ? (
        <>
          <div className="text-sm font-semibold text-slate-900">No chat requests in your queue</div>
          <div className="mt-1 text-xs text-slate-500">
            {waitingNew > 0 ? `${waitingNew} customer${waitingNew === 1 ? " is" : "s are"} waiting for a call.` : "No customer is waiting right now."}
          </div>
          {waitingNew > 0 && (
            <button type="button" onClick={() => openPull("new")} className={`${BTN.primary} mt-4 h-9`}>
              <Sparkles className="h-4 w-4" aria-hidden /> Get new requests
            </button>
          )}
        </>
      ) : (
        <>
          <div className="text-sm font-semibold text-slate-900">Nothing waiting</div>
          <div className="mt-1 text-xs text-slate-500">New chat requests from the store show up here automatically.</div>
        </>
      )}
    </div>
  );

  const pagerControls = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
        disabled={!hasPrevPage || loading}
        className={`${BTN.secondary} h-8 w-8 !px-0`}
        aria-label="Previous page"
      ><ChevronLeft className="h-4 w-4" aria-hidden /></button>
      <span className="min-w-[64px] text-center text-xs font-medium text-slate-600 tabular-nums">
        Page {pageIndex + 1}{pageCount > 1 ? ` / ${pageCount}` : ""}
      </span>
      <button
        type="button"
        onClick={() => setPageIndex((p) => p + 1)}
        disabled={!hasNextPage || loading}
        className={`${BTN.secondary} h-8 w-8 !px-0`}
        aria-label="Next page"
      ><ChevronRight className="h-4 w-4" aria-hidden /></button>
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {menuFor && data.requests.some((r) => r.id === menuFor) && (() => {
        const r = data.requests.find((x) => x.id === menuFor);
        return (
          <RequestPopup
            key={r.id}
            request={r}
            labels={labels}
            me={me}
            isAdmin={isAdmin}
            busy={busyIds.has(r.id)}
            onClose={() => setMenuFor(null)}
            onCreateLabel={addLabel}
            onSubmit={(choice) => submitPopup(r, choice)}
            onCall={() => { setMenuFor(null); try { location.href = `tel:${localPhone(r.phone)}`; } catch {} }}
            onCopyIntl={() => handleCopyIntl(r)}
            onAction={(action, success) => { setMenuFor(null); runAction(r, { action }, { success }); }}
          />
        );
      })()}
      <TopBar
        me={me}
        store={store}
        loading={loading}
        lastLoadedAt={lastLoadedAt}
        onRefresh={() => { refreshAll(); pushToast("Refreshing…", "info", 1200); }}
        onInventory={() => {
          try {
            history.pushState(null, "", `/inventory-helper?store=${encodeURIComponent(store)}`);
            window.dispatchEvent(new PopStateEvent("popstate"));
          } catch {}
        }}
        view={view}
        onViewChange={onViewChange}
        chatBadge={chatBadge}
      />
      <main className="mx-auto w-full max-w-[1600px] px-3 sm:px-5 lg:px-8 py-4 sm:py-6 space-y-4 sm:space-y-5">
        {/* Store + search within chat requests */}
        <section className={`${CARD} p-2.5 sm:p-3`}>
          <div className="flex items-center gap-2">
            <div className="flex h-11 max-w-[42%] shrink-0 items-center gap-1.5 rounded-xl bg-slate-50 pl-3 pr-1 ring-1 ring-inset ring-slate-200 sm:max-w-none">
              <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:inline">Store</span>
              <StorePicker
                value={store}
                onChange={changeStore}
                allowCustom={false}
                className="h-full !rounded-none !border-0 !bg-transparent !p-0 !pr-1 text-sm font-semibold text-slate-900 shadow-none focus:!ring-0"
              />
            </div>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }}
                placeholder="Search chat requests: phone, name, product, #id"
                className="h-11 w-full rounded-xl border-0 bg-white pl-9 pr-10 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-indigo-500"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                {loading && query
                  ? <Spinner className="h-4 w-4 text-indigo-500" />
                  : !query && <kbd className="hidden sm:inline rounded border border-slate-200 bg-slate-50 px-1.5 text-[10px] font-semibold text-slate-400">/</kbd>}
              </span>
            </div>
            {query && (
              <button type="button" onClick={() => setQuery("")} className={`${BTN.secondary} h-11 w-11 !px-0`} aria-label="Clear search">
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
          {debouncedQuery && (
            <div className="mt-2 px-1 text-[11px] text-slate-500">
              Searching every chat request in this store ({SCOPES.find((s) => s.key === scope)?.label.toLowerCase()}, {activeLevel.label.toLowerCase()}).
            </div>
          )}
        </section>

        <div className="flex items-center gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-slate-200 w-fit" role="tablist" aria-label="Chat confirmation views">
          {[["queue", "Requests", Inbox], ["reasons", "Reasons", BarChart3]].map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={subView === key}
              onClick={() => setSubView(key)}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-semibold transition ${subView === key ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}
            ><Icon className="h-4 w-4" aria-hidden />{label}</button>
          ))}
        </div>

        {subView === "reasons" ? (
          <ReasonsView
            store={store}
            labels={labels}
            canManage={canManageLabels}
            onLabelsChanged={loadLabels}
            pushToast={pushToast}
            onOpenRequest={(r) => {
              setSubView("queue");
              setScope("all");
              setLevel(r.status === "ordered" ? "ordered" : CLOSED.has(r.status) ? "closed" : "");
              setQuery(`#${r.id}`);
            }}
          />
        ) : (<>
        {error && (
          <div className="cf-fade-in flex items-start gap-2.5 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-900 ring-1 ring-inset ring-rose-200">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={refreshAll} className="text-xs font-semibold underline">Try again</button>
          </div>
        )}

        {/* Overview + take more requests */}
        <section className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 sm:gap-4">
            <KpiCard
              icon={Inbox}
              tone="sky"
              label="My open requests"
              value={Number(scopeCounts.mine || 0)}
              loading={firstLoad}
              active={scope === "mine" && !level}
              onClick={() => { setScope("mine"); setLevel(""); }}
            />
            <KpiCard
              icon={Sparkles}
              tone="indigo"
              label="Waiting for a call"
              value={waitingNew}
              loading={firstLoad}
              active={scope === "unassigned" && level === "new"}
              onClick={() => {
                if (scope === "unassigned" && level === "new") { setScope("mine"); setLevel(""); }
                else { setScope("unassigned"); setLevel("new"); }
              }}
            />
            <KpiCard icon={Phone} tone="amber" label="My calls today" value={Number(mine?.calls_today || 0)} />
            <KpiCard
              icon={ShoppingBag}
              tone="emerald"
              label="Ordered today"
              value={Number(mine?.ordered_today || 0)}
              hint={myRank && myRank.of > 1 ? `#${myRank.rank} of ${myRank.of} in team` : null}
            />
          </div>
          <GetMoreRequestsCard isAdmin={isAdmin} waiting={waitingNew} onPull={openPull} />
        </section>

        {/* Queue */}
        <section className={`${CARD} overflow-hidden`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 sm:px-5">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900">Chat requests</h2>
              <p className="text-xs text-slate-500">
                {firstLoad ? "Loading requests…" : (
                  <>
                    {data.requests.length} shown
                    {data.total > data.requests.length && <> of <AnimatedNumber value={data.total} /></>}
                    {level ? <> · {activeLevel.label}</> : null}
                    {" "}· tap a row for details
                  </>
                )}
              </p>
            </div>
            <div className="cf-scroll-x flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Whose requests">
              {SCOPES.map((s) => {
                const active = scope === s.key;
                const n = Number(scopeCounts[s.count] || 0);
                return (
                  <button
                    key={s.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setScope(s.key)}
                    className={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold transition ${
                      active ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {s.label}
                    <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${active ? "bg-indigo-50 text-indigo-700" : "bg-white/70 text-slate-500"}`}>{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="ml-auto hidden sm:block">{pagerControls}</div>
          </div>

          <ChatLevelTabs value={level} counts={levelCounts} onChange={setLevel} />
          <LabelPills
            labels={labels.filter((l) => !l.archived)}
            counts={data.label_counts || {}}
            value={labelFilter}
            onChange={setLabelFilter}
            canRemove={canManageLabels}
            onRemove={removeLabel}
          />

          <div className="hidden xl:block overflow-x-auto border-t border-slate-100">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50/70 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Request</th>
                  <th className="px-2 py-2.5">Customer</th>
                  <th className="px-2 py-2.5">Phone</th>
                  <th className="px-2 py-2.5">Product / message</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="sticky right-0 bg-slate-50 px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody ref={tableBodyRef}>
                {firstLoad && <SkeletonRows columns={6} />}
                {displayRows.map(renderRow)}
              </tbody>
            </table>
            {emptyState}
          </div>

          <div className="xl:hidden border-t border-slate-100">
            {firstLoad && <SkeletonCards />}
            <div ref={cardListRef} className="divide-y divide-slate-100">
              {displayRows.map(({ item, leaving }) => renderCard(item, { leaving }))}
            </div>
            {emptyState}
          </div>

          <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 sm:px-5">
            <span className="text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{data.requests.length}</span> on this page ·{" "}
              <span className="font-semibold text-slate-700"><AnimatedNumber value={data.total} /></span> {level ? activeLevel.label : "open"}
            </span>
            <div className="ml-auto">{pagerControls}</div>
          </div>
        </section>

        {/* Team */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-500" aria-hidden />
            <h2 className="text-sm font-semibold text-slate-900">Chat team today</h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">all stores</span>
          </div>
          {sortedTeam.length === 0 ? (
            <div className={`${CARD} px-4 py-6 text-center text-xs text-slate-500`}>No chat activity yet today.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {sortedTeam.map((a, idx) => (
                <ChatAgentCard key={a.id} agent={a} rank={idx + 1} isMe={a.id === me.id} maxOrdered={teamMax} />
              ))}
            </div>
          )}
        </section>
        </>)}
      </main>

      {createOrderFor && (
        <ChatCreateOrderModal
          request={createOrderFor}
          store={store}
          shopDomain={data.shop_domain}
          me={me}
          onClose={() => setCreateOrderFor(null)}
          onCreated={onOrderCreated}
          onLinkExisting={(ref) => linkExistingOrder(createOrderFor, ref)}
        />
      )}
      {pullMode && (
        <ChatPullModal
          initialMode={pullMode.mode}
          initialIncludeAssigned={pullMode.includeAssigned}
          store={store}
          me={me}
          isAdmin={isAdmin}
          team={assignableAgents}
          onClose={() => setPullMode(null)}
          onSuccess={onPulled}
        />
      )}
    </div>
  );
}

// ---------- Pieces ----------

const CHAT_PULL_BUTTONS = [
  { mode: "n1",    label: "N1",      tone: "amber" },
  { mode: "n2",    label: "N2",      tone: "orange" },
  { mode: "n3",    label: "N3",      tone: "rose" },
  { mode: "n4",    label: "N4",      tone: "red" },
  { mode: "enatt", label: "En att.", tone: "fuchsia" },
];

// Same card as "Get more orders" on the Orders tab.
function GetMoreRequestsCard({ onPull, isAdmin, waiting = 0 }) {
  return (
    <div className={`${CARD} relative overflow-hidden p-4`}>
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-gradient-to-br from-indigo-200/50 to-violet-200/40 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">Get more requests</h2>
          <p className="mt-0.5 hidden text-xs text-slate-500 sm:block">Pulled requests go to your queue and leave everyone else's queue.</p>
        </div>
      </div>
      <div className="relative mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          data-testid="chat-pull-new"
          onClick={() => onPull("new")}
          className={`${BTN.primary} h-10`}
        >
          <Sparkles className="h-4 w-4" aria-hidden /> New requests
          {waiting > 0 && <span className="rounded-full bg-white/25 px-1.5 text-[11px] tabular-nums">{waiting}</span>}
        </button>
        <button
          type="button"
          data-testid="chat-pull-move"
          onClick={() => onPull("all", { includeAssigned: true })}
          className={`${BTN.secondary} h-10`}
          title={isAdmin ? "Move requests between agents, or take them off an agent" : "Take requests that sit in another agent's queue"}
        >
          <ArrowRightLeft className="h-4 w-4 text-indigo-600" aria-hidden /> {isAdmin ? "Move requests" : "From an agent"}
        </button>
      </div>
      <div className="cf-scroll-x relative -mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {CHAT_PULL_BUTTONS.map((b) => (
          <button
            key={b.mode}
            type="button"
            onClick={() => onPull(b.mode)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:ring-slate-300 active:scale-[0.96] transition disabled:opacity-50"
            title={`Pull ${b.label} requests into your queue`}
          >
            <span aria-hidden className={`h-2 w-2 rounded-full ${TONES[b.tone].dot}`} />
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const CHAT_PULL_MODES = [
  { mode: "all",   label: "All open",   title: "Get open requests",       tone: "slate",   icon: Inbox },
  { mode: "new",   label: "New",        title: "Get new requests",        tone: "indigo",  icon: Sparkles },
  { mode: "n1",    label: "N1",         title: "Get N1 requests",         tone: "amber",   icon: Phone },
  { mode: "n2",    label: "N2",         title: "Get N2 requests",         tone: "orange",  icon: Phone },
  { mode: "n3",    label: "N3",         title: "Get N3 requests",         tone: "rose",    icon: Phone },
  { mode: "n4",    label: "N4",         title: "Get N4 requests",         tone: "red",     icon: Phone },
  { mode: "enatt", label: "En attente", title: "Get En-attente requests", tone: "fuchsia", icon: Hourglass },
];
// Must match PULL_SOURCE_UNASSIGNED / PULL_TARGET_UNASSIGNED in chat_request_routes.py.
const PULL_UNASSIGNED = "__unassigned__";
const PULL_REFRESH_MS = 20_000;

function requestsWord(n) {
  return `request${n === 1 ? "" : "s"}`;
}

// The chat version of the orders "Get more orders" dialog: pick which requests
// (level, and whose: unassigned or one agent's), then who gets them. Admins can
// also send them to "Nobody", which takes them off an agent and back to Unassigned.
function ChatPullModal({ initialMode = "new", initialIncludeAssigned = false, store, me, isAdmin, team, onClose, onSuccess }) {
  const [mode, setMode] = useState(initialMode);
  const cfg = CHAT_PULL_MODES.find((m) => m.mode === mode) || CHAT_PULL_MODES[0];
  // Call-attempt levels always offer every agent's requests: by then they
  // nearly always belong to whoever called.
  const isLevelMode = mode !== "new" && mode !== "all";
  const [includeAssigned, setIncludeAssigned] = useState(!!initialIncludeAssigned);
  // Whose requests to take: "" = anyone in the pool, PULL_UNASSIGNED, or an agent id.
  const [sourceId, setSourceId] = useState("");

  // Where the requests go. Agents always pull into their own queue.
  const targetOptions = useMemo(() => {
    const list = [{ id: me.id, name: me.name, email: me.email, isMe: true }];
    if (isAdmin) {
      const seen = new Set([me.id]);
      for (const a of team || []) {
        if (!a?.id || seen.has(a.id)) continue;
        seen.add(a.id);
        list.push({ id: a.id, name: a.name, email: a.email, isMe: false });
      }
    }
    return list;
  }, [me, isAdmin, team]);
  const [targetId, setTargetId] = useState(me.id);
  const removing = isAdmin && targetId === PULL_UNASSIGNED;
  const target = removing ? null : (targetOptions.find((t) => t.id === targetId) || targetOptions[0]);
  const targetIsMe = !removing && target.id === me.id;

  const showOwners = removing || isLevelMode || includeAssigned;
  const effectiveSource = !showOwners ? "" : (removing && sourceId === PULL_UNASSIGNED ? "" : sourceId);
  const targetParam = removing ? PULL_UNASSIGNED : (targetIsMe ? null : target.id);

  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState(null);
  const [previewAt, setPreviewAt] = useState(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [takeAll, setTakeAll] = useState(false);
  const [amount, setAmount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const previewReqRef = useRef(0);

  useEffect(() => {
    const handle = setTimeout(async () => {
      const reqId = ++previewReqRef.current;
      setPreviewing(true); setPreviewErr(null);
      try {
        const js = await CHAT_API.pullPreview({
          store, level: mode, include_assigned: includeAssigned,
          source_agent_id: effectiveSource || null, target_agent_id: targetParam,
        });
        if (reqId !== previewReqRef.current) return;
        setPreview(js);
        setPreviewAt(Date.now());
      } catch (e) {
        if (reqId !== previewReqRef.current) return;
        setPreviewErr(e?.message || "Preview failed");
        setPreview(null);
      } finally {
        if (reqId === previewReqRef.current) setPreviewing(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [store, mode, includeAssigned, effectiveSource, targetParam, refreshNonce]);

  // Keep the number live while the dialog stays open.
  useEffect(() => {
    const t = setInterval(() => {
      if (!busy && document.visibilityState === "visible") setRefreshNonce((n) => n + 1);
    }, PULL_REFRESH_MS);
    return () => clearInterval(t);
  }, [busy]);

  const available = preview ? Number(preview.available || 0) : null;
  useEffect(() => {
    if (available != null && available > 0 && !takeAll && Number(amount) > available) setAmount(available);
  }, [available, takeAll, amount]);
  const assignedAvailable = preview ? Number(preview.assigned_available || 0) : 0;
  const byAgent = preview?.by_agent || [];
  const sourceAgent = byAgent.find((a) => a.id === effectiveSource) || null;
  const wanted = takeAll ? available : Math.max(0, Number(amount) || 0);
  const willPull = available == null ? wanted : Math.min(wanted || 0, available);

  async function submit() {
    const limit = takeAll ? 0 : Math.max(0, Number(amount) || 0);
    if (!takeAll && limit <= 0) {
      setErr("Enter a number greater than 0 (or pick All).");
      return;
    }
    setBusy(true); setErr(null);
    try {
      const js = await CHAT_API.pullExecute({
        store, level: mode, include_assigned: includeAssigned,
        source_agent_id: effectiveSource || null, target_agent_id: targetParam, limit,
      });
      const n = Number(js.pulled || 0);
      const fromAgent = sourceAgent ? ` from ${agentName(sourceAgent)}` : "";
      let message = null;
      if (removing) {
        message = `Removed ${n} ${requestsWord(n)}${fromAgent || " from agents"} · back in Unassigned`;
      } else if (!targetIsMe) {
        message = `Moved ${n} ${requestsWord(n)}${fromAgent} to ${agentName(target)}`;
      } else if (sourceAgent) {
        message = `Moved ${n} ${requestsWord(n)}${fromAgent} to your queue`;
      }
      onSuccess?.(js, { message });
    } catch (e) {
      setErr(e?.message || "Could not move requests");
    } finally {
      setBusy(false);
    }
  }

  const presets = [10, 20, 50, 100];
  const submitDisabled = busy || previewing || !preview || available === 0 || (!takeAll && !(Number(amount) > 0));
  const moving = removing || !targetIsMe || (!isLevelMode && includeAssigned);
  const title = removing
    ? "Remove requests from agents"
    : moving && !isLevelMode && includeAssigned
      ? (isAdmin ? "Move requests between agents" : "Take requests from an agent")
      : cfg.title;
  const inputCls = "h-10 w-full rounded-xl border-0 bg-white px-3 text-sm ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500";
  const count = willPull > 0 ? `${takeAll ? "all " : ""}${willPull} ${requestsWord(willPull)}` : "requests";

  return (
    <Modal onClose={onClose} busy={busy} labelledBy="chat-pull-title" maxWidth="max-w-lg">
      <ModalHeader
        id="chat-pull-title"
        icon={removing ? UserMinus : moving ? ArrowRightLeft : cfg.icon}
        tone={removing ? "rose" : cfg.tone}
        title={title}
        subtitle={<>Chat requests · store <span className="font-semibold text-slate-700">{store}</span></>}
        onClose={onClose}
        busy={busy}
      />

      <div className="space-y-4 overflow-y-auto px-5 py-4">
        {/* Which requests */}
        <div className="cf-scroll-x -mx-5 flex gap-1.5 overflow-x-auto px-5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="tablist" aria-label="Which requests">
          {CHAT_PULL_MODES.map((m) => {
            const active = m.mode === mode;
            return (
              <button
                key={m.mode}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={busy}
                onClick={() => { setMode(m.mode); setSourceId(""); }}
                className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition active:scale-[0.96] ${
                  active ? `${TONES[m.tone].solid} shadow-sm` : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                }`}
              >
                {!active && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${TONES[m.tone].dot}`} />}
                {m.label}
              </button>
            );
          })}
        </div>

        {!isLevelMode && !removing && (
          <label
            className={`flex cursor-pointer select-none items-start gap-3 rounded-xl px-3.5 py-3 ring-1 ring-inset transition-colors ${
              includeAssigned ? "bg-amber-50 ring-amber-200" : "bg-slate-50 ring-slate-200 hover:bg-slate-100"
            }`}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={includeAssigned}
              disabled={busy}
              onChange={(e) => { setIncludeAssigned(e.target.checked); setSourceId(""); }}
            />
            <span aria-hidden="true" className={`mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors duration-200 ${includeAssigned ? "bg-amber-500" : "bg-slate-300"}`}>
              <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${includeAssigned ? "translate-x-4" : "translate-x-0"}`} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-800">Include requests already assigned to another agent</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {includeAssigned
                  ? "Pick an agent below to move only their requests. They leave that agent's queue."
                  : "Off: only requests nobody is working on right now."}
              </span>
            </span>
          </label>
        )}

        {/* Who currently has them */}
        {showOwners && (
          <div className="cf-collapse-in">
            <div className="mb-2 flex items-center gap-2">
              <Users className="h-4 w-4 text-slate-400" aria-hidden />
              <span className="text-xs font-semibold text-slate-700">{removing ? "Remove from" : "Take requests from"}</span>
              {previewing && preview && <Spinner className="h-3.5 w-3.5 text-slate-400" />}
            </div>
            {!preview && previewing ? (
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((i) => <div key={i} className="cf-shimmer h-12 rounded-xl" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label={removing ? "Remove from" : "Take requests from"}>
                <SourceOption
                  testId="chat-source-all"
                  active={!effectiveSource}
                  onClick={() => setSourceId("")}
                  title={removing ? "Every agent" : "Everyone"}
                  subtitle={removing ? "All assigned requests in this pool" : "Anyone in this pool"}
                  count={preview?.pool_total ?? preview?.available ?? 0}
                  disabled={busy}
                />
                {!removing && (
                  <SourceOption
                    testId="chat-source-unassigned"
                    active={effectiveSource === PULL_UNASSIGNED}
                    onClick={() => setSourceId(PULL_UNASSIGNED)}
                    title="Unassigned"
                    subtitle="Nobody is working on them"
                    count={preview?.unassigned_available ?? 0}
                    disabled={busy}
                  />
                )}
                {byAgent.map((a) => (
                  <SourceOption
                    key={a.id}
                    testId={`chat-source-${a.id}`}
                    active={effectiveSource === a.id}
                    onClick={() => setSourceId(a.id)}
                    title={agentName(a)}
                    subtitle={`${a.email || ""}${a.is_active === false ? " · inactive" : ""}`}
                    count={a.count}
                    avatar={initialOf(agentName(a))}
                    disabled={busy}
                  />
                ))}
              </div>
            )}
            {preview && byAgent.length === 0 && (
              <div className="mt-2 text-xs text-slate-500">
                {removing ? "No agent holds requests in this pool right now." : "No other agent holds requests in this pool right now."}
              </div>
            )}
          </div>
        )}

        {/* Where they go (admins) */}
        {isAdmin && (
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-700" htmlFor="chat-pull-target">Assign to</label>
            <select
              id="chat-pull-target"
              data-testid="chat-pull-target"
              value={removing ? PULL_UNASSIGNED : target.id}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value;
                setTargetId(next);
                if (next === effectiveSource) setSourceId("");
              }}
              className={inputCls}
            >
              {targetOptions.map((t) => (
                <option key={t.id} value={t.id}>{t.isMe ? `Me (${agentName(t)})` : agentName(t)}</option>
              ))}
              <option value={PULL_UNASSIGNED}>Nobody — remove from the agent (back to Unassigned)</option>
            </select>
          </div>
        )}

        {/* Live count */}
        <div className={`rounded-2xl px-4 py-3 ring-1 ring-inset ${removing ? "bg-rose-50 ring-rose-100" : "bg-gradient-to-br from-indigo-50 to-violet-50 ring-indigo-100"}`}>
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <div className={`text-xs font-semibold ${removing ? "text-rose-900" : "text-indigo-900"}`}>Available now</div>
              <div className={`mt-0.5 text-[11px] ${removing ? "text-rose-700/80" : "text-indigo-700/80"}`}>
                {previewErr ? "Couldn't load the count" : previewAt ? <PreviewAge at={previewAt} busy={previewing} /> : "Counting…"}
              </div>
            </div>
            <div className={`ml-auto text-3xl font-bold leading-none tracking-tight ${removing ? "text-rose-950" : "text-indigo-950"}`} data-testid="chat-pull-available">
              {available == null ? (previewing ? <Spinner className="h-6 w-6 text-indigo-400" /> : "—") : <AnimatedNumber value={available} />}
            </div>
            <button
              type="button"
              onClick={() => setRefreshNonce((n) => n + 1)}
              disabled={previewing || busy}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/80 text-indigo-600 ring-1 ring-inset ring-indigo-200 hover:bg-white disabled:opacity-60"
              title="Recount now"
              aria-label="Recount now"
            ><RefreshCw className={`h-4 w-4 ${previewing ? "animate-spin" : ""}`} aria-hidden /></button>
          </div>
          {!previewing && assignedAvailable > 0 && !removing && (
            <div className="mt-2 border-t border-indigo-100 pt-2 text-[11px] text-amber-800">
              {sourceAgent
                ? <>All {assignedAvailable} belong to <b>{agentName(sourceAgent)}</b> and will leave their queue.</>
                : <>{assignedAvailable} of these currently belong to another agent and will be taken over.</>}
            </div>
          )}
        </div>
        {previewErr && (
          <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">{previewErr}</div>
        )}

        <div>
          <div className="mb-1.5 text-xs font-semibold text-slate-700">How many</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {presets.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => { setAmount(n); setTakeAll(false); }}
                disabled={busy || (available != null && n > available && Number(amount) !== n)}
                className={`h-9 min-w-[48px] rounded-xl px-3 text-sm font-semibold transition active:scale-[0.96] disabled:opacity-35 ${
                  !takeAll && Number(amount) === n
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                }`}
              >{n}</button>
            ))}
            <button
              type="button"
              data-testid="chat-pull-all"
              onClick={() => setTakeAll((p) => !p)}
              disabled={busy || available === 0}
              className={`h-9 rounded-xl px-3 text-sm font-semibold transition active:scale-[0.96] disabled:opacity-35 ${
                takeAll ? "bg-indigo-600 text-white shadow-sm" : "bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
              }`}
            >All{available != null ? ` (${available})` : ""}</button>
            <input
              type="number"
              min={1}
              max={available || 9999}
              value={takeAll ? (available ?? "") : amount}
              onChange={(e) => { setAmount(e.target.value); setTakeAll(false); }}
              disabled={busy || takeAll}
              aria-label="Number of requests"
              className="h-9 w-20 rounded-xl border-0 px-3 text-sm ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
        </div>

        {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">{err}</div>}
      </div>

      <div className="border-t border-slate-100 bg-slate-50/70 px-5 py-3">
        <div className="mb-2.5 text-[11px] leading-relaxed text-slate-500">
          {removing
            ? "These requests leave the agent's queue and go back to Unassigned, where anyone can take them."
            : <>Each request belongs to exactly one agent — taken requests leave everyone else's queue
              {targetIsMe ? " and go to yours." : <> and go to <b>{agentName(target)}</b>.</>}</>}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={`${BTN.secondary} h-10`}>Cancel</button>
          <button
            type="button"
            data-testid="chat-pull-submit"
            onClick={submit}
            disabled={submitDisabled}
            className={`${removing ? "inline-flex items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.97] transition" : BTN.primary} h-10 px-4`}
          >
            {busy ? <><Spinner /> Saving…</> : removing ? (
              <><UserMinus className="h-4 w-4" aria-hidden /> Remove {count}</>
            ) : targetIsMe ? (
              <><Sparkles className="h-4 w-4" aria-hidden /> Take {count}</>
            ) : (
              <><ArrowRightLeft className="h-4 w-4" aria-hidden /> Move {count}<span className="hidden sm:inline"> to {agentName(target)}</span></>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// One pill per reason label, with how many requests in the current view carry it.
function LabelPills({ labels, counts, value, onChange, canRemove, onRemove }) {
  if (!labels.length) return null;
  return (
    <div className="cf-scroll-x -mt-1 flex items-center gap-1.5 overflow-x-auto px-4 pb-3 sm:px-5" role="tablist" aria-label="Filter by label">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Labels</span>
      {labels.map((l) => {
        const active = value === l.id;
        const tone = TONES[l.color] || TONES.slate;
        const n = Number(counts?.[String(l.id)] || 0);
        return (
          <span key={l.id} className={`inline-flex h-8 shrink-0 items-center rounded-full text-xs font-semibold transition ${active ? `${tone.solid} shadow-sm` : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"}`}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`label-pill-${l.key}`}
              onClick={() => onChange(active ? null : l.id)}
              className="inline-flex h-full items-center gap-1.5 rounded-full pl-2.5 pr-1.5"
            >
              {!active && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />}
              {l.name}
              <span className={`min-w-[20px] rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${active ? "bg-white/25" : n > 0 ? "bg-slate-100 text-slate-700" : "bg-slate-50 text-slate-400"}`}>{n}</span>
            </button>
            {canRemove && (
              <button
                type="button"
                onClick={() => onRemove(l)}
                className={`mr-1 flex h-5 w-5 items-center justify-center rounded-full text-[13px] leading-none ${active ? "hover:bg-white/25" : "text-slate-400 hover:bg-rose-50 hover:text-rose-600"}`}
                title={`Remove the label “${l.name}”`}
                aria-label={`Remove the label ${l.name}`}
              >×</button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function ChatLevelTabs({ value, counts, onChange }) {
  return (
    <div className="cf-scroll-x mt-3 flex gap-1.5 overflow-x-auto px-4 pb-3 sm:px-5" role="tablist" aria-label="Filter by call level">
      {CHAT_LEVELS.map((lv) => {
        const active = value === lv.key;
        const tone = TONES[lv.tone];
        const n = Number(counts?.[lv.count] || 0);
        return (
          <button
            key={lv.key || "all"}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(active && lv.key ? "" : lv.key)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-2.5 pr-1.5 text-xs font-semibold transition duration-200 active:scale-[0.96] ${
              active ? `${tone.solid} shadow-sm` : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:text-slate-900"
            }`}
            title={lv.key === "closed" ? "Not interested or wrong number, last 30 days" : lv.key === "ordered" ? "Ordered in the last 30 days, including orders the website AI placed" : lv.key === "cancelled" ? "Cancelled in the last 30 days" : undefined}
          >
            {!active && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />}
            {lv.label}
            <span className={`min-w-[22px] rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${active ? "bg-white/25" : n > 0 ? "bg-slate-100 text-slate-700" : "bg-slate-50 text-slate-400"}`}>
              <AnimatedNumber value={n} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ChatAgentCard({ agent, isMe, rank, maxOrdered = 1 }) {
  const ordered = Number(agent.ordered_today || 0);
  const medal = ordered > 0 ? ["bg-amber-400 text-amber-950", "bg-slate-300 text-slate-800", "bg-orange-300 text-orange-950"][rank - 1] : null;
  const stats = [
    { label: "Calls", value: Number(agent.calls_today || 0), tone: "amber" },
    { label: "Closed", value: Number(agent.closed_today || 0), tone: "slate" },
    { label: "Open", value: Number(agent.open_assigned || 0), tone: "sky" },
  ];
  return (
    <div className={`${CARD} p-4 transition hover:shadow-md ${isMe ? "ring-2 ring-indigo-500/70 border-transparent" : ""}`}>
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold ${isMe ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700"}`}>
            {initialOf(agent.name || agent.email)}
          </div>
          {medal && (
            <span className={`absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ring-2 ring-white ${medal}`}>{rank}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-900" title={agent.name || agent.email}>{agent.name || agent.email}</span>
            {isMe && <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-200">You</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold leading-none tabular-nums text-emerald-600"><AnimatedNumber value={ordered} /></div>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">ordered</div>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-[width] duration-700 ease-out"
          style={{ width: `${Math.round((ordered / Math.max(1, maxOrdered)) * 100)}%` }}
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-1">
        {stats.map((s) => (
          <div
            key={s.label}
            className={`rounded-lg px-1 py-1 text-center ring-1 ring-inset ${s.value > 0 ? TONES[s.tone].soft : "bg-slate-50 text-slate-400 ring-slate-100"}`}
          >
            <div className="text-[9px] font-semibold uppercase leading-tight opacity-80">{s.label}</div>
            <div className="text-sm font-bold leading-tight tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RequestPopup({ request: r, labels, me, isAdmin, busy, onClose, onCreateLabel, onSubmit, onCall, onCopyIntl, onAction }) {
  const [chosen, setChosen] = useState(() => new Set((r.labels || []).map((l) => l.id)));
  const [note, setNote] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState("");
  const noteRef = useRef(null);
  const closed = CLOSED.has(r.status);
  // Archived labels already on this request stay visible so they can be removed.
  const shown = [...labels, ...(r.labels || []).filter((l) => !labels.some((x) => x.id === l.id))];
  const other = shown.find((l) => l.key === "other");
  const needsNote = Boolean(other && chosen.has(other.id));

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; };
  }, [onClose]);

  function toggle(label) {
    setProblem("");
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(label.id)) next.delete(label.id); else next.add(label.id);
      return next;
    });
    if (label.key === "other" && !chosen.has(label.id)) setTimeout(() => noteRef.current?.focus(), 0);
  }
  async function create() {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    const label = await onCreateLabel(name);
    setAdding(false);
    if (label) {
      setNewName("");
      setChosen((prev) => new Set(prev).add(label.id));
    }
  }
  function submit(outcome) {
    const text = note.trim();
    if (needsNote && !text) {
      setProblem("Write what the customer said for “Other”.");
      noteRef.current?.focus();
      return;
    }
    onSubmit({ ids: [...chosen], note: text, outcome });
  }

  const quick = "inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 active:scale-[0.97] transition";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`request-popup-${r.id}`}
        onClick={(ev) => ev.stopPropagation()}
        className="cf-pop-in flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl ring-1 ring-slate-900/10 sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <div id={`request-popup-${r.id}`} className="truncate text-base font-semibold text-slate-900">
              #{r.id} · {r.customer_name || prettyPhone(r.phone)}
            </div>
            <div className="truncate text-xs text-slate-500">{prettyPhone(r.phone)}{r.product_title ? ` · ${r.product_title}` : ""}</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={onCall} className={quick}><PhoneCall className="h-3.5 w-3.5" aria-hidden />Call from this device</button>
            <button type="button" onClick={onCopyIntl} className={quick}><Copy className="h-3.5 w-3.5" aria-hidden />Copy phone (intl.)</button>
            {!closed && Number(r.attempts) > 0 && (
              <button type="button" onClick={() => onAction("undo_call", "Last call attempt removed")} className={quick}><Undo2 className="h-3.5 w-3.5" aria-hidden />Undo N{r.attempts}</button>
            )}
            {!r.assigned_to && (
              <button type="button" onClick={() => onAction("claim", "Added to your requests")} className={quick}><Hand className="h-3.5 w-3.5" aria-hidden />Take this request</button>
            )}
            {r.assigned_to && r.assigned_to.id !== me.id && isAdmin && (
              <button type="button" onClick={() => onAction("claim", "Moved to your requests")} className={quick}><UserPlus className="h-3.5 w-3.5" aria-hidden />Take over from {agentName(r.assigned_to)}</button>
            )}
            {r.assigned_to && (r.assigned_to.id === me.id || isAdmin) && (
              <button type="button" onClick={() => onAction("release", "Released back to the team")} className={quick}><UserMinus className="h-3.5 w-3.5" aria-hidden />Release to the team</button>
            )}
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <Tag className="h-4 w-4 text-indigo-600" aria-hidden />What did the customer say?
            </div>
            <p className="mt-0.5 text-xs text-slate-500">Pick one or more reasons. They feed the Reasons analysis.</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Reason labels">
              {shown.map((l) => {
                const on = chosen.has(l.id);
                const tone = TONES[l.color] || TONES.slate;
                return (
                  <button
                    key={l.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(l)}
                    className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold ring-1 ring-inset transition active:scale-95 ${on ? `${tone.solid} ring-transparent shadow-sm` : `${tone.soft} hover:brightness-95`}`}
                  >
                    {on ? <Check className="h-3.5 w-3.5" aria-hidden /> : <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden />}
                    {l.name}
                  </button>
                );
              })}
              <span className="inline-flex h-9 items-center gap-1 rounded-full border border-dashed border-slate-300 bg-slate-50 pl-3 pr-1">
                <input
                  value={newName}
                  maxLength={60}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }}
                  placeholder="New label…"
                  aria-label="New label name"
                  className="w-28 bg-transparent text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none"
                />
                <button type="button" disabled={!newName.trim() || adding} onClick={create} className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200 disabled:opacity-40" aria-label="Add label">
                  {adding ? <Spinner className="h-3 w-3" /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
                </button>
              </span>
            </div>
          </div>

          <label className="block">
            <span className="text-sm font-semibold text-slate-900">Note{needsNote ? " (required for Other)" : " (optional)"}</span>
            <textarea
              ref={noteRef}
              value={note}
              maxLength={900}
              rows={3}
              onChange={(e) => { setNote(e.target.value); setProblem(""); }}
              placeholder={needsNote ? "What did the customer say?" : "e.g. wants size 30, call back after 18h"}
              className={`mt-1.5 block w-full rounded-xl border-0 px-3 py-2 text-sm text-slate-800 ring-1 ring-inset placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 ${problem ? "ring-rose-400" : "ring-slate-200"}`}
            />
            {problem && <span className="mt-1 block text-xs font-medium text-rose-600">{problem}</span>}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-3 sm:px-5">
          {closed ? (
            <>
              <button type="button" disabled={busy} onClick={() => onAction("reopen", "Request reopened")} className={`${BTN.secondary} h-10`}>
                <RotateCcw className="h-4 w-4" aria-hidden />Reopen
              </button>
              {r.status === "ordered" && (
                <button type="button" disabled={busy} onClick={() => submit("cancelled")} data-testid="popup-cancelled"
                  className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-3.5 text-sm font-semibold text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-50 active:scale-[0.97] transition disabled:opacity-50">
                  <X className="h-4 w-4" aria-hidden />Order cancelled
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => submit("not_interested")}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 text-sm font-semibold text-white shadow-sm hover:bg-rose-700 active:scale-[0.97] transition disabled:opacity-50">
                <Ban className="h-4 w-4" aria-hidden />Not interested
              </button>
              <button type="button" disabled={busy} onClick={() => submit("wrong_number")}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-3.5 text-sm font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50 active:scale-[0.97] transition disabled:opacity-50">
                <PhoneOff className="h-4 w-4" aria-hidden />Wrong number
              </button>
              <button type="button" disabled={busy} onClick={() => submit("cancelled")} data-testid="popup-cancelled"
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-3.5 text-sm font-semibold text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-50 active:scale-[0.97] transition disabled:opacity-50">
                <X className="h-4 w-4" aria-hidden />Cancelled
              </button>
            </>
          )}
          <button type="button" disabled={busy} onClick={() => submit(null)}
            className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 active:scale-[0.97] transition disabled:opacity-50">
            {busy ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4" aria-hidden />}Save
          </button>
        </div>
      </div>
    </div>
  );
}

const REASON_PERIODS = [7, 30, 90];
const REASON_STATUS = [
  { key: "any", label: "All" },
  { key: "lost", label: "Lost" },
  { key: "ordered", label: "Ordered" },
  { key: "", label: "Still open" },
];

function percent(part, whole) {
  return whole ? `${Math.round((100 * part) / whole)}%` : "—";
}

function ReasonsView({ store, labels, canManage, onLabelsChanged, pushToast, onOpenRequest }) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("any");
  const [rows, setRows] = useState({ requests: [], total: 0 });
  const [rowsLoading, setRowsLoading] = useState(false);
  const [managing, setManaging] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setReport(await CHAT_API.reasons(store, days)); } catch (e) { setError(e?.message || "Failed to load reasons"); }
  }, [store, days]);
  useEffect(() => { load(); }, [load, labels]);
  useEffect(() => { setSelected(null); }, [store]);

  useEffect(() => {
    if (!selected) { setRows({ requests: [], total: 0 }); return; }
    let alive = true;
    setRowsLoading(true);
    CHAT_API.list(store, { scope: "all", level: status, label: selected.id, offset: 0 })
      .then((js) => { if (alive) setRows({ requests: js.requests || [], total: js.total || 0 }); })
      .catch((e) => pushToast(e?.message || "Failed to load requests", "error", 5000))
      .finally(() => { if (alive) setRowsLoading(false); });
    return () => { alive = false; };
  }, [store, selected, status, pushToast]);

  async function updateLabel(label, patch) {
    try {
      await CHAT_API.updateLabel(label.id, patch);
      onLabelsChanged();
    } catch (e) {
      pushToast(e?.message || "Could not update the label", "error", 5000);
    }
  }

  const o = report?.outcomes || {};
  const lost = Number(o.not_interested || 0) + Number(o.wrong_number || 0);
  const maxTotal = Math.max(1, ...(report?.labels || []).map((l) => l.total));
  return (
    <div className="space-y-4">
      <section className={`${CARD} p-4 sm:p-5`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">Why customers don’t order</h2>
            <p className="text-xs text-slate-500">Requests created in the last {days} days, by the reasons agents labelled after the call.</p>
          </div>
          <div className="ml-auto flex items-center gap-1 rounded-xl bg-slate-100 p-1">
            {REASON_PERIODS.map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
                className={`h-7 rounded-lg px-2.5 text-xs font-semibold transition ${days === d ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5" : "text-slate-600 hover:text-slate-900"}`}>{d} days</button>
            ))}
          </div>
        </div>
        {error && <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">{error}</div>}
        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <KpiCard icon={Inbox} tone="indigo" label="Requests" value={Number(report?.total || 0)} loading={!report} />
          <KpiCard icon={ShoppingBag} tone="emerald" label="Ordered" value={Number(o.ordered || 0)} hint={`${percent(o.ordered || 0, report?.total)} of requests`} loading={!report} />
          <KpiCard icon={Ban} tone="rose" label="Lost" value={lost} hint={`${o.not_interested || 0} not interested · ${o.wrong_number || 0} wrong number`} loading={!report} />
          <KpiCard icon={Tag} tone="amber" label="Lost without a reason" value={Number(report?.lost_without_label || 0)} hint="label them to see why" loading={!report} />
        </div>
      </section>

      <section className={`${CARD} p-4 sm:p-5`}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Reasons</h3>
          <span className="text-xs text-slate-500">most lost customers first · tap a reason to see its requests</span>
          {canManage && (
            <button type="button" onClick={() => setManaging((m) => !m)} className={`${BTN.secondary} ml-auto h-8 text-xs`}>
              <Tag className="h-3.5 w-3.5" aria-hidden /> {managing ? "Done" : "Manage labels"}
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-rose-500" />Lost</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-amber-400" />Still open</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" />Ordered</span>
        </div>
        <ul className="mt-3 space-y-1.5">
          {(report?.labels || []).map((l) => {
            const tone = TONES[l.color] || TONES.slate;
            const active = selected?.id === l.id;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => setSelected(active ? null : l)}
                  aria-pressed={active}
                  className={`grid w-full grid-cols-[minmax(0,9rem)_1fr_auto] sm:grid-cols-[minmax(0,12rem)_1fr_10rem] items-center gap-3 rounded-xl px-2.5 py-2 text-left transition ${active ? "bg-indigo-50 ring-1 ring-inset ring-indigo-200" : "hover:bg-slate-50"}`}
                >
                  <span className={`inline-flex min-w-0 items-center gap-1.5 justify-self-start rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${tone.soft}`}>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} /><span className="truncate">{l.name}</span>
                    {l.archived && <Archive className="h-3 w-3 shrink-0" aria-label="archived" />}
                  </span>
                  <span className="flex h-6 overflow-hidden rounded-lg bg-slate-100" style={{ width: `${Math.max(4, (100 * l.total) / maxTotal)}%` }} title={`${l.lost} lost · ${l.open} open · ${l.ordered} ordered`}>
                    {l.lost > 0 && <span className="h-full bg-rose-500 transition-all" style={{ width: `${(100 * l.lost) / l.total}%` }} />}
                    {l.open > 0 && <span className="h-full bg-amber-400 transition-all" style={{ width: `${(100 * l.open) / l.total}%` }} />}
                    {l.ordered > 0 && <span className="h-full bg-emerald-500 transition-all" style={{ width: `${(100 * l.ordered) / l.total}%` }} />}
                  </span>
                  <span className="text-right text-xs tabular-nums text-slate-600">
                    <span className="font-semibold text-slate-900">{l.total}</span> · <span className="text-rose-700">{l.lost} lost</span>
                    <span className="hidden sm:inline"> · {percent(l.ordered, l.total)} ordered</span>
                  </span>
                </button>
                {managing && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 px-2.5 pb-1">
                    <input defaultValue={l.name} maxLength={60} aria-label={`Rename ${l.name}`}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== l.name) updateLabel(l, { name: v }); }}
                      className="h-7 w-40 rounded-lg border-0 px-2 text-xs ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-indigo-500" />
                    <div className="flex gap-1">
                      {Object.keys(TONES).map((c) => (
                        <button key={c} type="button" onClick={() => updateLabel(l, { color: c })} aria-label={`Color ${c}`} aria-pressed={l.color === c}
                          className={`h-5 w-5 rounded-full ${TONES[c].dot} ${l.color === c ? "ring-2 ring-offset-1 ring-slate-900" : ""}`} />
                      ))}
                    </div>
                    <button type="button" onClick={() => updateLabel(l, { archived: !l.archived })} className={`${BTN.ghost} h-7 text-xs`}>
                      <Archive className="h-3.5 w-3.5" aria-hidden /> {l.archived ? "Restore" : "Archive"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
          {report && !(report.labels || []).length && <li className="px-2.5 py-4 text-sm text-slate-500">No labels yet.</li>}
        </ul>
        {report && report.total > 0 && (
          <p className="mt-3 text-xs text-slate-500">{report.labelled} of {report.total} requests have at least one reason.</p>
        )}
      </section>

      {selected && (
        <section className={`${CARD} overflow-hidden`}>
          <div className="flex flex-wrap items-center gap-2 px-4 pt-4 sm:px-5">
            <h3 className="text-sm font-semibold text-slate-900">Requests labelled “{selected.name}”</h3>
            <span className="text-xs text-slate-500">{rows.total}</span>
            <div className="ml-auto flex items-center gap-1 rounded-xl bg-slate-100 p-1">
              {REASON_STATUS.map((s) => (
                <button key={s.key || "open"} type="button" onClick={() => setStatus(s.key)} aria-pressed={status === s.key}
                  className={`h-7 rounded-lg px-2.5 text-xs font-semibold transition ${status === s.key ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5" : "text-slate-600 hover:text-slate-900"}`}>{s.label}</button>
              ))}
            </div>
          </div>
          <div className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
            {rowsLoading && <div className="px-5 py-6 text-center"><Spinner className="h-5 w-5 text-indigo-500" /></div>}
            {!rowsLoading && rows.requests.map((r) => {
              const outcome = OUTCOMES[r.status];
              return (
                <button key={r.id} type="button" onClick={() => onOpenRequest(r)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50 sm:px-5">
                  <span className="font-semibold text-slate-900">#{r.id}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{r.customer_name || prettyPhone(r.phone)}<span className="ml-2 text-xs text-slate-500">{r.product_title || ""}</span></span>
                  <span className="flex flex-wrap gap-1">
                    {(r.labels || []).map((l) => (
                      <span key={l.id} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${(TONES[l.color] || TONES.slate).soft}`}>{l.name}</span>
                    ))}
                  </span>
                  <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${(TONES[outcome?.tone] || TONES.amber).soft}`}>{outcome ? outcome.label : "Open"}</span>
                  <span className="text-[11px] text-slate-400">{timeAgo(r.closed_at || r.created_at)}</span>
                </button>
              );
            })}
            {!rowsLoading && rows.requests.length === 0 && <div className="px-5 py-6 text-center text-sm text-slate-500">No request with this label here.</div>}
          </div>
        </section>
      )}
    </div>
  );
}

const HISTORY_LABELS = {
  requested: () => "Asked for a call on the store",
  requested_again: () => "Asked again on the store",
  call: (d) => `Call attempt · N${d.attempt ?? ""}`,
  undo_call: (d) => `Undid a call attempt · now N${d.attempt ?? 0}`,
  enatt: (d) => `En attente · EA${d.enatt ?? ""}`,
  ordered: (d) => `Ordered${d.order_ref ? ` · ${d.order_ref}` : ""}`,
  chat_updated: () => "Customer came back and wrote more in the website chat",
  labels: (d) => ["Labels", (d.added || []).length ? `+ ${d.added.join(", ")}` : "", (d.removed || []).length ? `− ${d.removed.join(", ")}` : ""].filter(Boolean).join(" · "),
  not_interested: () => "Closed · not interested",
  wrong_number: () => "Closed · wrong number",
  cancelled: (d) => `Cancelled${d.order_ref ? ` · order ${d.order_ref}` : ""}`,
  order_create_failed: (d) => `Order not created · ${d.error || "Shopify refused it"}`,
  order_create_unknown: (d) => `Order attempt not confirmed by Shopify (check recent orders) · ${d.error || ""}`,
  reopen: () => "Reopened",
  claim: () => "Took the request",
  claimed: () => "Took the request (Get more)",
  release: () => "Released to the team",
  assign: () => "Reassigned",
  note: (d) => `Note: ${d.note || ""}`,
};

// The customer's website chat exactly as they saw it: scrollable, with photos, collections and
// voice notes. Falls back to the saved transcript text for requests that did not come from the chat.
function ConversationView({ request: r }) {
  const [view, setView] = useState({ loading: true });
  useEffect(() => {
    let cancelled = false;
    setView({ loading: true });
    CHAT_API.conversation(r.id)
      .then((js) => { if (!cancelled) setView({ url: js && /^https:\/\//.test(js.url || "") ? js.url : null }); })
      .catch((e) => { if (!cancelled) setView({ error: e?.message || "Failed to load the conversation" }); });
    return () => { cancelled = true; };
  }, [r.id, r.request_count]);

  if (view.loading) return <div className="flex h-24 items-center justify-center"><Spinner /></div>;
  if (view.url) {
    return (
      <div className="space-y-1.5">
        <iframe
          src={view.url}
          title="Website chat"
          className="h-[600px] w-full rounded-xl bg-[#efeae2] ring-1 ring-inset ring-slate-200"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
        <a href={view.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 hover:underline">
          <ExternalLink className="h-3 w-3" aria-hidden /> Open the chat in a new tab
        </a>
      </div>
    );
  }
  return (
    <>
      {view.error && <p className="text-xs text-rose-600">{view.error}</p>}
      {r.message ? (
        <p className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-800 ring-1 ring-inset ring-slate-200">{r.message}</p>
      ) : (
        <p className="text-xs text-slate-400">The customer did not write a message.</p>
      )}
    </>
  );
}

function ChatRequestDetails({ request: r, store, shopDomain, isAdmin, agents, busy, onNote, onAssign }) {
  const [note, setNote] = useState("");
  const [events, setEvents] = useState(null);
  const [eventsError, setEventsError] = useState(null);
  const [lookup, setLookup] = useState(null); // { loading, orders, error, shop_domain }

  // Reload the history whenever the request changes (a click adds an event).
  const version = `${r.id}|${r.updated_at}|${r.attempts}|${r.enatt}|${r.status}`;
  useEffect(() => {
    let cancelled = false;
    CHAT_API.history(r.id)
      .then((js) => { if (!cancelled) { setEvents(js.events || []); setEventsError(null); } })
      .catch((e) => { if (!cancelled) setEventsError(e?.message || "Failed to load history"); });
    return () => { cancelled = true; };
  }, [version, r.id]);

  async function saveNote() {
    const text = note.trim();
    if (!text) return;
    const ok = await onNote(text);
    if (ok) setNote("");
  }

  async function findOrders() {
    setLookup({ loading: true, orders: [] });
    try {
      const js = await CHAT_API.shopifyOrders(store, localPhone(r.phone));
      const byId = new Map();
      for (const o of js.orders || []) byId.set(o.id, o);
      for (const c of js.customers || []) for (const o of (c.orders || [])) if (!byId.has(o.id)) byId.set(o.id, o);
      setLookup({ loading: false, orders: [...byId.values()], shop_domain: js.shop_domain || shopDomain });
    } catch (e) {
      setLookup({ loading: false, orders: [], error: e?.message || "Shopify search failed" });
    }
  }

  const detailRows = [
    ["Asked", r.created_at ? `${new Date(r.created_at).toLocaleString()} (${timeAgo(r.created_at)})` : "—"],
    ["Times asked", String(r.request_count || 1)],
    ["Handled by", r.assigned_to ? agentName(r.assigned_to) : "Unassigned"],
  ];
  if (r.closed_at) detailRows.push(["Closed", `${new Date(r.closed_at).toLocaleString()}${r.closed_by ? ` by ${agentName(r.closed_by)}` : ""}`]);
  if (r.phone_raw && r.phone_raw !== localPhone(r.phone)) detailRows.push(["Typed phone", r.phone_raw]);

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className={`${CARD} p-3.5 space-y-3`}>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <MessageSquareText className="h-3.5 w-3.5" aria-hidden /> Request
        </div>
        <ConversationView request={r} />
        {(r.product_title || r.product_image) && (
          <div className="flex items-center gap-3 rounded-xl bg-white p-2 ring-1 ring-inset ring-slate-200">
            {r.product_image && <img src={r.product_image} alt="" className="h-14 w-14 rounded-lg object-cover" loading="lazy" />}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{r.product_title || "Product"}</div>
              {r.variant_title && <div className="truncate text-xs text-slate-500">{r.variant_title}</div>}
              {r.product_url && (
                <a href={r.product_url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 hover:underline">
                  <ExternalLink className="h-3 w-3" aria-hidden /> Open product
                </a>
              )}
            </div>
          </div>
        )}
        {r.page_url && r.page_url !== r.product_url && (
          <a href={r.page_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 truncate text-xs text-slate-500 hover:text-indigo-700 hover:underline" title={r.page_url}>
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate">{r.page_url}</span>
          </a>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {detailRows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-slate-500">{k}</dt>
              <dd className="truncate font-medium text-slate-800">{v}</dd>
            </React.Fragment>
          ))}
        </dl>
        {isAdmin && (
          <label className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">Assign to</span>
            <select
              value={r.assigned_to?.id || ""}
              disabled={busy}
              onChange={(e) => onAssign(e.target.value)}
              className="h-8 flex-1 rounded-lg border-0 bg-white px-2 text-xs ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Unassigned</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{agentName(a)}</option>)}
              {r.assigned_to && !agents.some((a) => a.id === r.assigned_to.id) && (
                <option value={r.assigned_to.id}>{agentName(r.assigned_to)}</option>
              )}
            </select>
          </label>
        )}
      </div>

      <div className={`${CARD} p-3.5 space-y-3`}>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <StickyNote className="h-3.5 w-3.5" aria-hidden /> Notes
        </div>
        {r.note ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-amber-50/60 px-3 py-2 font-sans text-xs text-slate-800 ring-1 ring-inset ring-amber-200">{r.note}</pre>
        ) : (
          <p className="text-xs text-slate-400">No notes yet.</p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); } }}
            rows={2}
            placeholder="e.g. wants size 6, call back after 18h"
            className="min-h-[2.5rem] flex-1 resize-y rounded-xl border-0 bg-white px-3 py-2 text-sm ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-indigo-500"
          />
          <button type="button" disabled={busy || !note.trim()} onClick={saveNote} className={`${BTN.primary} h-9`}>Save</button>
        </div>

        <div className="border-t border-slate-100 pt-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shopify orders</span>
            <button type="button" onClick={findOrders} disabled={lookup?.loading} className={`${BTN.secondary} ml-auto h-8 text-xs`}>
              {lookup?.loading ? <Spinner className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" aria-hidden />}
              {lookup ? "Search again" : "Find by phone"}
            </button>
          </div>
          {lookup?.error && <p className="mt-2 text-xs text-rose-700">{lookup.error}</p>}
          {lookup && !lookup.loading && !lookup.error && (
            lookup.orders.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">No Shopify order for this phone yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {lookup.orders.slice(0, 8).map((o) => {
                  const numeric = String(o.legacy_id || String(o.id || "").match(/(\d+)\s*$/)?.[1] || "");
                  const url = numeric ? shopifyAdminUrl(lookup.shop_domain, `orders/${numeric}`) : null;
                  return (
                    <li key={o.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs ring-1 ring-inset ring-slate-200">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 hover:underline">{o.name}</a>
                      ) : <span className="font-semibold">{o.name}</span>}
                      <span className="text-slate-400">{timeAgo(o.created_at)}</span>
                      <span className="ml-auto truncate text-slate-500">{(o.tags || []).slice(0, 3).join(", ")}</span>
                      <span className="shrink-0 font-semibold tabular-nums text-slate-800">{o.total_price} {o.currency}</span>
                    </li>
                  );
                })}
              </ul>
            )
          )}
        </div>
      </div>

      <div className={`${CARD} p-3.5`}>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <History className="h-3.5 w-3.5" aria-hidden /> History
        </div>
        {eventsError && <p className="mt-2 text-xs text-rose-700">{eventsError}</p>}
        {!events && !eventsError && (
          <div className="mt-3 space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="cf-shimmer h-4 rounded" />)}
          </div>
        )}
        {events && (
          <ol className="mt-2 max-h-64 space-y-2 overflow-auto pr-1">
            {events.map((e) => {
              const label = (HISTORY_LABELS[e.action] || (() => e.action))(e.detail || {});
              return (
                <li key={e.id} className="flex gap-2 text-xs">
                  <span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                  <div className="min-w-0">
                    <div className="break-words text-slate-800">{label}</div>
                    <div className="text-[11px] text-slate-400" title={e.created_at ? new Date(e.created_at).toLocaleString() : ""}>
                      {e.user ? agentName(e.user) : "Customer"} · {timeAgo(e.created_at)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
