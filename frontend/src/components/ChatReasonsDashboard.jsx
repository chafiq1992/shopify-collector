import React, { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDownRight, ArrowRight, Ban, BarChart3, CalendarDays, ChevronLeft, ChevronRight, Clock3, Inbox, RotateCcw, ShoppingBag, Tag, Users } from "lucide-react";
import { authFetch } from "../lib/auth";
import { BTN, CARD, Spinner, TONES, initialOf } from "./ConfirmationUi";

const PRESETS = [["1", "Today"], ["yesterday", "Yesterday"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["custom", "Custom"]];
const OUTCOMES = [["", "All outcomes"], ["ordered", "Ordered"], ["open", "Still open"], ["lost", "All lost"], ["not_interested", "Not interested"], ["wrong_number", "Wrong number"], ["cancelled", "Cancelled"]];
const OUTCOME_NAMES = Object.fromEntries(OUTCOMES);
const CONTROL = "mt-1.5 h-10 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-2.5 text-sm text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500";
const count = new Intl.NumberFormat();
const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const fullDate = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const toDate = (value) => new Date(value + "T00:00:00Z");
const short = (value) => dayLabel.format(toDate(value));
const dateSpan = (from, to) => from === to ? fullDate.format(toDate(from)) : fullDate.formatRange(toDate(from), toDate(to));
const lostCount = (value) => (value.not_interested || 0) + (value.wrong_number || 0) + (value.cancelled || 0);
const share = (n, total) => total ? Math.round(n * 100 / total) : 0;
const percent = (n, total) => total ? `${share(n, total)}%` : "—";

function useAnalytics(params, revision, labels) {
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  const key = `${params}|${revision}|${retry}`;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await authFetch(`/api/chat-requests/reasons?${params}`, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Could not load chat analytics.");
        if (!controller.signal.aborted) setResult({ key, data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: error.message || "Could not load chat analytics." });
      }
    }
    load();
    return () => controller.abort();
  }, [params, key, labels]);
  const current = result?.key === key ? result : null;
  return { data: current?.data, error: current?.error, pending: !current, retry: () => setRetry((n) => n + 1) };
}

function Filter({ label, value, onChange, children }) {
  return <label className="block min-w-0 text-xs font-semibold text-slate-600">{label}
    <select aria-label={label} className={CONTROL} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
  </label>;
}

function Stat({ icon: Icon, tone, label, value, hint, onClick }) {
  const Element = onClick ? "button" : "div";
  return <Element type={onClick ? "button" : undefined} onClick={onClick} className={`group min-w-0 rounded-2xl border border-slate-200 bg-white p-3.5 text-left shadow-sm sm:p-4 ${onClick ? "transition hover:border-indigo-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500" : ""}`}>
    <div className="flex items-center justify-between gap-1">
      <span className={`rounded-lg p-2 ring-1 ring-inset ${TONES[tone].soft}`}><Icon size={16} aria-hidden /></span>
      {onClick && <ArrowDownRight size={15} className="shrink-0 text-slate-300 group-hover:text-indigo-500" aria-hidden />}
    </div>
    <div className="mt-3 text-2xl font-bold tabular-nums tracking-tight text-slate-950 sm:text-3xl">{count.format(value)}</div>
    <div className="text-xs font-semibold text-slate-700 sm:text-sm">{label}</div>
    <p className="mt-0.5 text-xs leading-4 text-slate-500">{hint}</p>
  </Element>;
}

const SERIES = [
  ["ordered", "Ordered", "bg-emerald-500"],
  ["open", "Still open", "bg-amber-400"],
  ["lost", "Lost", "bg-rose-500"],
];

function Stack({ values, total }) {
  return SERIES.map(([key, label, color]) => values[key] > 0 && <span key={key} title={`${label} ${values[key]}`} className={color} style={{ flexBasis: `${100 * values[key] / total}%` }} />);
}

function Trend({ daily, dateBasis, onPick }) {
  const [granularity, setGranularity] = useState("");
  const mode = granularity || (daily.length > 31 ? "weekly" : "daily");
  const buckets = useMemo(() => {
    const groups = new Map();
    for (const day of daily) {
      const monday = toDate(day.date);
      monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
      const key = mode === "weekly" ? monday.toISOString().slice(0, 10) : day.date;
      const bucket = groups.get(key) || { first: day.date, last: day.date, total: 0, ordered: 0, open: 0, lost: 0 };
      bucket.last = day.date;
      bucket.total += day.total;
      bucket.ordered += day.ordered;
      bucket.open += day.open;
      bucket.lost += lostCount(day);
      groups.set(key, bucket);
    }
    return [...groups.values()];
  }, [daily, mode]);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const step = Math.max(1, Math.ceil(buckets.length / 8));
  return <section className={`${CARD} min-w-0 p-4 sm:p-5`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold text-slate-900">Request trend</h3><p className="mt-1 text-xs text-slate-500">By {dateBasis === "closed" ? "closing" : "request"} date. Select a bar to inspect that period.</p></div>
      {daily.length > 1 && <div className="flex rounded-lg bg-slate-100 p-1" aria-label="Trend interval">
        {["daily", "weekly"].map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setGranularity(value)} className={`rounded-md px-2.5 py-1.5 text-xs font-semibold capitalize ${mode === value ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600"}`}>{value}</button>)}
      </div>}
    </div>
    <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-600">
      {SERIES.map(([key, label, color]) => <span key={key} className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${color}`} />{label}</span>)}
    </div>
    <div className="mt-4 overflow-x-auto pb-2">
      <div className="relative flex gap-1 px-1" style={{ minWidth: buckets.length * 23 }}>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-7 bottom-7 flex flex-col justify-between">{[1, 2, 3].map((line) => <div key={line} className="border-t border-dashed border-slate-200" />)}</div>
        {buckets.map((bucket, index) => {
          const summary = `${dateSpan(bucket.first, bucket.last)}, ${bucket.total} requests, ${bucket.ordered} ordered, ${bucket.open} open, ${bucket.lost} lost`;
          return <button key={bucket.first} type="button" title={summary} aria-label={summary} onClick={() => onPick(bucket.first, bucket.last)} className="group z-0 flex min-w-0 flex-1 flex-col items-center justify-end rounded-lg px-0.5 hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">
            <span className="flex h-40 w-full max-w-20 items-end justify-center">
              <span className="relative flex w-full flex-col-reverse overflow-visible rounded-t-md bg-slate-100" style={{ height: Math.max(2, bucket.total / max * 135) }}>
                <span aria-hidden className="absolute -top-5 left-0 right-0 text-center text-[10px] font-semibold tabular-nums text-slate-600">{buckets.length <= 12 && bucket.total > 0 ? bucket.total : ""}</span>
                <span className="flex h-full flex-col-reverse overflow-hidden rounded-t-md"><Stack values={bucket} total={bucket.total} /></span>
              </span>
            </span>
            <span aria-hidden className="flex h-7 items-center whitespace-nowrap text-[10px] text-slate-500">{index % step === 0 ? short(bucket.first) : ""}</span>
          </button>;
        })}
      </div>
    </div>
  </section>;
}

function LoadError({ error, onRetry }) {
  return <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error} <button type="button" className="ml-2 font-semibold underline" onClick={onRetry}>Try again</button></div>;
}

function RequestList({ params, revision, labels, onOpenRequest, onClose }) {
  const [page, setPage] = useState(0);
  const url = `${params}&detail=true&offset=${page * 30}`;
  const { data, error, pending, retry } = useAnalytics(url, revision, labels);
  return <section className={`${CARD} min-w-0 overflow-hidden`} aria-label="Matching requests">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-4 sm:p-5">
      <div><h3 className="font-semibold text-slate-900">Matching requests</h3><p className="mt-1 text-xs text-slate-500">{data ? `${count.format(data.total)} in this view` : "Uses the same dashboard filters"}</p></div>
      <button type="button" onClick={onClose} className={`${BTN.secondary} h-9`}>Hide requests</button>
    </div>
    {pending && <div role="status" className="flex items-center gap-2 p-5 text-sm text-slate-500"><Spinner className="h-4 w-4" /> Loading requests…</div>}
    {error && <div className="p-4"><LoadError error={error} onRetry={retry} /></div>}
    {data?.requests?.length === 0 && <p className="p-5 text-sm text-slate-500">No requests match these filters.</p>}
    <div className="divide-y divide-slate-100">
      {data?.requests?.map((request) => <button type="button" key={request.id} onClick={() => onOpenRequest(request)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5">
        <span className="shrink-0 rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">#{request.id}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-900">{request.customer_name || request.phone}</span>
          {request.product_title && <span className="block truncate text-xs text-slate-500">{request.product_title}</span>}
        </span>
        <span className="shrink-0 text-right text-xs text-slate-600">{OUTCOME_NAMES[request.status] || "Still open"}</span>
        <ArrowRight size={15} className="hidden shrink-0 text-slate-400 sm:block" aria-hidden />
      </button>)}
    </div>
    {data && (page > 0 || data.total > data.limit) && <div className="flex items-center justify-between gap-2 border-t border-slate-100 p-3 text-xs text-slate-600">
      <button type="button" className={BTN.secondary} disabled={!page} onClick={() => setPage(page - 1)} aria-label="Previous requests"><ChevronLeft size={16} /></button>
      {data.requests.length ? `${data.offset + 1}–${data.offset + data.requests.length} of ${data.total}` : `Page ${page + 1}`}
      <button type="button" className={BTN.secondary} disabled={data.offset + data.limit >= data.total} onClick={() => setPage(page + 1)} aria-label="Next requests"><ChevronRight size={16} /></button>
    </div>}
  </section>;
}

function LabelSettings({ labels, onUpdate }) {
  return <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-3">
    {labels.map((label) => <div key={label.id} className="flex flex-wrap items-center gap-2">
      <input key={label.name} defaultValue={label.name} maxLength={60} aria-label={`Rename ${label.name}`}
        onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== label.name) onUpdate(label, { name }); }}
        className="h-8 w-32 rounded-md border border-slate-200 px-2 text-xs" />
      <div className="flex flex-wrap gap-1" aria-label={`Color for ${label.name}`}>
        {Object.keys(TONES).map((color) => <button key={color} type="button" aria-label={`${label.name} color ${color}`} aria-pressed={label.color === color} onClick={() => onUpdate(label, { color })}
          className={`h-4 w-4 rounded-full ${TONES[color].dot} ${label.color === color ? "ring-2 ring-slate-900 ring-offset-1" : ""}`} />)}
      </div>
      <button type="button" onClick={() => onUpdate(label, { archived: !label.archived })} className={`${BTN.ghost} h-7 text-xs`}><Archive size={13} aria-hidden />{label.archived ? "Restore" : "Archive"}</button>
    </div>)}
  </div>;
}

export default function ChatReasonsDashboard({ store, query, revision, labels, canManage, onLabelUpdate, onOpenRequest, onClearSearch }) {
  const [period, setPeriod] = useState("7");
  const [range, setRange] = useState(null);
  const [dates, setDates] = useState({ start: "", end: "" });
  const [dateBasis, setDateBasis] = useState("created");
  const [agent, setAgent] = useState("");
  const [outcome, setOutcome] = useState("");
  const [reason, setReason] = useState("");
  const [showRequests, setShowRequests] = useState(false);
  const [managing, setManaging] = useState(false);
  const [choices, setChoices] = useState({ agents: [], labels: [] });
  const requestSection = useRef(null);
  const jumpToRequests = useRef(false);

  const params = new URLSearchParams({ store, date_basis: dateBasis });
  if (range) { params.set("start_date", range.start); params.set("end_date", range.end); }
  else if (period === "yesterday") params.set("yesterday", "true");
  else params.set("days", period === "custom" ? "7" : period);
  for (const [name, value] of Object.entries({ agent, outcome, reason, q: query })) if (value) params.set(name, value);
  const key = params.toString();
  const { data, error, pending, retry } = useAnalytics(key, revision, labels);
  useEffect(() => {
    if (data) setChoices({ agents: data.agents, labels: data.labels });
  }, [data]);
  useEffect(() => {
    if (data && showRequests && jumpToRequests.current && requestSection.current) {
      jumpToRequests.current = false;
      requestSection.current.scrollIntoView({ block: "nearest" });
    }
  }, [data, showRequests]);

  function pickPeriod(value) {
    if (value === "custom") {
      setDates(range || { start: data?.start_date || "", end: data?.end_date || "" });
      if (data) setRange({ start: data.start_date, end: data.end_date });
    } else setRange(null);
    setPeriod(value);
  }
  function applyRange(start, end) {
    setRange({ start, end });
    setDates({ start, end });
    setPeriod("custom");
  }
  function clear() {
    setAgent(""); setOutcome(""); setReason(""); setDateBasis("created");
    setPeriod("7"); setRange(null); setShowRequests(false); onClearSearch();
  }
  function inspect(nextOutcome = "", nextReason = "") {
    setOutcome(nextOutcome);
    setReason(nextReason);
    openRequests();
  }
  function openRequests() {
    if (requestSection.current) requestSection.current.scrollIntoView({ block: "nearest" });
    else jumpToRequests.current = true;
    setShowRequests(true);
  }

  const current = data?.outcomes;
  const lost = current ? lostCount(current) : 0;
  const reasonChoices = data?.labels || choices.labels;
  const agentChoices = data?.agents || choices.agents;
  const selectedAgent = agentChoices.find((item) => item.id === agent);
  const selectedReason = reasonChoices.find((item) => String(item.id) === reason);
  const datesValid = dates.start && dates.end && dates.start <= dates.end;

  return <div className="space-y-4">
    <section className={`${CARD} overflow-hidden`}>
      <div className="bg-gradient-to-r from-slate-950 via-indigo-950 to-indigo-800 px-4 py-5 text-white sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-indigo-200"><BarChart3 size={15} aria-hidden /> Chat confirmation</p>
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">Request analytics</h2>
            <p className="mt-1 text-sm text-indigo-100">Track daily volume, outcomes, and why customers drop off.</p>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2.5 text-xs font-medium ring-1 ring-white/15">
            <CalendarDays size={16} aria-hidden /> {data ? dateSpan(data.start_date, data.end_date) : PRESETS.find(([value]) => value === period)?.[1]}
          </div>
        </div>
      </div>
      <div className="space-y-4 p-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1" aria-label="Reporting period">
            {PRESETS.map(([value, title]) => <button key={value} type="button" onClick={() => pickPeriod(value)} aria-pressed={period === value}
              className={`rounded-lg px-2.5 py-2 text-xs font-semibold transition ${period === value ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"}`}>{title}</button>)}
          </div>
          <button type="button" onClick={clear} className={`${BTN.ghost} h-9 text-xs`}><RotateCcw size={14} aria-hidden />Reset filters</button>
        </div>
        {period === "custom" && <form onSubmit={(event) => { event.preventDefault(); if (datesValid) applyRange(dates.start, dates.end); }} className="grid items-end gap-2 rounded-xl bg-indigo-50/70 p-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="min-w-0 text-xs font-semibold text-slate-700">Start date<input required type="date" className={CONTROL} value={dates.start} max={dates.end || data?.today} onChange={(event) => setDates({ ...dates, start: event.target.value })} /></label>
          <label className="min-w-0 text-xs font-semibold text-slate-700">End date<input required type="date" className={CONTROL} value={dates.end} min={dates.start || undefined} max={data?.today} onChange={(event) => setDates({ ...dates, end: event.target.value })} /></label>
          <button type="submit" disabled={!datesValid} className="h-10 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">Apply dates</button>
        </form>}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Filter label="Date basis" value={dateBasis} onChange={(value) => { setDateBasis(value); if (value === "closed" && outcome === "open") setOutcome(""); }}>
            <option value="created">Request date</option><option value="closed">Closing date</option>
          </Filter>
          <Filter label="Agent" value={agent} onChange={setAgent}>
            <option value="">All agents</option>
            {!agentChoices.some((item) => item.id === "unassigned") && <option value="unassigned">No agent</option>}
            {agentChoices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            {agent && agent !== "unassigned" && !selectedAgent && <option value={agent}>Selected agent</option>}
          </Filter>
          <Filter label="Outcome" value={outcome} onChange={setOutcome}>
            {OUTCOMES.filter(([value]) => value !== "open" || dateBasis !== "closed").map(([value, title]) => <option key={value} value={value}>{title}</option>)}
          </Filter>
          <Filter label="Reason" value={reason} onChange={setReason}>
            <option value="">All reasons</option><option value="unlabelled">Without a reason</option>
            {reasonChoices.map((item) => <option key={item.id} value={item.id}>{item.name}{item.archived ? " (archived)" : ""}</option>)}
            {reason && reason !== "unlabelled" && !selectedReason && <option value={reason}>Selected reason</option>}
          </Filter>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs leading-5 text-slate-500">{data?.timezone || "Africa/Casablanca"} · {dateBasis === "closed" ? "Requests closed in this period" : "Current outcomes of requests received in this period"}{query ? ` · Search “${query}”` : ""}</p>
          {!showRequests && <button type="button" onClick={openRequests} className={`${BTN.secondary} h-9 text-xs`}>View matching requests <ArrowRight size={14} aria-hidden /></button>}
        </div>
      </div>
    </section>

    {pending && <div role="status" className={`${CARD} flex items-center gap-2 p-5 text-sm text-slate-500`}><Spinner className="h-4 w-4" /> Loading analytics…</div>}
    {error && <LoadError error={error} onRetry={retry} />}
    {data && <div className="space-y-4">
      {!data.total && <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">No requests match this period and filters.</p>}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat icon={Inbox} tone="indigo" label="Requests" value={data.total} hint={`${data.days} ${data.days === 1 ? "day" : "days"} selected`} onClick={openRequests} />
        <Stat icon={ShoppingBag} tone="emerald" label="Ordered" value={current.ordered} hint={`${percent(current.ordered, data.total)} of requests`} onClick={() => inspect("ordered", reason)} />
        <Stat icon={Clock3} tone="amber" label="Still open" value={current.open} hint={dateBasis === "closed" ? "Available by request date" : "New, calling, or awaiting follow-up"} onClick={dateBasis === "created" ? () => inspect("open", reason) : undefined} />
        <Stat icon={Ban} tone="rose" label="Lost" value={lost} hint={`${current.cancelled} cancelled · ${current.wrong_number} wrong number`} onClick={() => inspect("lost", reason)} />
      </div>
      {showRequests && <div ref={requestSection} className="scroll-mt-24"><RequestList key={key} params={key} revision={revision} labels={labels} onOpenRequest={onOpenRequest} onClose={() => setShowRequests(false)} /></div>}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Trend daily={data.daily} dateBasis={dateBasis} onPick={applyRange} />
        <section className={`${CARD} min-w-0 p-4 sm:p-5`}>
          <h3 className="font-semibold text-slate-900">Outcome breakdown</h3>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
            {[["not_interested", "Not interested"], ["wrong_number", "Wrong number"], ["cancelled", "Cancelled"]].map(([value, title]) => <button type="button" key={value} onClick={() => inspect(value, reason)} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-left text-xs text-slate-600 hover:bg-indigo-50">
              {title}<strong className="tabular-nums text-slate-900">{count.format(current[value])}</strong>
            </button>)}
          </div>
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold text-slate-700">Reason coverage</span><strong className="text-indigo-700">{percent(data.labelled, data.total)}</strong></div>
            <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-100"><span className="rounded-full bg-indigo-500" style={{ width: `${share(data.labelled, data.total)}%` }} /></div>
            <p className="mt-2 text-xs text-slate-500">{count.format(data.labelled)} of {count.format(data.total)} requests have a reason.</p>
            <button type="button" onClick={() => inspect("lost", "unlabelled")} className="mt-3 flex w-full items-center justify-between gap-2 rounded-lg bg-amber-50 p-2.5 text-left text-xs font-semibold text-amber-900 hover:bg-amber-100">
              <span>{count.format(data.lost_without_label)} lost without a reason</span><ArrowRight size={14} className="shrink-0" aria-hidden />
            </button>
          </div>
        </section>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <section className={`${CARD} min-w-0 p-4 sm:p-5`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-semibold text-slate-900"><Tag size={16} className="text-indigo-500" aria-hidden />Reasons</h3>
            {canManage && <button type="button" aria-expanded={managing} onClick={() => setManaging(!managing)} className={`${BTN.secondary} h-9 text-xs`}>{managing ? "Done" : "Manage labels"}</button>}
          </div>
          <p className="mt-1 text-xs text-slate-500">Ranked by lost requests. A request can have more than one reason.</p>
          {managing && canManage && <LabelSettings labels={data.labels} onUpdate={onLabelUpdate} />}
          <ul className="mt-3 divide-y divide-slate-100">
            {data.labels.filter((item) => item.total > 0).map((item) => <li key={item.id}>
              <button type="button" onClick={() => inspect(outcome, String(item.id))} className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 rounded-lg p-2.5 text-left hover:bg-slate-50">
                <span className={`w-fit max-w-full truncate rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${(TONES[item.color] || TONES.slate).soft}`}>{item.name}{item.archived ? " · archived" : ""}</span>
                <span className="text-xs tabular-nums text-slate-500"><strong className="text-slate-900">{count.format(item.total)}</strong> · {count.format(item.lost)} lost</span>
                <span className="col-span-2 flex h-1.5 overflow-hidden rounded-full bg-slate-100" aria-label={`${item.ordered} ordered, ${item.open} open, ${item.lost} lost`}><Stack values={item} total={item.total} /></span>
              </button>
            </li>)}
          </ul>
          {!data.labelled && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-500">No reason labels on the matching requests.</p>}
        </section>
        <section className={`${CARD} min-w-0 p-4 sm:p-5`}>
          <h3 className="flex items-center gap-2 font-semibold text-slate-900"><Users size={16} className="text-indigo-500" aria-hidden />By agent</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">Open requests use the current assignee. Closed requests use the agent who closed them. Automated outcomes appear under No agent.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[340px] text-left text-xs">
              <thead className="bg-slate-50 text-slate-600"><tr><th className="rounded-l-lg p-2">Agent</th><th className="p-2 text-right">Requests</th><th className="p-2 text-right">Ordered</th><th className="rounded-r-lg p-2 text-right">Lost</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.agents.map((item) => <tr key={item.id} className={item.id === agent ? "bg-indigo-50" : ""}>
                  <td className="py-2 pl-2"><button type="button" onClick={() => setAgent(agent === item.id ? "" : item.id)} aria-pressed={agent === item.id} className="flex items-center gap-2 text-left font-semibold text-slate-800 hover:text-indigo-700">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-indigo-100 text-indigo-700">{initialOf(item.name)}</span>{item.name}
                  </button></td>
                  <td className="px-2 text-right tabular-nums text-slate-700">{count.format(item.total)}</td>
                  <td className="px-2 text-right tabular-nums text-emerald-700">{count.format(item.outcomes.ordered)} <span className="text-slate-500">({percent(item.outcomes.ordered, item.total)})</span></td>
                  <td className="px-2 text-right tabular-nums text-rose-700">{count.format(lostCount(item.outcomes))}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {!data.agents.length && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-500">No agent activity matches this view.</p>}
        </section>
      </div>
    </div>}
  </div>;
}
