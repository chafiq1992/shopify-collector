// Labels for the "Not sent to Delivery" list (GET /api/delivery-unsent).

const ERROR_LABELS = {
  city: "City not recognised",
  phone: "Phone number is invalid",
  order: "Order number is invalid or duplicated",
};

export function unsentReasonLabel(item) {
  if (!item) return "";
  if (item.kind === "not_in_delivery") {
    return "Never reached Delivery. Retry intake, then open it.";
  }
  if (item.hasError) {
    const base = ERROR_LABELS[String(item.errorType || "").toLowerCase()] || `Needs a fix (${item.status || "error"})`;
    const typedCity = String(item.cityRaw || item.city || "").trim();
    return item.errorType === "city" && typedCity ? `${base}: "${typedCity}"` : base;
  }
  return "Waiting in the merchant queue; not sent yet";
}

export function unsentAgeLabel(iso, now = Date.now()) {
  const raw = String(iso || "").trim();
  if (!raw) return "";
  // Delivery sends naive UTC timestamps; read them as UTC, not local time.
  const stamp = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(stamp)) return "";
  const minutes = Math.max(0, Math.round((now - stamp) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
