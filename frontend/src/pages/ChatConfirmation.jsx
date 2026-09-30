import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  CalendarCheck,
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
  RotateCcw,
  Search,
  ShoppingBag,
  Sparkles,
  StickyNote,
  Trophy,
  Undo2,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { authFetch, authHeaders } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import { useToasts, ToastStack } from "../components/Toast";
import { AnimatedNumber, useDepartingList, useFlipList } from "../components/Motion";
import {
  ACTION_BTN, ACTION_THEMES, BTN, CARD, TONES,
  KpiCard, SkeletonCards, SkeletonRows, Spinner, TopBar,
  initialOf, isInteractiveTarget, timeAgo,
} from "../components/ConfirmationUi";
import { copyToClipboard, moroccoInternational } from "../lib/confirmationActions";

// Chat confirmation: customers who asked for a chat on the storefront leave a phone
// number instead of opening WhatsApp, and agents call them back from here. Works
// like the Orders tab: call attempts N1 → N4, en attente, then an outcome.

const PER_PAGE = 50;

const CHAT_LEVELS = [
  { key: "",       label: "All open",   tone: "slate",   count: "total" },
  { key: "new",    label: "New",        tone: "indigo",  count: "new" },
  { key: "n1",     label: "N1",         tone: "amber",   count: "n1" },
  { key: "n2",     label: "N2",         tone: "orange",  count: "n2" },
  { key: "n3",     label: "N3",         tone: "rose",    count: "n3" },
  { key: "n4",     label: "N4",         tone: "red",     count: "n4" },
  { key: "enatt",  label: "En attente", tone: "fuchsia", count: "enatt" },
  { key: "closed", label: "Closed",     tone: "emerald", count: "closed" },
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
};
const CLOSED = new Set(Object.keys(OUTCOMES));

const SCOPE_STORAGE_KEY = "chatConfirmationScope";

// ---------- API ----------
async function jsonOrThrow(res, fallback) {
  if (res.ok) return res.json();
  const js = await res.json().catch(() => ({}));
  throw new Error(js.detail || `${fallback} (${res.status})`);
}

const CHAT_API = {
  async list(store, { scope, level, q, offset }) {
    const qs = new URLSearchParams({ store, scope, limit: String(PER_PAGE), offset: String(offset || 0) });
    if (level) qs.set("level", level);
    if (q) qs.set("q", q);
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
  async pull(store, limit) {
    return jsonOrThrow(await authFetch(`/api/chat-requests/pull`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ store, limit }),
    }), "Could not take requests");
  },
  async history(id) {
    return jsonOrThrow(await authFetch(`/api/chat-requests/${encodeURIComponent(id)}/history`, { headers: authHeaders() }), "Failed to load history");
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

function matchesView(r, { scope, level, meId }) {
  if (scope === "mine" && r.assigned_to?.id !== meId) return false;
  if (scope === "unassigned" && r.assigned_to) return false;
  const closed = CLOSED.has(r.status);
  if (level === "closed") return closed;
  if (closed) return false;
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
  const [orderedFor, setOrderedFor] = useState(null);
  const [orderRef, setOrderRef] = useState("");
  const [pullBusy, setPullBusy] = useState(false);
  const requestIdRef = useRef(0);
  const teamRequestIdRef = useRef(0);
  const searchInputRef = useRef(null);
  const isAdmin = me?.role === "admin";

  useEffect(() => { try { localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch {} }, [scope]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim().length >= 2 ? query.trim() : ""), 250);
    return () => clearTimeout(t);
  }, [query]);

  // A new filter, search or store starts again from the first page.
  useEffect(() => { setPageIndex(0); }, [store, scope, level, debouncedQuery]);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true); setError(null);
    try {
      const js = await CHAT_API.list(store, { scope, level, q: debouncedQuery, offset: pageIndex * PER_PAGE });
      if (reqId !== requestIdRef.current) return;
      setData({
        requests: js.requests || [],
        total: Number(js.total || 0),
        level_counts: js.level_counts || null,
        scope_counts: js.scope_counts || null,
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
  }, [store, scope, level, debouncedQuery, pageIndex]);

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
    if (!menuFor) return undefined;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuFor]);

  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || e.target?.isContentEditable) return;
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "r" || e.key === "R") {
        refreshAll();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshAll]);

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
    const stillVisible = matchesView(updated, { scope, level, meId: me.id });
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

  function openOrdered(r) {
    setOrderRef("");
    setOrderedFor(r.id);
  }

  async function submitOrdered(r) {
    const ref = orderRef.trim();
    const done = await runAction(r, { action: "ordered", order_ref: ref || null }, {
      success: `${r.customer_name || prettyPhone(r.phone)} marked as ordered${ref ? ` · ${ref}` : ""}`,
    });
    if (done) setOrderedFor(null);
  }

  function closeAs(r, outcome) {
    setMenuFor(null);
    return runAction(r, { action: outcome }, { success: `Closed as ${OUTCOMES[outcome].label.toLowerCase()}` });
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

  async function takeRequests(limit) {
    setPullBusy(true);
    try {
      const js = await CHAT_API.pull(store, limit);
      const pulled = Number(js.pulled || 0);
      if (pulled === 0) {
        pushToast("No unassigned chat requests left — someone may have just taken them.", "warn", 5000);
      } else {
        pushToast(`Took ${pulled} chat request${pulled === 1 ? "" : "s"} into your queue`, "success", 4000);
      }
      if (pulled > 0 && (scope !== "mine" || level)) {
        setScope("mine");
        setLevel("");
      } else {
        load();
      }
      loadTeam();
      onWaitingChanged?.();
    } catch (e) {
      pushToast(e?.message || "Could not take requests", "error", 6000);
    } finally {
      setPullBusy(false);
    }
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

  const listResetKey = `${store}|${scope}|${level}|${debouncedQuery}|${pageIndex}`;
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
    if (CLOSED.has(r.status)) {
      const o = OUTCOMES[r.status];
      chips.push(chip(`${o.label}${r.status === "ordered" && r.order_ref ? ` · ${r.order_ref}` : ""}`, o.tone, "outcome"));
    } else if (r.status === "new") {
      chips.push(chip("New", "indigo", "new"));
    }
    if (Number(r.attempts) > 0) chips.push(chip(`N${r.attempts}`, LEVEL_TONE[Math.min(4, Number(r.attempts))], "attempts"));
    if (Number(r.enatt) > 0) chips.push(chip(`EA${r.enatt}`, "fuchsia", "enatt"));
    if (Number(r.request_count) > 1) chips.push(chip(`Asked ×${r.request_count}`, "amber", "repeat"));
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
          onClick={(ev) => { ev.stopPropagation(); openOrdered(r); }}
          className={`${ACTION_BTN} ${ACTION_THEMES.confirm} ${grow}`}
          title="The customer ordered — close the request"
        >
          <ShoppingBag className="h-3.5 w-3.5" aria-hidden />
          <span className={stretch ? "" : "hidden 2xl:inline"}>Ordered</span>
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); setMenuFor((p) => (p === r.id ? null : r.id)); }}
            className={`${ACTION_BTN} ${ACTION_THEMES.more} w-8 !px-0`}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
          >
            <Ellipsis className="h-4 w-4" aria-hidden />
          </button>
          {menuOpen && (
            <div
              role="menu"
              onClick={(ev) => ev.stopPropagation()}
              className="cf-pop-in absolute right-0 top-full z-20 mt-1.5 w-56 overflow-hidden rounded-xl bg-white py-1 text-left shadow-lg shadow-slate-900/10 ring-1 ring-slate-900/10"
            >
              <MenuItem icon={PhoneCall} onClick={() => { setMenuFor(null); try { location.href = `tel:${localPhone(r.phone)}`; } catch {} }}>Call from this device</MenuItem>
              <MenuItem icon={Copy} onClick={() => { handleCopyIntl(r); setMenuFor(null); }}>Copy phone (intl.)</MenuItem>
              {Number(r.attempts) > 0 && (
                <MenuItem icon={Undo2} onClick={() => { setMenuFor(null); runAction(r, { action: "undo_call" }, { success: "Last call attempt removed" }); }}>Undo last call (N{r.attempts})</MenuItem>
              )}
              <div className="my-1 border-t border-slate-100" />
              {!r.assigned_to && (
                <MenuItem icon={Hand} onClick={() => { setMenuFor(null); runAction(r, { action: "claim" }, { success: "Added to your requests" }); }}>Take this request</MenuItem>
              )}
              {r.assigned_to && r.assigned_to.id !== me.id && isAdmin && (
                <MenuItem icon={UserPlus} onClick={() => { setMenuFor(null); runAction(r, { action: "claim" }, { success: "Moved to your requests" }); }}>Take over from {agentName(r.assigned_to)}</MenuItem>
              )}
              {r.assigned_to && (r.assigned_to.id === me.id || isAdmin) && (
                <MenuItem icon={UserMinus} onClick={() => { setMenuFor(null); runAction(r, { action: "release" }, { success: "Released back to the team" }); }}>Release to the team</MenuItem>
              )}
              <div className="my-1 border-t border-slate-100" />
              <MenuItem icon={Ban} tone="rose" onClick={() => closeAs(r, "not_interested")}>Not interested</MenuItem>
              <MenuItem icon={PhoneOff} tone="rose" onClick={() => closeAs(r, "wrong_number")}>Wrong number</MenuItem>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderOrderedPicker(r) {
    const busy = busyIds.has(r.id);
    const draftUrl = shopifyAdminUrl(data.shop_domain, "draft_orders/new");
    return (
      <div
        className="cf-collapse-in flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50/70 px-3 py-2.5 ring-1 ring-inset ring-emerald-200"
        onClick={(ev) => ev.stopPropagation()}
      >
        <CalendarCheck className="h-4 w-4 text-emerald-600" aria-hidden />
        <span className="text-xs font-semibold text-emerald-900">Order number</span>
        <input
          type="text"
          value={orderRef}
          autoFocus
          onChange={(e) => setOrderRef(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submitOrdered(r); }
            if (e.key === "Escape") { e.preventDefault(); setOrderedFor(null); }
          }}
          placeholder="#1234 (optional)"
          className="h-8 w-36 rounded-lg border-0 bg-white px-2 text-sm text-slate-800 ring-1 ring-inset ring-emerald-200 focus:ring-2 focus:ring-emerald-500"
        />
        {draftUrl && (
          <a
            href={draftUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 underline-offset-2 hover:underline"
          ><ExternalLink className="h-3.5 w-3.5" aria-hidden /> New order in Shopify</a>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setOrderedFor(null)} className={`${BTN.ghost} h-8 text-xs`}>Cancel</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => submitOrdered(r)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 active:scale-[0.97] transition disabled:opacity-50"
          >{busy ? <Spinner className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" aria-hidden />} Mark ordered</button>
        </div>
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
    const pickerOpen = orderedFor === r.id;
    const busy = busyIds.has(r.id);
    return (
      <div
        key={r.id}
        data-flip-key={r.id}
        className={`relative p-3.5 transition-colors ${leaving ? "cf-leave" : ""} ${isOpen || pickerOpen ? "bg-indigo-50/60" : "bg-white"}`}
        onClick={(e) => { if (!leaving && !isInteractiveTarget(e)) toggleExpanded(r.id); }}
      >
        {(isOpen || pickerOpen) && <span aria-hidden className="absolute left-0 inset-y-0 w-1 bg-indigo-500" />}
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
        {pickerOpen && <div className="mt-2.5">{renderOrderedPicker(r)}</div>}
        {isOpen && (
          <div className="cf-collapse-in mt-3" onClick={(ev) => ev.stopPropagation()}>{renderDetails(r)}</div>
        )}
      </div>
    );
  }

  function renderRow({ item: r, leaving }) {
    const isOpen = expanded.has(r.id);
    const pickerOpen = orderedFor === r.id;
    const active = isOpen || pickerOpen;
    const rowBg = active ? "bg-indigo-50/70" : "bg-white";
    return (
      <React.Fragment key={r.id}>
        <tr
          data-flip-key={r.id}
          className={`group border-t border-slate-100 cursor-pointer transition-colors ${rowBg} ${active ? "" : "hover:bg-slate-50/80"} ${leaving ? "cf-leave" : ""}`}
          onClick={(e) => { if (!leaving && !isInteractiveTarget(e)) toggleExpanded(r.id); }}
        >
          <td className={`relative px-4 py-3 whitespace-nowrap ${active ? "shadow-[inset_3px_0_0_rgb(99_102_241)]" : ""}`}>
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
        {pickerOpen && !leaving && (
          <tr className="bg-indigo-50/40">
            <td colSpan={6} className="px-4 py-2.5">{renderOrderedPicker(r)}</td>
          </tr>
        )}
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
            <button type="button" disabled={pullBusy} onClick={() => takeRequests(10)} className={`${BTN.primary} mt-4 h-9`}>
              {pullBusy ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />} Take new requests
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
          <TakeRequestsCard waiting={waitingNew} busy={pullBusy} onTake={takeRequests} />
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
      </main>
    </div>
  );
}

// ---------- Pieces ----------

function MenuItem({ icon: Icon, tone = "slate", disabled = false, onClick, children }) {
  const color = tone === "rose" ? "text-rose-700 hover:bg-rose-50" : "text-slate-700 hover:bg-slate-50";
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-40 ${color}`}
    >
      <Icon className={`h-4 w-4 ${tone === "rose" ? "" : "text-slate-400"}`} aria-hidden /> {children}
    </button>
  );
}

const TAKE_AMOUNTS = [5, 10, 25, 50];

function TakeRequestsCard({ waiting, busy, onTake }) {
  return (
    <div className={`${CARD} relative overflow-hidden p-4`}>
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-gradient-to-br from-indigo-200/50 to-violet-200/40 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">Get more chat requests</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {waiting > 0
              ? <><span className="font-semibold text-indigo-700">{waiting}</span> customer{waiting === 1 ? "" : "s"} asked for a chat and nobody has called yet.</>
              : "Unassigned requests move into your queue so nobody else calls the same customer."}
          </p>
        </div>
      </div>
      <div className="relative mt-3 grid grid-cols-1">
        <button
          type="button"
          data-testid="take-chat-requests"
          disabled={busy || waiting === 0}
          onClick={() => onTake(10)}
          className={`${BTN.primary} h-10`}
        >
          {busy ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />} Take new requests
        </button>
      </div>
      <div className="relative mt-2 flex flex-wrap gap-1.5">
        {TAKE_AMOUNTS.map((n) => (
          <button
            key={n}
            type="button"
            disabled={busy}
            onClick={() => onTake(n)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:ring-slate-300 active:scale-[0.96] transition disabled:opacity-50"
            title={`Take up to ${n} unassigned requests`}
          >
            <span aria-hidden className={`h-2 w-2 rounded-full ${TONES.indigo.dot}`} /> Take {n}
          </button>
        ))}
      </div>
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
            title={lv.key === "closed" ? "Closed in the last 30 days" : undefined}
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

const HISTORY_LABELS = {
  requested: () => "Asked for a call on the store",
  requested_again: () => "Asked again on the store",
  call: (d) => `Call attempt · N${d.attempt ?? ""}`,
  undo_call: (d) => `Undid a call attempt · now N${d.attempt ?? 0}`,
  enatt: (d) => `En attente · EA${d.enatt ?? ""}`,
  ordered: (d) => `Ordered${d.order_ref ? ` · ${d.order_ref}` : ""}`,
  not_interested: () => "Closed · not interested",
  wrong_number: () => "Closed · wrong number",
  reopen: () => "Reopened",
  claim: () => "Took the request",
  claimed: () => "Took the request (Get more)",
  release: () => "Released to the team",
  assign: () => "Reassigned",
  note: (d) => `Note: ${d.note || ""}`,
};

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
        {r.message ? (
          <p className="whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-800 ring-1 ring-inset ring-slate-200">{r.message}</p>
        ) : (
          <p className="text-xs text-slate-400">The customer did not write a message.</p>
        )}
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
