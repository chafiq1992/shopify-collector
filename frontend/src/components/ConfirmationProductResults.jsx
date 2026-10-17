import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Package, Plus, RefreshCw } from "lucide-react";
import { autoExpandedProductId, productSummaryLabels } from "../lib/productSearchPaging";
import { loadProductVariants } from "../lib/useConfirmationProductSearch";

const STOCK_TONES = { good: "text-emerald-700", bad: "text-rose-700", muted: "text-gray-500" };

export function VariantStock({ variant }) {
  const tracked = variant.inventory_tracked !== false;
  const available = Object.hasOwn(variant, "available_quantity") ? variant.available_quantity : variant.inventory_quantity;
  const stock = [
    ["On hand", variant.on_hand_quantity, "border-sky-200 bg-sky-50 text-sky-900"],
    ["Available", available, Number(available) <= 0 && available != null
      ? "border-rose-200 bg-rose-50 text-rose-900"
      : "border-emerald-200 bg-emerald-50 text-emerald-900"],
  ];
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Variant stock">
      {stock.map(([label, value, colors]) => (
        <span key={label} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${colors}`}>
          {label} <strong className="text-xs font-bold tabular-nums">{!tracked ? "Not tracked" : value == null ? "Unknown" : value}</strong>
        </span>
      ))}
    </div>
  );
}

function Thumb({ src, alt, size }) {
  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-white ${size}`}>
      {src ? <img src={src} alt={alt} loading="lazy" className="h-full w-full object-contain" /> : <Package size={20} className="text-gray-400" aria-hidden />}
    </div>
  );
}

function VariantRow({ variant, product, currency, matched, onChoose, actionLabel, disabled, resultTestId }) {
  const title = variant.variant_title && variant.variant_title !== "Default Title" ? variant.variant_title : "Default variant";
  return (
    <li>
      <button type="button" data-testid={resultTestId} disabled={disabled} onClick={() => onChoose(variant)}
        className={`flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-left hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 disabled:opacity-50 ${matched ? "bg-amber-50/60" : ""}`}>
        {variant.image && variant.image !== product.image && <Thumb src={variant.image} alt={`${product.title} ${title}`} size="h-11 w-11" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-800">{title}</span>
            {matched && <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">Matches search</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 break-all font-mono text-[10px] text-gray-500">
            {variant.sku && <span>SKU {variant.sku}</span>}
            <span>ID {String(variant.id).split("/").pop()}</span>
          </div>
        </div>
        <VariantStock variant={variant} />
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-gray-900">{variant.price} {variant.currency || currency}</span>
          <span className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white">{actionLabel} <Plus size={13} aria-hidden /></span>
        </span>
      </button>
    </li>
  );
}

// Matching products start collapsed; opening one lists its variants below it.
export default function ConfirmationProductResults({ searchState, currency, onChoose, actionLabel = "Add", disabled = false, resultTestId, loadVariants = loadProductVariants }) {
  const products = searchState?.products || [];
  const store = searchState?.store || "";
  const [open, setOpen] = useState(() => new Set());
  const [variantsById, setVariantsById] = useState({});
  const requests = useRef(new Map());
  const autoOpened = useRef("");

  useEffect(() => {
    // A different store or query starts with every product collapsed again.
    setOpen(new Set());
    autoOpened.current = "";
  }, [store, searchState?.query]);
  useEffect(() => {
    for (const controller of requests.current.values()) controller.abort();
    requests.current.clear();
    setVariantsById({});
  }, [store]);
  useEffect(() => () => { for (const controller of requests.current.values()) controller.abort(); }, []);

  function fetchVariants(productId) {
    if (requests.current.has(productId)) return;
    const controller = new AbortController();
    requests.current.set(productId, controller);
    setVariantsById((current) => ({ ...current, [productId]: { ...current[productId], loading: true, error: "" } }));
    loadVariants(store, productId, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setVariantsById((current) => ({ ...current, [productId]: { loading: false, error: "", variants: result.variants || [], warnings: result.warnings || [] } })); })
      .catch((error) => { if (!controller.signal.aborted) setVariantsById((current) => ({ ...current, [productId]: { ...current[productId], loading: false, error: error.message || "Could not load variants." } })); })
      .finally(() => { if (requests.current.get(productId) === controller) requests.current.delete(productId); });
  }

  function toggle(productId) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId); else next.add(productId);
      return next;
    });
    if (!open.has(productId) && !variantsById[productId]?.variants) fetchVariants(productId);
  }

  const autoId = autoExpandedProductId(products);
  useEffect(() => {
    const key = `${store}\0${searchState?.query}\0${autoId}`;
    if (!autoId || searchState?.loading || autoOpened.current === key) return;
    autoOpened.current = key;
    setOpen((current) => new Set([...current, autoId]));
    if (!variantsById[autoId]?.variants) fetchVariants(autoId);
  });

  if (!products.length && !searchState?.hasNextPage && !searchState?.error && !searchState?.warnings?.length) return null;
  return (
    <div>
      {products.length > 0 && <ul className="mt-3 max-h-[32rem] divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-200 bg-white" aria-label="Product search results">
        {products.map((product) => {
          const expanded = open.has(product.id);
          const labels = productSummaryLabels(product, currency);
          const entry = variantsById[product.id] || {};
          const matched = new Set(product.matched_variant_ids || []);
          const panelId = `product-variants-${String(product.id).split("/").pop()}`;
          return (
            <li key={product.id}>
              <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => toggle(product.id)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${expanded ? "bg-slate-50" : ""}`}>
                <Thumb src={product.image} alt={product.title || "Product"} size="h-14 w-14" />
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 break-words text-sm font-semibold text-gray-900">{product.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                    <span>{labels.variants}</span>
                    {labels.price && <><span aria-hidden>·</span><span className="font-medium tabular-nums text-gray-800">{labels.price}</span></>}
                    {labels.stock.label && <><span aria-hidden>·</span><span className={`font-medium ${STOCK_TONES[labels.stock.tone]}`}>{labels.stock.label}</span></>}
                    {product.status && product.status !== "ACTIVE" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-900">{product.status.toLowerCase()}</span>}
                    {product.match_kind === "identifier" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">SKU / barcode match</span>}
                  </div>
                </div>
                <ChevronDown size={18} className={`shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-180 text-indigo-600" : ""}`} aria-hidden />
              </button>
              {expanded && (
                <div id={panelId} className="border-t border-gray-100 bg-slate-50/70 px-2 pb-2 pt-1.5 sm:pl-[4.75rem]">
                  {entry.loading && !entry.variants && <p role="status" className="px-2 py-3 text-xs text-gray-500">Loading variants and stock…</p>}
                  {entry.error && <p role="alert" className="flex flex-wrap items-center gap-2 px-2 py-2 text-xs text-rose-700">{entry.error}<button type="button" onClick={() => fetchVariants(product.id)} className="inline-flex items-center gap-1 font-semibold underline"><RefreshCw size={12} aria-hidden />Retry</button></p>}
                  {entry.warnings?.map((warning) => <p key={warning} className="px-2 py-1 text-[11px] text-amber-800">{warning}</p>)}
                  {entry.variants && (entry.variants.length
                    ? <ul className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white" aria-label={`${product.title} variants`}>
                        {entry.variants.map((variant) => <VariantRow key={variant.id} variant={variant} product={product} currency={currency} matched={matched.has(variant.id)} onChoose={onChoose} actionLabel={actionLabel} disabled={disabled} resultTestId={resultTestId} />)}
                      </ul>
                    : <p className="px-2 py-3 text-xs text-gray-500">This product has no variants to add.</p>)}
                </div>
              )}
            </li>
          );
        })}
      </ul>}
      {searchState && <div className="mt-3 space-y-2">
        {searchState.warnings?.map((warning) => <p key={warning} className="text-xs text-amber-800">{warning}</p>)}
        {searchState.moreError && <p role="alert" className="text-xs text-rose-700">{searchState.moreError}</p>}
        {searchState.hasNextPage && <button type="button" disabled={disabled || searchState.loading || searchState.loadingMore} onClick={searchState.loadMore} className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 text-sm font-semibold text-indigo-800 hover:bg-indigo-100 disabled:opacity-50">{searchState.loadingMore ? "Loading more…" : searchState.moreError ? "Retry loading more products" : "Load more products"}</button>}
        {searchState.error && <button type="button" disabled={disabled || searchState.loading} onClick={searchState.retry} className="text-xs font-semibold text-indigo-700 underline">Retry product search</button>}
        {products.length > 0 && <p className="text-[11px] text-gray-500">{products.length} matching product{products.length === 1 ? "" : "s"}{searchState.hasNextPage ? " · More matches available" : ""} · Open a product to choose its variant</p>}
      </div>}
    </div>
  );
}
