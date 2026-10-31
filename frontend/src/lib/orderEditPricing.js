// Prices for the confirmation order editor, from /api/agent/order-pricing.
// Shopify recalculates on save; these numbers are what the agent quotes.

const cents = (value) => Math.round(Number(value || 0) * 100);
export const formatMoney = (centsValue) => (centsValue / 100).toFixed(2);

// One row per distinct discount (four "Item discount" applications on four
// lines read as a single "Item discount" total).
export function summarizeDiscounts(pricing) {
  const rows = new Map();
  for (const discount of pricing?.discounts || []) {
    const key = `${discount.applies_to}|${discount.label}`;
    const row = rows.get(key) || { label: discount.label, appliesTo: discount.applies_to, isCode: discount.is_code, cents: 0 };
    row.cents += cents(discount.amount);
    rows.set(key, row);
  }
  return [...rows.values()].filter((row) => row.cents > 0);
}

// An agent-typed price in cents, or null when it isn't a usable price.
export function parsePrice(value, maxCents = Infinity) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const parsed = cents(text);
  return parsed <= maxCents ? parsed : null;
}

// Existing lines whose price the agent changed: { lineId: cents }.
export function changedPrices(pricing, prices) {
  const changed = {};
  for (const [lineId, value] of Object.entries(prices || {})) {
    const line = pricing?.line_items?.[lineId];
    if (!line?.price_editable) continue;
    const price = parsePrice(value, cents(line.original_unit_price));
    if (price !== null && price !== cents(line.item_unit_price)) changed[lineId] = price;
  }
  return changed;
}

// The replaced item's own per-unit discount that a new variant keeps.
export function carriedUnitDiscount(pricing, addition) {
  if (!addition?.replaces || addition.keepDiscount === false) return 0;
  return cents(pricing?.line_items?.[addition.replaces]?.item_unit_discount);
}

export function additionUnitPrice(pricing, addition) {
  const price = cents(addition.price);
  const set = parsePrice(addition.unitPrice, price);
  if (set !== null) return set;
  return Math.max(0, price - carriedUnitDiscount(pricing, addition));
}

export function estimateEditedTotal({ pricing, items, quantities, additions, prices }) {
  if (!pricing) return null;
  const newPrices = changedPrices(pricing, prices);
  let total = cents(pricing.shipping);
  for (const item of items || []) {
    const quantity = Number(quantities?.[item.id] ?? item.quantity ?? 0);
    const line = pricing.line_items?.[item.id];
    let unit = line ? cents(line.discounted_unit_price) : cents(item.unit_price);
    // A new price replaces the item's own discount; order-wide discounts stay.
    if (line && item.id in newPrices) unit = Math.max(0, unit + newPrices[item.id] - cents(line.item_unit_price));
    total += unit * quantity;
  }
  for (const addition of additions || []) {
    total += additionUnitPrice(pricing, addition) * Number(addition.quantity || 0);
  }
  return total;
}
