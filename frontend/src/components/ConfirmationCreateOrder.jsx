import React, { useEffect, useRef, useState } from "react";
import { Minus, Package, Plus, Search, Trash2, X } from "lucide-react";
import ConfirmationProductResults from "./ConfirmationProductResults";

function Field({ label, optional = false, ...props }) {
  return <label className="block text-xs font-medium text-gray-700">{label}{optional && <span className="ml-1 font-normal text-gray-400">Optional</span>}
    <input {...props} required={!optional} className="mt-1 h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100" />
  </label>;
}

export default function ConfirmationCreateOrder({ store, actorId, searchProducts, createOrder, onCreated, onClose }) {
  const pendingKey = `confirmationPendingOrder:${actorId}:${store}`;
  const [pending] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
      return saved?.payload?.store === store && saved.payload.client_action_id ? saved : null;
    } catch { return null; }
  });
  const [shipping, setShipping] = useState(pending?.payload.shipping_address || { first_name: "", last_name: "", phone: "", address1: "", address2: "", city: "", province: "", zip: "", country: "Morocco" });
  const [email, setEmail] = useState(pending?.payload.email || "");
  const [note, setNote] = useState(pending?.payload.note || "");
  const [shippingPrice, setShippingPrice] = useState(pending?.payload.shipping_price || "0.00");
  const [items, setItems] = useState(pending?.items || []);
  const [query, setQuery] = useState("");
  const [variants, setVariants] = useState([]);
  const [currency, setCurrency] = useState(pending?.currency || "");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(pending ? "A previous creation request needs checking. Retry to recover its order before starting a new one." : "");
  const [retryOnly, setRetryOnly] = useState(Boolean(pending));
  const requestRef = useRef(0);
  const submittingRef = useRef(false);
  const submissionRef = useRef(pending?.payload || null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector("input")?.focus();
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

  useEffect(() => {
    const requestId = ++requestRef.current;
    setVariants([]); setSearchError("");
    if (query.trim().length < 2) { setSearchBusy(false); return; }
    setSearchBusy(true);
    const timer = setTimeout(async () => {
      try {
        const result = await searchProducts(store, query.trim());
        if (requestId !== requestRef.current) return;
        setVariants(result.variants || []);
        setCurrency(result.currency || result.variants?.[0]?.currency || "");
      } catch (err) {
        if (requestId === requestRef.current) setSearchError(err.message || "Product search failed");
      } finally { if (requestId === requestRef.current) setSearchBusy(false); }
    }, 250);
    return () => { clearTimeout(timer); requestRef.current += 1; };
  }, [query, store, searchProducts]);

  function addItem(variant) {
    setItems((current) => current.some((item) => item.id === variant.id)
      ? current.map((item) => item.id === variant.id ? { ...item, quantity: Math.min(999, item.quantity + 1) } : item)
      : [...current, { ...variant, quantity: 1 }]);
  }
  function quantity(id, value) {
    const next = Math.max(1, Math.min(999, Math.trunc(Number(value) || 1)));
    setItems((current) => current.map((item) => item.id === id ? { ...item, quantity: next } : item));
  }
  const subtotal = items.reduce((total, item) => total + Math.round(Number(item.price) * 100) * item.quantity, 0) / 100;
  const total = subtotal + Number(shippingPrice || 0);

  async function submit(event) {
    event.preventDefault();
    if (submittingRef.current || !items.length) return;
    submittingRef.current = true; setBusy(true); setError("");
    if (!submissionRef.current) {
      submissionRef.current = {
        store, client_action_id: globalThis.crypto?.randomUUID?.() || `order-${Date.now()}-${Math.random().toString(36).slice(2)}`, shipping_address: shipping,
        email: email.trim() || null, note: note.trim() || null,
        shipping_price: Number(shippingPrice || 0).toFixed(2),
        additions: items.map((item) => ({ variant_id: item.id, quantity: item.quantity })),
      };
    }
    try { sessionStorage.setItem(pendingKey, JSON.stringify({ payload: submissionRef.current, items, currency })); } catch {}
    try {
      const result = await createOrder(submissionRef.current);
      try { sessionStorage.removeItem(pendingKey); } catch {}
      onCreated(result);
    } catch (err) {
      // Keep the same payload and action ID after an uncertain response so Retry
      // cannot silently submit a different order while the first may have saved.
      const safeToEdit = [400, 401, 403, 422, 429].includes(err.status);
      if (safeToEdit) {
        submissionRef.current = null;
        try { sessionStorage.removeItem(pendingKey); } catch {}
      }
      setRetryOnly(!safeToEdit);
      setError(err.message || "Could not create order. Retry with the same request.");
    } finally { submittingRef.current = false; setBusy(false); }
  }

  const locked = busy || retryOnly;
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 p-2 backdrop-blur-[2px] sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="create-order-title" className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl">
      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <Package className="text-indigo-600" size={24} aria-hidden />
        <div><h2 id="create-order-title" className="text-base font-semibold">New order</h2><p className="text-xs text-gray-500">{store} · Cash on delivery · Assigned to you</p></div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close new order" className="ml-auto rounded-lg border border-gray-200 p-2 disabled:opacity-50"><X size={18} /></button>
      </header>
      <form onSubmit={submit} className="overflow-y-auto p-4 sm:p-6">
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            <section className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold">Customer and delivery</h3>
              <fieldset disabled={locked} className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="First name" autoComplete="given-name" value={shipping.first_name} onChange={(e) => setShipping({ ...shipping, first_name: e.target.value })} />
                <Field label="Last name" optional autoComplete="family-name" value={shipping.last_name} onChange={(e) => setShipping({ ...shipping, last_name: e.target.value })} />
                <Field label="Phone" type="tel" autoComplete="tel" placeholder="0612345678" value={shipping.phone} onChange={(e) => setShipping({ ...shipping, phone: e.target.value })} />
                <Field label="Email" optional type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
                <input disabled={locked} type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} placeholder="Search product title, variant, SKU, or barcode" className="h-11 w-full rounded-lg border border-gray-300 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
              </label>
              {searchBusy && <p role="status" className="mt-3 text-xs text-gray-500">Searching products…</p>}
              {searchError && <p role="alert" className="mt-3 text-xs text-rose-700">{searchError}</p>}
              {query.trim().length >= 2 && !searchBusy && !searchError && !variants.length && <p className="mt-3 text-xs text-gray-500">No matching variants found.</p>}
              <ConfirmationProductResults variants={variants} currency={currency} onChoose={addItem} disabled={locked} />
            </section>
          </div>
          <aside className="min-w-0 rounded-xl border border-gray-200 bg-white p-4 lg:sticky lg:top-0">
            <h3 className="text-sm font-semibold">Review order</h3>
            {!items.length && <p className="mt-4 rounded-lg bg-gray-50 p-3 text-xs text-gray-500">Search for a product and choose its variant to add it.</p>}
            <div className="mt-3 space-y-3">{items.map((item) => <div key={item.id} className="rounded-lg border border-gray-200 p-3">
              <p className="break-words text-sm font-semibold">{item.product_title}</p>
              <p className="mt-1 text-xs text-indigo-700">{item.variant_title === "Default Title" ? "Default variant" : item.variant_title}</p>
              <p className="mt-1 text-xs text-gray-600">{item.price} {item.currency || currency} each</p>
              <div className="mt-2 flex items-center gap-1">
                <button type="button" disabled={locked || item.quantity <= 1} onClick={() => quantity(item.id, item.quantity - 1)} aria-label={`Decrease ${item.product_title} quantity`} className="rounded border p-2 disabled:opacity-30"><Minus size={14} /></button>
                <input type="number" min="1" max="999" step="1" disabled={locked} aria-label={`Quantity for ${item.product_title}`} value={item.quantity} onChange={(e) => quantity(item.id, e.target.value)} className="h-9 w-16 rounded border text-center text-sm" />
                <button type="button" disabled={locked || item.quantity >= 999} onClick={() => quantity(item.id, item.quantity + 1)} aria-label={`Increase ${item.product_title} quantity`} className="rounded border p-2 disabled:opacity-30"><Plus size={14} /></button>
                <button type="button" disabled={locked} onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))} aria-label={`Remove ${item.product_title}`} className="ml-auto p-2 text-rose-600"><Trash2 size={16} /></button>
              </div>
            </div>)}</div>
            <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
              <Field label={`Delivery fee${currency ? ` (${currency})` : ""}`} disabled={locked} type="number" min="0" max="999999" step="0.01" value={shippingPrice} onChange={(e) => setShippingPrice(e.target.value)} />
              <label className="block text-xs font-medium text-gray-700">Order note <span className="text-gray-400">Optional</span><textarea disabled={locked} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal" /></label>
              <div className="flex justify-between text-xs"><span>Products</span><span>{subtotal.toFixed(2)} {currency}</span></div>
              <div className="flex justify-between text-sm font-semibold"><span>Estimated total</span><span>{total.toFixed(2)} {currency}</span></div>
              <p className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-xs leading-relaxed text-indigo-800">Payment remains pending for cash on delivery. Shopify calculates the final total. You can confirm the order after creating it.</p>
              {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}{retryOnly && <span className="mt-1 block">Retry checks the same request to avoid creating a duplicate.</span>}</p>}
              <button type="submit" disabled={busy || !items.length} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40">{busy ? "Creating order…" : retryOnly ? "Retry same order" : "Create order"}</button>
            </div>
          </aside>
        </div>
      </form>
    </div>
  </div>;
}
