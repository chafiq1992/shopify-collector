import React, { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Package, Plus, Search, Trash2, X } from "lucide-react";
import ConfirmationProductResults from "./ConfirmationProductResults";
import TagInput from "./TagInput";
import useConfirmationProductSearch, { PRODUCT_SEARCH_PLACEHOLDER } from "../lib/useConfirmationProductSearch";
import { cartKey, createOrderPayload, customerOrderFields, initialOrderForm, orderCartIssue } from "../lib/confirmationOrderForm";
import { codDateTags, useOrderTags } from "../lib/orderTags";

function Field({ label, optional = false, ...props }) {
  return <label className="block text-xs font-medium text-gray-700">{label}{optional && <span className="ml-1 font-normal text-gray-400">Optional</span>}
    <input {...props} required={!optional} className="mt-1 h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100" />
  </label>;
}

export default function ConfirmationCreateOrder(props) {
  return <ConfirmationCreateOrderForm key={`${props.actorId}:${props.store}:${props.initialOrderId || "new"}`} {...props} />;
}

function ConfirmationCreateOrderForm({ store, actorId, searchProducts, searchCustomers, loadDuplicateTemplate, initialOrderId, createOrder, onCreated, onClose }) {
  const pendingKey = `confirmationPendingOrder:${actorId}:${store}`;
  const [pending] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
      return saved?.payload?.store === store && saved.payload.client_action_id ? saved : null;
    } catch { return null; }
  });
  const [initial] = useState(() => initialOrderForm(pending));
  const [shipping, setShipping] = useState(initial.shipping);
  const [email, setEmail] = useState(initial.email);
  const [note, setNote] = useState(initial.note);
  const [shippingPrice, setShippingPrice] = useState(initial.shippingPrice);
  const [items, setItems] = useState(initial.items);
  const [tags, setTags] = useState(initial.tags);
  const storeTags = useOrderTags(store);
  const featuredTags = useMemo(() => codDateTags(), []);
  const [customer, setCustomer] = useState(initial.customer);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState([]);
  const [customerBusy, setCustomerBusy] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const [source, setSource] = useState(initial.source);
  const [seedLoading, setSeedLoading] = useState(Boolean(initialOrderId && !pending));
  const [seedError, setSeedError] = useState("");
  const [seedAttempt, setSeedAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [currency, setCurrency] = useState(initial.currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(pending ? "A previous creation request needs checking. Retry to recover its order before starting a new one." : "");
  const [retryOnly, setRetryOnly] = useState(Boolean(pending));
  const submittingRef = useRef(false);
  const submissionRef = useRef(pending?.payload || null);
  const dialogRef = useRef(null);
  const mountedRef = useRef(true);
  const blockedSeed = Boolean(initialOrderId && (seedLoading || seedError));
  const duplicateFlow = Boolean(initialOrderId && !pending);
  const locked = busy || retryOnly || blockedSeed;
  const cartIssue = orderCartIssue(items);
  const productSearch = useConfirmationProductSearch(store, query, { search: searchProducts, enabled: !locked });
  const { products, loading: searchBusy, error: searchError } = productSearch;
  useEffect(() => { if (productSearch.currency) setCurrency(productSearch.currency); }, [productSearch.currency]);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  useEffect(() => {
    if (!initialOrderId || pending) return;
    const controller = new AbortController();
    setSeedLoading(true); setSeedError("");
    Promise.resolve().then(() => {
      if (!loadDuplicateTemplate) throw new Error("Order duplication is unavailable. Close this form and try again.");
      return loadDuplicateTemplate(store, initialOrderId, { signal: controller.signal });
    }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result?.template || !Array.isArray(result.template.items)) throw new Error("Could not load the source order's products. Retry before creating an order.");
      const seed = initialOrderForm(null, result.template);
      setShipping(seed.shipping); setEmail(seed.email); setNote(seed.note); setShippingPrice(seed.shippingPrice);
      setItems(seed.items); setCurrency(seed.currency); setCustomer(seed.customer); setSource(seed.source);
    }).catch((err) => { if (!controller.signal.aborted) setSeedError(err.message || "Could not load source order."); })
      .finally(() => { if (!controller.signal.aborted) setSeedLoading(false); });
    return () => controller.abort();
  }, [initialOrderId, store, pending, loadDuplicateTemplate, seedAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setCustomers([]); setCustomerError("");
    if (locked || customer || !searchCustomers || customerQuery.replace(/\D/g, "").length < 7) { setCustomerBusy(false); return () => controller.abort(); }
    setCustomerBusy(true);
    const timer = setTimeout(() => {
      searchCustomers(store, customerQuery.trim(), { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) setCustomers(result.customers || []); })
        .catch((err) => { if (!controller.signal.aborted) setCustomerError(err.message || "Customer search failed."); })
        .finally(() => { if (!controller.signal.aborted) setCustomerBusy(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [customerQuery, store, searchCustomers, locked, customer]);

  function chooseCustomer(value) {
    const selected = customerOrderFields(value);
    setShipping(selected.shipping); setEmail(selected.email); setCustomer(selected.customer);
    setCustomers([]); setCustomerError("");
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = "hidden";
    (dialogRef.current?.querySelector("input:not(:disabled)") || dialogRef.current?.querySelector("button:not(:disabled)"))?.focus();
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus?.(); };
  }, []);

  useEffect(() => {
    const handleKey = (event) => {
      if (event.key === "Escape" && !submittingRef.current) onClose();
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])];
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function addItem(variant) {

    setItems((current) => current.some((item) => item.id === variant.id && !item.unavailable && !item.needs_review)
      ? current.map((item) => item.id === variant.id && !item.unavailable && !item.needs_review ? { ...item, quantity: Number(item.quantity) + 1 } : item)
      : [...current, { ...variant, quantity: 1, row_key: `added:${variant.id}` }]);
  }
  function quantity(key, value) {

    setItems((current) => current.map((item, index) => cartKey(item, index) === key ? { ...item, quantity: value } : item));
  }
  const subtotal = items.reduce((total, item) => total + (item.unavailable || item.needs_review || !Number.isFinite(Number(item.price)) ? 0 : Math.round(Number(item.price) * 100) * Number(item.quantity || 0)), 0) / 100;
  const total = subtotal + Number(shippingPrice || 0);

  async function submit(event) {
    event.preventDefault();
    if (submittingRef.current || blockedSeed || (!retryOnly && cartIssue)) return;
    submittingRef.current = true; setBusy(true); setError("");
    if (!submissionRef.current) {
      submissionRef.current = createOrderPayload({ store, actionId: globalThis.crypto?.randomUUID?.() || `order-${Date.now()}-${Math.random().toString(36).slice(2)}`, shipping, email, note, shippingPrice, items, customer, tags });
    }
    try { sessionStorage.setItem(pendingKey, JSON.stringify({ payload: submissionRef.current, items, currency, customer, source })); } catch {}
    try {
      const result = await createOrder(submissionRef.current);
      try { sessionStorage.removeItem(pendingKey); } catch {}
      if (mountedRef.current) onCreated(result);
    } catch (err) {
      if (!mountedRef.current) return;
      // Keep the same payload and action ID after an uncertain response so Retry
      // cannot silently submit a different order while the first may have saved.
      const safeToEdit = [400, 401, 403, 422, 429].includes(err.status);
      if (safeToEdit) {
        submissionRef.current = null;
        try { sessionStorage.removeItem(pendingKey); } catch {}
      }
      setRetryOnly(!safeToEdit);
      setError(err.message || "Could not create order. Retry with the same request.");
    } finally { submittingRef.current = false; if (mountedRef.current) setBusy(false); }
  }

  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 p-2 backdrop-blur-[2px] sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="create-order-title" className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl">
      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <Package className="text-indigo-600" size={24} aria-hidden />
        <div><h2 id="create-order-title" className="text-base font-semibold">{initialOrderId && !pending ? "Duplicate order" : "New order"}</h2><p className="text-xs text-gray-500">{store} · Cash on delivery · Assigned to you</p></div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close new order" className="ml-auto rounded-lg border border-gray-200 p-2 disabled:opacity-50"><X size={18} /></button>
      </header>
      <form onSubmit={submit} onKeyDown={(event) => { if (event.key === "Enter" && event.target.tagName === "INPUT") event.preventDefault(); }} className="overflow-y-auto p-4 sm:p-6">
        {seedLoading && <p role="status" className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-800">Loading the source customer and current product information…</p>}
        {seedError && <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{seedError}<button type="button" onClick={() => setSeedAttempt((value) => value + 1)} className="ml-2 font-semibold underline">Retry source order</button></div>}
        {source && !pending && <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-xs leading-relaxed text-indigo-900"><p className="font-semibold">Based on {source.name || "the selected order"}</p><p className="mt-1">Review every product and quantity. Prices use the current catalog. Payment status, tags, discounts and notes from the source are not copied.</p>{source.warnings?.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4">{source.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div>}
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            <section className="rounded-xl border border-indigo-200 bg-white p-4">
              <h3 className="text-sm font-semibold">Find customer by phone</h3>
              {customer ? <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-semibold text-emerald-900">{customer.name || "Shopify customer"}</p><p className="mt-1 break-words text-xs text-emerald-800">{[customer.phone, customer.email].filter(Boolean).join(" · ")}</p></div><button type="button" disabled={locked} onClick={() => { setCustomer(null); setCustomerQuery(""); setCustomers([]); }} className="shrink-0 text-xs font-semibold text-emerald-800 underline disabled:opacity-40">Change customer</button></div><p className="mt-2 text-xs text-emerald-800">Linked to this Shopify customer. Edits below apply to this order and do not change the customer profile.</p></div> : <>
                <label className="relative mt-3 block"><span className="sr-only">Find customer by phone</span><Search size={17} className="absolute left-3 top-3.5 text-gray-400" aria-hidden /><input type="search" inputMode="tel" autoComplete="off" disabled={locked || !searchCustomers} value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} placeholder="Enter phone number, e.g. 0612345678" className="h-11 w-full rounded-lg border border-gray-300 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-indigo-200" /></label>
                <p className="mt-2 text-xs text-gray-500">Enter at least 7 digits, then choose a matching customer to fill delivery details. You can also enter new customer information below.</p>
                {customerBusy && <p role="status" className="mt-3 text-xs text-gray-500">Searching customers…</p>}
                {customerError && <p role="alert" className="mt-3 text-xs text-rose-700">{customerError}</p>}
                {!locked && customerQuery.replace(/\D/g, "").length >= 7 && !customerBusy && !customerError && !customers.length && <p className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">No matching customer. You can create the order with new customer details below.</p>}
                {customers.length > 0 && <div className="mt-3 max-h-72 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-200" aria-label="Customer search results">{customers.map((match) => <button type="button" key={match.id} disabled={locked} onClick={() => chooseCustomer(match)} className="block w-full p-3 text-left hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"><span className="block text-sm font-semibold">{match.name || [match.first_name, match.last_name].filter(Boolean).join(" ") || "Shopify customer"}</span><span className="mt-1 block break-words text-xs text-gray-600">{[match.phone || match.address?.phone, match.email].filter(Boolean).join(" · ")}</span><span className="mt-1 block break-words text-xs text-gray-500">{[match.address?.address1, match.address?.city, match.address?.country].filter(Boolean).join(", ")}</span><span className="mt-1 block text-xs font-semibold text-indigo-700">Use customer{match.orders_count != null ? ` · ${match.orders_count} previous orders` : ""}</span></button>)}</div>}
              </>}
            </section>
            <section className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold">Customer and delivery</h3>
              <fieldset disabled={locked} className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="First name" autoComplete="given-name" value={shipping.first_name} onChange={(e) => setShipping({ ...shipping, first_name: e.target.value })} />
                <Field label="Last name" optional autoComplete="family-name" value={shipping.last_name} onChange={(e) => setShipping({ ...shipping, last_name: e.target.value })} />
                <Field label="Phone" type="tel" autoComplete="tel" placeholder="0612345678" value={shipping.phone} onChange={(e) => setShipping({ ...shipping, phone: e.target.value })} />
                <Field label="Email" optional type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <div className="sm:col-span-2"><Field label="Company" optional autoComplete="organization" value={shipping.company} onChange={(e) => setShipping({ ...shipping, company: e.target.value })} /></div>
                <div className="sm:col-span-2"><Field label="Delivery address" autoComplete="address-line1" value={shipping.address1} onChange={(e) => setShipping({ ...shipping, address1: e.target.value })} /></div>
                <div className="sm:col-span-2"><Field label="Apartment / delivery details" optional autoComplete="address-line2" value={shipping.address2} onChange={(e) => setShipping({ ...shipping, address2: e.target.value })} /></div>
                <Field label="City" autoComplete="address-level2" value={shipping.city} onChange={(e) => setShipping({ ...shipping, city: e.target.value })} />
                <Field label="Country" autoComplete="country-name" value={shipping.country} onChange={(e) => setShipping({ ...shipping, country: e.target.value })} />
                <Field label="Province / region" optional autoComplete="address-level1" value={shipping.province} onChange={(e) => setShipping({ ...shipping, province: e.target.value })} />
                <Field label="Postal code" optional autoComplete="postal-code" value={shipping.zip} onChange={(e) => setShipping({ ...shipping, zip: e.target.value })} />
              </fieldset>
            </section>
            <section className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold">Add products</h3>
              <label className="relative mt-3 block"><span className="sr-only">Search products</span><Search size={17} className="absolute left-3 top-3.5 text-gray-400" aria-hidden />
                <input disabled={locked} type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} placeholder={PRODUCT_SEARCH_PLACEHOLDER} className="h-11 w-full rounded-lg border border-gray-300 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
              </label>
              {searchBusy && <p role="status" className="mt-3 text-xs text-gray-500">Searching products…</p>}
              {searchError && <p role="alert" className="mt-3 text-xs text-rose-700">{searchError}</p>}
              {query.trim().length >= 2 && !searchBusy && !searchError && !productSearch.hasNextPage && !products.length && <p className="mt-3 text-xs text-gray-500">No matching products found.</p>}
              <ConfirmationProductResults currency={currency} onChoose={addItem} disabled={locked || searchBusy} searchState={productSearch} />
            </section>
          </div>
          <aside aria-label={duplicateFlow ? "Copied products" : "Review order"} className={`min-w-0 rounded-xl border border-gray-200 bg-white p-4 lg:sticky lg:top-0 ${duplicateFlow ? "order-first lg:order-none" : ""}`}>
            <h3 className="text-sm font-semibold">{duplicateFlow ? "Copied products" : "Review order"}</h3>
            {duplicateFlow && items.length > 0 && <p className="mt-1 text-xs text-gray-500">The source products, variants and quantities are ready to edit.</p>}
            {!items.length && <p className="mt-4 rounded-lg bg-gray-50 p-3 text-xs text-gray-500">{seedLoading ? "Loading copied products…" : seedError ? "Source products could not be loaded. Retry the source order above." : "Search for a product, open it, then choose a variant to add it."}</p>}
            <div className="mt-3 space-y-3">{items.map((item, index) => <div key={cartKey(item, index)} className={`rounded-lg border p-3 ${item.unavailable || item.needs_review ? "border-rose-200 bg-rose-50/30" : "border-gray-200"}`}>
              <div className="flex items-start gap-3">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                  {item.image ? <img src={item.image} alt={item.product_title || "Product"} className="h-full w-full object-contain" /> : <Package size={24} className="text-gray-400" aria-hidden />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold">{item.product_title}</p>
                  <p className="mt-1 inline-block rounded-md bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-800">{item.variant_title && item.variant_title !== "Default Title" ? item.variant_title : "Default variant"}</p>
                  {item.sku && <p className="mt-1 break-all text-[11px] text-gray-500">SKU {item.sku}</p>}
                  {item.id && <p className="mt-1 break-all font-mono text-[10px] text-gray-500">Variant ID {String(item.id).split("/").pop()}</p>}
                </div>
              </div>
              {item.unavailable || item.needs_review ? <p className="mt-2 text-xs font-medium text-rose-800">{item.unavailable_reason || "This source item is unavailable or needs review. Remove it and add a replacement."}</p> : <p className="mt-1 text-xs text-gray-600">{item.price} {item.currency || currency} each</p>}
              <div className="mt-2 flex items-center gap-1">
                <span className="mr-1 text-xs font-medium text-gray-600">Qty</span>
                <button type="button" disabled={locked || item.quantity <= 1} onClick={() => quantity(cartKey(item, index), Number(item.quantity) - 1)} aria-label={`Decrease ${item.product_title} quantity`} className="rounded border p-2 disabled:opacity-30"><Minus size={14} /></button>
                <input type="number" min="1" max="999" step="1" disabled={locked} aria-label={`Quantity for ${item.product_title}`} value={item.quantity} onChange={(e) => quantity(cartKey(item, index), e.target.value)} className="h-9 w-16 rounded border text-center text-sm" />
                <button type="button" disabled={locked || item.quantity >= 999} onClick={() => quantity(cartKey(item, index), Number(item.quantity) + 1)} aria-label={`Increase ${item.product_title} quantity`} className="rounded border p-2 disabled:opacity-30"><Plus size={14} /></button>
                <button type="button" disabled={locked} onClick={() => { setItems((current) => current.filter((row, at) => cartKey(row, at) !== cartKey(item, index))); }} aria-label={`Remove ${item.product_title}`} className="ml-auto p-2 text-rose-600"><Trash2 size={16} /></button>
              </div>
            </div>)}</div>
            <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
              <Field label={`Delivery fee${currency ? ` (${currency})` : ""}`} disabled={locked} type="number" min="0" max="999999" step="0.01" value={shippingPrice} onChange={(e) => setShippingPrice(e.target.value)} />
              <label className="block text-xs font-medium text-gray-700">Order note <span className="text-gray-400">Optional</span><textarea disabled={locked} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal" /></label>
              <TagInput label={<>Tags <span className="font-normal text-gray-400">Optional</span></>} value={tags} onChange={setTags} suggestions={storeTags.tags} featured={featuredTags} loading={storeTags.loading} disabled={locked}
                hint={storeTags.error ? "Store tags could not load. You can still type a tag and press Enter." : "Type to find a store tag, or press Enter to add a new one."} />
              <div className="flex justify-between text-xs"><span>Products</span><span>{subtotal.toFixed(2)} {currency}</span></div>
              <div className="flex justify-between text-sm font-semibold"><span>Estimated total</span><span>{total.toFixed(2)} {currency}</span></div>
              {items.some((item) => item.unavailable || item.needs_review) && <p className="text-xs text-rose-700">Unavailable items are excluded from this estimate. Remove or replace them before creating the order.</p>}
              {cartIssue && items.length > 0 && !retryOnly && <p role="alert" className="text-xs text-rose-700">{cartIssue}</p>}
              <p className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-xs leading-relaxed text-indigo-800">Payment remains pending for cash on delivery. Shopify calculates the final total. You can confirm the order after creating it.</p>
              {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}{retryOnly && <span className="mt-1 block">Retry checks the same request to avoid creating a duplicate.</span>}</p>}
              <button type="submit" disabled={busy || blockedSeed || (!retryOnly && Boolean(cartIssue))} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40">{busy ? "Creating order…" : retryOnly ? "Retry same order" : "Create order"}</button>
            </div>
          </aside>
        </div>
      </form>
    </div>
  </div>;
}
