/**
 * Parse an intentionally-entered internal Delivery order ID.
 *
 * Plain numbers are Shopify/display order numbers and must be resolved through
 * the Delivery search API. Only `id:<number>` is allowed to bypass that lookup.
 */
export function parseExplicitDeliveryOrderId(value) {
  const match = String(value || "").trim().match(/^id\s*:\s*(\d+)$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
