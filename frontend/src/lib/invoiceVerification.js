export function isFinancialStatusPaid(status) {
  const value = String(status || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  return ["paid", "paye", "payee"].includes(value);
}

export function canMarkInvoiceRowPaid(row, match) {
  const prefix = String(row?.sendCode || "").split("-")[0];
  const expectedStore = ({ "7": "irrakids", "9": "irranova" })[prefix] || row?.routingStore;
  return row?._doc?.validation?.complete === true && row.extractionComplete === true
    && !row.invoiceOnly && !match?.invoice_only
    && row.status === "Livré" && !!match?.found && !match?.ambiguous
    && !!expectedStore && match.store === expectedStore && !row.routingError
    && !!match?.order_gid && !!match?.store && !isFinancialStatusPaid(match.financial_status);
}

export function invoiceLookupItems(docs) {
  return docs.flatMap(doc => (doc.rows || []).filter(row => row.orderNumber).map(row => ({
    lookup_key: row.lookupKey, order_number: String(row.orderNumber),
    store: row.routingStore || null, crbt: row.crbt, is_refused: row.status === "Refusé",
    routing_error: row.routingError || null,
    send_code: row.sendCode, company: doc.company,
  })));
}
