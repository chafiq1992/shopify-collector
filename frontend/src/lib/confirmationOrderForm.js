export const SHIPPING_FIELDS = ["first_name", "last_name", "company", "phone", "address1", "address2", "city", "province", "zip", "country"];

export function shippingFields(value = {}) {
  return Object.fromEntries(SHIPPING_FIELDS.map((key) => [key, String(value?.[key] || (key === "country" ? "Morocco" : ""))]));
}

export function customerOrderFields(customer) {
  const address = customer.address || {};
  return {
    shipping: shippingFields({ ...address, first_name: address.first_name || customer.first_name || "", last_name: address.last_name || customer.last_name || "", phone: address.phone || customer.phone || "" }),
    email: customer.email || "",
    customer: { id: customer.id, name: customer.name || [customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Shopify customer", email: customer.email || "", phone: customer.phone || address.phone || "" },
  };
}

export function cartKey(item, index = 0) {
  return item.row_key || (item.id ? `variant:${item.id}` : `source:${item.source_line_id || index}`);
}

export function duplicateOrderSeed(template) {
  const items = [];
  const grouped = new Map();
  for (const [index, source] of (template.items || []).entries()) {
    const row = { ...source, needs_review: Boolean(source.needs_review || source.requires_review), quantity: Number(source.quantity), row_key: source.id ? `variant:${source.id}` : `source:${source.source_line_id || index}` };
    if (source.id && grouped.has(source.id)) {
      const existing = grouped.get(source.id);
      existing.quantity += row.quantity;
      existing.unavailable = existing.unavailable || row.unavailable;
      existing.needs_review = existing.needs_review || row.needs_review;
      existing.unavailable_reason ||= row.unavailable_reason;
    } else {
      items.push(row);
      if (source.id) grouped.set(source.id, row);
    }
  }
  return {
    shipping: shippingFields(template.shipping_address), email: template.email || "", note: "",
    shippingPrice: String(template.shipping_price ?? "0.00"), currency: template.currency || "", items,
    customer: template.customer_id ? { ...template.customer, id: template.customer_id, name: template.customer?.name || "Shopify customer" } : null,
    source: { id: template.source_order_id, name: template.source_order_name, warnings: [...(template.warnings || [])] },
  };
}

export function initialOrderForm(pending, template = null) {
  if (pending?.payload) {
    const payload = pending.payload;
    return {
      shipping: shippingFields(payload.shipping_address), email: payload.email || "", note: payload.note || "",
      shippingPrice: String(payload.shipping_price ?? "0.00"), currency: pending.currency || "",
      items: (pending.items || []).map((item, index) => ({ ...item, row_key: cartKey(item, index) })),
      customer: payload.customer_id ? { ...pending.customer, id: payload.customer_id, name: pending.customer?.name || "Shopify customer" } : null,
      source: pending.source || null, tags: [...(payload.tags || [])],
    };
  }
  // Source-order tags are never copied; a duplicate starts with no tags.
  return template ? { ...duplicateOrderSeed(template), tags: [] } : { shipping: shippingFields(), email: "", note: "", shippingPrice: "0.00", currency: "", items: [], customer: null, source: null, tags: [] };
}

export function orderCartIssue(items) {
  if (!items.length) return "Add at least one product.";
  if (items.length > 50) return "An order can contain at most 50 product variants. Remove a product before creating it.";
  if (items.some((item) => !item.id || item.unavailable || item.needs_review || item.requires_review)) return "Remove or replace every unavailable product before creating this order.";
  if (items.some((item) => !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 999)) return "Each quantity must be a whole number from 1 to 999. Review combined quantities from the source order.";
  return "";
}

export function createOrderPayload({ store, actionId, shipping, email, note, shippingPrice, items, customer, tags = [] }) {
  return {
    store, client_action_id: actionId, shipping_address: shippingFields(shipping),
    email: email.trim() || null, note: note.trim() || null,
    shipping_price: Number(shippingPrice || 0).toFixed(2),
    additions: items.map((item) => ({ variant_id: item.id, quantity: Number(item.quantity) })),
    ...(customer?.id ? { customer_id: customer.id } : {}),
    ...(tags.length ? { tags: [...tags] } : {}),
  };
}
