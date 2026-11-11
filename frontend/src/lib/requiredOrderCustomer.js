export function requiredOrderCustomer(fields = {}, minPhoneDigits = 7) {
  const text = (key) => String(fields[key] || "").trim();
  const digits = text("phone").replace(/\D/g, "");
  return {
    first_name: !text("first_name") && !text("last_name"),
    phone: digits.length < minPhoneDigits || digits.length > 15,
    address1: !text("address1"),
    city: !text("city"),
  };
}

export const CUSTOMER_FIELD_LABELS = {
  first_name: "Customer name (first or last name)",
  phone: "Valid phone number",
  address1: "Shipping address",
  city: "Shipping city",
};

export function focusCustomerField(root, missing) {
  const key = Object.keys(missing).find((field) => missing[field]);
  const input = root?.querySelector(`[data-customer-field="${key}"]`);
  input?.scrollIntoView({ block: "center", behavior: "smooth" });
  input?.focus({ preventScroll: true });
}
