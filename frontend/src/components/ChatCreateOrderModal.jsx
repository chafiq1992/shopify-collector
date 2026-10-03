import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  ExternalLink,
  Link2,
  MapPin,
  Minus,
  Package,
  Plus,
  Search,
  ShoppingBag,
  Tag,
  Trash2,
  TriangleAlert,
  Truck,
  UserCheck,
  UserRound,
  X,
} from "lucide-react";
import { authFetch, authHeaders } from "../lib/auth";
import { isoToDDMMYY, todayDDMMYY, todayISO } from "../lib/confirmationActions";
import { BTN, CARD, Spinner, initialOf, timeAgo } from "./ConfirmationUi";

// "Create order" for a chat request: who the customer is (with a Shopify customer
// search and their recent orders, so nobody orders twice), the products with the
// size / colour picked, tags and a note, then one click creates the order in
// Shopify and closes the request as ordered.

const CURRENCY = "MAD";
const RECENT_DAYS = 7;

const MOROCCO_CITIES = [
  "Casablanca", "Rabat", "Salé", "Témara", "Kénitra", "Mohammedia", "Marrakech", "Fès", "Meknès",
  "Tanger", "Tétouan", "Agadir", "Inezgane", "Aït Melloul", "Oujda", "Nador", "El Jadida", "Safi",
  "Essaouira", "Béni Mellal", "Khouribga", "Settat", "Berrechid", "Khémisset", "Larache",
  "Ksar El Kébir", "Al Hoceïma", "Taza", "Errachidia", "Ouarzazate", "Guelmim", "Laâyoune", "Dakhla",
  "Tiznit", "Taroudant", "Berkane", "Sidi Kacem", "Sidi Slimane", "Fquih Ben Salah", "Youssoufia",
  "Benguerir", "Martil", "M'diq", "Fnideq", "Chefchaouen", "Ifrane", "Azrou", "Midelt", "Taourirt",
  "Skhirat", "Bouznika", "Had Soualem", "Dar Bouazza", "Tit Mellil",
];

// ---------- API ----------
async function call(url, options = {}) {
  const res = await authFetch(url, { ...options, headers: authHeaders(options.headers || {}) });
  const js = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = js?.detail;
    const err = new Error(typeof detail === "string" ? detail : detail?.message || `Request failed (${res.status})`);
    err.code = detail && typeof detail === "object" ? detail.code : null;
    err.status = res.status;
    throw err;
  }
  return js;
}

const ORDER_API = {
  customers: (store, q) => call(`/api/chat-requests/customers/lookup?${new URLSearchParams({ store, q })}`),
  product: (store, params) => call(`/api/chat-requests/product-options?${new URLSearchParams({ store, ...params })}`),
  searchVariants: (store, q) => call(`/api/agent/product-variants/search?${new URLSearchParams({ store, q, first: "20" })}`),
  create: (id, body) => call(`/api/chat-requests/${encodeURIComponent(id)}/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
};

// ---------- Helpers ----------
function localPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("212") && digits.length === 12) return `0${digits.slice(3)}`;
  return String(phone || "");
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}

function money(n) {
  const v = Number(n || 0);
  return Number.isFinite(v) ? v.toFixed(2) : "0.00";
}

function newKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newActionId() {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
  return newKey();
}

// Size and colour are what agents get wrong most, so they always stand out.
function optionKind(name) {
  const n = String(name || "").toLowerCase();
  if (/size|taille|pointure|talla|age|âge|عمر|مقاس|سن/.test(n)) return "size";
  if (/colou?r|couleur|لون/.test(n)) return "color";
  return "other";
}

const KIND_STYLE = {
  size:  { box: "bg-amber-50/70 ring-amber-200", label: "text-amber-800", on: "bg-amber-500 text-white ring-amber-500", badge: "bg-amber-100 text-amber-900 ring-amber-300" },
  color: { box: "bg-violet-50/70 ring-violet-200", label: "text-violet-800", on: "bg-violet-600 text-white ring-violet-600", badge: "bg-violet-100 text-violet-900 ring-violet-300" },
  other: { box: "bg-slate-50 ring-slate-200", label: "text-slate-600", on: "bg-slate-800 text-white ring-slate-800", badge: "bg-slate-100 text-slate-800 ring-slate-300" },
};

function OptionBadges({ options, size = "sm" }) {
  const list = (options || []).filter((o) => o?.value && o.value !== "Default Title");
  if (!list.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {list.map((o) => {
        const style = KIND_STYLE[optionKind(o.name)];
        return (
          <span key={`${o.name}:${o.value}`} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold ring-1 ring-inset ${style.badge} ${size === "lg" ? "text-xs" : "text-[11px]"}`}>
            <span className="font-medium opacity-70">{o.name}</span>{o.value}
          </span>
        );
      })}
    </span>
  );
}

function variantOf(line) {
  return line.product?.variants?.find((v) => v.id === line.variantId) || null;
}

function isRecent(order) {
  if (!order?.created_at || order.cancelled_at) return false;
  return Date.now() - new Date(order.created_at).getTime() < RECENT_DAYS * 86_400_000;
}

function adminOrderUrl(shopDomain, order) {
  const domain = String(shopDomain || "").replace(/^https?:\/\//, "");
  const legacy = order?.legacy_id || String(order?.id || "").match(/(\d+)\s*$/)?.[1];
  return domain && legacy ? `https://${domain}/admin/orders/${legacy}` : null;
}

const INPUT = "h-10 w-full rounded-xl border-0 bg-white px-3 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500";

function Field({ label, required = false, error = false, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-slate-700">
        {label}{required && <span className="text-rose-500">*</span>}
        {hint && <span className="ml-auto font-normal text-slate-400">{hint}</span>}
      </span>
      <div className={error ? "rounded-xl ring-2 ring-rose-300" : ""}>{children}</div>
    </label>
  );
}

function Section({ icon: Icon, title, right, children }) {
  return (
    <section className={`${CARD} p-4`}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-slate-400" aria-hidden />
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </section>
  );
}

// ---------- Modal ----------
export default function ChatCreateOrderModal({ request: r, store, shopDomain, me, onClose, onCreated, onLinkExisting }) {
  const initialName = splitName(r.customer_name);
  const [form, setForm] = useState({
    first_name: initialName.first,
    last_name: initialName.last,
    phone: localPhone(r.phone),
    email: "",
    city: "",
    address1: "",
    address2: "",
  });
  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const [customer, setCustomer] = useState(null);

  // Customers already in Shopify with this phone: suggested up front, and their
  // orders are the "don't order twice" list.
  const [phoneMatches, setPhoneMatches] = useState({ loading: true, customers: [], error: null });
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState({ loading: false, customers: [], error: null });
  const [showCustomerMenu, setShowCustomerMenu] = useState(false);
  const customerReq = useRef(0);

  const [lines, setLines] = useState([]);
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState({ loading: false, variants: [], error: null });
  const [replaceKey, setReplaceKey] = useState(null);
  const productReq = useRef(0);
  const productInputRef = useRef(null);

  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState("");
  const [note, setNote] = useState("");
  const [shippingTitle, setShippingTitle] = useState("Livraison");
  const [shippingPrice, setShippingPrice] = useState("0");
  // Discount on the products: a percentage or an amount in MAD.
  const [discountType, setDiscountType] = useState("percentage");
  const [discountValue, setDiscountValue] = useState("");
  const [discountCode, setDiscountCode] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [maybeCreated, setMaybeCreated] = useState(false);
  const [triedSubmit, setTriedSubmit] = useState(false);
  const [created, setCreated] = useState(null);
  const [linking, setLinking] = useState(null);
  const [manualRef, setManualRef] = useState("");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e) { if (e.key === "Escape" && !busy) onClose?.(); }
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [busy, onClose]);

  // Phone lookup + the product the customer was looking at, on open.
  useEffect(() => {
    let cancelled = false;
    ORDER_API.customers(store, localPhone(r.phone))
      .then((js) => { if (!cancelled) setPhoneMatches({ loading: false, customers: js.customers || [], error: null }); })
      .catch((e) => { if (!cancelled) setPhoneMatches({ loading: false, customers: [], error: e.message }); });
    if (r.product_title || r.product_url) {
      const key = newKey();
      setLines([{ key, loading: true, quantity: 1, fromChat: true }]);
      ORDER_API.product(store, {
        ...(r.product_url ? { product_url: r.product_url } : {}),
        ...(r.product_title ? { title: r.product_title } : {}),
        ...(r.variant_title ? { variant_title: r.variant_title } : {}),
      })
        .then((js) => {
          if (cancelled) return;
          setLines((ls) => ls.map((l) => (l.key !== key ? l : js.product
            ? { ...l, loading: false, product: js.product, variantId: js.matched_variant_id || onlyVariant(js.product) }
            : { ...l, loading: false, notFound: true })));
        })
        .catch((e) => { if (!cancelled) setLines((ls) => ls.map((l) => (l.key === key ? { ...l, loading: false, error: e.message } : l))); });
    }
    return () => { cancelled = true; };
  }, [r.id, store]); // eslint-disable-line react-hooks/exhaustive-deps

  // Customer search box.
  useEffect(() => {
    const q = customerQuery.trim();
    if (q.length < 2) { setCustomerResults({ loading: false, customers: [], error: null }); return undefined; }
    const t = setTimeout(async () => {
      const id = ++customerReq.current;
      setCustomerResults((s) => ({ ...s, loading: true, error: null }));
      try {
        const js = await ORDER_API.customers(store, q);
        if (id === customerReq.current) setCustomerResults({ loading: false, customers: js.customers || [], error: null });
      } catch (e) {
        if (id === customerReq.current) setCustomerResults({ loading: false, customers: [], error: e.message });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [customerQuery, store]);

  // Product search box.
  useEffect(() => {
    const q = productQuery.trim();
    if (q.length < 2) { setProductResults({ loading: false, variants: [], error: null }); return undefined; }
    const t = setTimeout(async () => {
      const id = ++productReq.current;
      setProductResults((s) => ({ ...s, loading: true, error: null }));
      try {
        const js = await ORDER_API.searchVariants(store, q);
        if (id === productReq.current) setProductResults({ loading: false, variants: js.variants || [], error: null });
      } catch (e) {
        if (id === productReq.current) setProductResults({ loading: false, variants: [], error: e.message });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [productQuery, store]);

  function onlyVariant(product) {
    return product?.variants?.length === 1 ? product.variants[0].id : null;
  }

  function pickCustomer(c) {
    setCustomer(c);
    setShowCustomerMenu(false);
    setCustomerQuery("");
    const a = c.address || {};
    setForm((f) => ({
      ...f,
      first_name: a.first_name || c.first_name || f.first_name,
      last_name: a.last_name || c.last_name || f.last_name,
      phone: f.phone || localPhone(a.phone || c.phone),
      email: c.email || f.email,
      city: a.city || f.city,
      address1: a.address1 || f.address1,
      address2: a.address2 || f.address2,
    }));
  }

  async function addVariant(v) {
    const key = replaceKey || newKey();
    const placeholder = { key, loading: true, quantity: 1, variantId: v.id, preview: v };
    setLines((ls) => (replaceKey ? ls.map((l) => (l.key === replaceKey ? { ...placeholder, quantity: l.quantity } : l)) : [...ls, placeholder]));
    setReplaceKey(null);
    setProductQuery("");
    try {
      const js = await ORDER_API.product(store, { product_id: v.product_id });
      setLines((ls) => ls.map((l) => (l.key === key ? { ...l, loading: false, product: js.product, preview: null } : l)));
    } catch (e) {
      setLines((ls) => ls.map((l) => (l.key === key ? { ...l, loading: false, error: e.message } : l)));
    }
  }

  function pickOption(line, name, value) {
    const variants = line.product?.variants || [];
    const current = variantOf(line);
    const wanted = {};
    for (const o of current?.options || []) wanted[o.name] = o.value;
    wanted[name] = value;
    const exact = variants.find((v) => v.options.every((o) => wanted[o.name] === o.value));
    const fallback = variants
      .filter((v) => v.options.some((o) => o.name === name && o.value === value))
      .sort((a, b) => Number(b.available) - Number(a.available))[0];
    const next = exact || fallback;
    if (next) setLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, variantId: next.id } : l)));
  }

  function setQuantity(key, q) {
    const n = Math.max(1, Math.min(999, Number(q) || 1));
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, quantity: n } : l)));
  }

  function addTag(raw) {
    const tag = String(raw || "").replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!tag) return;
    setTags((ts) => (ts.some((t) => t.toLowerCase() === tag.toLowerCase()) ? ts : [...ts, tag]));
    setTagInput("");
  }

  // ---------- Derived ----------
  const knownOrders = useMemo(() => {
    const byId = new Map();
    const sources = customer ? [customer, ...phoneMatches.customers] : phoneMatches.customers;
    for (const c of sources) for (const o of c.orders || []) if (o?.id && !byId.has(o.id)) byId.set(o.id, o);
    return [...byId.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [customer, phoneMatches.customers]);
  const recentOrders = knownOrders.filter(isRecent);
  const suggested = phoneMatches.customers.filter((c) => c.id !== customer?.id);

  const subtotal = lines.reduce((sum, l) => sum + Number(variantOf(l)?.price || 0) * Number(l.quantity || 0), 0);
  const shipping = Math.max(0, Number(String(shippingPrice).replace(",", ".")) || 0);
  const discountInput = Math.max(0, Number(String(discountValue).replace(",", ".")) || 0);
  const discountTooBig = discountType === "percentage" ? discountInput > 100 : discountInput > subtotal;
  const discount = discountTooBig ? 0 : discountType === "percentage"
    ? Math.round(subtotal * discountInput) / 100
    : discountInput;
  const total = Math.max(0, subtotal - discount) + shipping;

  const tagSuggestions = useMemo(() => {
    const tomorrow = isoToDDMMYY(todayISO(new Date(Date.now() + 86_400_000)));
    const list = [`cod ${todayDDMMYY()}`, `cod ${tomorrow}`, ...(me?.tags || [])];
    return list.filter((t, i) => t && list.indexOf(t) === i && !tags.some((x) => x.toLowerCase() === t.toLowerCase()));
  }, [me, tags]);

  const problems = [];
  const missing = {
    first_name: !form.first_name.trim(),
    phone: String(form.phone).replace(/\D/g, "").length < 9,
    city: !form.city.trim(),
    address1: !form.address1.trim(),
  };
  if (missing.first_name) problems.push("customer name");
  if (missing.phone) problems.push("a valid phone");
  if (missing.city) problems.push("city");
  if (missing.address1) problems.push("address");
  if (!lines.length) problems.push("at least one product");
  if (lines.some((l) => l.loading)) problems.push("products still loading");
  if (lines.some((l) => !l.loading && l.product && !variantOf(l))) problems.push("size / colour for every product");
  if (lines.some((l) => !l.loading && !l.product)) problems.push("remove or replace the product not found");
  if (discountTooBig) problems.push(discountType === "percentage" ? "a discount of 100 % or less" : "a discount no larger than the products total");
  const show = triedSubmit;

  async function submit(confirmDuplicate = false) {
    setTriedSubmit(true);
    if (problems.length) {
      setError(`Still needed: ${problems.join(", ")}.`);
      return;
    }
    setBusy(true); setError(null);
    try {
      const js = await ORDER_API.create(r.id, {
        customer_id: customer?.id || null,
        first_name: form.first_name,
        last_name: form.last_name,
        phone: form.phone,
        email: form.email || null,
        city: form.city,
        address1: form.address1,
        address2: form.address2 || null,
        country_code: "MA",
        lines: lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity })),
        tags,
        note: note || null,
        shipping_title: shipping > 0 ? shippingTitle : null,
        shipping_price: String(shipping),
        discount_type: discountInput > 0 ? discountType : null,
        discount_value: discountInput > 0 ? String(discountInput) : null,
        discount_code: discountInput > 0 ? (discountCode.trim() || null) : null,
        confirm_possible_duplicate: confirmDuplicate,
        client_action_id: newActionId(),
      });
      setMaybeCreated(false);
      setCreated(js.order);
      onCreated?.(js);
    } catch (e) {
      // A gateway error (502/504…) means the server's answer never arrived:
      // the order may exist, so treat it like Shopify not confirming.
      const lostAnswer = [502, 503, 504, 520, 521, 522, 523, 524].includes(e.status);
      if (e.code === "maybe_created" || lostAnswer) setMaybeCreated(true);
      setError(lostAnswer
        ? "The server did not answer, so the order may or may not have been created. Check the customer's recent orders first."
        : e.message || "Could not create the order");
    } finally {
      setBusy(false);
    }
  }

  async function linkExisting(orderName) {
    const ref = String(orderName || "").trim();
    if (!ref) return;
    setLinking(ref);
    const ok = await onLinkExisting?.(ref);
    setLinking(null);
    if (ok) onClose?.();
  }

  // ---------- Render ----------
  if (created) {
    const url = created.admin_url;
    return (
      <Shell onClose={onClose} busy={false} title="Order created" subtitle={`${store} · chat request #${r.id}`}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"><Check className="h-7 w-7" aria-hidden /></div>
          <div className="text-lg font-bold text-slate-900">Order {created.name} created</div>
          <div className="text-sm text-slate-500">Cash on delivery · the chat request is closed as ordered.</div>
          <div className="mt-2 flex gap-2">
            {url && <a href={url} target="_blank" rel="noopener noreferrer" className={`${BTN.secondary} h-10`}><ExternalLink className="h-4 w-4" aria-hidden /> Open in Shopify</a>}
            <button type="button" onClick={onClose} className={`${BTN.primary} h-10 px-5`}>Done</button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose} busy={busy} title="Create order" subtitle={<>{store} · chat request #{r.id} · cash on delivery</>}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            {recentOrders.length > 0 && (
              <div className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200 lg:hidden">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                <span><b>{recentOrders[0].name}</b> was placed {timeAgo(recentOrders[0].created_at)} by this customer — see “Customer's recent orders” below before creating another.</span>
              </div>
            )}
            {/* Customer */}
            <Section
              icon={UserRound}
              title="Customer"
              right={customer && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                  <UserCheck className="h-3.5 w-3.5" aria-hidden /> Shopify customer · {customer.name || "linked"}
                  <button type="button" onClick={() => setCustomer(null)} className="ml-0.5 rounded px-1 hover:bg-emerald-100" aria-label="Unlink customer">×</button>
                </span>
              )}
            >
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
                <input
                  type="search"
                  data-testid="order-customer-search"
                  value={customerQuery}
                  onChange={(e) => { setCustomerQuery(e.target.value); setShowCustomerMenu(true); }}
                  onFocus={() => setShowCustomerMenu(true)}
                  onBlur={() => setTimeout(() => setShowCustomerMenu(false), 150)}
                  placeholder="Search Shopify customers: phone, name or email"
                  className={`${INPUT} pl-9`}
                />
                {showCustomerMenu && (customerQuery.trim().length >= 2 || suggested.length > 0) && (
                  <div className="cf-pop-in absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-xl bg-white py-1 shadow-xl ring-1 ring-slate-900/10">
                    {customerQuery.trim().length < 2 && <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Same phone in Shopify</div>}
                    {customerResults.loading && <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500"><Spinner className="h-3.5 w-3.5" /> Searching…</div>}
                    {customerResults.error && <div className="px-3 py-2 text-xs text-rose-700">{customerResults.error}</div>}
                    {(customerQuery.trim().length >= 2 ? customerResults.customers : suggested).map((c) => (
                      <CustomerOption key={c.id} customer={c} onPick={() => pickCustomer(c)} />
                    ))}
                    {customerQuery.trim().length >= 2 && !customerResults.loading && !customerResults.error && customerResults.customers.length === 0 && (
                      <div className="px-3 py-2 text-xs text-slate-500">No customer found. Fill in the fields below to create a new one.</div>
                    )}
                  </div>
                )}
              </div>

              {!customer && suggested.length > 0 && (
                <div className="mt-2 rounded-xl bg-indigo-50/70 p-2 ring-1 ring-inset ring-indigo-200">
                  <div className="mb-1 px-1 text-[11px] font-semibold text-indigo-900">
                    {suggested.length === 1 ? "This phone already belongs to a Shopify customer" : `${suggested.length} Shopify customers have this phone`}
                  </div>
                  {suggested.map((c) => <CustomerOption key={c.id} customer={c} onPick={() => pickCustomer(c)} cta="Use this customer" />)}
                </div>
              )}
              {phoneMatches.loading && <div className="mt-2 flex items-center gap-2 text-xs text-slate-500"><Spinner className="h-3.5 w-3.5" /> Looking for this phone in Shopify…</div>}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="First name" required error={show && missing.first_name}>
                  <input value={form.first_name} onChange={setField("first_name")} className={INPUT} data-testid="order-first-name" />
                </Field>
                <Field label="Last name">
                  <input value={form.last_name} onChange={setField("last_name")} className={INPUT} />
                </Field>
                <Field label="Phone" required error={show && missing.phone}>
                  <input value={form.phone} onChange={setField("phone")} inputMode="tel" className={`${INPUT} font-mono`} />
                </Field>
                <Field label="Email" hint="optional">
                  <input value={form.email} onChange={setField("email")} type="email" className={INPUT} />
                </Field>
                <Field label="City" required error={show && missing.city}>
                  <input value={form.city} onChange={setField("city")} list="chat-order-cities" className={INPUT} data-testid="order-city" placeholder="e.g. Casablanca" />
                  <datalist id="chat-order-cities">{MOROCCO_CITIES.map((c) => <option key={c} value={c} />)}</datalist>
                </Field>
                <Field label="Country">
                  <div className="flex h-10 items-center rounded-xl bg-slate-50 px-3 text-sm text-slate-600 ring-1 ring-inset ring-slate-200"><MapPin className="mr-1.5 h-4 w-4 text-slate-400" aria-hidden />Morocco</div>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Address" required error={show && missing.address1}>
                    <input value={form.address1} onChange={setField("address1")} className={INPUT} data-testid="order-address" placeholder="Street, neighbourhood, building…" />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field label="Landmark / apartment" hint="optional">
                    <input value={form.address2} onChange={setField("address2")} className={INPUT} placeholder="Near the mosque, 2nd floor…" />
                  </Field>
                </div>
              </div>
            </Section>

            {/* Products */}
            <Section icon={Package} title="Products" right={<span className="text-xs text-slate-500">{lines.length} item{lines.length === 1 ? "" : "s"}</span>}>
              <div className="space-y-3">
                {lines.map((line) => (
                  <OrderLine
                    key={line.key}
                    line={line}
                    highlight={replaceKey === line.key}
                    showErrors={show}
                    onPick={(name, value) => pickOption(line, name, value)}
                    onQuantity={(q) => setQuantity(line.key, q)}
                    onRemove={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                    onReplace={() => { setReplaceKey(line.key); setTimeout(() => productInputRef.current?.focus(), 0); }}
                  />
                ))}
                {lines.length === 0 && <div className="rounded-xl bg-slate-50 px-3 py-4 text-center text-xs text-slate-500 ring-1 ring-inset ring-slate-200">No product yet. Search below to add one.</div>}
              </div>

              <div className={`mt-3 rounded-xl p-2 ring-1 ring-inset ${replaceKey ? "bg-indigo-50 ring-indigo-200" : "bg-slate-50 ring-slate-200"}`}>
                {replaceKey && (
                  <div className="mb-1.5 flex items-center gap-2 px-1 text-xs font-semibold text-indigo-800">
                    Pick the product that replaces it
                    <button type="button" onClick={() => setReplaceKey(null)} className="ml-auto font-medium text-indigo-600 hover:underline">Cancel</button>
                  </div>
                )}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
                  <input
                    ref={productInputRef}
                    type="search"
                    data-testid="order-product-search"
                    value={productQuery}
                    onChange={(e) => setProductQuery(e.target.value)}
                    placeholder={replaceKey ? "Search the new product…" : "Add a product: name or SKU"}
                    className={`${INPUT} pl-9`}
                  />
                </div>
                {(productQuery.trim().length >= 2) && (
                  <div className="mt-1.5 max-h-72 space-y-1 overflow-auto">
                    {productResults.loading && <div className="flex items-center gap-2 px-2 py-2 text-xs text-slate-500"><Spinner className="h-3.5 w-3.5" /> Searching products…</div>}
                    {productResults.error && <div className="px-2 py-2 text-xs text-rose-700">{productResults.error}</div>}
                    {!productResults.loading && !productResults.error && productResults.variants.length === 0 && <div className="px-2 py-2 text-xs text-slate-500">No product found.</div>}
                    {productResults.variants.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        data-testid="order-product-result"
                        onClick={() => addVariant(v)}
                        className="flex w-full items-center gap-2.5 rounded-lg bg-white px-2 py-1.5 text-left ring-1 ring-inset ring-slate-200 hover:bg-indigo-50 hover:ring-indigo-200"
                      >
                        {v.image ? <img src={v.image} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-slate-100"><Package className="h-4 w-4 text-slate-400" aria-hidden /></span>}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-900">{v.product_title}</span>
                          <span className="mt-0.5 block"><OptionBadges options={v.options} /></span>
                        </span>
                        <span className="shrink-0 text-right text-xs">
                          <span className="block font-semibold tabular-nums text-slate-900">{money(v.price)} {CURRENCY}</span>
                          <span className={`block ${Number(v.inventory_quantity) > 0 ? "text-emerald-600" : "text-rose-600"}`}>{v.inventory_quantity == null ? "" : `${v.inventory_quantity} in stock`}</span>
                        </span>
                        <Plus className="h-4 w-4 shrink-0 text-indigo-600" aria-hidden />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Section>

            {/* Tags + note */}
            <Section icon={Tag} title="Tags and note">
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-white p-1.5 ring-1 ring-inset ring-slate-200 focus-within:ring-2 focus-within:ring-indigo-500">
                {tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-800 ring-1 ring-inset ring-indigo-200">
                    {t}
                    <button type="button" onClick={() => setTags((ts) => ts.filter((x) => x !== t))} className="rounded px-0.5 opacity-60 hover:opacity-100" aria-label={`Remove tag ${t}`}>×</button>
                  </span>
                ))}
                <input
                  value={tagInput}
                  data-testid="order-tag-input"
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagInput); }
                    if (e.key === "Backspace" && !tagInput && tags.length) setTags((ts) => ts.slice(0, -1));
                  }}
                  onBlur={() => addTag(tagInput)}
                  placeholder={tags.length ? "" : "Add a tag and press Enter"}
                  className="h-8 min-w-[140px] flex-1 border-0 bg-transparent px-1.5 text-sm focus:ring-0"
                />
              </div>
              {tagSuggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {tagSuggestions.map((t) => (
                    <button key={t} type="button" onClick={() => addTag(t)} className="inline-flex h-7 items-center gap-1 rounded-lg bg-white px-2 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50">
                      <Plus className="h-3 w-3" aria-hidden /> {t}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-3">
                <Field label="Order note" hint="shown on the Shopify order">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. call before delivery, wants to try the size first…" className={`${INPUT} h-auto py-2`} />
                </Field>
              </div>
            </Section>
          </div>

          {/* Side: duplicates + summary */}
          <div className="min-w-0 space-y-4">
            <Section icon={ShoppingBag} title="Customer's recent orders">
              {phoneMatches.loading ? (
                <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="cf-shimmer h-14 rounded-xl" />)}</div>
              ) : knownOrders.length === 0 ? (
                <p className="text-xs text-slate-500">{phoneMatches.error ? `Couldn't check Shopify: ${phoneMatches.error}` : "No order in Shopify for this customer yet."}</p>
              ) : (
                <>
                  {recentOrders.length > 0 && (
                    <div className="mb-2 flex gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200" data-testid="order-duplicate-warning">
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                      <span>
                        <b>{recentOrders[0].name}</b> was placed {timeAgo(recentOrders[0].created_at)}.
                        {" "}If it's the same order, link it instead of creating a new one.
                      </span>
                    </div>
                  )}
                  <div className="space-y-2">
                    {knownOrders.slice(0, 6).map((o) => (
                      <RecentOrder
                        key={o.id}
                        order={o}
                        shopDomain={shopDomain}
                        linking={linking === o.name}
                        onLink={() => linkExisting(o.name)}
                      />
                    ))}
                  </div>
                </>
              )}
              <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                <input value={manualRef} onChange={(e) => setManualRef(e.target.value)} placeholder="Order # e.g. #1234" className="h-8 min-w-0 flex-1 rounded-lg border-0 px-2 text-xs ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-indigo-500" />
                <button type="button" disabled={!manualRef.trim() || !!linking} onClick={() => linkExisting(manualRef)} className={`${BTN.secondary} h-8 text-xs`}>
                  <Link2 className="h-3.5 w-3.5" aria-hidden /> Link order
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">Already ordered on the website? Link that order and no new one is created.</p>
            </Section>

            <Section icon={Truck} title="Shipping, discount and total">
              <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2">
                <Field label="Shipping">
                  <input value={shippingTitle} onChange={(e) => setShippingTitle(e.target.value)} className={INPUT} />
                </Field>
                <Field label={`Price (${CURRENCY})`} hint={shipping === 0 ? "free" : ""}>
                  <input value={shippingPrice} onChange={(e) => setShippingPrice(e.target.value)} inputMode="decimal" className={`${INPUT} tabular-nums`} />
                </Field>
              </div>
              <div className="mt-3">
                <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-slate-700">
                  Discount
                  <span className="ml-auto font-normal text-slate-400">optional</span>
                </span>
                <div className="flex gap-2">
                  <div className="inline-flex h-10 shrink-0 rounded-xl bg-slate-100 p-1" role="radiogroup" aria-label="Discount type">
                    {[["percentage", "%"], ["amount", CURRENCY]].map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={discountType === key}
                        data-testid={`order-discount-${key}`}
                        onClick={() => setDiscountType(key)}
                        className={`rounded-lg px-3 text-xs font-bold transition ${discountType === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                      >{label}</button>
                    ))}
                  </div>
                  <input
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    inputMode="decimal"
                    data-testid="order-discount-value"
                    placeholder={discountType === "percentage" ? "e.g. 10" : "e.g. 50"}
                    className={`${INPUT} min-w-0 tabular-nums ${discountTooBig ? "ring-2 ring-rose-300" : ""}`}
                  />
                </div>
                {discountInput > 0 && (
                  <input
                    value={discountCode}
                    onChange={(e) => setDiscountCode(e.target.value)}
                    placeholder="Discount name shown in Shopify (default REMISE)"
                    className={`${INPUT} mt-2 h-9 text-xs`}
                  />
                )}
                {discountTooBig && (
                  <p className="mt-1 text-xs text-rose-600">
                    {discountType === "percentage" ? "A percentage can't be more than 100." : "The discount is larger than the products total."}
                  </p>
                )}
              </div>
              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between text-slate-600"><dt>Products</dt><dd className="tabular-nums">{money(subtotal)} {CURRENCY}</dd></div>
                {discount > 0 && (
                  <div className="flex justify-between font-medium text-emerald-700" data-testid="order-discount-line">
                    <dt>Discount{discountType === "percentage" ? ` (${discountInput} %)` : ""}</dt>
                    <dd className="tabular-nums">−{money(discount)} {CURRENCY}</dd>
                  </div>
                )}
                <div className="flex justify-between text-slate-600"><dt>Shipping</dt><dd className="tabular-nums">{shipping ? `${money(shipping)} ${CURRENCY}` : "Free"}</dd></div>
                <div className="flex justify-between border-t border-slate-100 pt-1.5 text-base font-bold text-slate-900"><dt>Total to collect</dt><dd className="tabular-nums" data-testid="order-total">{money(total)} {CURRENCY}</dd></div>
              </dl>
            </Section>
          </div>
        </div>
      </div>

      <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
        {maybeCreated && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
            <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
            <span className="flex-1">{error || "The last try may already have created this order in Shopify. Check the customer's recent orders first."}</span>
            <button type="button" disabled={busy} onClick={() => submit(true)} className="rounded-lg bg-amber-600 px-2.5 py-1 font-semibold text-white hover:bg-amber-700 disabled:opacity-50">Create anyway</button>
          </div>
        )}
        {error && !maybeCreated && (
          <div className="mb-2 flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-inset ring-rose-200" data-testid="order-error">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden /><span>{error}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-slate-500 sm:inline">Cash on delivery · payment pending in Shopify</span>
          <button type="button" onClick={onClose} disabled={busy} className={`${BTN.secondary} ml-auto h-11`}>Cancel</button>
          <button
            type="button"
            data-testid="order-create-submit"
            onClick={() => submit(false)}
            disabled={busy}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-bold text-white shadow-sm shadow-emerald-600/25 transition hover:bg-emerald-700 active:scale-[0.97] disabled:opacity-60"
          >
            {busy ? <><Spinner /> Creating…</> : <><ShoppingBag className="h-4 w-4" aria-hidden /> Create order · {money(total)} {CURRENCY}</>}
          </button>
        </div>
      </footer>
    </Shell>
  );
}

function Shell({ onClose, busy, title, subtitle, children }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-create-order-title"
      className="cf-fade-in fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}
    >
      <div className="cf-pop-in flex h-[96vh] w-full max-w-6xl flex-col overflow-hidden rounded-t-2xl bg-slate-50 shadow-2xl ring-1 ring-slate-900/10 sm:h-[min(94vh,960px)] sm:rounded-2xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-200"><ShoppingBag className="h-5 w-5" aria-hidden /></span>
          <div className="min-w-0">
            <h2 id="chat-create-order-title" className="text-base font-semibold text-slate-900">{title}</h2>
            <div className="truncate text-xs text-slate-500">{subtitle}</div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className={`${BTN.ghost} ml-auto h-9 w-9 !px-0`} aria-label="Close"><X className="h-4 w-4" aria-hidden /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

function CustomerOption({ customer: c, onPick, cta = "Use" }) {
  return (
    <button
      type="button"
      data-testid="order-customer-option"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-indigo-50"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-xs font-bold text-indigo-700">{initialOf(c.name || c.phone)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-900">{c.name || "No name"}</span>
        <span className="block truncate text-[11px] text-slate-500">
          {[localPhone(c.phone || c.address?.phone), c.address?.city, `${c.orders_count} order${c.orders_count === 1 ? "" : "s"}`, c.email].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="hidden shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 sm:inline">{c.orders_count} order{c.orders_count === 1 ? "" : "s"}</span>
      <span className="shrink-0 text-xs font-semibold text-indigo-700"><span className="hidden sm:inline">{cta}</span><span className="sm:hidden">Use</span></span>
    </button>
  );
}

function RecentOrder({ order: o, shopDomain, linking, onLink }) {
  const url = adminOrderUrl(shopDomain, o);
  const recent = isRecent(o);
  return (
    <div className={`rounded-xl p-2.5 ring-1 ring-inset ${recent ? "bg-amber-50/60 ring-amber-200" : "bg-white ring-slate-200"}`}>
      <div className="flex items-center gap-2 text-xs">
        {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="font-bold text-indigo-700 hover:underline">{o.name}</a> : <b>{o.name}</b>}
        <span className="text-slate-400">{timeAgo(o.created_at)}</span>
        {o.cancelled_at && <span className="rounded bg-rose-50 px-1.5 text-[10px] font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">Cancelled</span>}
        <span className="ml-auto font-semibold tabular-nums text-slate-900">{o.total_price} {o.currency}</span>
      </div>
      <div className="mt-1 space-y-1">
        {(o.line_items || []).slice(0, 3).map((li) => (
          <div key={li.id} className="flex items-center gap-1.5 text-[11px] text-slate-700">
            <span className="truncate">{li.quantity}× {li.title}</span>
            <OptionBadges options={li.options} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="truncate text-[10px] text-slate-500">{[o.fulfillment_status, ...(o.tags || []).slice(0, 2)].filter(Boolean).join(" · ")}</span>
        {!o.cancelled_at && (
          <button type="button" onClick={onLink} disabled={linking} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:opacity-50">
            {linking ? <Spinner className="h-3 w-3" /> : <Link2 className="h-3 w-3" aria-hidden />} This is the order
          </button>
        )}
      </div>
    </div>
  );
}

function OrderLine({ line, highlight, showErrors, onPick, onQuantity, onRemove, onReplace }) {
  const variant = variantOf(line);
  const product = line.product;
  if (line.loading) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-inset ring-slate-200">
        <div className="cf-shimmer h-14 w-14 rounded-lg" />
        <div className="flex-1 space-y-2"><div className="cf-shimmer h-4 w-1/2 rounded" /><div className="cf-shimmer h-6 w-2/3 rounded" /></div>
        <Spinner className="h-4 w-4 text-slate-400" />
      </div>
    );
  }
  if (!product) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-800 ring-1 ring-inset ring-rose-200">
        <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1">{line.error || "The product from the chat wasn't found in Shopify. Search for it below."}</span>
        <button type="button" onClick={onReplace} className="font-semibold underline">Find it</button>
        <button type="button" onClick={onRemove} className="rounded p-1 hover:bg-rose-100" aria-label="Remove"><Trash2 className="h-4 w-4" aria-hidden /></button>
      </div>
    );
  }
  const image = variant?.image || product.image;
  const needsPick = !variant;
  const lineTotal = Number(variant?.price || 0) * Number(line.quantity || 0);
  const values = (name) => {
    const seen = [];
    for (const v of product.variants) for (const o of v.options) if (o.name === name && !seen.includes(o.value)) seen.push(o.value);
    return seen;
  };
  const selected = {};
  for (const o of variant?.options || []) selected[o.name] = o.value;

  return (
    <div className={`rounded-xl bg-white p-3 ring-1 ring-inset ${highlight ? "ring-2 ring-indigo-400" : needsPick && showErrors ? "ring-2 ring-rose-300" : "ring-slate-200"}`} data-testid="order-line">
      <div className="flex gap-3">
        {image ? <img src={image} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover ring-1 ring-slate-200" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100"><Package className="h-5 w-5 text-slate-400" aria-hidden /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-slate-900" title={product.title}>{product.title}</div>
              <div className="mt-1" data-testid="order-line-selected">
                {variant ? <OptionBadges options={variant.options} size="lg" /> : (
                  <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">
                    <CircleAlert className="h-3.5 w-3.5" aria-hidden /> Pick the size / colour
                  </span>
                )}
              </div>
              {line.fromChat && <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-500">From the chat</div>}
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-bold tabular-nums text-slate-900">{money(lineTotal)} {CURRENCY}</div>
              {variant && <div className="text-[11px] tabular-nums text-slate-500">{money(variant.price)} each</div>}
              {variant && (
                <div className={`mt-0.5 text-[11px] font-semibold ${variant.available ? "text-emerald-600" : "text-rose-600"}`}>
                  {variant.available ? (variant.inventory_quantity != null && variant.inventory_policy !== "CONTINUE" ? `${variant.inventory_quantity} in stock` : "Available") : "Out of stock"}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {product.option_names.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {product.option_names.map((name) => {
            const style = KIND_STYLE[optionKind(name)];
            return (
              <div key={name} className={`flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1.5 ring-1 ring-inset ${style.box}`}>
                <span className={`mr-1 text-[11px] font-bold uppercase tracking-wide ${style.label}`}>{name}</span>
                {values(name).map((value) => {
                  const on = selected[name] === value;
                  const combo = product.variants.find((v) => v.options.every((o) => (o.name === name ? o.value === value : selected[o.name] === undefined || selected[o.name] === o.value)));
                  const soldOut = combo ? !combo.available : false;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => onPick(name, value)}
                      aria-pressed={on}
                      title={soldOut ? "Out of stock" : !combo ? "Not available with the other choices — switches them" : ""}
                      className={`h-7 rounded-lg px-2.5 text-xs font-semibold ring-1 ring-inset transition active:scale-[0.96] ${
                        on ? `${style.on} shadow-sm` : combo ? "bg-white text-slate-700 ring-slate-200 hover:ring-slate-400" : "bg-white/60 text-slate-400 ring-dashed ring-slate-200"
                      } ${soldOut && !on ? "line-through decoration-rose-400" : ""}`}
                    >{value}</button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <div className="inline-flex h-8 items-center rounded-lg ring-1 ring-inset ring-slate-300">
          <button type="button" onClick={() => onQuantity(line.quantity - 1)} disabled={line.quantity <= 1} className="flex h-full w-8 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-30" aria-label="Decrease quantity"><Minus className="h-3.5 w-3.5" /></button>
          <input value={line.quantity} onChange={(e) => onQuantity(e.target.value)} inputMode="numeric" className="h-full w-10 border-x border-slate-200 bg-transparent text-center text-sm font-semibold tabular-nums focus:outline-none" aria-label="Quantity" />
          <button type="button" onClick={() => onQuantity(line.quantity + 1)} className="flex h-full w-8 items-center justify-center text-slate-600 hover:bg-slate-50" aria-label="Increase quantity"><Plus className="h-3.5 w-3.5" /></button>
        </div>
        <button type="button" onClick={onReplace} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50">Change product</button>
        <button type="button" onClick={onRemove} className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Remove product"><Trash2 className="h-4 w-4" aria-hidden /></button>
      </div>
    </div>
  );
}
