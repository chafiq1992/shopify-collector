import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ClipboardList,
  Loader2,
  MapPin,
  PackageOpen,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import StorePicker from "../components/StorePicker.jsx";
import { authFetch, authHeaders, loadAuth } from "../lib/auth";
import { persistStoreSelection, readCurrentStore } from "../lib/stores";


async function apiJson(url, options = {}) {
  const response = await authFetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.detail || "Something went wrong");
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body;
}


function go(path) {
  try {
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch {
    location.href = path;
  }
}


function statusStyle(status) {
  if (status === "matched") return {
    row: "border-emerald-200 bg-emerald-50/70",
    badge: "border-emerald-200 bg-emerald-100 text-emerald-800",
    label: "Matched",
    icon: CheckCircle2,
  };
  if (status === "mismatch") return {
    row: "border-rose-200 bg-rose-50/80",
    badge: "border-rose-200 bg-rose-100 text-rose-800",
    label: "Mismatch",
    icon: AlertTriangle,
  };
  return {
    row: "border-emerald-200 bg-emerald-50/60",
    badge: "border-emerald-200 bg-white text-emerald-800",
    label: "Ready to count",
    icon: PackageOpen,
  };
}


function differenceText(receipt) {
  if (receipt?.actual_crates == null || receipt?.actual_items == null) {
    return "The receiving count has not been submitted yet.";
  }
  const hasCratePlan = Number(receipt.ordered_crates) > 0;
  const crateDiff = hasCratePlan ? Number(receipt.actual_crates) - Number(receipt.ordered_crates) : 0;
  const itemDiff = Number(receipt.actual_items) - Number(receipt.expected_items);
  const variantDiffs = (receipt.line_items || []).filter((item) => item.actual_quantity != null && Number(item.actual_quantity) !== Number(item.ordered_quantity));
  if (crateDiff === 0 && itemDiff === 0 && variantDiffs.length === 0) return "Crates and every variant match the purchase order.";
  const parts = [];
  if (crateDiff) parts.push(`${Math.abs(crateDiff)} ${crateDiff > 0 ? "more" : "fewer"} crate${Math.abs(crateDiff) === 1 ? "" : "s"}`);
  if (itemDiff) parts.push(`${Math.abs(itemDiff)} ${itemDiff > 0 ? "more" : "fewer"} item${Math.abs(itemDiff) === 1 ? "" : "s"}`);
  if (variantDiffs.length) parts.push(`${variantDiffs.length} variant${variantDiffs.length === 1 ? "" : "s"} differ`);
  return parts.join(" · ");
}


function ProductThumb({ src, alt = "Product" }) {
  if (!src) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-100 text-slate-400">
        <Boxes className="h-5 w-5" />
      </div>
    );
  }
  return <img src={src} alt={alt} className="h-12 w-12 shrink-0 rounded-xl border border-slate-200 bg-white object-cover" />;
}


function shortDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  return match ? `${match[3]}/${match[2]}` : "";
}


function orderedLabel(receipt) {
  const date = String(receipt?.shopify_created_at || "").slice(0, 10);
  if (!date) return "Linked Shopify transfer";
  return `Transfer created ${shortDate(date)}`;
}


function localDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}


async function mobilePhoto(file) {
  if (!file?.type?.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= 1800 && file.size <= 5.5 * 1024 * 1024) {
      bitmap.close?.();
      return file;
    }
    const scale = Math.min(1, 1800 / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "crate"}.jpg`, { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}


function PrivatePhoto({ photo, onDelete, canDelete }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    let objectUrl = "";
    (async () => {
      try {
        const response = await authFetch(photo.url, { headers: authHeaders() });
        if (!response.ok) return;
        objectUrl = URL.createObjectURL(await response.blob());
        if (live) setSrc(objectUrl);
      } catch {}
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photo.id, photo.url]);

  return (
    <div className="group relative aspect-square overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
      {src ? <img src={src} alt="Received crate" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>}
      {canDelete && (
        <button type="button" onClick={() => onDelete(photo.id)} className="absolute right-2 top-2 rounded-full bg-white/95 p-2 text-rose-600 shadow-sm" aria-label="Remove photo">
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}


function QuantityField({ value, onChange, label, disabled = false }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min="0"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value || 0)))}
        className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-bold text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-600"
      />
    </label>
  );
}


export default function InventoryHelper() {
  const auth = loadAuth();
  const isAdmin = auth?.user?.role === "admin";
  const [store, setStore] = useState(() => readCurrentStore());
  const [receipts, setReceipts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsShopifyReconnect, setNeedsShopifyReconnect] = useState(false);

  const [reference, setReference] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [browseDate, setBrowseDate] = useState(localDateInput);
  const [availableTransfers, setAvailableTransfers] = useState([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [choosingTransferId, setChoosingTransferId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftCrates, setDraftCrates] = useState(0);
  const [savingDraft, setSavingDraft] = useState(false);

  const selected = receipts.find((receipt) => receipt.id === selectedId) || null;
  const [adminItems, setAdminItems] = useState([]);
  const [agentItems, setAgentItems] = useState([]);
  const [adminCrates, setAdminCrates] = useState(0);
  const [actualCrates, setActualCrates] = useState(0);
  const [agentNote, setAgentNote] = useState("");
  const [countBusy, setCountBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const detailRef = useRef(null);
  const actualItems = useMemo(
    () => agentItems.reduce((sum, item) => sum + Number(item.actual_quantity || 0), 0),
    [agentItems],
  );
  const reconnectUrl = `/api/shopify/oauth/start?store=${encodeURIComponent(store)}&return_to=${encodeURIComponent(`/inventory-helper?store=${store}`)}`;

  function showApiError(err) {
    const message = err?.message || "Something went wrong";
    setError(message);
    if (err?.status === 403 && /reconnect this shopify store/i.test(message)) {
      setNeedsShopifyReconnect(true);
    }
  }

  const totals = useMemo(() => ({
    all: receipts.length,
    waiting: receipts.filter((item) => item.status === "waiting").length,
    mismatch: receipts.filter((item) => item.status === "mismatch").length,
    matched: receipts.filter((item) => item.status === "matched").length,
  }), [receipts]);

  useEffect(() => {
    persistStoreSelection(store);
    setNeedsShopifyReconnect(false);
    loadReceipts();
  }, [store]);

  useEffect(() => {
    if (!selected) return;
    setAdminItems((selected.line_items || []).map((item) => ({ ...item })));
    setAgentItems((selected.line_items || []).map((item) => ({
      ...item,
      actual_quantity: item.actual_quantity ?? (Number(item.shopify_received_quantity || 0) > 0 ? item.shopify_received_quantity : item.ordered_quantity),
    })));
    setAdminCrates(Number(selected.ordered_crates || 0));
    setActualCrates(selected.actual_crates ?? selected.ordered_crates ?? 0);
    setAgentNote(selected.agent_note || "");
  }, [selected?.id, selected?.updated_at]);

  async function loadReceipts(preferredId) {
    setLoading(true);
    setError("");
    try {
      const data = await apiJson(`/api/inventory-helper/receipts?store=${encodeURIComponent(store)}`, {
        headers: authHeaders({ Accept: "application/json" }),
      });
      const list = data.receipts || [];
      setReceipts(list);
      setSelectedId((current) => preferredId || (list.some((item) => item.id === current) ? current : null));
    } catch (err) {
      showApiError(err);
    } finally {
      setLoading(false);
    }
  }

  function openReceipt(receiptId) {
    setSelectedId(receiptId);
    window.setTimeout(() => detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 60);
  }

  function closeCreate() {
    if (savingDraft || lookupBusy || browseBusy || choosingTransferId) return;
    setShowCreate(false);
    setDraft(null);
    setReference("");
    setAvailableTransfers([]);
  }

  function refreshCurrent() {
    loadReceipts(selected?.id);
  }

  function replaceReceipt(next) {
    setReceipts((current) => current.map((item) => item.id === next.id ? next : item));
  }

  async function lookup(event) {
    event?.preventDefault();
    if (!reference.trim()) return;
    setLookupBusy(true);
    setError("");
    setDraft(null);
    try {
      const data = await apiJson(`/api/inventory-helper/lookup?store=${encodeURIComponent(store)}&reference=${encodeURIComponent(reference.trim())}`, {
        headers: authHeaders({ Accept: "application/json" }),
      });
      setDraft({ ...data, line_items: (data.line_items || []).map((item) => ({ ...item })) });
      setDraftCrates(0);
    } catch (err) {
      showApiError(err);
    } finally {
      setLookupBusy(false);
    }
  }

  async function loadAvailable(event) {
    event?.preventDefault();
    if (!browseDate) return;
    setBrowseBusy(true);
    setError("");
    setNotice("");
    setDraft(null);
    try {
      const data = await apiJson(`/api/inventory-helper/available?store=${encodeURIComponent(store)}&purchase_date=${encodeURIComponent(browseDate)}`, {
        headers: authHeaders({ Accept: "application/json" }),
      });
      setAvailableTransfers(data.transfers || []);
      if (!(data.transfers || []).length) {
        setNotice(`No linked inventory transfers were created on ${browseDate}.`);
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setBrowseBusy(false);
    }
  }

  async function chooseTransfer(transfer) {
    if (transfer.already_added || choosingTransferId) return;
    setChoosingTransferId(transfer.shopify_order_gid);
    setError("");
    setNotice("");
    try {
      const data = await apiJson(`/api/inventory-helper/lookup?store=${encodeURIComponent(store)}&reference=${encodeURIComponent(transfer.shopify_order_gid)}`, {
        headers: authHeaders({ Accept: "application/json" }),
      });
      setDraft({ ...data, line_items: (data.line_items || []).map((item) => ({ ...item })) });
      setDraftCrates(0);
    } catch (err) {
      showApiError(err);
    } finally {
      setChoosingTransferId(null);
    }
  }

  function changeDraftQuantity(index, value) {
    setDraft((current) => ({
      ...current,
      line_items: current.line_items.map((item, itemIndex) => itemIndex === index ? { ...item, ordered_quantity: value } : item),
    }));
  }

  async function saveDraft() {
    if (!draft) return;
    setSavingDraft(true);
    setError("");
    try {
      const saved = await apiJson("/api/inventory-helper/receipts", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ...draft, ordered_crates: draftCrates }),
      });
      setDraft(null);
      setReference("");
      setAvailableTransfers((current) => current.map((item) => item.shopify_order_gid === saved.shopify_order_gid ? { ...item, already_added: true } : item));
      setNotice(`${saved.order_number} added to Inventory Helper.`);
      setShowCreate(false);
      await loadReceipts(saved.id);
      window.setTimeout(() => detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 60);
    } catch (err) {
      showApiError(err);
    } finally {
      setSavingDraft(false);
    }
  }

  async function saveAdminPlan() {
    if (!selected) return;
    setCountBusy(true);
    setError("");
    try {
      const saved = await apiJson(`/api/inventory-helper/receipts/${selected.id}/admin`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ordered_crates: adminCrates, line_items: adminItems }),
      });
      replaceReceipt(saved);
      setNotice("Purchase order plan updated.");
    } catch (err) {
      showApiError(err);
    } finally {
      setCountBusy(false);
    }
  }

  async function saveCount(event) {
    event.preventDefault();
    if (!selected) return;
    setCountBusy(true);
    setError("");
    try {
      const saved = await apiJson(`/api/inventory-helper/receipts/${selected.id}/count`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          actual_crates: actualCrates,
          agent_note: agentNote,
          sync_inventory: true,
          line_items: agentItems.map((item) => ({ id: item.id, actual_quantity: Number(item.actual_quantity || 0) })),
        }),
      });
      replaceReceipt(saved);
      const operations = saved.inventory_operations || [];
      setNotice(
        operations.length
          ? `${saved.status === "matched" ? "Count matches." : "Mismatch saved."} Shopify inventory updated: ${operations.join("; ")}.`
          : `${saved.status === "matched" ? "Count saved — everything matches." : "Count saved — mismatch highlighted for review."} No Shopify quantity change was needed.`,
      );
    } catch (err) {
      showApiError(err);
    } finally {
      setCountBusy(false);
    }
  }

  async function uploadPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selected) return;
    setPhotoBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("photo", await mobilePhoto(file));
      const saved = await apiJson(`/api/inventory-helper/receipts/${selected.id}/photos`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      replaceReceipt(saved);
      setNotice("Crate photo added.");
    } catch (err) {
      showApiError(err);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function deletePhoto(photoId) {
    if (!selected) return;
    try {
      const response = await authFetch(`/api/inventory-helper/photos/${photoId}`, { method: "DELETE", headers: authHeaders() });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.detail || "Could not remove photo");
      replaceReceipt({ ...selected, photos: selected.photos.filter((photo) => photo.id !== photoId) });
    } catch (err) {
      showApiError(err);
    }
  }

  const selectedTone = statusStyle(selected?.status);
  const SelectedIcon = selectedTone.icon;

  return (
    <div className="min-h-screen bg-[#f6f7f9] text-slate-950">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <button type="button" onClick={() => go(auth?.user?.role === "agent" ? "/confirmation" : "/")} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white"><PackageOpen className="h-5 w-5" /></div>
          <div>
            <h1 className="text-base font-extrabold tracking-tight sm:text-lg">Inventory Helper</h1>
            <p className="hidden text-xs text-slate-500 sm:block">Purchase orders in, checked crates out.</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <StorePicker value={store} onChange={setStore} allowCustom />
            <button type="button" onClick={refreshCurrent} className="rounded-xl border border-slate-200 p-2.5 text-slate-600 hover:bg-slate-50" aria-label="Refresh"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5 sm:px-6 sm:py-7">
        {(error || notice) && (
          <div className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-medium ${error ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
            <span>{error || notice}</span>
            {isAdmin && needsShopifyReconnect && (
              <a href={reconnectUrl} className="ml-auto rounded-xl bg-rose-800 px-3 py-2 text-xs font-black text-white">
                Reconnect Shopify
              </a>
            )}
          </div>
        )}

        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-indigo-600">Receiving queue</div>
              <h2 className="text-lg font-black">Purchase orders</h2>
              <p className="text-xs text-slate-500">Newest first · scroll down for older purchase orders.</p>
            </div>
            {isAdmin && <button type="button" onClick={() => { setShowCreate(true); setError(""); setNotice(""); }} className="ml-auto inline-flex h-10 items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-black text-white shadow-sm"><Plus className="h-4 w-4" /> Add from Shopify</button>}
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm font-semibold text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Loading purchase orders…</div>
          ) : !receipts.length ? (
            <div className="p-10 text-center"><ClipboardList className="mx-auto mb-3 h-9 w-9 text-slate-300" /><div className="font-black">No purchase orders added yet</div><p className="mx-auto mt-1 max-w-lg text-sm text-slate-500">{isAdmin ? "In Shopify, mark the purchase order as ordered and create its linked inventory transfer. Then paste the transfer name or PO reference here." : "An admin has not added a purchase order yet."}</p></div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 p-2.5 sm:grid-cols-3 sm:gap-4 sm:p-4 lg:grid-cols-4">
              {receipts.map((receipt) => {
                const tone = statusStyle(receipt.status);
                const Icon = tone.icon;
                const image = receipt.line_items?.find((item) => item.image_url)?.image_url;
                const isCounted = receipt.actual_items != null && receipt.actual_crates != null;
                return (
                  <button key={receipt.id} type="button" onClick={() => openReceipt(receipt.id)} className={`min-w-0 overflow-hidden rounded-2xl border text-left shadow-sm transition active:scale-[0.98] ${tone.row} ${selected?.id === receipt.id ? "ring-2 ring-indigo-500 ring-offset-2" : "hover:shadow-md"}`}>
                    <div className="relative aspect-[4/3] overflow-hidden bg-slate-100">
                      {image ? <img src={image} alt={receipt.line_items?.[0]?.title || "Purchase order product"} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-slate-300"><Boxes className="h-9 w-9" /></div>}
                      <span className={`absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-black shadow-sm ${tone.badge}`}><Icon className="h-3 w-3" />{tone.label}</span>
                    </div>
                    <div className="space-y-2 p-2.5 sm:p-3">
                      <div className="min-w-0"><div className="truncate text-sm font-black sm:text-base">{receipt.order_number}</div><div className="truncate text-[10px] font-semibold text-slate-500 sm:text-xs">{orderedLabel(receipt)}</div></div>
                      <div className="rounded-xl border border-white/90 bg-white/80 p-2">
                        <div className="text-[9px] font-bold uppercase tracking-wide text-slate-500 sm:text-[10px]">Quantity ordered</div>
                        <div className="text-xl font-black leading-none sm:text-2xl">{receipt.expected_items}</div>
                        <div className="mt-1 truncate text-[10px] text-slate-500">{receipt.line_items?.length || 0} variant{receipt.line_items?.length === 1 ? "" : "s"}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 text-center">
                        <div className="rounded-lg bg-white/70 px-1 py-1.5"><div className="text-[9px] text-slate-500">Crates</div><div className="text-xs font-black">{isCounted ? `${receipt.actual_crates}/${receipt.ordered_crates || "—"}` : (receipt.ordered_crates || "—")}</div></div>
                        <div className="rounded-lg bg-white/70 px-1 py-1.5"><div className="text-[9px] text-slate-500">Counted</div><div className="text-xs font-black">{receipt.actual_items ?? "—"}</div></div>
                      </div>
                      {receipt.agent_note && <div className="rounded-xl border border-amber-300 bg-amber-100 px-2 py-2 text-[10px] font-bold leading-snug text-amber-950 sm:text-xs"><span className="block text-[9px] uppercase tracking-wide text-amber-700">Agent note</span><span className="block truncate">{receipt.agent_note}</span></div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {isAdmin && showCreate && (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 px-3 py-5 backdrop-blur-sm sm:py-10" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}>
          <section className="mx-auto max-w-3xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-100 p-4 sm:p-6">
              <div className="mb-4 flex items-start gap-3">
                <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600"><Plus className="h-5 w-5" /></div>
                <div><h2 className="font-bold">Add purchase order</h2><p className="text-sm text-slate-500">Browse linked Shopify transfers by date or search a transfer reference.</p></div>
                <button type="button" onClick={closeCreate} className="ml-auto rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-slate-50" aria-label="Close"><X className="h-4 w-4" /></button>
              </div>
              {error && (
                <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
                  <span>{error}</span>
                  {needsShopifyReconnect && <a href={reconnectUrl} className="ml-auto rounded-lg bg-rose-800 px-3 py-2 text-xs font-black text-white">Reconnect Shopify</a>}
                </div>
              )}
              <form onSubmit={loadAvailable} className="mb-4 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-wide text-indigo-700"><CalendarDays className="h-4 w-4" /> Browse by transfer date</div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input type="date" value={browseDate} onChange={(event) => setBrowseDate(event.target.value)} className="h-11 flex-1 rounded-xl border border-indigo-200 bg-white px-3 text-sm font-bold outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" />
                  <button disabled={browseBusy || !browseDate} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-bold text-white disabled:opacity-50">
                    {browseBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />} Load date
                  </button>
                </div>
              </form>
              <div className="mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">Or search one linked transfer</div>
              <form onSubmit={lookup} className="flex flex-col gap-2 sm:flex-row">
                <label className="relative flex-1">
                  <Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                  <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Transfer name or PO reference" autoFocus className="h-11 w-full rounded-xl border border-slate-300 pl-10 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" />
                </label>
                <button disabled={lookupBusy || !reference.trim()} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-slate-950 px-5 text-sm font-bold text-white disabled:opacity-50">
                  {lookupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Find in Shopify
                </button>
              </form>
            </div>

            {!draft && availableTransfers.length > 0 && (
              <div className="border-b border-slate-100 bg-slate-50/70 p-3 sm:p-5">
                <div className="mb-3 flex items-center justify-between"><div><div className="font-black">Transfers created {shortDate(browseDate)}</div><div className="text-xs text-slate-500">Tap a card to review every variant before adding it.</div></div><span className="rounded-full bg-white px-3 py-1 text-xs font-black text-slate-600">{availableTransfers.length}</span></div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {availableTransfers.map((transfer) => {
                    const image = transfer.line_items?.find((item) => item.image_url)?.image_url;
                    const isChoosing = choosingTransferId === transfer.shopify_order_gid;
                    return (
                      <button key={transfer.shopify_order_gid} type="button" disabled={transfer.already_added || Boolean(choosingTransferId)} onClick={() => chooseTransfer(transfer)} className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-sm transition active:scale-[0.98] disabled:opacity-55">
                        <div className="aspect-[4/3] bg-slate-100">{image ? <img src={image} alt={transfer.line_items?.[0]?.title || "Transfer product"} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-slate-300"><Boxes className="h-8 w-8" /></div>}</div>
                        <div className="space-y-1.5 p-2.5"><div className="truncate text-sm font-black">{transfer.order_number}</div><div className="text-lg font-black">{transfer.expected_items} <span className="text-[10px] font-bold text-slate-500">items</span></div><div className="flex items-center gap-1 truncate text-[10px] text-slate-500"><MapPin className="h-3 w-3 shrink-0" />{transfer.destination_name || "Shopify location"}</div><div className={`flex items-center gap-1 text-[10px] font-black ${transfer.already_added ? "text-emerald-700" : "text-indigo-700"}`}>{isChoosing && <Loader2 className="h-3 w-3 animate-spin" />}{transfer.already_added ? "Already added" : isChoosing ? "Loading variants" : "Review variants"}</div></div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {draft && (
              <div className="bg-slate-50/70 p-4 sm:p-6">
                <div className="mb-5 flex flex-wrap items-center gap-3">
                  <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Linked Shopify transfer</div><div className="text-xl font-black">{draft.order_number}</div>{draft.destination_name && <div className="mt-1 flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3 w-3" />{draft.destination_name}</div>}</div>
                  {draft.po_number && <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">PO {draft.po_number}</span>}
                  <div className="ml-auto w-full sm:w-40"><QuantityField label="Crates ordered" value={draftCrates} onChange={setDraftCrates} /></div>
                </div>
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                  <div className="hidden grid-cols-[minmax(0,1fr)_110px_120px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 sm:grid">
                    <span>Variant</span><span>Transfer qty</span><span>Qty ordered</span>
                  </div>
                  {draft.line_items.map((item, index) => (
                    <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_84px] items-center gap-3 border-b border-slate-100 p-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_110px_120px] sm:px-4">
                      <div className="flex min-w-0 items-center gap-3"><ProductThumb src={item.image_url} alt={item.title} /><div className="min-w-0"><div className="truncate text-sm font-bold">{item.title}</div><div className="truncate text-xs text-slate-500">{item.sku || "No SKU"}</div></div></div>
                      <div className="hidden text-sm font-bold text-slate-600 sm:block">{item.shopify_quantity}</div>
                      <QuantityField label="Ordered" value={item.ordered_quantity} onChange={(value) => changeDraftQuantity(index, value)} />
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button type="button" onClick={() => setDraft(null)} className="h-11 rounded-xl border border-slate-300 px-5 text-sm font-bold">Back</button>
                  <button type="button" onClick={saveDraft} disabled={savingDraft || !draft.line_items.length} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-bold text-white disabled:opacity-50">{savingDraft && <Loader2 className="h-4 w-4 animate-spin" />} Create purchase-order card</button>
                </div>
              </div>
            )}
          </section>
          </div>
        )}

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[['Total POs', totals.all, 'text-slate-950'], ['Ready', totals.waiting, 'text-emerald-700'], ['Mismatch', totals.mismatch, 'text-rose-700'], ['Matched', totals.matched, 'text-emerald-700']].map(([label, value, tone]) => (
            <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="text-xs font-semibold text-slate-500">{label}</div><div className={`mt-1 text-2xl font-black ${tone}`}>{value}</div></div>
          ))}
        </section>

        <div ref={detailRef} className="scroll-mt-24">
          {selected ? (
            <section className="mx-auto max-w-4xl space-y-5">
              <div className={`rounded-3xl border p-4 shadow-sm sm:p-6 ${selectedTone.row}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className={`rounded-2xl border p-3 ${selectedTone.badge}`}><SelectedIcon className="h-6 w-6" /></div>
                  <div><div className="text-xs font-bold uppercase tracking-wide text-slate-500">{selected.po_number ? `PO ${selected.po_number}` : orderedLabel(selected)}</div><h2 className="text-2xl font-black tracking-tight">{selected.order_number}</h2><p className="mt-1 text-sm font-semibold text-slate-600">{differenceText(selected)}</p></div>
                  <div className={`ml-auto rounded-full border px-3 py-1 text-xs font-bold ${selectedTone.badge}`}>{selectedTone.label}</div>
                </div>
                {selected.agent_note && <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-100 px-4 py-3 text-sm font-bold text-amber-950"><span className="mb-0.5 block text-[10px] uppercase tracking-wider text-amber-700">Agent note</span>{selected.agent_note}</div>}
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center gap-3 border-b border-slate-100 p-4 sm:p-6"><div className="rounded-xl bg-slate-100 p-2 text-slate-700"><ClipboardList className="h-5 w-5" /></div><div><h3 className="font-bold">Admin order plan</h3><p className="text-sm text-slate-500">Expected crates and item quantities.</p></div></div>
                <div className="p-4 sm:p-6">
                  <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-sm"><div className="rounded-2xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Expected items</div><div className="text-xl font-black">{adminItems.reduce((sum, item) => sum + Number(item.ordered_quantity || 0), 0)}</div></div><QuantityField label="Crates ordered" value={adminCrates} onChange={setAdminCrates} disabled={!isAdmin} /></div>
                  <div className="overflow-hidden rounded-2xl border border-slate-200">
                    {adminItems.map((item, index) => (
                      <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_84px] items-center gap-3 border-b border-slate-100 p-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_120px] sm:px-4">
                        <div className="flex min-w-0 items-center gap-3"><ProductThumb src={item.image_url} alt={item.title} /><div className="min-w-0"><div className="truncate text-sm font-bold">{item.title}</div><div className="truncate text-xs text-slate-500">{item.sku || item.variant_title || "Variant"} · Shopify {item.shopify_quantity}</div></div></div>
                        <QuantityField label="Qty ordered" value={item.ordered_quantity} disabled={!isAdmin} onChange={(value) => setAdminItems((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, ordered_quantity: value } : entry))} />
                      </div>
                    ))}
                  </div>
                  {isAdmin && <div className="mt-4 flex justify-end"><button type="button" onClick={saveAdminPlan} disabled={countBusy} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-slate-950 px-5 text-sm font-bold text-white disabled:opacity-50">{countBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save plan</button></div>}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center gap-3 border-b border-slate-100 p-4 sm:p-6"><div className="rounded-xl bg-indigo-50 p-2 text-indigo-600"><PackageOpen className="h-5 w-5" /></div><div><h3 className="font-bold">Agent receiving check</h3><p className="text-sm text-slate-500">Photograph the crates and enter the quantity actually found for every variant.</p></div></div>
                <form onSubmit={saveCount} className="space-y-5 p-4 sm:p-6">
                  <div>
                    <div className="mb-2 flex items-center justify-between"><div><div className="text-sm font-bold">Crate photos</div><div className="text-xs text-slate-500">JPG, PNG, or WebP · up to 4 photos</div></div><label className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 text-sm font-bold text-indigo-700 ${photoBusy || selected.photos?.length >= 4 ? "pointer-events-none opacity-50" : ""}`}><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={uploadPhoto} className="sr-only" />{photoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Add photo</label></div>
                    {!!selected.photos?.length && <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{selected.photos.map((photo) => <PrivatePhoto key={photo.id} photo={photo} onDelete={deletePhoto} canDelete={isAdmin || photo.uploaded_by_id === auth?.user?.id} />)}</div>}
                    {!selected.photos?.length && <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 text-center text-slate-500"><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={uploadPhoto} className="sr-only" /><Camera className="mb-2 h-6 w-6" /><span className="text-sm font-bold">Take or choose a crate photo</span></label>}
                  </div>
                  <div>
                    <div className="mb-2 flex items-end justify-between"><div><div className="text-sm font-black">Variant quantities</div><div className="text-xs text-slate-500">Changing a saved value applies only the difference to Shopify inventory.</div></div><div className="rounded-xl bg-indigo-50 px-3 py-2 text-right"><div className="text-[10px] font-bold uppercase text-indigo-600">Counted</div><div className="text-xl font-black text-indigo-950">{actualItems}</div></div></div>
                    <div className="overflow-hidden rounded-2xl border border-slate-200">
                      {agentItems.map((item, index) => {
                        const differs = Number(item.actual_quantity || 0) !== Number(item.ordered_quantity || 0);
                        return (
                          <div key={item.id} className={`grid grid-cols-[minmax(0,1fr)_88px] items-center gap-3 border-b border-slate-100 p-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_120px] sm:px-4 ${differs ? "bg-rose-50/60" : "bg-white"}`}>
                            <div className="flex min-w-0 items-center gap-3"><ProductThumb src={item.image_url} alt={item.title} /><div className="min-w-0"><div className="truncate text-sm font-bold">{item.title}</div><div className="truncate text-xs text-slate-500">{item.sku || item.variant_title || "Variant"} · ordered {item.ordered_quantity}</div>{item.inventory_synced_at && <div className="text-[10px] font-bold text-emerald-700">Shopify inventory previously synced</div>}</div></div>
                            <QuantityField label="Found" value={item.actual_quantity} onChange={(value) => setAgentItems((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, actual_quantity: value } : entry))} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3"><QuantityField label="Crates received" value={actualCrates} onChange={setActualCrates} /><div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Items found</div><div className="mt-1 text-2xl font-black">{actualItems}</div></div></div>
                  <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Agent note · optional</span><textarea value={agentNote} onChange={(event) => setAgentNote(event.target.value)} rows="3" placeholder="Damaged box, opened crate, or anything the admin should know…" className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" /></label>
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900">Saving receives new quantities into the transfer destination. If you correct an earlier count, Shopify inventory changes only by the difference.</div>
                  <button disabled={countBusy || !agentItems.length} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-black text-white shadow-sm disabled:opacity-50 sm:w-auto">{countBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save & update Shopify inventory</button>
                </form>
              </div>

              {selected.actual_crates != null && selected.actual_items != null && (
                <div className={`rounded-3xl border p-5 ${selectedTone.row}`}>
                  <div className="mb-4 flex items-center gap-2"><SelectedIcon className={`h-5 w-5 ${selected.status === "matched" ? "text-emerald-600" : "text-rose-600"}`} /><h3 className="font-black">Count summary</h3></div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[['Crates ordered', selected.ordered_crates || '—'], ['Crates received', selected.actual_crates], ['Items ordered', selected.expected_items], ['Items counted', selected.actual_items]].map(([label, value]) => <div key={label} className="rounded-2xl border border-white/80 bg-white/80 p-3"><div className="text-xs text-slate-500">{label}</div><div className="text-2xl font-black">{value}</div></div>)}
                  </div>
                  <p className={`mt-4 text-sm font-bold ${selected.status === "matched" ? "text-emerald-800" : "text-rose-800"}`}>{differenceText(selected)}</p>
                  {selected.counted_by && <p className="mt-1 text-xs text-slate-500">Counted by {selected.counted_by.name || selected.counted_by.email}</p>}
                </div>
              )}
            </section>
          ) : (
            receipts.length > 0 && <div className="flex min-h-44 items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white text-center text-slate-500"><div><PackageOpen className="mx-auto mb-3 h-9 w-9 text-slate-300" /><p className="font-bold">Tap a card to see all purchase-order details.</p></div></div>
          )}
        </div>
      </main>
    </div>
  );
}
