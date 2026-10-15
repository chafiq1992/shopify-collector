const ADDRESS_KEYS = ["first_name", "last_name", "company", "address1", "address2", "city", "province", "zip", "country", "phone"];

export const DRAFT_STATUSES = [
  ["", "All"], ["OPEN", "Open"], ["INVOICE_SENT", "Invoice sent"], ["COMPLETED", "Completed"],
];

function address(value) {
  return Object.fromEntries(ADDRESS_KEYS.map((key) => [key, value?.[key] || ""]));
}

export function draftEditor(draft) {
  return {
    email: draft.email || "", phone: draft.phone || "", note: draft.note || "",
    tags: [...(draft.tags || [])], shipping_address: address(draft.shipping_address), billing_address: address(draft.billing_address),
    line_items: (draft.line_items || []).map((item) => ({ ...item, quantity: Number(item.quantity) })),
    shipping_line: { title: draft.shipping_line?.title || "Shipping", price: String(draft.shipping_line?.price ?? draft.total_shipping ?? "0.00") },
    applied_discount: draft.applied_discount
      ? { title: draft.applied_discount.title || "", value: String(draft.applied_discount.value ?? "0"), value_type: draft.applied_discount.value_type || "FIXED_AMOUNT" }
      : null,
  };
}

// Existing lines carry only identity and quantity. Shopify's saved variant options,
// line discounts, tax flags and custom-item fields remain intact on the server.
export function draftLineInput(item) {
  if (item.id && !item.is_new) return { id: item.id, quantity: Number(item.quantity) };
  if (item.variant_id) return { variant_id: item.variant_id, quantity: Number(item.quantity) };
  return { title: String(item.title || "").trim(), unit_price: Number(item.unit_price).toFixed(2), quantity: Number(item.quantity) };
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function draftChanges(draft, editor) {
  const original = draftEditor(draft);
  const changes = {};
  for (const key of ["email", "phone", "note", "tags", "shipping_address", "billing_address", "applied_discount"]) {
    if (!equal(original[key], editor[key])) changes[key] = editor[key];
  }
  const oldShipping = original.shipping_line;
  const shippingChanged = oldShipping.title !== editor.shipping_line.title || Number(oldShipping.price) !== Number(editor.shipping_line.price);
  if (shippingChanged) changes.shipping_line = { title: editor.shipping_line.title, price: Number(editor.shipping_line.price).toFixed(2) };
  const oldLines = original.line_items.map(draftLineInput);
  const newLines = editor.line_items.map(draftLineInput);
  if (!equal(oldLines, newLines)) changes.line_items = newLines;
  return changes;
}

export function draftValidation(editor) {
  if (!editor.line_items.length) return "Add at least one product before saving or completing this draft.";
  for (const item of editor.line_items) {
    if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 999) return "Each quantity must be a whole number from 1 to 999.";
    if (!item.id && !item.variant_id && (!String(item.title || "").trim() || !Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0)) return "Custom items need a title and a valid price.";
  }
  if (!Number.isFinite(Number(editor.shipping_line.price)) || Number(editor.shipping_line.price) < 0) return "Enter a valid shipping fee.";
  const discount = editor.applied_discount;
  if (discount && (!Number.isFinite(Number(discount.value)) || Number(discount.value) < 0 || (discount.value_type === "PERCENTAGE" && Number(discount.value) > 100))) return "Enter a valid discount. Percentages cannot exceed 100%.";
  return "";
}

export function draftListParams({ store, q = "", status = "", sort_key = "UPDATED_AT", reverse = true, date_from = "", date_to = "", tag = "", after = "", before = "" }) {
  const params = new URLSearchParams({ store, first: "30", sort_key, reverse: String(reverse) });
  for (const [key, value] of Object.entries({ q: q.trim(), status, date_from, date_to, tag: tag.trim(), after, before })) {
    if (value) params.set(key, value);
  }
  return params;
}

export function pendingDraftKey(actorId, store, id) {
  return `confirmationPendingDraft:${actorId}:${store}:${id}`;
}

export function draftStockWarning(item) {
  if (item.inventory_tracked === false) return false;
  const available = Object.hasOwn(item, "available_quantity") ? item.available_quantity : item.inventory_quantity;
  return available != null && available !== "" && Number.isFinite(Number(available)) && Number(available) <= 0;
}

export function readDraftCompletion(storage, key, store, id) {
  try {
    const saved = JSON.parse(storage.getItem(key) || "null");
    return saved?.store === store && saved.draft_id === id && saved.client_action_id ? saved : null;
  } catch { return null; }
}
