function normalizeOrderNumber(value) {
  return String(value || "").trim().replace(/^#/, "");
}

function normalizeErrorValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeErrorValue).find(Boolean) || "";
  }
  if (value && typeof value === "object") {
    return normalizeErrorValue(
      value.type ?? value.field ?? value.code ?? value.message ?? value.detail
    );
  }
  return String(value || "").trim();
}

function truthyErrorFlag(value) {
  if (typeof value === "string") {
    return !["", "0", "false", "no", "none", "null"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

export function parseMerchantOrderReference(value) {
  const match = String(value || "").trim().match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  return { merchantId: Number(match[1]), orderNumber: match[2] };
}

export function normalizeDeliveryQueueRow(row) {
  if (!row || typeof row !== "object") return null;
  const rawCity = String(row.city ?? row.city_name ?? "").trim();
  const exposesCityId = Object.prototype.hasOwnProperty.call(row, "cityId") ||
    Object.prototype.hasOwnProperty.call(row, "city_id");
  const rawCityId = row.cityId ?? row.city_id;
  const missingCityId = exposesCityId && Boolean(rawCity) &&
    (rawCityId == null || String(rawCityId).trim() === "" || Number(rawCityId) === 0);
  const reportedErrorType = normalizeErrorValue(
    row.errorType ??
    row.error_type ??
    row.validationError ??
    row.validation_error ??
    row.error ??
    row.errors
  );
  const errorType = reportedErrorType || (missingCityId ? "city" : "");
  const explicitError = row.hasError ?? row.has_error ?? row.invalid ?? row.isInvalid ?? row.is_invalid;
  return {
    ...row,
    id: row.id ?? row.queueRowId ?? row.queue_row_id,
    orderName: row.orderName ?? row.order_name ?? "",
    customerName: row.customerName ?? row.customer_name ?? "",
    customerPhone: row.customerPhone ?? row.customer_phone ?? "",
    city: rawCity,
    cityId: rawCityId ?? null,
    cashAmount: row.cashAmount ?? row.cash_amount ?? "",
    specialNote: row.specialNote ?? row.special_note ?? "",
    hasError: truthyErrorFlag(explicitError) || Boolean(errorType),
    errorType,
  };
}

export function hasDeliveryUpdateErrors(response) {
  if (!response || typeof response !== "object") return false;
  if (response.success === false || response.ok === false) return true;
  const errors = response.errors;
  if (Array.isArray(errors)) return errors.length > 0;
  if (errors && typeof errors === "object") return Object.keys(errors).length > 0;
  return Boolean(String(errors || "").trim());
}

export function findCreatedDeliveryOrderId(response, queueRowId) {
  const wantedRowId = Number(queueRowId || 0);
  const results = Array.isArray(response?.results) ? response.results : [];
  const match = results.find((result) => {
    const resultRowId = Number(result?.queueRowId ?? result?.queue_row_id ?? result?.id ?? 0);
    return wantedRowId > 0 ? resultRowId === wantedRowId : Boolean(resultRowId);
  });
  const orderId = Number(match?.orderId ?? match?.order_id ?? match?.existingOrderId ?? match?.existing_order_id ?? 0);
  return orderId > 0 ? orderId : null;
}

export function findDeliveryQueueRow(items, targetOrderNumber) {
  if (!Array.isArray(items)) return null;
  const wanted = normalizeOrderNumber(targetOrderNumber);
  return items
    .map(normalizeDeliveryQueueRow)
    .find((row) => row && normalizeOrderNumber(row.orderName) === wanted) || null;
}
