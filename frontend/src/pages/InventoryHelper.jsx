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
  History,
  Loader2,
  Minus,
  PackageOpen,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Ruler,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import StorePicker from "../components/StorePicker.jsx";
import { authFetch, authHeaders, loadAuth } from "../lib/auth";
import { formatInventoryOperation, groupInventoryColors, groupInventoryItems, inventoryReview } from "../lib/inventoryHelper";
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
  if (status === "complete" || status === "matched") return {
    row: "border-emerald-200 bg-emerald-50/70",
    badge: "border-emerald-200 bg-emerald-100 text-emerald-800",
    label: "Complete",
    icon: CheckCircle2,
  };
  if (status === "incomplete") return {
    row: "border-amber-300 bg-amber-50/90",
    badge: "border-amber-300 bg-amber-100 text-amber-950",
    label: "Incomplete",
    icon: AlertTriangle,
  };
  if (status === "pending" || status === "mismatch") return {
    row: "border-amber-200 bg-amber-50/80",
    badge: "border-amber-200 bg-amber-100 text-amber-900",
    label: "Pending",
    icon: AlertTriangle,
  };
  return {
    row: "border-slate-200 bg-white",
    badge: "border-slate-200 bg-white text-slate-700",
    label: "New",
    icon: PackageOpen,
  };
}


function differenceText(receipt) {
  if (receipt?.actual_crates == null || receipt?.actual_items == null) {
    return "The receiving count has not been submitted yet.";
  }
  const crateDiff = Number(receipt.actual_crates) - Number(receipt.ordered_crates);
  const itemDiff = Number(receipt.actual_items) - Number(receipt.expected_items);
  const reportedDiff = receipt.reported_items_received == null ? 0 : Number(receipt.reported_items_received) - Number(receipt.actual_items);
  const variantDiffs = (receipt.line_items || []).filter((item) => item.actual_quantity != null && Number(item.actual_quantity) !== Number(item.ordered_quantity));
  if (crateDiff === 0 && itemDiff === 0 && variantDiffs.length === 0 && reportedDiff === 0) return "Crates, entered total, and every variant match the purchase order.";
  const parts = [];
  if (crateDiff) parts.push(`${Math.abs(crateDiff)} ${crateDiff > 0 ? "more" : "fewer"} crate${Math.abs(crateDiff) === 1 ? "" : "s"}`);
  if (itemDiff) parts.push(`${Math.abs(itemDiff)} ${itemDiff > 0 ? "more" : "fewer"} item${Math.abs(itemDiff) === 1 ? "" : "s"}`);
  if (variantDiffs.length) parts.push(`${variantDiffs.length} variant${variantDiffs.length === 1 ? "" : "s"} differ`);
  if (reportedDiff) parts.push(`entered total is ${Math.abs(reportedDiff)} ${reportedDiff > 0 ? "higher" : "lower"} than the variant sum`);
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


function variantDimensions(item) {
  let color = String(item?.variant_color || "").trim();
  let size = String(item?.variant_size || "").trim();
  for (const option of item?.selected_options || []) {
    const name = String(option?.name || "").trim().toLowerCase();
    const value = String(option?.value || "").trim();
    if (!color && ["color", "colour", "couleur", "colore", "farbe", "لون"].includes(name)) color = value;
    if (!size && ["size", "taille", "pointure", "shoe size", "eu size", "uk size", "us size", "größe", "tamanho", "مقاس"].includes(name)) size = value;
  }
  if (!color && !size) {
    const parts = String(item?.variant_title || "").split("/").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) [color, size] = [parts[0], parts[parts.length - 1]];
  }
  return { color: color || "—", size: size || "—" };
}


function DimensionBadge({ type, value, compact = false }) {
  const isColor = type === "color";
  const Icon = isColor ? Palette : Ruler;
  return (
    <div className={`min-w-0 rounded-xl border ${compact ? "px-2 py-1.5" : "px-3 py-2"} ${isColor ? "border-violet-200 bg-violet-50 text-violet-950" : "border-sky-200 bg-sky-50 text-sky-950"}`}>
      <div className={`flex items-center gap-1 font-black uppercase tracking-wide ${compact ? "text-[9px]" : "text-[10px]"} ${isColor ? "text-violet-600" : "text-sky-600"}`}><Icon className="h-3 w-3" />{isColor ? "Color" : "Size"}</div>
      <div className={`mt-0.5 whitespace-normal break-words font-black leading-tight ${compact ? "text-xs" : "text-sm"}`}>{value}</div>
    </div>
  );
}


function ProductIdentity({ item, meta }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <ProductThumb src={item.image_url} alt={item.title} />
      <div className="min-w-0 flex-1">
        <div className="whitespace-normal break-words text-sm font-bold leading-snug text-slate-950">{item.title}</div>
        <div className="mt-1 break-all text-[11px] text-slate-500">{item.sku || "No SKU"}</div>
        {meta && <div className="mt-1 text-[10px] font-semibold text-slate-500">{meta}</div>}
      </div>
    </div>
  );
}


function QuantityEditButton({ label, value, onClick, disabled = false, tone = "indigo" }) {
  const toneClass = tone === "rose"
    ? "border-rose-300 bg-rose-100 text-rose-950"
    : "border-indigo-200 bg-indigo-50 text-indigo-950";
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left shadow-sm transition active:scale-[0.98] disabled:cursor-default disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-500 ${disabled ? "" : toneClass}`}>
      <span><span className="block text-[9px] font-black uppercase tracking-wide opacity-70">{label}</span><span className="block text-xl font-black leading-none">{value}</span></span>
      {!disabled && <span className="rounded-lg bg-white/80 p-2"><Pencil className="h-4 w-4" /></span>}
    </button>
  );
}


function QuantityEditSheet({ editor, onChange, onClose, onConfirm }) {
  if (!editor) return null;
  const { color, size } = variantDimensions(editor.item);
  const contextLabel = editor.mode === "agent" ? "Quantity found" : "Quantity ordered";
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form onSubmit={(event) => { event.preventDefault(); onConfirm(); }} className="max-h-[100dvh] w-full overflow-y-auto overscroll-contain rounded-t-3xl border border-slate-200 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl sm:max-w-lg sm:rounded-3xl sm:p-6">
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-slate-300 sm:hidden" />
        <div className="flex items-start gap-3">
          <ProductThumb src={editor.item.image_url} alt={editor.item.title} />
          <div className="min-w-0 flex-1"><div className="text-[10px] font-black uppercase tracking-widest text-indigo-600">Edit {contextLabel}</div><h3 className="mt-1 whitespace-normal break-words text-lg font-black leading-snug">{editor.item.title}</h3><div className="mt-1 break-all text-xs text-slate-500">{editor.item.sku || "No SKU"}</div></div>
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-200 p-2.5 text-slate-500" aria-label="Close quantity editor"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2"><DimensionBadge type="color" value={color} /><DimensionBadge type="size" value={size} /></div>
        <div className="mt-4 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 px-3 py-2"><div className="text-[10px] font-bold uppercase text-slate-500">Shopify transfer</div><div className="text-xl font-black">{editor.item.shopify_quantity ?? "—"}</div></div>
          <div className="rounded-xl bg-slate-50 px-3 py-2"><div className="text-[10px] font-bold uppercase text-slate-500">Ordered</div><div className="text-xl font-black">{editor.item.ordered_quantity ?? "—"}</div></div>
        </div>
        <label className="mt-5 block text-center"><span className="mb-2 block text-xs font-black uppercase tracking-widest text-slate-600">{contextLabel}</span><div className="grid grid-cols-[56px_minmax(0,1fr)_56px] gap-2"><button type="button" onClick={() => onChange(Math.max(0, editor.value - 1))} disabled={editor.value <= 0} className="flex h-14 items-center justify-center rounded-2xl border border-slate-300 bg-slate-100 disabled:opacity-40" aria-label="Decrease quantity"><Minus className="h-6 w-6" /></button><input autoFocus type="number" inputMode="numeric" min="0" value={editor.value} onFocus={(event) => event.currentTarget.select()} onChange={(event) => onChange(Math.max(0, Number(event.target.value || 0)))} className="h-14 min-w-0 rounded-2xl border-2 border-indigo-300 bg-white text-center text-3xl font-black outline-none focus:border-indigo-600 focus:ring-4 focus:ring-indigo-100" /><button type="button" onClick={() => onChange(editor.value + 1)} className="flex h-14 items-center justify-center rounded-2xl bg-indigo-600 text-white" aria-label="Increase quantity"><Plus className="h-6 w-6" /></button></div></label>
        {editor.mode === "agent" && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">This prepares the count only. Shopify inventory changes after you press “Save &amp; update Shopify inventory” on the main page.</div>}
        <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" onClick={onClose} className="h-12 rounded-xl border border-slate-300 text-sm font-black">Cancel</button><button type="submit" className="h-12 rounded-xl bg-indigo-600 px-3 text-sm font-black text-white">Confirm {editor.value}</button></div>
      </form>
    </div>
  );
}


function CountReviewSheet({ open, receipt, items, actualCrates, totalItemsReceived, busy, onClose, onConfirm }) {
  if (!open || !receipt) return null;
  const changes = inventoryReview(items);
  const shortages = items.filter((item) => Number(item.actual_quantity || 0) !== Number(item.ordered_quantity || 0));
  const reduceTotal = changes.filter((entry) => entry.delta < 0).reduce((sum, entry) => sum + Math.abs(entry.delta), 0);
  const receiveTotal = changes.filter((entry) => entry.delta > 0).reduce((sum, entry) => sum + entry.delta, 0);
  const attention = changes.filter((entry) => entry.delta < 0 || Number(entry.item.actual_quantity || 0) !== Number(entry.item.ordered_quantity || 0));

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/65 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="max-h-[100dvh] w-full overflow-y-auto rounded-t-3xl bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl sm:max-w-xl sm:rounded-3xl sm:p-6">
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-slate-300 sm:hidden" />
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-700"><Check className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1"><div className="text-[10px] font-black uppercase tracking-widest text-indigo-600">Final check</div><h3 className="break-words text-xl font-black">Apply {receipt.order_number} to Shopify?</h3><p className="mt-1 text-sm text-slate-500">Review the count once. This action changes live inventory.</p></div>
          <button type="button" disabled={busy} onClick={onClose} className="rounded-xl border border-slate-200 p-2.5 text-slate-500 disabled:opacity-50" aria-label="Close review"><X className="h-5 w-5" /></button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 p-2"><div className="text-[9px] font-bold uppercase text-slate-500">Crates</div><div className="text-xl font-black">{actualCrates}</div></div>
          <div className="rounded-xl bg-indigo-50 p-2 text-indigo-950"><div className="text-[9px] font-bold uppercase text-indigo-600">Total entered</div><div className="text-xl font-black">{totalItemsReceived}</div></div>
          <div className={`rounded-xl p-2 ${shortages.length ? "bg-rose-50 text-rose-900" : "bg-emerald-50 text-emerald-900"}`}><div className="text-[9px] font-bold uppercase opacity-70">Different</div><div className="text-xl font-black">{shortages.length}</div></div>
        </div>

        {(reduceTotal > 0 || receiveTotal > 0) ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3">
            <div className="text-xs font-black uppercase tracking-wide text-amber-800">Planned Shopify inventory change</div>
            <div className="mt-1 flex flex-wrap gap-2 text-sm font-black">
              {reduceTotal > 0 && <span className="rounded-lg bg-rose-100 px-2 py-1 text-rose-800">Reduce {reduceTotal}</span>}
              {receiveTotal > 0 && <span className="rounded-lg bg-emerald-100 px-2 py-1 text-emerald-800">Receive {receiveTotal}</span>}
            </div>
          </div>
        ) : <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm font-semibold text-slate-600">No Shopify quantity change is needed. The count details will still be saved.</div>}

        {attention.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200">
            <div className="grid grid-cols-[minmax(0,1fr)_48px_48px_56px] gap-2 bg-slate-100 px-3 py-2 text-[9px] font-black uppercase text-slate-500"><span>Variant</span><span>Was</span><span>Now</span><span>Stock</span></div>
            {attention.map(({ item, applied, found, delta }) => {
              const dimensions = variantDimensions(item);
              return <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_48px_48px_56px] items-center gap-2 border-t border-slate-100 px-3 py-2 text-sm"><div className="min-w-0"><div className="truncate font-bold">{dimensions.color} · {dimensions.size}</div><div className="truncate text-[10px] text-slate-500">{item.title}</div></div><span className="font-black">{applied}</span><span className="font-black">{found}</span><span className={`font-black ${delta < 0 ? "text-rose-700" : "text-emerald-700"}`}>{delta > 0 ? "+" : ""}{delta}</span></div>;
            })}
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" disabled={busy} onClick={onClose} className="h-12 rounded-xl border border-slate-300 text-sm font-black disabled:opacity-50">Go back</button><button type="button" disabled={busy} onClick={onConfirm} className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 text-sm font-black text-white disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Apply to Shopify</button></div>
      </div>
    </div>
  );
}


function shortDate(value) {
  const normalized = receiptDateInput(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(normalized);
  return match ? `${match[3]}/${match[2]}` : "";
}


function receiptDateInput(value) {
  const text = String(value || "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const shopify = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (shopify) return `${shopify[3]}-${shopify[1]}-${shopify[2]}`;
  return "";
}


function orderedLabel(receipt) {
  const date = receiptDateInput(receipt?.shopify_created_at);
  if (!date) return "Linked Shopify transfer";
  return `Transfer created ${shortDate(date)}`;
}


function localDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}


function selectedPeriodLabel(dateFrom, dateTo) {
  if (!dateTo || dateTo === dateFrom) return shortDate(dateFrom);
  return `${shortDate(dateFrom)}–${shortDate(dateTo)}`;
}


function historyDayKey(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "unknown";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Casablanca",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}


function historyDayLabel(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "Earlier";
  return new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Casablanca",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
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


export default function InventoryHelper() {
  const auth = loadAuth();
  const isAdmin = auth?.user?.role === "admin";
  const [store, setStore] = useState(() => readCurrentStore());
  const [receipts, setReceipts] = useState([]);
  const [historyReceipts, setHistoryReceipts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [viewDateFrom, setViewDateFrom] = useState(localDateInput);
  const [viewDateTo, setViewDateTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailBusyId, setDetailBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsShopifyReconnect, setNeedsShopifyReconnect] = useState(false);

  const selected = [...receipts, ...historyReceipts].find((receipt) => receipt.id === selectedId) || null;
  const [adminItems, setAdminItems] = useState([]);
  const [agentItems, setAgentItems] = useState([]);
  const [adminCrates, setAdminCrates] = useState(0);
  const [actualCrates, setActualCrates] = useState(0);
  const [agentTotalItems, setAgentTotalItems] = useState("");
  const [agentNote, setAgentNote] = useState("");
  const [countBusy, setCountBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [quantityEditor, setQuantityEditor] = useState(null);
  const [showCountReview, setShowCountReview] = useState(false);
  const [lastSyncOperations, setLastSyncOperations] = useState([]);
  const detailRef = useRef(null);
  const actualItems = useMemo(
    () => agentItems.reduce((sum, item) => sum + Number(item.actual_quantity || 0), 0),
    [agentItems],
  );
  const groupedAgentItems = useMemo(
    () => groupInventoryItems(agentItems).map((group) => ({ ...group, colors: groupInventoryColors(group.items) })),
    [agentItems],
  );
  const historyGroups = useMemo(() => {
    const groups = new Map();
    for (const receipt of historyReceipts) {
      const markedAt = receipt.finalized_at || receipt.counted_at || receipt.updated_at;
      const key = historyDayKey(markedAt);
      if (!groups.has(key)) groups.set(key, { key, label: historyDayLabel(markedAt), receipts: [] });
      groups.get(key).receipts.push(receipt);
    }
    return [...groups.values()];
  }, [historyReceipts]);
  const countHasChanges = useMemo(() => {
    if (!selected) return false;
    if (selected.actual_items == null || selected.actual_crates == null) return true;
    const savedById = new Map((selected.line_items || []).map((item) => [String(item.id), item]));
    const itemChanged = agentItems.some((item) => Number(item.actual_quantity || 0) !== Number(savedById.get(String(item.id))?.actual_quantity || 0));
    return itemChanged
      || Number(actualCrates || 0) !== Number(selected.actual_crates || 0)
      || String(agentTotalItems) !== String(selected.reported_items_received ?? "")
      || agentNote.trim() !== String(selected.agent_note || "").trim();
  }, [selected, agentItems, actualCrates, agentTotalItems, agentNote]);
  const reconnectUrl = `/api/shopify/oauth/start?store=${encodeURIComponent(store)}&return_to=${encodeURIComponent(`/inventory-helper?store=${store}`)}`;

  function showApiError(err) {
    const message = err?.message || "Something went wrong";
    setError(message);
    if (err?.status === 403 && /reconnect this shopify store/i.test(message)) {
      setNeedsShopifyReconnect(true);
    }
  }

  const totals = useMemo(() => ({
    queue: receipts.length,
    new: receipts.filter((item) => item.status === "new" || item.status === "waiting").length,
    pending: receipts.filter((item) => item.status === "pending" || item.status === "mismatch").length,
    history: historyReceipts.length,
  }), [receipts, historyReceipts]);

  useEffect(() => {
    persistStoreSelection(store);
    setNeedsShopifyReconnect(false);
    setLastSyncOperations([]);
    loadReceipts(null, viewDateFrom, viewDateTo);
  }, [store, viewDateFrom, viewDateTo]);

  useEffect(() => {
    if (!selected) return;
    setQuantityEditor(null);
    setShowCountReview(false);
    setAdminItems((selected.line_items || []).map((item) => ({ ...item })));
    setAgentItems((selected.line_items || []).map((item) => ({
      ...item,
      actual_quantity: item.actual_quantity ?? (Number(item.shopify_received_quantity || 0) > 0 ? item.shopify_received_quantity : item.ordered_quantity),
    })));
    setAdminCrates(Number(selected.ordered_crates || 0));
    setActualCrates(selected.actual_crates == null ? "" : String(selected.actual_crates));
    setAgentTotalItems(selected.reported_items_received == null ? "" : String(selected.reported_items_received));
    setAgentNote(selected.agent_note || "");
  }, [selected?.id, selected?.updated_at]);

  async function loadReceipts(preferredId, selectedFrom = viewDateFrom, selectedTo = viewDateTo) {
    if (!selectedFrom) return;
    if (selectedTo && selectedTo < selectedFrom) {
      setError("The end date must be on or after the start date.");
      setReceipts([]);
      setSelectedId(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ store, date_from: selectedFrom });
      if (selectedTo) params.set("date_to", selectedTo);
      const data = await apiJson(`/api/inventory-helper/receipts?${params.toString()}`, {
        headers: authHeaders({ Accept: "application/json" }),
      });
      const list = data.receipts || [];
      const history = data.history || [];
      setReceipts(list);
      setHistoryReceipts(history);
      setSelectedId((current) => preferredId || ([...list, ...history].some((item) => item.id === current) ? current : null));
    } catch (err) {
      showApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function openReceipt(receiptId) {
    const receipt = [...receipts, ...historyReceipts].find((item) => item.id === receiptId);
    if (!receipt || detailBusyId) return;
    setLastSyncOperations([]);
    if (receipt.shopify_details_loaded || receipt.status === "complete" || receipt.status === "incomplete") {
      setSelectedId(receiptId);
      window.setTimeout(() => detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 60);
      return;
    }
    setDetailBusyId(receiptId);
    setError("");
    try {
      const hydrated = await apiJson(`/api/inventory-helper/receipts/${receiptId}/details`, {
        method: "PATCH",
        headers: authHeaders({ Accept: "application/json" }),
      });
      replaceReceipt(hydrated);
      setSelectedId(receiptId);
      window.setTimeout(() => detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 60);
    } catch (err) {
      showApiError(err);
    } finally {
      setDetailBusyId(null);
    }
  }

  function refreshCurrent() {
    loadReceipts(selected?.id, viewDateFrom, viewDateTo);
  }

  function replaceReceipt(next) {
    const finalized = next.status === "complete" || next.status === "incomplete";
    setReceipts((current) => finalized
      ? current.filter((item) => item.id !== next.id)
      : current.some((item) => item.id === next.id)
        ? current.map((item) => item.id === next.id ? next : item)
        : [next, ...current]);
    setHistoryReceipts((current) => finalized
      ? [next, ...current.filter((item) => item.id !== next.id)]
      : current.filter((item) => item.id !== next.id));
  }

  function openQuantityEditor(mode, item) {
    const field = mode === "agent" ? "actual_quantity" : "ordered_quantity";
    setQuantityEditor({ mode, item, value: Math.max(0, Number(item[field] || 0)) });
  }

  function confirmQuantityEditor() {
    if (!quantityEditor) return;
    const itemId = String(quantityEditor.item.id);
    const value = Math.max(0, Number(quantityEditor.value || 0));
    const updateItems = (items, field) => items.map((item) => String(item.id) === itemId ? { ...item, [field]: value } : item);
    if (quantityEditor.mode === "admin") {
      setAdminItems((current) => updateItems(current, "ordered_quantity"));
    } else {
      setAgentItems((current) => updateItems(current, "actual_quantity"));
    }
    setQuantityEditor(null);
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

  function reviewCount(event) {
    event.preventDefault();
    if (!selected || !agentItems.length || !countHasChanges) return;
    if (actualCrates === "") {
      setError("Enter the number of crates received before reviewing the count.");
      return;
    }
    if (agentTotalItems === "") {
      setError("Enter the total items received before reviewing the count.");
      return;
    }
    setError("");
    setNotice("");
    setShowCountReview(true);
  }

  async function saveCount() {
    if (!selected) return;
    setCountBusy(true);
    setError("");
    try {
      const saved = await apiJson(`/api/inventory-helper/receipts/${selected.id}/count`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          actual_crates: actualCrates,
          total_items_received: Number(agentTotalItems),
          agent_note: agentNote,
          sync_inventory: true,
          line_items: agentItems.map((item) => ({ id: item.id, actual_quantity: Number(item.actual_quantity || 0) })),
        }),
      });
      replaceReceipt(saved);
      const operations = saved.inventory_operations || [];
      setLastSyncOperations(operations);
      setShowCountReview(false);
      const operationText = operations.map(formatInventoryOperation);
      setNotice(
        operations.length
          ? `Count saved as pending. ${operationText.join("; ")}.`
          : "Count saved as pending. No Shopify quantity change was needed.",
      );
    } catch (err) {
      showApiError(err);
    } finally {
      setCountBusy(false);
    }
  }

  async function finalizeReceipt(outcome) {
    if (!selected || selected.actual_items == null || countHasChanges) return;
    setCountBusy(true);
    setError("");
    try {
      const saved = await apiJson(`/api/inventory-helper/receipts/${selected.id}/complete`, {
        method: "PATCH",
        headers: authHeaders({ Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify({ outcome }),
      });
      replaceReceipt(saved);
      setNotice(`${saved.order_number} moved to received history as ${saved.status}.`);
    } catch (err) {
      showApiError(err);
    } finally {
      setCountBusy(false);
    }
  }

  async function reopenReceipt() {
    if (!selected || !isFinalized || countBusy) return;
    setCountBusy(true);
    setError("");
    try {
      const saved = await apiJson(`/api/inventory-helper/receipts/${selected.id}/reopen`, {
        method: "PATCH",
        headers: authHeaders({ Accept: "application/json" }),
      });
      replaceReceipt(saved);
      setSelectedId(saved.id);
      const purchaseOrderDate = receiptDateInput(saved.shopify_created_at);
      if (purchaseOrderDate && (purchaseOrderDate !== viewDateFrom || viewDateTo)) {
        setViewDateFrom(purchaseOrderDate);
        setViewDateTo("");
      }
      setNotice(`${saved.order_number} returned to the receiving queue. You can edit and approve it again.`);
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
      replaceReceipt({ ...selected, status: "pending", photos: selected.photos.filter((photo) => photo.id !== photoId) });
    } catch (err) {
      showApiError(err);
    }
  }

  const isFinalized = selected?.status === "complete" || selected?.status === "incomplete";
  const selectedTone = statusStyle(selected?.status);
  const SelectedIcon = selectedTone.icon;

  return (
    <div className="min-h-screen bg-[#f6f7f9] text-slate-950">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur">
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

      <main className="mx-auto max-w-7xl space-y-5 px-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 sm:py-7">
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
          <div className="border-b border-slate-100 px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-start gap-3">
              <div>
              <div className="text-xs font-bold uppercase tracking-wide text-indigo-600">Receiving queue</div>
              <h2 className="text-lg font-black">Purchase orders</h2>
                <p className="text-xs text-slate-500">Choose a day or period. Shopify purchase orders appear automatically.</p>
              </div>
            </div>
            <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-3">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-indigo-700"><CalendarDays className="h-4 w-4" /> Purchase-order date or period</div>
              <div className="grid grid-cols-2 gap-2">
                <label><span className="mb-1 block text-[9px] font-black uppercase text-slate-500">From</span><input type="date" value={viewDateFrom} onChange={(event) => setViewDateFrom(event.target.value)} className="h-12 w-full min-w-0 rounded-xl border border-indigo-200 bg-white px-2 text-sm font-black text-slate-950 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" aria-label="Purchase orders from date" /></label>
                <label><span className="mb-1 block text-[9px] font-black uppercase text-slate-500">To · optional</span><input type="date" min={viewDateFrom} value={viewDateTo} onChange={(event) => setViewDateTo(event.target.value)} className="h-12 w-full min-w-0 rounded-xl border border-indigo-200 bg-white px-2 text-sm font-black text-slate-950 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" aria-label="Purchase orders to date" /></label>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm font-semibold text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Loading purchase orders…</div>
          ) : !receipts.length ? (
            <div className="p-10 text-center"><ClipboardList className="mx-auto mb-3 h-9 w-9 text-slate-300" /><div className="font-black">No open purchase orders for {selectedPeriodLabel(viewDateFrom, viewDateTo)}</div><p className="mx-auto mt-1 max-w-lg text-sm text-slate-500">The app checked Shopify automatically. Choose another date or period.</p></div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 p-2.5 sm:grid-cols-3 sm:gap-4 sm:p-4 lg:grid-cols-4">
              {receipts.map((receipt) => {
                const tone = statusStyle(receipt.status);
                const Icon = tone.icon;
                const image = receipt.line_items?.find((item) => item.image_url)?.image_url;
                return (
                  <button key={receipt.id} type="button" disabled={Boolean(detailBusyId)} onClick={() => openReceipt(receipt.id)} className={`min-w-0 overflow-hidden rounded-2xl border text-left shadow-sm transition active:scale-[0.98] disabled:opacity-65 ${tone.row} ${selected?.id === receipt.id ? "ring-2 ring-indigo-500 ring-offset-2" : "hover:shadow-md"}`}>
                    <div className="space-y-2 p-2.5 sm:p-3">
                      <div className="flex min-w-0 items-start gap-2">
                        {image ? <img src={image} alt={receipt.line_items?.[0]?.title || "Purchase order product"} className="h-10 w-10 shrink-0 rounded-xl border border-slate-200 object-cover" /> : <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-400"><Boxes className="h-5 w-5" /></div>}
                        <div className="min-w-0 flex-1"><div className="truncate text-sm font-black sm:text-base">{receipt.order_number}</div><div className="truncate text-[10px] font-semibold text-slate-500 sm:text-xs">{orderedLabel(receipt)}</div></div>
                      </div>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-black ${tone.badge}`}>{detailBusyId === receipt.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}{detailBusyId === receipt.id ? "Loading variants" : tone.label}</span>
                      <div className="grid grid-cols-2 gap-1.5 text-center">
                        <div className="rounded-lg border border-slate-200 bg-white/80 px-1 py-1.5"><div className="text-[9px] text-slate-500">Items ordered</div><div className="text-sm font-black">{receipt.expected_items}</div></div>
                        <div className="rounded-lg border border-slate-200 bg-white/80 px-1 py-1.5"><div className="text-[9px] text-slate-500">Crates received</div><div className="text-sm font-black">{receipt.actual_crates ?? "—"}</div></div>
                      </div>
                      <div className="rounded-xl border-2 border-violet-300 bg-violet-50 px-2 py-2 text-center text-violet-950"><div className="flex items-center justify-center gap-1 text-[9px] font-black uppercase tracking-wide text-violet-700"><Tag className="h-3 w-3" /> Crates ordered · Shopify tag</div><div className="text-2xl font-black leading-none">{receipt.ordered_crates}</div></div>
                      <div className="rounded-xl border-2 border-indigo-300 bg-indigo-50 px-2 py-2 text-center text-indigo-950"><div className="text-[9px] font-black uppercase tracking-wide text-indigo-600">Agent total received</div><div className="text-xl font-black leading-none">{receipt.reported_items_received ?? "—"}</div></div>
                      {receipt.agent_note && <div className="rounded-xl border border-amber-300 bg-amber-100 px-2 py-2 text-[10px] font-bold leading-snug text-amber-950 sm:text-xs"><span className="block text-[9px] uppercase tracking-wide text-amber-700">Agent note</span><span className="block truncate">{receipt.agent_note}</span></div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
            <div className="rounded-xl bg-emerald-50 p-2 text-emerald-700"><History className="h-5 w-5" /></div>
            <div><div className="text-xs font-bold uppercase tracking-wide text-emerald-700">Received history</div><h2 className="text-lg font-black">Completed receiving</h2><p className="text-xs text-slate-500">Grouped by the day the purchase order was marked complete or incomplete.</p></div>
          </div>
          {!historyGroups.length ? (
            <div className="px-4 py-8 text-center text-sm font-semibold text-slate-500">No purchase orders have been finalized yet.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {historyGroups.map((group) => (
                <div key={group.key} className="p-3 sm:p-4">
                  <div className="mb-2 flex items-center gap-2 text-xs font-black text-slate-700"><CalendarDays className="h-4 w-4 text-emerald-700" />{group.label}<span className="ml-auto rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500">{group.receipts.length}</span></div>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                    {group.receipts.map((receipt) => {
                      const tone = statusStyle(receipt.status);
                      const Icon = tone.icon;
                      const image = receipt.line_items?.find((item) => item.image_url)?.image_url;
                      return (
                        <button key={receipt.id} type="button" onClick={() => openReceipt(receipt.id)} className={`min-w-0 rounded-2xl border p-2.5 text-left shadow-sm transition active:scale-[0.98] ${tone.row}`}>
                          <div className="flex min-w-0 items-start gap-2">{image ? <img src={image} alt="" className="h-9 w-9 shrink-0 rounded-lg border border-slate-200 object-cover" /> : <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/80"><Boxes className="h-4 w-4 text-slate-400" /></div>}<div className="min-w-0"><div className="truncate text-sm font-black">{receipt.order_number}</div><div className="text-[10px] font-semibold text-slate-500">{receipt.actual_crates ?? 0} / {receipt.ordered_crates} crates</div></div></div>
                          <span className={`mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-black ${tone.badge}`}><Icon className="h-3 w-3" />{tone.label}</span>
                          <div className="mt-2 grid grid-cols-2 gap-1 text-center"><div className="rounded-lg bg-white/75 px-1 py-1"><div className="text-[8px] uppercase text-slate-500">Items</div><div className="text-sm font-black">{receipt.reported_items_received ?? receipt.actual_items ?? "—"}</div></div><div className="rounded-lg bg-white/75 px-1 py-1"><div className="text-[8px] uppercase text-slate-500">Crates</div><div className="text-sm font-black">{receipt.actual_crates ?? "—"}</div></div></div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[[`Queue ${selectedPeriodLabel(viewDateFrom, viewDateTo)}`, totals.queue, 'text-slate-950'], ['New', totals.new, 'text-slate-700'], ['Pending', totals.pending, 'text-amber-700'], ['Received history', totals.history, 'text-emerald-700']].map(([label, value, tone]) => (
            <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="text-xs font-semibold text-slate-500">{label}</div><div className={`mt-1 text-2xl font-black ${tone}`}>{value}</div></div>
          ))}
        </section>

        <div ref={detailRef} className="scroll-mt-24">
          {selected && (
            <div className="fixed inset-0 z-40 overflow-y-auto bg-[#f6f7f9] pt-[env(safe-area-inset-top)] sm:static sm:z-auto sm:overflow-visible sm:bg-transparent sm:pt-0">
              <section className="mx-auto max-w-5xl space-y-3 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-0">
                <div className={`sticky top-0 z-10 rounded-2xl border p-3 shadow-sm sm:static sm:rounded-3xl sm:p-5 ${selectedTone.row}`}>
                  <div className="flex items-start gap-2.5">
                    <div className={`rounded-xl border p-2 ${selectedTone.badge}`}><SelectedIcon className="h-5 w-5" /></div>
                    <div className="min-w-0 flex-1"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{selected.po_number ? `PO ${selected.po_number}` : orderedLabel(selected)}</div><h2 className="break-words text-xl font-black leading-tight sm:text-2xl">{selected.order_number}</h2><p className="mt-1 text-xs font-semibold text-slate-600 sm:text-sm">{differenceText(selected)}</p></div>
                    <span className={`hidden rounded-full border px-3 py-1 text-xs font-bold sm:block ${selectedTone.badge}`}>{selectedTone.label}</span>
                    <button type="button" onClick={() => setSelectedId(null)} className="rounded-xl border border-slate-300 bg-white/90 p-2.5 text-slate-600" aria-label="Close purchase order"><X className="h-5 w-5" /></button>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
                    {[['Tag crates', selected.ordered_crates], ['Received', selected.actual_crates ?? '—'], ['Items ordered', selected.expected_items], ['Agent total', selected.reported_items_received ?? '—']].map(([label, value]) => <div key={label} className={`rounded-xl px-1 py-2 ${label === 'Agent total' ? 'border border-indigo-300 bg-indigo-50 text-indigo-950' : label === 'Tag crates' ? 'border border-violet-300 bg-violet-50 text-violet-950' : 'bg-white/80'}`}><div className={`text-[9px] font-bold uppercase ${label === 'Agent total' ? 'text-indigo-600' : label === 'Tag crates' ? 'text-violet-700' : 'text-slate-500'}`}>{label}</div><div className="text-lg font-black leading-none">{value}</div></div>)}
                  </div>
                  <div className="mt-2 flex items-center gap-1 text-[10px] font-bold text-violet-800"><Tag className="h-3 w-3" /> Shopify tags: {(selected.shopify_tags || []).join(", ") || "No numeric crate tag"}</div>
                  {selected.agent_note && <div className="mt-3 rounded-xl border border-amber-300 bg-amber-100 px-3 py-2 text-xs font-bold text-amber-950"><span className="mr-1 text-[9px] uppercase tracking-wider text-amber-700">Agent note</span>{selected.agent_note}</div>}
                </div>

                {isAdmin && !isFinalized && (
                  <details className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <summary className="flex cursor-pointer list-none items-center gap-3 p-4"><div className="rounded-xl bg-slate-100 p-2 text-slate-700"><ClipboardList className="h-5 w-5" /></div><div><h3 className="font-bold">Admin order plan</h3><p className="text-xs text-slate-500">Open to review the Shopify tag and edit item quantities.</p></div><Pencil className="ml-auto h-4 w-4 text-slate-400" /></summary>
                    <div className="border-t border-slate-100 p-4">
                      <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-sm"><div className="rounded-2xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Expected items</div><div className="text-xl font-black">{adminItems.reduce((sum, item) => sum + Number(item.ordered_quantity || 0), 0)}</div></div><div className="rounded-2xl border border-violet-200 bg-violet-50 p-3"><div className="flex items-center gap-1 text-xs font-bold text-violet-700"><Tag className="h-3 w-3" /> Crates from tag</div><div className="text-xl font-black text-violet-950">{adminCrates}</div></div></div>
                      <div className="overflow-hidden rounded-2xl border border-slate-200">
                        <div className="hidden grid-cols-[minmax(180px,1.5fr)_120px_100px_90px_130px] items-center gap-2 border-b border-slate-200 bg-slate-100 px-4 py-2 text-[10px] font-black uppercase tracking-wide text-slate-600 sm:grid"><span>Product</span><span className="text-violet-700">Color</span><span className="text-sky-700">Size</span><span>Shopify</span><span>Ordered</span></div>
                        {adminItems.map((item) => { const dimensions = variantDimensions(item); return <div key={item.id} className="border-b border-slate-100 p-3 last:border-0 sm:grid sm:grid-cols-[minmax(180px,1.5fr)_120px_100px_90px_130px] sm:items-center sm:gap-2 sm:px-4"><ProductIdentity item={item} /><div className="mt-3 grid grid-cols-2 gap-2 sm:mt-0 sm:block"><DimensionBadge type="color" value={dimensions.color} compact /><div className="sm:hidden"><DimensionBadge type="size" value={dimensions.size} compact /></div></div><div className="hidden sm:block"><DimensionBadge type="size" value={dimensions.size} compact /></div><div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm font-black text-slate-700 sm:mt-0 sm:bg-transparent sm:px-0 sm:py-0">Shopify <span className="float-right sm:float-none">{item.shopify_quantity}</span></div><div className="mt-2 sm:mt-0"><QuantityEditButton label="Qty ordered" value={item.ordered_quantity} onClick={() => openQuantityEditor("admin", item)} /></div></div>; })}
                      </div>
                      <div className="mt-4 flex justify-end"><button type="button" onClick={saveAdminPlan} disabled={countBusy} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-slate-950 px-5 text-sm font-bold text-white disabled:opacity-50">{countBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save plan</button></div>
                    </div>
                  </details>
                )}

                <div className="rounded-2xl border border-slate-200 bg-white shadow-sm sm:rounded-3xl">
                  <div className="flex items-center gap-3 border-b border-slate-100 p-4"><div className="rounded-xl bg-indigo-50 p-2 text-indigo-600"><PackageOpen className="h-5 w-5" /></div><div className="min-w-0"><h3 className="font-bold">Receiving count</h3><p className="text-xs text-slate-500">Tap Found to edit a color and size.</p></div><div className="ml-auto rounded-xl bg-indigo-50 px-3 py-2 text-right"><div className="text-[9px] font-bold uppercase text-indigo-600">Found</div><div className="text-xl font-black leading-none text-indigo-950">{actualItems}</div></div></div>
                  <form onSubmit={reviewCount} className="space-y-4 p-3 sm:p-5">
                    <label className="block rounded-2xl border-2 border-violet-300 bg-violet-50 p-3 text-violet-950 shadow-sm">
                      <span className="block text-[10px] font-black uppercase tracking-widest text-violet-700">Crates received · enter manually</span>
                      <input type="number" inputMode="numeric" min="0" required disabled={isFinalized} value={actualCrates} onChange={(event) => setActualCrates(event.target.value === "" ? "" : String(Math.max(0, Number(event.target.value))))} placeholder="0" className="mt-2 h-14 w-full rounded-xl border border-violet-300 bg-white px-3 text-center text-3xl font-black outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100 disabled:bg-violet-100" />
                      <span className="mt-1 block text-center text-[10px] font-semibold text-violet-700">Shopify tag says {selected.ordered_crates} crate{Number(selected.ordered_crates) === 1 ? "" : "s"} ordered</span>
                    </label>
                    <label className="block rounded-2xl border-2 border-indigo-300 bg-indigo-50 p-3 text-indigo-950 shadow-sm">
                      <span className="block text-[10px] font-black uppercase tracking-widest text-indigo-700">Total items received · enter manually</span>
                      <input type="number" inputMode="numeric" min="0" required disabled={isFinalized} value={agentTotalItems} onChange={(event) => setAgentTotalItems(event.target.value === "" ? "" : String(Math.max(0, Number(event.target.value))))} placeholder="0" className="mt-2 h-14 w-full rounded-xl border border-indigo-300 bg-white px-3 text-center text-3xl font-black outline-none focus:border-indigo-600 focus:ring-4 focus:ring-indigo-100 disabled:bg-indigo-100" />
                      <span className="mt-1 block text-center text-[10px] font-semibold text-indigo-700">Variant sum: {actualItems}</span>
                    </label>
                    <div className="space-y-3">
                      {groupedAgentItems.map((group) => (
                        <div key={group.key} className="overflow-hidden rounded-2xl border border-slate-200">
                          <div className="border-b border-slate-200 bg-slate-50 p-3"><ProductIdentity item={{ title: group.title, image_url: group.image_url, image_alt: group.image_alt, sku: `${group.items.length} variant${group.items.length === 1 ? "" : "s"}` }} /></div>
                          {group.colors.map((colorGroup) => {
                            const orderedColor = colorGroup.items.reduce((sum, item) => sum + Number(item.ordered_quantity || 0), 0);
                            const foundColor = colorGroup.items.reduce((sum, item) => sum + Number(item.actual_quantity || 0), 0);
                            const colorDiffers = orderedColor !== foundColor;
                            return (
                              <details key={colorGroup.color} className="border-t border-slate-200 bg-white">
                                <summary className={`flex cursor-pointer list-none items-center gap-2 p-3 ${colorDiffers ? "bg-rose-50 text-rose-950" : "bg-white"}`}>
                                  <div className="rounded-lg bg-violet-100 p-2 text-violet-700"><Palette className="h-4 w-4" /></div>
                                  <div className="min-w-0 flex-1"><div className="whitespace-normal break-words text-sm font-black">{colorGroup.color}</div><div className="text-[10px] text-slate-500">{colorGroup.items.length} size{colorGroup.items.length === 1 ? "" : "s"}</div></div>
                                  <div className="text-right"><div className="text-[9px] font-bold uppercase text-slate-400">Found / ordered</div><div className={`text-sm font-black ${colorDiffers ? "text-rose-700" : "text-slate-800"}`}>{foundColor} / {orderedColor}</div></div>
                                  <Plus className="h-4 w-4 shrink-0 text-slate-400" />
                                </summary>
                                <div className="border-t border-slate-100 bg-slate-50/50">
                                  <div className="grid grid-cols-[minmax(70px,1fr)_60px_82px] gap-2 px-3 py-2 text-[9px] font-black uppercase tracking-wide text-slate-500"><span className="text-sky-700">Size</span><span className="text-center">Ordered</span><span className="text-center">Found</span></div>
                                  {colorGroup.items.map((item) => {
                                    const differs = Number(item.actual_quantity || 0) !== Number(item.ordered_quantity || 0);
                                    const dimensions = variantDimensions(item);
                                    return <div key={item.id} className={`grid grid-cols-[minmax(70px,1fr)_60px_82px] items-center gap-2 border-t border-slate-100 px-3 py-2 ${differs ? "bg-rose-50/80" : "bg-white"}`}><div className="rounded-lg bg-sky-50 px-2 py-2 text-xs font-black text-sky-950">{dimensions.size}</div><div className="text-center text-sm font-black text-slate-700">{item.ordered_quantity}</div><button type="button" disabled={isFinalized} onClick={() => openQuantityEditor("agent", item)} className={`flex min-h-10 items-center justify-center gap-1 rounded-xl border px-1 text-base font-black shadow-sm active:scale-[0.98] disabled:cursor-default disabled:opacity-80 ${differs ? "border-rose-300 bg-rose-100 text-rose-950" : "border-indigo-200 bg-indigo-50 text-indigo-950"}`}><span>{item.actual_quantity}</span>{!isFinalized && <Pencil className="h-3 w-3" />}</button></div>;
                                  })}
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      ))}
                    </div>

                    {!isFinalized && <details className="rounded-2xl border border-slate-200 bg-slate-50" open={!selected.photos?.length}>
                      <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm font-black"><Camera className="h-4 w-4 text-indigo-600" /> Crate photos &amp; note <span className="ml-auto rounded-full bg-white px-2 py-1 text-[10px] text-slate-500">{selected.photos?.length || 0}/4 photos</span></summary>
                      <div className="space-y-3 border-t border-slate-200 p-3">
                        <label className={`inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-white px-3 text-sm font-bold text-indigo-700 ${photoBusy || selected.photos?.length >= 4 ? "pointer-events-none opacity-50" : ""}`}><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={uploadPhoto} className="sr-only" />{photoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Take or add crate photo</label>
                        {!!selected.photos?.length && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{selected.photos.map((photo) => <PrivatePhoto key={photo.id} photo={photo} onDelete={deletePhoto} canDelete={isAdmin || photo.uploaded_by_id === auth?.user?.id} />)}</div>}
                        <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Agent note · optional</span><textarea value={agentNote} onChange={(event) => setAgentNote(event.target.value)} rows="2" placeholder="Damage, opened crate, or anything the admin should know…" className="w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" /></label>
                      </div>
                    </details>}

                    {!!lastSyncOperations.length && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3"><div className="text-xs font-black uppercase tracking-wide text-emerald-800">Verified Shopify result</div>{lastSyncOperations.map((operation, index) => <div key={index} className="mt-1 text-xs font-bold text-emerald-950">{formatInventoryOperation(operation)}</div>)}</div>}
                    {!isFinalized && <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">You will review every inventory change before it is applied to Shopify.</div>}
                    {!isFinalized && <button disabled={countBusy || !agentItems.length || !countHasChanges || agentTotalItems === "" || actualCrates === ""} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-black text-white shadow-sm disabled:bg-slate-300 disabled:text-slate-600"><Check className="h-4 w-4" />{countHasChanges ? "Review & update Shopify inventory" : "Inventory count saved"}</button>}
                    {!isFinalized && selected.actual_items != null && <div className="space-y-2">
                      {countHasChanges && <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-center text-xs font-bold text-slate-600">Save the inventory changes before choosing the final status.</div>}
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button" onClick={() => finalizeReceipt("complete")} disabled={countBusy || countHasChanges} className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-2 py-3 text-xs font-black text-white shadow-sm active:scale-[0.98] disabled:bg-slate-300 disabled:text-slate-600 sm:text-sm"><CheckCircle2 className="h-5 w-5 shrink-0" />Mark complete</button>
                        <button type="button" onClick={() => finalizeReceipt("incomplete")} disabled={countBusy || countHasChanges} className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-2 py-3 text-xs font-black text-amber-950 shadow-sm active:scale-[0.98] disabled:bg-slate-300 disabled:text-slate-600 sm:text-sm"><AlertTriangle className="h-5 w-5 shrink-0" />Mark incomplete</button>
                      </div>
                    </div>}
                    {isFinalized && <div className="space-y-2">
                      <div className={`rounded-2xl border px-4 py-3 text-center text-sm font-black ${selected.status === "complete" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-900"}`}>{selected.status === "complete" ? <CheckCircle2 className="mr-1 inline h-5 w-5" /> : <AlertTriangle className="mr-1 inline h-5 w-5" />} Purchase order marked {selected.status}.</div>
                      <button type="button" onClick={reopenReceipt} disabled={countBusy} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-indigo-200 bg-white px-4 py-3 text-sm font-black text-indigo-700 shadow-sm active:scale-[0.98] disabled:opacity-50">{countBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <RefreshCw className="h-5 w-5" />}Return to receiving queue &amp; edit</button>
                    </div>}
                  </form>
                </div>
              </section>
            </div>
          )}
        </div>
      </main>
      <QuantityEditSheet
        editor={quantityEditor}
        onChange={(value) => setQuantityEditor((current) => current ? { ...current, value } : current)}
        onClose={() => setQuantityEditor(null)}
        onConfirm={confirmQuantityEditor}
      />
      <CountReviewSheet
        open={showCountReview}
        receipt={selected}
        items={agentItems}
        actualCrates={actualCrates}
        totalItemsReceived={agentTotalItems}
        busy={countBusy}
        onClose={() => setShowCountReview(false)}
        onConfirm={saveCount}
      />
    </div>
  );
}
