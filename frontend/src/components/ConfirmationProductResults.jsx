import React from "react";
import { Package, Plus } from "lucide-react";
import { interleaveProductVariants } from "../lib/productSearchPaging";

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
    <div className="mt-2 flex flex-wrap gap-2" aria-label="Variant stock">
      {stock.map(([label, value, colors]) => (
        <span key={label} className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-medium ${colors}`}>
          {label} <strong className="text-sm font-bold tabular-nums">{!tracked ? "Not tracked" : value == null ? "Unknown" : value}</strong>
        </span>
      ))}
    </div>
  );
}

export default function ConfirmationProductResults({ variants, currency, onChoose, actionLabel = "Add", disabled = false, searchState, resultTestId }) {
  if (!variants.length && !searchState?.hasNextPage && !searchState?.error && !searchState?.warnings?.length) return null;
  return (
    <div>
    {variants.length > 0 && <div className="mt-3 max-h-[30rem] divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-200" aria-label="Product search results">
      {interleaveProductVariants(variants).map((variant) => (
        <button key={variant.id} type="button" data-testid={resultTestId} disabled={disabled} onClick={() => onChoose(variant)}
          className="flex w-full items-start gap-3 p-3 text-left hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 disabled:opacity-50 sm:gap-4">
          <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-white sm:h-32 sm:w-32">
            {variant.image
              ? <img src={variant.image} alt={variant.product_title || "Product"} loading="lazy" className="h-full w-full object-contain" />
              : <Package size={32} className="text-gray-400" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-semibold text-gray-900">{variant.product_title}</div>
            <div className="mt-1 break-words text-sm font-medium text-indigo-800">
              {variant.variant_title && variant.variant_title !== "Default Title" ? variant.variant_title : "Default variant"}
            </div>
            {variant.sku && <div className="mt-0.5 break-all text-xs text-gray-500">SKU {variant.sku}</div>}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 break-all font-mono text-[10px] text-gray-500">{variant.product_id && <span>Product ID {String(variant.product_id).split("/").pop()}</span>}<span>Variant ID {String(variant.id).split("/").pop()}</span></div>
            <VariantStock variant={variant} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold tabular-nums text-gray-900">{variant.price} {variant.currency || currency}</span>
              <span className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white">{actionLabel} <Plus size={13} aria-hidden /></span>
            </div>
          </div>
        </button>
      ))}
    </div>}
    {searchState && <div className="mt-3 space-y-2">
      {searchState.warnings?.map((warning) => <p key={warning} className="text-xs text-amber-800">{warning}</p>)}
      {searchState.moreError && <p role="alert" className="text-xs text-rose-700">{searchState.moreError}</p>}
      {searchState.hasNextPage && <button type="button" disabled={disabled || searchState.loading || searchState.loadingMore} onClick={searchState.loadMore} className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 text-sm font-semibold text-indigo-800 hover:bg-indigo-100 disabled:opacity-50">{searchState.loadingMore ? "Loading more…" : searchState.moreError ? "Retry loading more products" : "Load more products and variants"}</button>}
      {searchState.error && <button type="button" disabled={disabled || searchState.loading} onClick={searchState.retry} className="text-xs font-semibold text-indigo-700 underline">Retry product search</button>}
      {variants.length > 0 && <p className="text-[11px] text-gray-500">{variants.length} variants loaded{searchState.hasNextPage ? " · More matches available" : ""}</p>}
    </div>}
    </div>
  );
}
