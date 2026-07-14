function normalizeOrderNumber(value) {
  return String(value || "").trim().replace(/^#/, "");
}

export function parseMerchantOrderReference(value) {
  const match = String(value || "").trim().match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  return { merchantId: Number(match[1]), orderNumber: match[2] };
}

export function normalizeDeliveryQueueRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    ...row,
    id: row.id ?? row.queueRowId ?? row.queue_row_id,
    orderName: row.orderName ?? row.order_name ?? "",
    customerName: row.customerName ?? row.customer_name ?? "",
    customerPhone: row.customerPhone ?? row.customer_phone ?? "",
    cashAmount: row.cashAmount ?? row.cash_amount ?? "",
    specialNote: row.specialNote ?? row.special_note ?? "",
    hasError: row.hasError ?? row.has_error ?? false,
    errorType: row.errorType ?? row.error_type ?? "",
  };
}

export function findDeliveryQueueRow(items, targetOrderNumber) {
  if (!Array.isArray(items)) return null;
  const wanted = normalizeOrderNumber(targetOrderNumber);
  return items
    .map(normalizeDeliveryQueueRow)
    .find((row) => row && normalizeOrderNumber(row.orderName) === wanted) || null;
}
