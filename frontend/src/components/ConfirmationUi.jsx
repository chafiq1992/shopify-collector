import React, { useEffect, useState } from "react";
import {
  Boxes,
  CircleAlert,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Package,
  Phone,
  RefreshCw,
  X,
} from "lucide-react";
import { clearAuth } from "../lib/auth";
import { retrySyncQueueNow } from "../lib/syncQueue";
import { AnimatedNumber } from "./Motion";

// Look-and-feel shared by the two Confirmation tabs (orders and chat requests),
// so both read as one app.

// Tailwind utility chunk applied to interactive buttons so every click visually presses
// the button. Pairs with the existing color/hover styling.
export const BTN_TAP = "active:scale-[0.97] transition duration-150";

// Shared button looks, so every control on the page reads as one system.
export const BTN = {
  primary: "inline-flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-sm font-semibold text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.97] transition duration-150",
  secondary: "inline-flex items-center justify-center gap-1.5 rounded-xl bg-white px-3 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.97] transition duration-150",
  ghost: "inline-flex items-center justify-center gap-1.5 rounded-xl px-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50 active:scale-[0.97] transition duration-150",
};

// Per-order action buttons: one height, colour-coded by what the click records.
export const ACTION_BTN = "inline-flex h-8 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition duration-150 active:scale-[0.94] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-wait disabled:opacity-50";
export const ACTION_THEMES = {
  call:    "bg-sky-600 text-white shadow-sm shadow-sky-600/25 hover:bg-sky-700 focus-visible:ring-sky-400",
  nowtp:   "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200 hover:bg-violet-100 focus-visible:ring-violet-400",
  enatt:   "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-inset ring-fuchsia-200 hover:bg-fuchsia-100 focus-visible:ring-fuchsia-400",
  confirm: "bg-emerald-600 text-white shadow-sm shadow-emerald-600/25 hover:bg-emerald-700 focus-visible:ring-emerald-400",
  more:    "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-slate-400",
};

export const CARD = "rounded-2xl border border-slate-200/80 bg-white shadow-sm shadow-slate-900/[0.03]";

// Colour families shared by the level tabs, tag chips, pull modes and team cards.
export const TONES = {
  slate:   { dot: "bg-slate-400",   soft: "bg-slate-100 text-slate-700 ring-slate-200",       solid: "bg-slate-800 text-white",   text: "text-slate-700" },
  indigo:  { dot: "bg-indigo-500",  soft: "bg-indigo-50 text-indigo-700 ring-indigo-200",     solid: "bg-indigo-600 text-white",  text: "text-indigo-700" },
  amber:   { dot: "bg-amber-500",   soft: "bg-amber-50 text-amber-800 ring-amber-200",        solid: "bg-amber-500 text-white",   text: "text-amber-700" },
  orange:  { dot: "bg-orange-500",  soft: "bg-orange-50 text-orange-700 ring-orange-200",     solid: "bg-orange-500 text-white",  text: "text-orange-700" },
  rose:    { dot: "bg-rose-500",    soft: "bg-rose-50 text-rose-700 ring-rose-200",           solid: "bg-rose-500 text-white",    text: "text-rose-700" },
  red:     { dot: "bg-red-600",     soft: "bg-red-50 text-red-700 ring-red-200",              solid: "bg-red-600 text-white",     text: "text-red-700" },
  violet:  { dot: "bg-violet-500",  soft: "bg-violet-50 text-violet-700 ring-violet-200",     solid: "bg-violet-600 text-white",  text: "text-violet-700" },
  fuchsia: { dot: "bg-fuchsia-500", soft: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",  solid: "bg-fuchsia-600 text-white", text: "text-fuchsia-700" },
  emerald: { dot: "bg-emerald-500", soft: "bg-emerald-50 text-emerald-700 ring-emerald-200",  solid: "bg-emerald-600 text-white", text: "text-emerald-700" },
  sky:     { dot: "bg-sky-500",     soft: "bg-sky-50 text-sky-700 ring-sky-200",              solid: "bg-sky-600 text-white",     text: "text-sky-700" },
};

export function initialOf(value) {
  return ((String(value || "?").trim().charAt(0)) || "?").toUpperCase();
}

// "3h ago"-style age for an order, so agents can prioritise without reading dates.
export function timeAgo(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

// Clicks on these (or inside them) act on the control, not the row.
export function isInteractiveTarget(event) {
  try {
    return !!event.target?.closest?.("button, a, input, select, textarea, label, [role='menu']");
  } catch {
    return false;
  }
}

export function Spinner({ className = "w-4 h-4" }) {
  return <LoaderCircle aria-hidden className={`animate-spin ${className}`} />;
}

// Owns its own 1-second ticker so the "updated Xs ago" label doesn't re-render the
// whole page every second.
export function UpdatedAgo({ at, loading }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (loading && !at) return <span>Loading…</span>;
  if (!at) return <span>Not loaded</span>;
  const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return <span>{loading ? "Refreshing…" : sec < 5 ? "Up to date" : `Updated ${sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m`} ago`}</span>;
}

// The two Confirmation tabs. `chatBadge` is the number of chat requests nobody
// has picked up yet, so agents on the Orders tab notice waiting customers.
export const CONFIRMATION_VIEWS = [
  { key: "orders", label: "Orders", short: "Orders", icon: Package },
  { key: "chat", label: "Chat confirmation", short: "Chat", icon: MessageCircle },
];

export function ViewSwitch({ value, onChange, chatBadge = 0, className = "" }) {
  return (
    <div className={`items-center gap-1 rounded-xl bg-slate-100 p-1 ${className}`} role="tablist" aria-label="Confirmation view">
      {CONFIRMATION_VIEWS.map((v) => {
        const active = value === v.key;
        const Icon = v.icon;
        const badge = v.key === "chat" ? Number(chatBadge || 0) : 0;
        return (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`view-${v.key}`}
            onClick={() => { if (!active) onChange?.(v.key); }}
            className={`relative inline-flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition duration-150 active:scale-[0.97] ${
              active ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Icon className={`h-3.5 w-3.5 ${active ? "text-indigo-600" : ""}`} aria-hidden />
            <span className="hidden lg:inline">{v.label}</span>
            <span className="lg:hidden">{v.short}</span>
            {badge > 0 && (
              <span className="min-w-[18px] rounded-full bg-rose-500 px-1.5 py-px text-[10px] font-bold leading-4 text-white tabular-nums" title={`${badge} chat request${badge === 1 ? "" : "s"} waiting for a call`}>
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const NO_SYNC = { count: 0, blockedCount: 0, lastError: null };

export function TopBar({ me, store, loading, lastLoadedAt, syncState = NO_SYNC, onRefresh, onInventory, view, onViewChange, chatBadge = 0 }) {
  const syncCount = syncState.count;
  const blocked = syncState.blockedCount > 0;
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 sm:h-16 max-w-[1600px] items-center gap-2 sm:gap-3 px-3 sm:px-5 lg:px-8">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-600/30">
          <Phone className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 leading-tight">
          <div className="text-[15px] sm:text-base font-semibold text-slate-900">Confirmation</div>
          <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className={`h-1.5 w-1.5 rounded-full ${loading ? "bg-amber-400" : "bg-emerald-500 cf-live-dot text-emerald-500"}`} aria-hidden />
            <UpdatedAgo at={lastLoadedAt} loading={loading} />
            <span className="text-slate-300">·</span>
            <span className="font-medium text-slate-600">{store}</span>
          </div>
        </div>

        {onViewChange && (
          <ViewSwitch value={view} onChange={onViewChange} chatBadge={chatBadge} className="ml-2 hidden sm:flex" />
        )}

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {syncCount > 0 && (
            <button
              type="button"
              onClick={retrySyncQueueNow}
              className={`cf-fade-in inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold ring-1 ring-inset ${
                blocked ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200"
              }`}
              title={syncState.lastError || "Your clicks are being saved to Shopify"}
            >
              {blocked ? <CircleAlert className="h-3.5 w-3.5" aria-hidden /> : <Spinner className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{blocked ? `${syncCount} not saved · Retry` : `Saving ${syncCount}`}</span>
              <span className="sm:hidden">{syncCount}</span>
            </button>
          )}
          <button type="button" onClick={onInventory} className={`${BTN.secondary} h-9`} title="Inventory helper">
            <Boxes className="h-4 w-4 text-emerald-600" aria-hidden />
            <span className="hidden md:inline">Inventory</span>
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className={`${BTN.secondary} h-9 w-9 !px-0 sm:w-auto sm:!px-3`}
            title="Refresh now (R)"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin text-indigo-600" : ""}`} aria-hidden />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <div className="hidden lg:flex items-center gap-2 rounded-xl pl-1 pr-3 py-1 ring-1 ring-inset ring-slate-200 bg-white">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100 text-xs font-bold text-indigo-700">
              {initialOf(me?.name || me?.email)}
            </div>
            <div className="leading-tight max-w-[160px]">
              <div className="truncate text-xs font-semibold text-slate-800">{me?.name || me?.email}</div>
              {me?.name && <div className="truncate text-[10px] text-slate-500">{me.email}</div>}
            </div>
          </div>
          <button
            type="button"
            onClick={() => { clearAuth(); try { location.href = "/login"; } catch {} }}
            className={`${BTN.ghost} h-9 w-9 !px-0`}
            title="Log out"
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      {onViewChange && (
        <div className="border-t border-slate-100 px-3 py-1.5 sm:hidden">
          <ViewSwitch value={view} onChange={onViewChange} chatBadge={chatBadge} className="flex w-full" />
        </div>
      )}
    </header>
  );
}

export function KpiCard({ icon: Icon, tone = "slate", label, value, hint, loading = false, onClick, active = false }) {
  const t = TONES[tone] || TONES.slate;
  const interactive = typeof onClick === "function";
  const Tag = interactive ? "button" : "div";
  return (
    <Tag
      type={interactive ? "button" : undefined}
      onClick={onClick}
      aria-pressed={interactive ? active : undefined}
      className={`${CARD} group relative flex items-center gap-3 p-3 text-left sm:flex-col sm:items-start sm:gap-0 sm:p-4 ${
        interactive ? "cursor-pointer transition hover:-translate-y-0.5 hover:shadow-md active:translate-y-0" : ""
      } ${active ? "ring-2 ring-indigo-500 border-transparent" : ""}`}
    >
      <div className="flex items-center gap-2 sm:w-full">
        <span className={`flex h-9 w-9 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${t.soft}`}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        {active && <span className="ml-auto hidden rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white sm:inline">Filtering</span>}
      </div>
      <div className="min-w-0">
        <div className="text-[22px] sm:mt-3 sm:text-[28px] font-bold leading-none tracking-tight text-slate-900">
          {loading ? <span className="cf-shimmer inline-block h-6 w-10 sm:h-7 sm:w-12 rounded-md align-middle" /> : <AnimatedNumber value={value} />}
        </div>
        <div className="mt-1 sm:mt-1.5 truncate text-[11px] sm:text-xs font-medium text-slate-500">{label}</div>
        {hint && <div className={`mt-0.5 sm:mt-1 truncate text-[10px] sm:text-[11px] font-semibold ${t.text}`}>{hint}</div>}
      </div>
    </Tag>
  );
}

export function SkeletonRows({ columns = 7, rows = 6 }) {
  return Array.from({ length: rows }).map((_, i) => (
    <tr key={`sk-${i}`} className="border-t border-slate-100">
      {Array.from({ length: columns }).map((__, j) => (
        <td key={j} className="px-3 py-4">
          <div className="cf-shimmer h-3.5 rounded" style={{ width: `${[16, 60, 120, 110, 60, 90, 180][j] || 80}px` }} />
        </td>
      ))}
    </tr>
  ));
}

export function SkeletonCards({ rows = 4 }) {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2.5 p-4">
          <div className="flex justify-between"><div className="cf-shimmer h-4 w-24 rounded" /><div className="cf-shimmer h-4 w-16 rounded" /></div>
          <div className="cf-shimmer h-4 w-40 rounded" />
          <div className="cf-shimmer h-7 w-36 rounded-lg" />
          <div className="cf-shimmer h-8 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

// Shared dialog shell: fades in, pops the panel, closes on Esc / backdrop, locks page
// scroll, and becomes a bottom sheet on phones.
export function Modal({ onClose, busy = false, labelledBy, maxWidth = "max-w-md", children }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e) { if (e.key === "Escape" && !busy) onClose?.(); }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [busy, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className="cf-fade-in fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}
    >
      <div className={`cf-pop-in flex max-h-[92vh] w-full ${maxWidth} flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl ring-1 ring-slate-900/10 sm:rounded-2xl`}>
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ id, icon: Icon, tone = "indigo", title, subtitle, onClose, busy }) {
  const t = TONES[tone] || TONES.indigo;
  return (
    <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
      {Icon && (
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${t.soft}`}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-base font-semibold text-slate-900">{title}</h2>
        {subtitle && <div className="mt-0.5 text-xs text-slate-500">{subtitle}</div>}
      </div>
      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className={`${BTN.ghost} h-8 w-8 !px-0 -mr-1.5`}
        aria-label="Close"
      ><X className="h-4 w-4" aria-hidden /></button>
    </div>
  );
}
