export function isFinancialStatusPaid(status) {
  const value = String(status || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  return ["paid", "paye", "payee"].includes(value);
}

const STORE_BY_PREFIX = { "7": "irrakids", "9": "irranova" };

/**
 * Why this row cannot be paid, or null when it can.
 *
 * Deliberately per row. An invoice that does not reconcile as a whole is worth
 * a warning, but it must not hold back rows that are themselves verified: the
 * operator's remedy is to review the flagged rows and deselect them, and that
 * only works if the rest stay payable. Nothing here reads a row's amounts —
 * orderMarkAsPaid carries no amount, so a misread invoice total cannot move
 * money. What guards the payment is the identity of the order, its store and
 * its delivery status, all of which are checked below and again server-side.
 */
export function invoiceRowPaymentBlocker(row, match) {
  const prefix = String(row?.sendCode || "").split("-")[0];
  const expectedStore = STORE_BY_PREFIX[prefix] || row?.routingStore;
  if (row?.extractionComplete !== true) {
    return (row?.extractionIssues || []).join("; ") || "Row fields need review";
  }
  if (row?.invoiceOnly || match?.invoice_only) return "No Shopify store mapped";
  if (row?.status !== "Livré") return row?.status ? `Not delivered (${row.status})` : "Delivery status requires review";
  if (!match?.found) return "No Shopify order matched";
  if (match?.ambiguous) return "Order number exists in more than one store";
  if (row?.routingError) return row.routingError;
  if (!expectedStore) return "No store mapped for this reference";
  if (match?.store !== expectedStore) {
    return `Invoice says ${expectedStore}, Shopify matched ${match?.store || "nothing"}`;
  }
  if (!match?.order_gid || !match?.store) return "Shopify order identity missing";
  if (isFinancialStatusPaid(match?.financial_status)) return "Already paid";
  return null;
}

export function canMarkInvoiceRowPaid(row, match) {
  return invoiceRowPaymentBlocker(row, match) === null;
}

export function invoiceLookupItems(docs) {
  return docs.flatMap(doc => (doc.rows || []).filter(row => row.orderNumber).map(row => ({
    lookup_key: row.lookupKey, order_number: String(row.orderNumber),
    store: row.routingStore || null, crbt: row.crbt, is_refused: row.status === "Refusé",
    routing_error: row.routingError || null,
    send_code: row.sendCode, company: doc.company,
  })));
}
