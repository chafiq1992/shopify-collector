import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, ListOrdered, Package, Search, X } from "lucide-react";
import { authFetch } from "../lib/auth";
import StorePicker from "../components/StorePicker";
import TagInput from "../components/TagInput";
import { BTN, CARD, Spinner, TopBar } from "../components/ConfirmationUi";
import { useOrderTags } from "../lib/orderTags";
import { searchConfirmationProducts } from "../lib/useConfirmationProductSearch";
import {
  DATE_PRESETS, EMPTY_FILTERS, FULFILLMENT_OPTIONS, ORDER_VIEWS, PAYMENT_OPTIONS, SORT_OPTIONS, STATUS_OPTIONS,
  activeView, countLabel, filterChips, fulfillmentBadge, moneyLabel, orderDateLabel, orderListParams,
  paymentBadge, shopifyAdminOrderUrl, viewFilters,
} from "../lib/confirmationOrdersList";

const INPUT = "h-10 min-w-0 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";
const BADGE_TONES = { orange: "bg-orange-100 text-orange-900", yellow: "bg-yellow-100 text-yellow-900", gray: "bg-slate-100 text-slate-700" };

const savedKey = (store) => `confirmationOrdersList:${store}`;
function readSaved(store) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(savedKey(store)) || "null");
    if (!saved?.filters) return null;
    return { ...saved, filters: { ...EMPTY_FILTERS, ...saved.filters } };
  } catch { return null; }
}

async function fetchOrders(params, signal) {
  const res = await authFetch(`/api/agent/orders/list?${params}`, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    throw new Error(typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((item) => item.msg).join("; ") : `Could not load orders (${res.status})`);
  }
  return data;
}

// Closes a popover on an outside click or Escape. The event path is checked,
// not the target: choosing a suggestion removes that row before this runs.
function useDismiss(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (ref.current && !event.composedPath().includes(ref.current)) onClose(); };
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [ref, open, onClose]);
}

function Badge({ badge }) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[badge.tone] || BADGE_TONES.gray}`}><span className={`h-2 w-2 shrink-0 rounded-full ${badge.hollow ? "border-[1.5px] border-current" : "bg-current"}`} aria-hidden />{badge.label}</span>;
}

function FilterMenu({ id, label, count = 0, openId, setOpenId, wide = false, children }) {
  const ref = useRef(null);
  const open = openId === id;
  const close = useCallback(() => setOpenId((current) => (current === id ? null : current)), [id, setOpenId]);
  useDismiss(ref, open, close);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpenId(open ? null : id)}
        className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium transition ${count ? "border-indigo-300 bg-indigo-50 text-indigo-800" : "border-dashed border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50"}`}>
        {label}
        {count > 0 && <span className="min-w-[18px] rounded-full bg-indigo-600 px-1.5 text-center text-[10px] font-bold leading-4 text-white">{count}</span>}
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label={label} className={`z-40 rounded-xl border border-slate-200 bg-white p-3 shadow-xl max-sm:fixed max-sm:inset-x-3 max-sm:top-24 max-sm:max-h-[70vh] max-sm:overflow-y-auto sm:absolute sm:left-0 sm:top-full sm:mt-1.5 ${wide ? "sm:w-[22rem]" : "sm:w-64"}`}>
          {children}
        </div>
      )}
    </div>
  );
}

function CheckList({ options, value, onChange }) {
  return (
    <div className="space-y-0.5">
      {options.map(([key, text]) => (
        <label key={key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-50">
          <input type="checkbox" checked={value.includes(key)} onChange={(event) => onChange(event.target.checked ? [...value, key] : value.filter((item) => item !== key))} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
          {text}
        </label>
      ))}
    </div>
  );
}

function ClearLink({ disabled, onClick }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="mt-2 text-xs font-semibold text-indigo-700 hover:underline disabled:text-slate-300 disabled:no-underline">Clear</button>;
}

function ProductFilter({ store, filters, onChange }) {
  const [text, setText] = useState("");
  const [state, setState] = useState({ loading: false, products: [], error: "" });
  const typed = text.trim();
  useEffect(() => {
    if (typed.length < 2) { setState({ loading: false, products: [], error: "" }); return undefined; }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: "" }));
    const timer = setTimeout(() => {
      searchConfirmationProducts(store, typed, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) setState({ loading: false, products: (result.products || []).slice(0, 8), error: "" }); })
        .catch((error) => { if (!controller.signal.aborted) setState({ loading: false, products: [], error: error.message || "Product search failed" }); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [store, typed]);

  const choose = (product) => {
    if (!filters.products.some((item) => item.id === product.id)) onChange({ products: [...filters.products, { id: product.id, title: product.title }] });
    setText("");
  };
  const matchTitle = () => { if (typed.length >= 2) { onChange({ product_title: typed }); setText(""); } };
  const numeric = /^\d+$/.test(typed);
  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-600">Product title or ID
        <input type="search" value={text} autoFocus placeholder="e.g. high-top sneakers or 6682975567929" onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (numeric) choose({ id: `gid://shopify/Product/${typed}`, title: `ID ${typed}` }); else matchTitle();
          }} className={`${INPUT} mt-1`} />
      </label>
      {typed.length >= 2 && !numeric && (
        <button type="button" onClick={matchTitle} className="flex w-full items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-2 text-left text-xs font-medium text-indigo-900 hover:bg-indigo-100">
          <Search size={13} className="shrink-0" aria-hidden />All products with “{typed}” in the title
        </button>
      )}
      {state.loading && <p role="status" className="flex items-center gap-2 px-1 text-xs text-slate-500"><Spinner className="h-3.5 w-3.5" />Searching products…</p>}
      {state.error && <p role="alert" className="px-1 text-xs text-rose-700">{state.error}</p>}
      {state.products.length > 0 && (
        <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200" aria-label="Matching products">
          {state.products.map((product) => (
            <li key={product.id}>
              <button type="button" onClick={() => choose(product)} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-slate-50">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-white">
                  {product.image ? <img src={product.image} alt="" className="h-full w-full object-contain" /> : <Package size={15} className="text-slate-400" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1 text-xs font-medium text-slate-800"><span className="line-clamp-2">{product.title}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(filters.products.length > 0 || filters.product_title) && (
        <ul className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-2" aria-label="Chosen products">
          {filters.products.map((product) => (
            <li key={product.id} className="inline-flex max-w-full items-center gap-1 rounded-md bg-slate-100 py-1 pl-2 pr-1 text-xs font-medium text-slate-800">
              <span className="truncate">{product.title || product.id.split("/").pop()}</span>
              <button type="button" aria-label={`Remove product ${product.title}`} onClick={() => onChange({ products: filters.products.filter((item) => item.id !== product.id) })} className="rounded p-0.5 hover:bg-black/5"><X size={12} aria-hidden /></button>
            </li>
          ))}
          {filters.product_title && (
            <li className="inline-flex max-w-full items-center gap-1 rounded-md bg-slate-100 py-1 pl-2 pr-1 text-xs font-medium text-slate-800">
              <span className="truncate">Title: {filters.product_title}</span>
              <button type="button" aria-label="Remove product title filter" onClick={() => onChange({ product_title: "" })} className="rounded p-0.5 hover:bg-black/5"><X size={12} aria-hidden /></button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ItemsCell({ order }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const count = order.items_count;
  const more = Math.max(0, count - order.line_items.reduce((sum, item) => sum + item.quantity, 0));
  return (
    <div ref={ref} className="relative" onClick={(event) => event.stopPropagation()}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-sm text-slate-700 hover:bg-slate-100">
        {count} item{count === 1 ? "" : "s"}<ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          {order.line_items.length ? <ul className="space-y-1.5">
            {order.line_items.map((item, index) => (
              <li key={`${item.title}:${index}`} className="flex items-center gap-2.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-white">{item.image ? <img src={item.image} alt="" className="h-full w-full object-contain" /> : <Package size={15} className="text-slate-400" aria-hidden />}</span>
                <span className="min-w-0 flex-1 text-xs"><span className="line-clamp-2 font-medium text-slate-800">{item.title}</span>{item.variant_title && item.variant_title !== "Default Title" && <span className="text-slate-500">{item.variant_title}</span>}</span>
                <span className="text-xs font-semibold tabular-nums text-slate-700">×{item.quantity}</span>
              </li>
            ))}
          </ul> : <p className="px-1 py-2 text-xs text-slate-500">No remaining items.</p>}
          {more > 0 && <p className="mt-2 border-t border-slate-100 px-1 pt-2 text-[11px] text-slate-500">+{more} more item{more === 1 ? "" : "s"}. Open the order to see everything.</p>}
        </div>
      )}
    </div>
  );
}

function TagsCell({ tags, onTag, wrap = false }) {
  if (!tags.length) return <span className="text-xs text-slate-400">—</span>;
  const shown = tags.slice(0, wrap ? 6 : 2);
  return (
    <div className={`flex gap-1 ${wrap ? "flex-wrap" : "flex-nowrap"}`}>
      {shown.map((tag) => (
        <button key={tag} type="button" title={`Show orders tagged ${tag}`} onClick={(event) => { event.stopPropagation(); onTag(tag); }} className="max-w-[7rem] shrink-0 truncate whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 hover:bg-indigo-100 hover:text-indigo-900">{tag}</button>
      ))}
      {tags.length > shown.length && <span title={tags.slice(shown.length).join(", ")} className="shrink-0 whitespace-nowrap px-1 py-0.5 text-xs text-slate-500">+{tags.length - shown.length}</span>}
    </div>
  );
}

function OrderName({ order }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-semibold text-slate-900">{order.name}</span>
      {order.cancelled_at && <span className="rounded bg-slate-200 px-1.5 py-px text-[10px] font-semibold uppercase text-slate-600">Cancelled</span>}
      {!order.cancelled_at && order.closed && <span className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-semibold uppercase text-slate-500">Closed</span>}
    </span>
  );
}

export default function ConfirmationOrdersList({ me, store, setStore, view = "list", onViewChange, chatBadge, onInventory, onOpenOrder }) {
  const [saved] = useState(() => readSaved(store));
  const [filters, setFilters] = useState(saved?.filters || { ...EMPTY_FILTERS });
  const [searchText, setSearchText] = useState(saved?.filters?.q || "");
  const [sort, setSort] = useState(saved?.sort || "CREATED_AT:true");
  const [cursor, setCursor] = useState(saved?.cursor || {});
  const [page, setPage] = useState(saved?.page || 1);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [menu, setMenu] = useState(null);
  const storeTags = useOrderTags(store);

  const changeFilters = useCallback((patch) => {
    setFilters((current) => ({ ...current, ...patch }));
    setCursor({}); setPage(1);
  }, []);

  useEffect(() => {
    const q = searchText.trim();
    if (q === filters.q) return undefined;
    const timer = setTimeout(() => changeFilters({ q }), 300);
    return () => clearTimeout(timer);
  }, [searchText, filters.q, changeFilters]);

  useEffect(() => {
    try { sessionStorage.setItem(savedKey(store), JSON.stringify({ filters, sort, cursor, page })); } catch {}
  }, [store, filters, sort, cursor, page]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    if (filters.date === "custom" && filters.date_from && filters.date_to && filters.date_from > filters.date_to) {
      setError("The start date must be on or before the end date."); setLoading(false);
      return () => controller.abort();
    }
    fetchOrders(orderListParams({ store, filters, sort, ...cursor }), controller.signal)
      .then((data) => { if (!controller.signal.aborted) { setResult(data); setLastLoadedAt(Date.now()); } })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message || "Could not load orders"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [store, filters, sort, cursor, refresh]);

  const orders = result?.orders || [];
  const chips = filterChips(filters);
  const current = activeView(filters);
  const clearAll = () => { setSearchText(""); setFilters({ ...EMPTY_FILTERS }); setCursor({}); setPage(1); };
  const addTagFilter = (tag) => { if (!filters.tags.some((item) => item.toLowerCase() === tag.toLowerCase())) changeFilters({ tags: [...filters.tags, tag] }); };
  const open = (order) => onOpenOrder?.(order);
  const adminUrl = (order) => shopifyAdminOrderUrl(result?.shop_domain, order);
  const pageInfo = result?.page_info || {};

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <TopBar me={me} store={store} loading={loading} lastLoadedAt={lastLoadedAt} onRefresh={() => setRefresh((n) => n + 1)} onInventory={onInventory} view={view} onViewChange={onViewChange} chatBadge={chatBadge} />
      <main className="mx-auto max-w-[1600px] px-3 py-5 sm:px-5 lg:px-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold"><ListOrdered size={22} className="text-indigo-600" aria-hidden />Orders</h1>
            <p className="mt-1 text-sm text-slate-500">{result ? countLabel(result.count, result.count_precision) || "Store orders" : "Loading store orders…"}{result?.count != null && chips.length + (filters.q ? 1 : 0) > 0 ? " match these filters" : ""}</p>
          </div>
          <div className="flex items-center gap-2"><span className="text-xs font-medium text-slate-500">Store</span><StorePicker value={store} onChange={setStore} allowCustom={false} /></div>
        </div>

        <section className={`${CARD}`} aria-label="Orders">
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200 px-3 pt-2" role="tablist" aria-label="Order views">
            {ORDER_VIEWS.map((item) => (
              <button key={item.key} type="button" role="tab" aria-selected={current === item.key}
                onClick={() => { setFilters(viewFilters(item, filters.q)); setCursor({}); setPage(1); }}
                className={`relative whitespace-nowrap rounded-t-lg px-3 pb-2.5 pt-2 text-sm font-medium transition ${current === item.key ? "text-slate-900" : "text-slate-500 hover:text-slate-800"}`}>
                {item.label}
                {current === item.key && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-indigo-600" />}
              </button>
            ))}
            {!current && <span className="relative whitespace-nowrap px-3 pb-2.5 pt-2 text-sm font-medium text-slate-900">Custom filter<span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-indigo-600" /></span>}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
            <label className="relative min-w-[200px] flex-1">
              <span className="sr-only">Search orders</span>
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
              <input type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search order number, customer name, phone or email" className={`${INPUT} pl-9`} />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-500">Sort
              <select aria-label="Sort orders" value={sort} onChange={(event) => { setSort(event.target.value); setCursor({}); setPage(1); }} className={`${INPUT} !w-auto pr-8`}>
                {SORT_OPTIONS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-2.5 py-2.5">
            <FilterMenu id="status" label="Status" count={filters.status.length} openId={menu} setOpenId={setMenu}>
              <CheckList options={STATUS_OPTIONS} value={filters.status} onChange={(status) => changeFilters({ status })} />
              <ClearLink disabled={!filters.status.length} onClick={() => changeFilters({ status: [] })} />
            </FilterMenu>
            <FilterMenu id="fulfillment" label="Fulfillment status" count={filters.fulfillment.length} openId={menu} setOpenId={setMenu}>
              <CheckList options={FULFILLMENT_OPTIONS} value={filters.fulfillment} onChange={(fulfillment) => changeFilters({ fulfillment })} />
              <ClearLink disabled={!filters.fulfillment.length} onClick={() => changeFilters({ fulfillment: [] })} />
            </FilterMenu>
            <FilterMenu id="payment" label="Payment status" count={filters.payment.length} openId={menu} setOpenId={setMenu}>
              <CheckList options={PAYMENT_OPTIONS} value={filters.payment} onChange={(payment) => changeFilters({ payment })} />
              <ClearLink disabled={!filters.payment.length} onClick={() => changeFilters({ payment: [] })} />
            </FilterMenu>
            <FilterMenu id="tags" label="Tagged with" count={filters.tags.length} openId={menu} setOpenId={setMenu} wide>
              <TagInput autoFocus openOnFocus={false} createFirst={false} createLabel="Use" label="Tagged with" name="Tagged with" placeholder="Search or type a tag" value={filters.tags} onChange={(tags) => changeFilters({ tags })} suggestions={storeTags.tags} loading={storeTags.loading} />
              {filters.tags.length > 1 && (
                <fieldset className="mt-3">
                  <legend className="text-xs font-medium text-slate-600">Orders must have</legend>
                  <div className="mt-1 inline-flex rounded-lg bg-slate-100 p-0.5">
                    {[["any", "Any of these tags"], ["all", "All of these tags"]].map(([key, text]) => (
                      <button key={key} type="button" aria-pressed={filters.tag_mode === key} onClick={() => changeFilters({ tag_mode: key })} className={`rounded-md px-2.5 py-1 text-xs font-medium ${filters.tag_mode === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}>{text}</button>
                    ))}
                  </div>
                </fieldset>
              )}
            </FilterMenu>
            <FilterMenu id="exclude" label="Not tagged with" count={filters.exclude_tags.length} openId={menu} setOpenId={setMenu} wide>
              <TagInput autoFocus openOnFocus={false} createFirst={false} createLabel="Use" label="Not tagged with" name="Not tagged with" placeholder="Search or type a tag" chipTone="rose" value={filters.exclude_tags} onChange={(exclude_tags) => changeFilters({ exclude_tags })} suggestions={storeTags.tags} loading={storeTags.loading} hint="Hides orders that have any of these tags." />
            </FilterMenu>
            <FilterMenu id="product" label="Product" count={filters.products.length + (filters.product_title ? 1 : 0)} openId={menu} setOpenId={setMenu} wide>
              <ProductFilter store={store} filters={filters} onChange={changeFilters} />
            </FilterMenu>
            <FilterMenu id="date" label="Date" count={filters.date ? 1 : 0} openId={menu} setOpenId={setMenu}>
              <div className="space-y-0.5" role="radiogroup" aria-label="Order date">
                {DATE_PRESETS.map(([key, text]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-50">
                    <input type="radio" name="order-date" checked={filters.date === key} onChange={() => changeFilters({ date: key })} className="h-4 w-4 border-slate-300 text-indigo-600 focus:ring-indigo-500" />{text}
                  </label>
                ))}
              </div>
              {filters.date === "custom" && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="text-xs font-medium text-slate-600">From<input type="date" value={filters.date_from} onChange={(event) => changeFilters({ date_from: event.target.value })} className={`${INPUT} mt-1 px-2`} /></label>
                  <label className="text-xs font-medium text-slate-600">To<input type="date" value={filters.date_to} onChange={(event) => changeFilters({ date_to: event.target.value })} className={`${INPUT} mt-1 px-2`} /></label>
                </div>
              )}
              <ClearLink disabled={!filters.date} onClick={() => changeFilters({ date: "", date_from: "", date_to: "" })} />
            </FilterMenu>
            {(chips.length > 0 || filters.q) && <button type="button" onClick={clearAll} className="ml-auto text-xs font-semibold text-indigo-700 hover:underline">Clear all</button>}
          </div>

          {chips.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 border-b border-slate-100 px-3 py-2" aria-label="Applied filters">
              {chips.map((chip) => (
                <li key={chip.key} className="inline-flex max-w-full items-center gap-1 rounded-full bg-indigo-50 py-1 pl-3 pr-1 text-xs font-medium text-indigo-900 ring-1 ring-inset ring-indigo-200">
                  <span className="truncate">{chip.label}</span>
                  <button type="button" aria-label={`Remove filter ${chip.label}`} onClick={() => changeFilters(chip.clear)} className="rounded-full p-0.5 hover:bg-indigo-100"><X size={12} aria-hidden /></button>
                </li>
              ))}
            </ul>
          )}

          {result?.product_title_matches === 0 && <p className="border-b border-slate-100 px-4 py-2 text-xs text-amber-800">No product title contains “{filters.product_title}”.</p>}
          {result?.product_title_matches >= 20 && <p className="border-b border-slate-100 px-4 py-2 text-xs text-amber-800">Many products match “{filters.product_title}”. Orders for the 20 best matches are shown. Use a longer title or choose products to narrow it.</p>}
          {error && <div className="p-3"><div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden /><div className="min-w-0 break-words">{error} <button type="button" className="ml-1 font-semibold underline" onClick={() => setRefresh((n) => n + 1)}>Retry</button>{page > 1 && <button type="button" className="ml-3 font-semibold underline" onClick={() => { setCursor({}); setPage(1); }}>Go to the first page</button>}</div></div></div>}

          <div className={`relative transition-opacity ${loading && result ? "opacity-60" : ""}`} aria-busy={loading}>
            {!result && loading ? (
              <div className="space-y-px p-3">{Array.from({ length: 8 }, (_, index) => <div key={index} className="cf-shimmer h-11 rounded-lg" />)}</div>
            ) : !error && orders.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <p className="text-sm font-medium text-slate-800">{chips.length || filters.q ? "No orders match these filters" : "No orders in this store yet"}</p>
                {(chips.length > 0 || filters.q) && <button type="button" onClick={clearAll} className={`${BTN.secondary} mt-3 h-9`}>Clear filters</button>}
              </div>
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[1000px] border-collapse text-sm">
                    <caption className="sr-only">Orders for {store}. Select an order to open it in confirmation.</caption>
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold text-slate-600">
                      <tr>
                        <th scope="col" className="px-4 py-2.5">Order</th>
                        <th scope="col" className="px-2.5 py-2.5">Date</th>
                        <th scope="col" className="px-2.5 py-2.5">Customer</th>
                        <th scope="col" className="px-2.5 py-2.5">Destination</th>
                        <th scope="col" className="px-2.5 py-2.5 text-right">Total</th>
                        <th scope="col" className="px-2.5 py-2.5">Payment status</th>
                        <th scope="col" className="px-2.5 py-2.5">Fulfillment status</th>
                        <th scope="col" className="px-2.5 py-2.5">Items</th>
                        <th scope="col" className="px-2.5 py-2.5">Tags</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {orders.map((order) => {
                        const url = adminUrl(order);
                        return (
                          <tr key={order.id} onClick={(event) => { if (!event.target.closest("button,a,input")) open(order); }} className={`cursor-pointer hover:bg-slate-50 ${order.cancelled_at ? "text-slate-500" : ""}`}>
                            <td className="whitespace-nowrap py-2.5 pl-4 pr-2.5">
                              <span className="inline-flex items-center gap-0.5">
                                <button type="button" onClick={() => open(order)} className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><OrderName order={order} /></button>
                                {url && <a href={url} target="_blank" rel="noopener noreferrer" title="Open in Shopify admin" aria-label={`Open ${order.name} in Shopify admin`} className="inline-flex rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-700"><ExternalLink size={13} aria-hidden /></a>}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-2.5 py-2.5 text-slate-600">{orderDateLabel(order.created_at)}</td>
                            <td className="max-w-[10rem] truncate px-2.5 py-2.5" title={order.customer_name}>{order.customer_name || <span className="text-slate-400">No customer</span>}</td>
                            <td className="max-w-[10rem] truncate px-2.5 py-2.5 text-slate-600" title={order.destination}>{order.destination || "—"}</td>
                            <td className="whitespace-nowrap px-2.5 py-2.5 text-right tabular-nums">{moneyLabel(order.total_price, order.currency)}</td>
                            <td className="px-2.5 py-2.5"><Badge badge={paymentBadge(order.financial_status)} /></td>
                            <td className="px-2.5 py-2.5"><Badge badge={fulfillmentBadge(order.fulfillment_status)} /></td>
                            <td className="px-2.5 py-2.5"><ItemsCell order={order} /></td>
                            <td className="px-2.5 py-2.5"><TagsCell tags={order.tags} onTag={addTagFilter} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <ul className="divide-y divide-slate-100 md:hidden" aria-label="Orders">
                  {orders.map((order) => (
                    <li key={order.id}>
                      <div role="button" tabIndex={0} onClick={(event) => { if (!event.target.closest("button,a")) open(order); }} onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) open(order); }} className="block w-full px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500">
                        <div className="flex items-start justify-between gap-3">
                          <OrderName order={order} />
                          <span className="whitespace-nowrap text-sm font-medium tabular-nums">{moneyLabel(order.total_price, order.currency)}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500">{orderDateLabel(order.created_at)}</p>
                        <p className="mt-1 truncate text-sm text-slate-800">{order.customer_name || "No customer"}{order.destination && <span className="text-slate-500"> · {order.destination}</span>}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5"><Badge badge={paymentBadge(order.financial_status)} /><Badge badge={fulfillmentBadge(order.fulfillment_status)} /><span className="text-xs text-slate-500">{order.items_count} item{order.items_count === 1 ? "" : "s"}</span></div>
                        {order.tags.length > 0 && <div className="mt-2"><TagsCell wrap tags={order.tags} onTag={addTagFilter} /></div>}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
            <span>Page {page}{result && ` · ${orders.length} on this page`}{result?.count != null && ` · ${countLabel(result.count, result.count_precision)}`}</span>
            <div className="flex items-center gap-2">
              {loading && result && <Spinner className="h-4 w-4" />}
              <button type="button" aria-label="Previous page of orders" disabled={loading || !pageInfo.has_previous_page || !pageInfo.start_cursor} onClick={() => { setCursor({ before: pageInfo.start_cursor }); setPage((value) => Math.max(1, value - 1)); window.scrollTo({ top: 0, behavior: "smooth" }); }} className={`${BTN.secondary} h-9`}><ChevronLeft size={15} aria-hidden />Previous</button>
              <button type="button" aria-label="Next page of orders" disabled={loading || !pageInfo.has_next_page || !pageInfo.end_cursor} onClick={() => { setCursor({ after: pageInfo.end_cursor }); setPage((value) => value + 1); window.scrollTo({ top: 0, behavior: "smooth" }); }} className={`${BTN.secondary} h-9`}>Next<ChevronRight size={15} aria-hidden /></button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
