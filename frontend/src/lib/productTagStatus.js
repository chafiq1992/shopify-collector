// Product tags that tell confirmation agents what to do with an order:
//   test               -> don't touch the order
//   cod/change         -> product unavailable, the customer must change it
//   cod/3-4 … cod/15-16 -> don't confirm yet, hold for that many days
// Untagged products are ready to confirm.

const SEVERITY = { test: 3, change: 2, days: 1, ready: 0 };

const CHANGE_RE = /^cod\s*[-/_ ]\s*change$/i;
const DAYS_RE = /^cod\s*[-/_ ]?\s*(\d{1,2})\s*[-/]\s*(\d{1,2})$/i;

export function parseProductTag(tag) {
  const t = String(tag || "").trim();
  if (t.toLowerCase() === "test") return { kind: "test", label: "TEST" };
  if (CHANGE_RE.test(t)) return { kind: "change", label: "COD CHANGE" };
  const m = t.match(DAYS_RE);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    return { kind: "days", from, to, label: `COD ${from}-${to} DAYS` };
  }
  return null;
}

// The most severe instruction among one product's tags; a product carrying
// several day ranges is held for the longest one.
export function lineItemTagStatus(lineItem) {
  let best = { kind: "ready", label: "READY" };
  for (const tag of lineItem?.product_tags || []) {
    const parsed = parseProductTag(tag);
    if (!parsed) continue;
    const more = SEVERITY[parsed.kind] - SEVERITY[best.kind];
    if (more > 0 || (more === 0 && parsed.kind === "days" && parsed.to > best.to)) best = parsed;
  }
  return best;
}

export function isNegativeStock(lineItem) {
  return lineItem?.inventory_tracked === true
    && typeof lineItem.available_quantity === "number"
    && lineItem.available_quantity < 0;
}

export function orderProductStatus(order) {
  const items = order?.line_items || [];
  const statuses = items.map(lineItemTagStatus);
  let kind = "ready";
  for (const s of statuses) if (SEVERITY[s.kind] > SEVERITY[kind]) kind = s.kind;
  const labels = new Set(statuses.map((s) => s.label));
  const top = statuses.find((s) => s.kind === kind);
  return {
    kind,
    label: top?.label || "READY",
    mixed: labels.size > 1,
    negativeStock: items.filter(isNegativeStock),
  };
}

// Why an agent should stop before confirming, or "" when the order is clear.
export function confirmWarning(order) {
  const status = orderProductStatus(order);
  const reasons = [];
  if (status.mixed) reasons.push("Products have different tags (MIXED) — check each product.");
  if (status.kind === "test") reasons.push("A product is tagged TEST — don't touch this order.");
  if (status.kind === "change") reasons.push("A product is tagged COD CHANGE — the customer must change it.");
  if (status.kind === "days") reasons.push(`A product is tagged ${status.label} — don't confirm yet.`);
  if (status.negativeStock.length) {
    const names = status.negativeStock.map((li) => `${li.title}${li.variant_title ? ` (${li.variant_title})` : ""}`);
    reasons.push(`Negative stock — check inventory first: ${names.join(", ")}.`);
  }
  return reasons.join("\n");
}

export const PRODUCT_STATUS_THEMES = {
  test: {
    bg: "bg-rose-50", bar: "bg-rose-500",
    badge: "bg-rose-600 text-white border-rose-700",
    chip: "bg-rose-100 text-rose-800 border-rose-300",
    title: "TEST — don't touch this order",
  },
  change: {
    bg: "bg-orange-50", bar: "bg-orange-500",
    badge: "bg-orange-500 text-white border-orange-600",
    chip: "bg-orange-100 text-orange-800 border-orange-300",
    title: "COD CHANGE — product unavailable, the customer must change it",
  },
  days: {
    bg: "bg-lime-50", bar: "bg-lime-400",
    badge: "bg-lime-200 text-lime-900 border-lime-400",
    chip: "bg-lime-100 text-lime-900 border-lime-300",
    title: "Don't confirm yet — hold for the tagged number of days",
  },
  ready: {
    bg: "bg-emerald-50", bar: "bg-emerald-600",
    badge: "bg-emerald-600 text-white border-emerald-700",
    chip: "bg-emerald-100 text-emerald-800 border-emerald-300",
    title: "No product tags — ready to confirm",
  },
};
