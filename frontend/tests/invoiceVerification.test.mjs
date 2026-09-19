import test from "node:test";
import assert from "node:assert/strict";
import { isFinancialStatusPaid, canMarkInvoiceRowPaid, invoiceRowPaymentBlocker, invoiceLookupItems } from "../src/lib/invoiceVerification.js";

test("unpaid and partially paid are not confused with fully paid", () => {
  assert.equal(isFinancialStatusPaid("PAID"), true);
  assert.equal(isFinancialStatusPaid("Payée"), true);
  assert.equal(isFinancialStatusPaid("UNPAID"), false);
  assert.equal(isFinancialStatusPaid("PARTIALLY_PAID"), false);
});

test("payment eligibility requires a delivered row matched in its own store", () => {
  const row = { sendCode: "7-123456", routingStore: "irrakids", status: "Livré", extractionComplete: true, _doc: { validation: { complete: true } } };
  const match = { found: true, order_gid: "1", store: "irrakids", financial_status: "PENDING" };
  assert.equal(canMarkInvoiceRowPaid(row, match), true);
  assert.equal(canMarkInvoiceRowPaid({ ...row, sendCode: "9-123456" }, match), false);
  assert.equal(canMarkInvoiceRowPaid({ ...row, status: "Refusé" }, match), false);
  assert.equal(canMarkInvoiceRowPaid({ ...row, extractionComplete: false }, match), false);
  assert.equal(canMarkInvoiceRowPaid(row, { ...match, ambiguous: true }), false);
  assert.equal(canMarkInvoiceRowPaid(row, { ...match, financial_status: "PAID" }), false);
});

test("a row the operator cannot pay says why, so it can be found and deselected", () => {
  const row = { sendCode: "7-123456", routingStore: "irrakids", status: "Livré", extractionComplete: true };
  const match = { found: true, order_gid: "1", store: "irrakids", financial_status: "PENDING" };
  assert.equal(invoiceRowPaymentBlocker(row, match), null);
  assert.equal(invoiceRowPaymentBlocker({ ...row, extractionComplete: false, extractionIssues: ["Missing crbt"] }, match), "Missing crbt");
  assert.equal(invoiceRowPaymentBlocker({ ...row, status: "Refusé" }, match), "Not delivered (Refusé)");
  assert.equal(invoiceRowPaymentBlocker(row, { found: false }), "No Shopify order matched");
  assert.equal(invoiceRowPaymentBlocker(row, { ...match, store: "irranova" }), "Invoice says irrakids, Shopify matched irranova");
  assert.equal(invoiceRowPaymentBlocker(row, { ...match, financial_status: "PAID" }), "Already paid");
});

test("one unverifiable row does not hold back the rows that did verify", () => {
  // The whole point of the checkboxes: an invoice that does not reconcile is a
  // warning on the document, not a freeze on every order inside it.
  const doc = { validation: { complete: false, warnings: ["Expected 22 invoice rows; extracted 21."] } };
  const good = { sendCode: "7-163181", status: "Livré", extractionComplete: true, _doc: doc };
  const bad = { sendCode: "7-163382", status: "Livré", extractionComplete: false, extractionIssues: ["Missing crbt"], _doc: doc };
  const match = { found: true, order_gid: "gid://1", store: "irrakids", financial_status: "PENDING" };
  assert.equal(canMarkInvoiceRowPaid(good, match), true);
  assert.equal(canMarkInvoiceRowPaid(bad, match), false);
});

test("lookup batches retain every shipment, short reference and routing error", () => {
  const rows = Array.from({ length: 110 }, (_, i) => ({ lookupKey: `0:${i}:125`, orderNumber: "125", crbt: 200 }));
  rows[0].routingError = "Conflicting rules";
  const items = invoiceLookupItems([{ rows }]);
  assert.equal(items.length, 110);
  assert.equal(new Set(items.map(r => r.lookup_key)).size, 110);
  assert.equal(items[0].routing_error, "Conflicting rules");
});

test("invoice-only merchants remain in invoice totals without disabling other payments", () => {
  const doc = { validation: { complete: true }, rows: [
    { sendCode: "7-162127", crbt: 250, fees: 23, total: 227, status: "Livré", extractionComplete: true },
    { sendCode: "17-136", crbt: 300, fees: 23, total: 277, status: "Livré", extractionComplete: true, invoiceOnly: true },
    { sendCode: "91224", crbt: 270, fees: 25, total: 245, status: "Livré", extractionComplete: true },
  ] };
  const match = { found: true, order_gid: "gid://1", store: "irrakids", financial_status: "PENDING" };
  assert.equal(doc.rows.reduce((sum, row) => sum + row.crbt, 0), 820);
  assert.equal(canMarkInvoiceRowPaid({ ...doc.rows[0], _doc: doc }, match), true);
  assert.equal(canMarkInvoiceRowPaid({ ...doc.rows[1], _doc: doc }, match), false);
  assert.equal(canMarkInvoiceRowPaid({ ...doc.rows[2], _doc: doc }, match), false);
  assert.equal(canMarkInvoiceRowPaid({ ...doc.rows[0], _doc: { validation: { complete: false } } }, match), true);
});
