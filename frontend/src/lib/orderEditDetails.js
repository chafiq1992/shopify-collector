import { shippingFields } from "./confirmationOrderForm.js";
import { requiredOrderCustomer } from "./requiredOrderCustomer.js";

export function orderDetailsDraft(order) {
  return {
    email: order.email || "",
    note: order.note || "",
    tags: [...(order.tags || [])],
    customerId: order.customer_id || null,
    shipping: shippingFields({
      ...Object.fromEntries(["first_name", "last_name", "company", "address1", "address2", "city", "province", "zip", "country"].map((key) => [key, order[`shipping_${key}`] || ""])),
      phone: order.phone || "",
    }),
  };
}

export function orderDetailsPatch(original, draft) {
  if (!original) return {};
  const patch = {};
  if (draft.email.trim() !== original.email.trim()) patch.email = draft.email.trim() || null;
  // Preserve line breaks and spaces; the order note is editable in full.
  if (draft.note !== original.note) {
    patch.note = draft.note;
    patch.original_note = original.note;
  }
  const has = (tags, value) => tags.some((tag) => tag.toLowerCase() === value.toLowerCase());
  const added = draft.tags.filter((tag) => !has(original.tags, tag));
  const removed = original.tags.filter((tag) => !has(draft.tags, tag));
  if (added.length) patch.tags_added = added;
  if (removed.length) patch.tags_removed = removed;
  if (draft.customerId && draft.customerId !== original.customerId) patch.customer_id = draft.customerId;
  if (Object.keys(original.shipping).some((key) => draft.shipping[key].trim() !== original.shipping[key].trim())) {
    patch.shipping_address = shippingFields(draft.shipping);
  }
  return patch;
}

export function orderDetailsIssue(patch) {
  if (patch.shipping_address) {
    const missing = requiredOrderCustomer(patch.shipping_address);
    if (Object.values(missing).some(Boolean) || !patch.shipping_address.country.trim()) {
      return "Enter a customer name, valid phone, delivery address, city, and country before saving.";
    }
  }
  if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) return "Enter a valid email address or leave it empty.";
  return "";
}
