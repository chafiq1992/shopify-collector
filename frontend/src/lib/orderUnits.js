function quantity(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

export function isRemovedOrderVariant(variant) {
  const status = String(variant?.status || "").trim().toLowerCase();
  return status === "removed" || status === "restocked" || quantity(variant?.qty, 1) <= 0;
}

function remainingUnits(variant, count) {
  return variant?.unfulfilled_qty != null
    ? Math.min(count, quantity(variant.unfulfilled_qty, count))
    : String(variant?.status || "").trim().toLowerCase() === "fulfilled" ? 0 : count;
}

// Display copies only: ids and source variants stay intact for API mutations.
export function expandOrderUnits(variants) {
  return (Array.isArray(variants) ? variants : []).flatMap((variant, sourceIndex) => {
    if (!variant || typeof variant !== "object") return [];
    const removed = isRemovedOrderVariant(variant);
    const count = removed ? 1 : quantity(variant.qty, 1);
    const remaining = removed ? 0 : remainingUnits(variant, count);
    const sourceKey = String(variant.line_item_id || variant.id || variant.sku || "item");
    return Array.from({ length: count }, (_, unitIndex) => ({
      ...variant,
      qty: removed ? variant.qty : 1,
      unfulfilled_qty: unitIndex < remaining ? 1 : 0,
      status: removed ? "removed" : unitIndex < remaining ? "unfulfilled" : "fulfilled",
      displayKey: `${sourceKey}:${sourceIndex}:${unitIndex}`,
      sourceIndex,
      sourceVariant: variant,
      unitIndex,
      unitCount: removed ? quantity(variant.original_qty, 1) : count,
    }));
  });
}

// A selection remains a fulfillment-order line selection, even with many display cards.
export function applyFulfillmentQuantities(variants, fulfilledByVariant) {
  const remainingByVariant = new Map(fulfilledByVariant);
  return (variants || []).map((variant) => {
    if (isRemovedOrderVariant(variant)) return variant;
    const count = quantity(variant.qty, 1);
    const unfulfilled = remainingUnits(variant, count);
    const variantId = String(variant.id || "");
    const fulfilled = Math.min(unfulfilled, quantity(remainingByVariant.get(variantId)));
    remainingByVariant.set(variantId, quantity(remainingByVariant.get(variantId)) - fulfilled);
    if (!fulfilled) return variant;
    const nextRemaining = unfulfilled - fulfilled;
    return { ...variant, unfulfilled_qty: nextRemaining, status: nextRemaining > 0 ? "unfulfilled" : "fulfilled" };
  });
}
