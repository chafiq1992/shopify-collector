import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, FilePenLine, Package, Plus, Save, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { authFetch } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import ConfirmationProductResults from "../components/ConfirmationProductResults";
import useConfirmationProductSearch, { PRODUCT_SEARCH_PLACEHOLDER } from "../lib/useConfirmationProductSearch";
import { BTN, CARD, Spinner, TopBar } from "../components/ConfirmationUi";
import { DRAFT_STATUSES, draftChanges, draftEditor, draftListParams, draftValidation, pendingDraftKey, readDraftCompletion, draftStockWarning } from "../lib/confirmationDrafts";

const INPUT = "min-w-0 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-600";
const API_ROOT = "/api/agent/draft-orders";

async function request(path, options = {}) {
  const res = await authFetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    const message = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((item) => item.msg || "Invalid details").join("; ") : detail?.message;
    const error = new Error(message || `Request failed (${res.status})`);
    error.status = res.status; error.detail = detail;
    throw error;
  }
  return data;
}
const post = (path, body) => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function money(value, currency) {
  if (value == null || value === "") return "—";
  return `${Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value} ${currency || ""}`;
}
function date(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function Status({ value }) {
  const label = DRAFT_STATUSES.find(([key]) => key === value)?.[1] || value || "Open";
  const tone = value === "COMPLETED" ? "bg-slate-100 text-slate-700" : value === "INVOICE_SENT" ? "bg-sky-100 text-sky-800" : "bg-amber-100 text-amber-900";
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{label}</span>;
}
function ErrorBox({ children }) {
  return <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><CircleAlert size={17} className="mt-0.5 shrink-0" /><div className="min-w-0 break-words">{children}</div></div>;
}
function Field({ label, children, ...props }) {
  return <label className="block min-w-0 text-xs font-medium text-slate-600"><span className="mb-1 block">{label}</span>{children || <input {...props} className={INPUT} />}</label>;
}
function Section({ title, action, children, className = "" }) {
  return <section className={`${CARD} min-w-0 p-4 sm:p-5 ${className}`}><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-slate-900">{title}</h2>{action}</div>{children}</section>;
}
function AddressFields({ value, onChange, disabled, label }) {
  const fields = [["first_name", "First name"], ["last_name", "Last name"], ["company", "Company"], ["address1", "Address"], ["address2", "Apartment / delivery details"], ["city", "City"], ["province", "Province / region"], ["zip", "Postal code"], ["country", "Country"], ["phone", "Phone"]];
  return <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">{fields.map(([key, title]) => <Field key={key} label={title} aria-label={`${label} ${title.toLowerCase()}`} value={value[key]} disabled={disabled} onChange={(event) => onChange({ ...value, [key]: event.target.value })} />)}</div>;
}

function detailFromLocation(store) {
  const params = new URLSearchParams(window.location.search);
  return params.get("draft_store") === store ? params.get("draft_id") || null : null;
}
function detailLocation(store, id) {
  const url = new URL(window.location.href);
  if (id) { url.searchParams.set("draft_id", id); url.searchParams.set("draft_store", store); }
  else { url.searchParams.delete("draft_id"); url.searchParams.delete("draft_store"); }
  window.history.replaceState(window.history.state, "", url);
}

export default function ConfirmationDrafts({ me, store, setStore, view = "drafts", onViewChange, chatBadge, onInventory, onOrderCompleted }) {
  const [selectedId, setSelectedId] = useState(() => detailFromLocation(store));
  const [filters, setFilters] = useState({ q: "", status: "", date_from: "", date_to: "", tag: "", sort_key: "UPDATED_AT", reverse: true });
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [cursor, setCursor] = useState({});
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ drafts: [], page_info: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const detailGuard = useRef(() => true);

  const changeFilter = useCallback((patch) => { setFilters((current) => ({ ...current, ...patch })); setCursor({}); setPage(1); }, []);
  useEffect(() => { const timer = setTimeout(() => changeFilter({ q: query.trim() }), 300); return () => clearTimeout(timer); }, [query, changeFilter]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setResult({ drafts: [], page_info: {} });
    if (filters.date_from && filters.date_to && filters.date_from > filters.date_to) { setError("The start date must be on or before the end date."); setLoading(false); return () => controller.abort(); }
    request(`${API_ROOT}?${draftListParams({ store, ...filters, ...cursor })}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { setResult(data); setLastLoadedAt(Date.now()); } })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [store, filters, cursor, refresh]);

  const open = (id) => { setSelectedId(id); detailLocation(store, id); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const close = () => { if (detailGuard.current()) { setSelectedId(null); detailLocation(store, null); setRefresh((n) => n + 1); } };
  const guarded = (callback) => (...args) => { if (detailGuard.current()) callback?.(...args); };
  const sort = (key) => changeFilter({ sort_key: key, reverse: filters.sort_key === key ? !filters.reverse : false });
  const sortHeading = (label, key) => <th scope="col" aria-sort={filters.sort_key === key ? filters.reverse ? "descending" : "ascending" : "none"} className="px-4 py-3 text-left"><button type="button" onClick={() => sort(key)} className="inline-flex items-center gap-1.5 font-semibold hover:text-indigo-700">{label}{filters.sort_key === key && (filters.reverse ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}</button></th>;
  const activeFilter = Boolean(filters.q || filters.status || filters.date_from || filters.date_to || filters.tag);

  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <TopBar me={me} store={store} loading={loading} lastLoadedAt={lastLoadedAt} onRefresh={() => setRefresh((n) => n + 1)} onInventory={guarded(onInventory)} view={view} onViewChange={guarded(onViewChange)} chatBadge={chatBadge} />
    <main className="mx-auto max-w-[1600px] px-3 py-5 sm:px-5 lg:px-8">
      {selectedId ? <DraftDetail key={`${store}:${selectedId}`} id={selectedId} store={store} me={me} onBack={close} guardRef={detailGuard} refresh={refresh} onOrderCompleted={onOrderCompleted} /> : <>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h1 className="flex items-center gap-2 text-xl font-semibold"><FilePenLine size={22} className="text-indigo-600" />Draft orders</h1><p className="mt-1 text-sm text-slate-500">Review, edit and complete Shopify drafts as unpaid cash-on-delivery orders.</p></div><div className="flex items-center gap-2"><span className="text-xs font-medium text-slate-500">Store</span><StorePicker value={store} onChange={guarded(setStore)} allowCustom={false} /></div></div>
        <section className={`${CARD} overflow-hidden`} aria-label="Draft orders">
          <div className="flex flex-wrap gap-1 border-b border-slate-200 p-3" role="tablist" aria-label="Draft status">{DRAFT_STATUSES.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={filters.status === key} onClick={() => changeFilter({ status: key })} className={`rounded-lg px-3 py-2 text-sm font-medium ${filters.status === key ? "bg-indigo-50 text-indigo-800" : "text-slate-600 hover:bg-slate-50"}`}>{label}</button>)}</div>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
            <label className="relative min-w-[190px] flex-1"><Search size={17} className="absolute left-3 top-3 text-slate-400" /><span className="sr-only">Search draft orders</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search draft number, customer, phone, or email" className={`${INPUT} !pl-10`} /></label>
            <button type="button" className={`${BTN.secondary} h-10`} onClick={() => setShowFilters((value) => !value)} aria-expanded={showFilters}><SlidersHorizontal size={15} />Filters</button>
            <label className="flex items-center gap-2 text-xs text-slate-500">Sort<select aria-label="Sort drafts" className={`${INPUT} !w-auto`} value={`${filters.sort_key}:${filters.reverse}`} onChange={(event) => { const [sort_key, reverse] = event.target.value.split(":"); changeFilter({ sort_key, reverse: reverse === "true" }); }}>
              <option value="UPDATED_AT:true">Updated, newest first</option><option value="UPDATED_AT:false">Updated, oldest first</option><option value="NUMBER:true">Draft number, descending</option><option value="NUMBER:false">Draft number, ascending</option><option value="CUSTOMER_NAME:false">Customer, A–Z</option><option value="CUSTOMER_NAME:true">Customer, Z–A</option><option value="TOTAL_PRICE:true">Total, highest first</option><option value="TOTAL_PRICE:false">Total, lowest first</option><option value="STATUS:false">Status, ascending</option><option value="STATUS:true">Status, descending</option>
            </select></label>
          </div>
          {showFilters && <div className="grid gap-3 border-b border-slate-200 bg-slate-50/70 p-4 sm:grid-cols-2 lg:grid-cols-4"><Field label="Created from" type="date" value={filters.date_from} onChange={(event) => changeFilter({ date_from: event.target.value })} /><Field label="Created through" type="date" value={filters.date_to} onChange={(event) => changeFilter({ date_to: event.target.value })} /><Field label="Tag" value={filters.tag} placeholder="Exact tag" onChange={(event) => changeFilter({ tag: event.target.value })} /><div className="flex items-end"><button type="button" disabled={!activeFilter} onClick={() => { setQuery(""); changeFilter({ q: "", status: "", date_from: "", date_to: "", tag: "" }); }} className={`${BTN.secondary} h-10`}>Clear filters</button></div></div>}
          {activeFilter && <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-xs text-slate-600"><span>Filtered results</span>{filters.status && <span className="rounded bg-slate-100 px-2 py-1">{DRAFT_STATUSES.find(([key]) => key === filters.status)?.[1]}</span>}{filters.date_from && <span>From {filters.date_from}</span>}{filters.date_to && <span>Through {filters.date_to}</span>}{filters.tag && <span>Tag: {filters.tag}</span>}<button type="button" className="ml-auto inline-flex items-center gap-1 font-semibold text-indigo-700" onClick={() => { setQuery(""); changeFilter({ q: "", status: "", date_from: "", date_to: "", tag: "" }); }}><X size={13} />Clear all</button></div>}
          {error && <div className="p-4"><ErrorBox>{error} <button type="button" className="ml-2 underline" onClick={() => setRefresh((n) => n + 1)}>Retry</button></ErrorBox></div>}
          <div className="overflow-x-auto"><table className="w-full min-w-[780px] border-collapse text-sm"><caption className="sr-only">Shopify draft orders for {store}. Select a draft number to edit.</caption><thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600"><tr>{sortHeading("Draft order", "NUMBER")}<th scope="col" className="px-4 py-3 text-left font-semibold">PO number</th>{sortHeading("Last updated", "UPDATED_AT")}{sortHeading("Customer", "CUSTOMER_NAME")}{sortHeading("Status", "STATUS")}{sortHeading("Total", "TOTAL_PRICE")}</tr></thead><tbody className="divide-y divide-slate-100">
            {loading ? <tr><td colSpan={6} className="px-4 py-14 text-center text-slate-500"><span className="inline-flex items-center gap-2"><Spinner />Loading drafts…</span></td></tr> : !error && !(result.drafts || []).length ? <tr><td colSpan={6} className="px-4 py-14 text-center text-slate-500">{activeFilter ? "No draft orders match these filters." : "No draft orders in this store."}</td></tr> : (result.drafts || []).map((draft) => <tr key={draft.id} className="cursor-pointer hover:bg-indigo-50/40" onClick={(event) => { if (!event.target.closest("button,a,input")) open(draft.id); }}><td className="px-4 py-4"><button type="button" className="font-semibold text-indigo-700 hover:underline" onClick={() => open(draft.id)}>{draft.name || draft.id.split("/").pop()}</button></td><td className="px-4 py-4 text-slate-500">{draft.po_number || "—"}</td><td className="whitespace-nowrap px-4 py-4 text-xs text-slate-600">{date(draft.updated_at)}<span className="mt-1 block text-[11px] text-slate-400">Created {date(draft.created_at)}</span></td><td className="px-4 py-4"><span className="font-medium">{draft.customer?.name || [draft.shipping_address?.first_name, draft.shipping_address?.last_name].filter(Boolean).join(" ") || "No customer"}</span><span className="mt-1 block text-xs text-slate-500">{draft.email || draft.phone || ""}</span></td><td className="px-4 py-4"><Status value={draft.status} /></td><td className="whitespace-nowrap px-4 py-4 text-right font-medium tabular-nums">{money(draft.total_price, draft.currency || result.currency)}</td></tr>)}
          </tbody></table></div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-500"><span>Page {page}{!loading && ` · ${(result.drafts || []).length} drafts`}</span><div className="flex items-center gap-2"><button type="button" aria-label="Previous page of drafts" className={`${BTN.secondary} h-9`} disabled={loading || !result.page_info?.has_previous_page || !result.page_info?.start_cursor} onClick={() => { setCursor({ before: result.page_info.start_cursor }); setPage((value) => Math.max(1, value - 1)); }}><ChevronLeft size={15} />Previous</button><button type="button" aria-label="Next page of drafts" className={`${BTN.secondary} h-9`} disabled={loading || !result.page_info?.has_next_page || !result.page_info?.end_cursor} onClick={() => { setCursor({ after: result.page_info.end_cursor }); setPage((value) => value + 1); }}>Next<ChevronRight size={15} /></button></div></div>
        </section>
      </>}
    </main>
  </div>;
}

function DraftDetail({ id, store, me, onBack, guardRef, refresh, onOrderCompleted }) {
  const [draft, setDraft] = useState(null);
  const [editor, setEditor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [productOpen, setProductOpen] = useState(false);
  const [productQuery, setProductQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ title: "", unit_price: "", quantity: 1 });
  const [newTag, setNewTag] = useState("");
  const [editShipping, setEditShipping] = useState(false);
  const [editBilling, setEditBilling] = useState(false);
  const [editDiscount, setEditDiscount] = useState(false);
  const pendingKey = pendingDraftKey(me?.id, store, id);
  const [pending, setPending] = useState(() => readDraftCompletion(sessionStorage, pendingKey, store, id));
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const loadedRefresh = useRef(refresh);
  const dirty = Boolean(draft && editor && Object.keys(draftChanges(draft, editor)).length);
  const completed = draft?.status === "COMPLETED";
  const locked = completed || busy || Boolean(pending);
  const validation = editor ? draftValidation(editor) : "";
  const productSearch = useConfirmationProductSearch(store, productQuery, { enabled: productOpen && !locked });
  const { variants: products, loading: productBusy, error: productError } = productSearch;

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    guardRef.current = () => !submittingRef.current && (!dirty || window.confirm("You have unsaved draft changes. Discard them and leave this draft?"));
    const beforeUnload = (event) => { if (dirty || submittingRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { guardRef.current = () => true; window.removeEventListener("beforeunload", beforeUnload); };
  }, [dirty, guardRef]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    request(`${API_ROOT}/detail?${new URLSearchParams({ store, draft_id: id })}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { setDraft(data.draft); setEditor(draftEditor(data.draft)); } })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, store, reload]);
  useEffect(() => {
    if (loadedRefresh.current === refresh) return;
    loadedRefresh.current = refresh;
    if (submittingRef.current) return;
    if (dirty && !window.confirm("Refreshing will discard your unsaved changes. Continue?")) return;
    setReload((n) => n + 1);
  }, [refresh, dirty]);

  function patch(value) { setEditor((current) => ({ ...current, ...value })); setMessage(""); setCompletionOpen(false); }
  function patchItem(index, value) { patch({ line_items: editor.line_items.map((item, at) => at === index ? { ...item, ...value } : item) }); }
  function addProduct(variant) {
    const existing = editor.line_items.findIndex((item) => item.variant_id === variant.id && item.is_new);
    if (existing >= 0) patchItem(existing, { quantity: Math.min(999, editor.line_items[existing].quantity + 1) });
    else patch({ line_items: [...editor.line_items, { is_new: true, variant_id: variant.id, title: variant.product_title, variant_title: variant.variant_title, sku: variant.sku, image: variant.image, unit_price: variant.price, quantity: 1, inventory_tracked: variant.inventory_tracked, inventory_quantity: variant.inventory_quantity, available_quantity: variant.available_quantity }] });
  }
  function addCustom(event) {
    event.preventDefault();
    patch({ line_items: [...editor.line_items, { ...custom, title: custom.title.trim(), quantity: Number(custom.quantity), is_new: true, custom: true }] });
    setCustom({ title: "", unit_price: "", quantity: 1 }); setCustomOpen(false);
  }
  function forgetPending() { setPending(null); try { sessionStorage.removeItem(pendingKey); } catch {} }
  async function save() {
    if (submittingRef.current || locked || !dirty || validation) return;
    submittingRef.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const data = await post(`${API_ROOT}/update`, { store, draft_id: id, expected_updated_at: draft.updated_at, changes: draftChanges(draft, editor) });
      if (!mountedRef.current) return;
      setDraft(data.draft); setEditor(draftEditor(data.draft)); setMessage("Draft saved. Totals updated by Shopify.");
      // The list reloads when the detail closes; keep this draft in place after saving.
    } catch (err) { if (mountedRef.current) setError(err.message); }
    finally { submittingRef.current = false; if (mountedRef.current) setBusy(false); }
  }
  async function complete() {
    if (submittingRef.current || (!pending && (dirty || validation || completed))) return;
    submittingRef.current = true; setBusy(true); setError(""); setMessage("");
    const payload = pending || { store, draft_id: id, expected_updated_at: draft.updated_at, client_action_id: globalThis.crypto?.randomUUID?.() || `draft-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    setPending(payload);
    try { sessionStorage.setItem(pendingKey, JSON.stringify(payload)); } catch {}
    try {
      const data = await post(`${API_ROOT}/complete`, payload);
      try { sessionStorage.removeItem(pendingKey); } catch {}
      if (!mountedRef.current) return;
      setPending(null); setCompletionOpen(false); setDraft({ ...data.draft, order: data.order || data.draft?.order }); setEditor(draftEditor(data.draft)); setMessage("Order created with payment pending for cash on delivery.");
    } catch (err) {
      if (!mountedRef.current) return;
      if ([400, 401, 403, 422, 429].includes(err.status) || err.detail?.safe_to_edit === true) forgetPending();
      setError(err.message);
    } finally { submittingRef.current = false; if (mountedRef.current) setBusy(false); }
  }

  if (loading) return <div className="py-12 text-center text-sm text-slate-500"><Spinner className="mx-auto mb-3 h-6 w-6" />Loading draft…</div>;
  if (!draft || !editor) return <div className="space-y-4"><button type="button" className={`${BTN.secondary} h-10`} onClick={onBack}><ArrowLeft size={15} />Drafts</button><ErrorBox>{error || "Draft not found."} <button type="button" className="ml-2 underline" onClick={() => setReload((n) => n + 1)}>Retry</button></ErrorBox></div>;
  const savedOrder = draft.order;
  const itemEstimate = editor.line_items.reduce((sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 0), 0);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><button type="button" aria-label="Back to drafts" onClick={onBack} className={`${BTN.secondary} h-10 w-10 !px-0`}><ArrowLeft size={17} /></button><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{draft.name}</h1><Status value={draft.status} /></div><p className="mt-1 text-xs text-slate-500">Created {date(draft.created_at)} · Updated {date(draft.updated_at)}</p>{draft.po_number && <p className="mt-1 text-xs text-slate-500">PO number: {draft.po_number}</p>}</div></div><div className="flex flex-wrap items-center gap-2">{draft.invoice_url && <a href={draft.invoice_url} target="_blank" rel="noopener noreferrer" className={`${BTN.secondary} h-10`}><ExternalLink size={14} />View invoice</a>}{completed ? savedOrder && <button type="button" onClick={() => onOrderCompleted?.(savedOrder)} className={`${BTN.primary} h-10`}>View order {savedOrder.name || ""}<ChevronRight size={15} /></button> : <><button type="button" disabled={locked || !dirty || Boolean(validation)} onClick={save} className={`${BTN.secondary} h-10`}>{busy && !pending ? <Spinner /> : <Save size={15} />}Save changes</button><button type="button" disabled={busy || dirty || Boolean(validation)} onClick={() => setCompletionOpen((value) => !value)} className={`${BTN.primary} h-10`}><Check size={15} />{pending ? "Check completion" : "Complete order"}</button></>}</div></div>
    {error && <ErrorBox>{error}{!pending && <button type="button" className="ml-2 underline" disabled={busy} onClick={() => { if (!dirty || window.confirm("Reload and discard your unsaved changes?")) setReload((n) => n + 1); }}>Reload draft</button>}</ErrorBox>}
    {message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p>}
    {pending && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">A completion request needs checking.</p><p className="mt-1">This draft is locked while its result is uncertain. Retry checks the same request to avoid creating a duplicate.</p><button type="button" disabled={busy} onClick={complete} className={`${BTN.primary} mt-3 h-10`}>{busy ? <Spinner /> : <Check size={15} />}Retry same completion</button></div>}
    {completionOpen && !pending && !completed && <section className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4" aria-label="Complete draft order"><h2 className="text-sm font-semibold text-emerald-900">Create an unpaid cash-on-delivery order</h2><p className="mt-1 text-sm text-emerald-800">Complete {draft.name} at its saved Shopify total of <strong>{money(draft.total_price, draft.currency)}</strong>. Payment will remain pending. The order will be available for confirmation.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy || dirty || Boolean(validation)} className={`${BTN.primary} h-10`} onClick={complete}>{busy && <Spinner />}Create unpaid COD order</button><button type="button" disabled={busy} className={`${BTN.secondary} h-10`} onClick={() => setCompletionOpen(false)}>Keep draft</button></div></section>}
    {dirty && <p role="status" className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">You have unsaved changes. Save them to update Shopify totals before completing this draft.</p>}
    {validation && !completed && <p className="text-sm text-amber-800">{validation}</p>}
    <div className="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-5">
        <Section title="Products" action={!completed && <div className="flex flex-wrap gap-2"><button type="button" disabled={locked} onClick={() => setCustomOpen((value) => !value)} className={`${BTN.secondary} h-9 text-xs`}><Plus size={14} />Custom item</button><button type="button" disabled={locked} onClick={() => setProductOpen((value) => !value)} className={`${BTN.secondary} h-9 text-xs`}><Plus size={14} />Product</button></div>}>
          {productOpen && !completed && <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50/30 p-3"><Field label="Search products" type="search" value={productQuery} disabled={locked} placeholder={PRODUCT_SEARCH_PLACEHOLDER} onChange={(event) => setProductQuery(event.target.value)} />{productBusy && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-slate-500"><Spinner />Searching products…</p>}{productError && <p role="alert" className="mt-3 text-xs text-rose-700">{productError}</p>}{productQuery.trim().length >= 2 && !productBusy && !productError && !productSearch.hasNextPage && !products.length && <p className="mt-3 text-xs text-slate-500">No matching products.</p>}<ConfirmationProductResults variants={products} currency={draft.currency} disabled={locked || productBusy} onChoose={addProduct} searchState={productSearch} /></div>}
          {customOpen && !completed && <form onSubmit={addCustom} className="mb-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_110px_80px]"><Field label="Custom item title" required maxLength={255} disabled={locked} value={custom.title} onChange={(event) => setCustom({ ...custom, title: event.target.value })} /><Field label={`Price (${draft.currency})`} required min="0" step="0.01" type="number" disabled={locked} value={custom.unit_price} onChange={(event) => setCustom({ ...custom, unit_price: event.target.value })} /><Field label="Quantity" required min="1" max="999" step="1" type="number" disabled={locked} value={custom.quantity} onChange={(event) => setCustom({ ...custom, quantity: event.target.value })} /><div className="flex gap-2 sm:col-span-3"><button type="submit" disabled={locked || !custom.title.trim()} className={`${BTN.primary} h-9 text-xs`}>Add custom item</button><button type="button" className={`${BTN.ghost} h-9 text-xs`} onClick={() => setCustomOpen(false)}>Cancel</button></div></form>}
          {!editor.line_items.length && <p className="py-7 text-center text-sm text-slate-500">This draft has no products. Add a product or custom item.</p>}
          <div className="divide-y divide-slate-100">{editor.line_items.map((item, index) => <div key={item.id || `${item.variant_id || "custom"}:${index}`} className="flex min-w-0 flex-wrap items-start gap-3 py-4 first:pt-0 last:pb-0"><div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">{item.image ? <img src={item.image} alt={item.title} className="h-full w-full object-contain" /> : <Package size={24} className="text-slate-400" />}</div><div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold">{item.title}</p><p className="mt-1 text-xs text-indigo-700">{item.variant_title && item.variant_title !== "Default Title" ? item.variant_title : item.custom ? "Custom item" : "Default variant"}</p>{item.sku && <p className="mt-1 break-all text-xs text-slate-500">SKU {item.sku}</p>}<p className="mt-1 text-xs text-slate-600">{money(item.unit_price, draft.currency)} each</p>{draftStockWarning(item) && <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-100 px-2 py-1.5 text-xs font-medium text-amber-900"><CircleAlert size={13} className="shrink-0" />This variant has no available stock.</p>}{item.applied_discount && <p className="mt-1 text-xs text-emerald-700">Line discount preserved{item.applied_discount.title ? ` · ${item.applied_discount.title}` : ""}</p>}{item.is_new && <span className="mt-1 inline-block rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">Not saved yet</span>}</div><div className="ml-auto flex items-center gap-2"><Field label="Quantity"><input aria-label={`Quantity for ${item.title}`} type="number" min="1" max="999" step="1" value={item.quantity} disabled={locked} onChange={(event) => patchItem(index, { quantity: event.target.value })} className={`${INPUT} !w-20 text-center`} /></Field>{!completed && <button type="button" disabled={locked} aria-label={`Remove ${item.title}`} onClick={() => patch({ line_items: editor.line_items.filter((_, at) => at !== index) })} className="mt-4 rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"><Trash2 size={17} /></button>}</div></div>)}</div>
          {dirty && <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">Estimated products before discounts and tax: <strong className="text-slate-800">{money(itemEstimate, draft.currency)}</strong>. Save to calculate the final totals.</p>}
        </Section>
        <Section title="Payment" action={<span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">{completed ? "Completed draft" : "Cash on delivery · Unpaid"}</span>}>
          {dirty && <p className="mb-3 text-xs font-medium text-amber-800">Last saved Shopify totals. Unsaved edits are not included.</p>}
          <dl className="space-y-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-slate-600">Subtotal</dt><dd className="tabular-nums">{money(draft.subtotal_price, draft.currency)}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-600">Discount{!completed && <button type="button" disabled={locked} onClick={() => setEditDiscount((value) => !value)} className="ml-2 text-xs font-medium text-indigo-700 underline">Edit</button>}</dt><dd className="tabular-nums">−{money(draft.total_discount ?? "0", draft.currency)}</dd></div>
            {editDiscount && !completed && <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3"><label className="flex items-center gap-2 text-xs font-medium"><input type="checkbox" checked={Boolean(editor.applied_discount)} disabled={locked} onChange={(event) => patch({ applied_discount: event.target.checked ? { title: "Discount", value: "0", value_type: "FIXED_AMOUNT" } : null })} />Apply an order discount</label>{editor.applied_discount && <div className="grid gap-3 sm:grid-cols-3"><Field label="Discount label" value={editor.applied_discount.title} disabled={locked} onChange={(event) => patch({ applied_discount: { ...editor.applied_discount, title: event.target.value } })} /><Field label="Discount type"><select className={INPUT} disabled={locked} value={editor.applied_discount.value_type} onChange={(event) => patch({ applied_discount: { ...editor.applied_discount, value_type: event.target.value } })}><option value="FIXED_AMOUNT">Amount ({draft.currency})</option><option value="PERCENTAGE">Percentage</option></select></Field><Field label="Discount value" type="number" min="0" max={editor.applied_discount.value_type === "PERCENTAGE" ? 100 : undefined} step="0.01" disabled={locked} value={editor.applied_discount.value} onChange={(event) => patch({ applied_discount: { ...editor.applied_discount, value: event.target.value } })} /></div>}</div>}
            <div className="flex justify-between gap-3"><dt className="text-slate-600">Shipping / delivery{!completed && <button type="button" disabled={locked} onClick={() => setEditShipping((value) => !value)} className="ml-2 text-xs font-medium text-indigo-700 underline">Edit fee</button>}</dt><dd className="tabular-nums">{money(draft.total_shipping ?? "0", draft.currency)}</dd></div>{editShipping && !completed && <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2"><Field label="Delivery method" disabled={locked} value={editor.shipping_line.title} onChange={(event) => patch({ shipping_line: { ...editor.shipping_line, title: event.target.value } })} /><Field label={`Delivery fee (${draft.currency})`} disabled={locked} type="number" min="0" step="0.01" value={editor.shipping_line.price} onChange={(event) => patch({ shipping_line: { ...editor.shipping_line, price: event.target.value } })} /></div>}
            <div className="flex justify-between gap-3"><dt className="text-slate-600">Tax</dt><dd className="tabular-nums">{money(draft.total_tax, draft.currency)}</dd></div><div className="flex justify-between gap-3 border-t border-slate-200 pt-4 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{money(draft.total_price, draft.currency)}</dd></div></dl>
          <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">{completed ? "This draft has been completed. Open the resulting order to view its current confirmation and payment status." : "Shopify calculates saved totals. Completing this draft creates an order with payment pending for cash on delivery."}</p>
        </Section>
      </div>
      <aside className="min-w-0 space-y-5">
        <Section title="Notes"><Field label="Order note"><textarea rows={5} maxLength={2000} className={INPUT} disabled={locked} value={editor.note} onChange={(event) => patch({ note: event.target.value })} /></Field></Section>
        <Section title="Customer"><p className="mb-1 break-words text-sm font-semibold">{draft.customer?.name || [editor.shipping_address.first_name, editor.shipping_address.last_name].filter(Boolean).join(" ") || "No customer assigned"}</p>{draft.customer?.orders_count != null && <p className="mb-4 text-xs text-slate-500">{draft.customer.orders_count} order{draft.customer.orders_count === 1 ? "" : "s"}</p>}<div className="space-y-3"><Field label="Email" type="email" disabled={locked} value={editor.email} onChange={(event) => patch({ email: event.target.value })} /><Field label="Phone" type="tel" disabled={locked} value={editor.phone} onChange={(event) => patch({ phone: event.target.value })} /></div></Section>
        <Section title="Shipping address"><AddressFields label="Shipping" value={editor.shipping_address} disabled={locked} onChange={(shipping_address) => patch({ shipping_address })} /></Section>
        <Section title="Billing address" action={!completed && <button type="button" disabled={locked} className="text-xs font-medium text-indigo-700" aria-expanded={editBilling} onClick={() => setEditBilling((value) => !value)}>{editBilling ? "Close" : "Edit"}</button>}>{editBilling && !completed ? <><button type="button" disabled={locked} className="mb-3 text-xs font-medium text-indigo-700 underline" onClick={() => patch({ billing_address: { ...editor.shipping_address } })}>Copy shipping address</button><AddressFields label="Billing" value={editor.billing_address} disabled={locked} onChange={(billing_address) => patch({ billing_address })} /></> : <p className="whitespace-pre-line text-sm leading-relaxed text-slate-600">{Object.values(editor.billing_address).some(Boolean) ? [[editor.billing_address.first_name, editor.billing_address.last_name].filter(Boolean).join(" "), editor.billing_address.company, editor.billing_address.address1, editor.billing_address.address2, [editor.billing_address.zip, editor.billing_address.city].filter(Boolean).join(" "), editor.billing_address.province, editor.billing_address.country, editor.billing_address.phone].filter(Boolean).join("\n") : "No separate billing address"}</p>}</Section>
        <Section title="Tags"><div className="flex flex-wrap gap-2">{editor.tags.map((tag) => <span key={tag} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700"><span className="break-words">{tag}</span>{!completed && <button type="button" disabled={locked} aria-label={`Remove tag ${tag}`} onClick={() => patch({ tags: editor.tags.filter((value) => value !== tag) })} className="rounded p-0.5 hover:bg-slate-200"><X size={12} /></button>}</span>)}{!editor.tags.length && <p className="text-xs text-slate-500">No tags</p>}</div>{!completed && <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); const tag = newTag.trim(); if (tag && !editor.tags.includes(tag)) patch({ tags: [...editor.tags, tag] }); setNewTag(""); }}><input aria-label="New draft tag" disabled={locked} className={INPUT} placeholder="Add a tag" value={newTag} onChange={(event) => setNewTag(event.target.value)} /><button type="submit" disabled={locked || !newTag.trim()} aria-label="Add tag" className={`${BTN.secondary} h-10 w-10 shrink-0 !px-0`}><Plus size={16} /></button></form>}</Section>
      </aside>
    </div>
    {!completed && <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur"><span className="text-xs text-slate-500">{pending ? "Completion result needs checking" : dirty ? "Unsaved changes" : "All changes saved"}</span><div className="flex gap-2"><button type="button" disabled={locked || !dirty || Boolean(validation)} onClick={save} className={`${BTN.secondary} h-10`}>Save changes</button><button type="button" disabled={busy || dirty || Boolean(validation)} onClick={() => { if (pending) complete(); else { setCompletionOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); } }} className={`${BTN.primary} h-10`}>{busy && <Spinner />}{pending ? "Retry same completion" : "Complete order"}</button></div></div>}
  </div>;
}
