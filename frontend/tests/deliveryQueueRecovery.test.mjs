import test from "node:test";
import assert from "node:assert/strict";

import {
  findCreatedDeliveryOrderId,
  findDeliveryQueueRow,
  hasDeliveryUpdateErrors,
  parseMerchantOrderReference,
} from "../src/lib/deliveryQueueRecovery.js";


test("merchant-order references keep merchant and Shopify order separate", () => {
  assert.deepEqual(parseMerchantOrderReference("9-81018"), {
    merchantId: 9,
    orderNumber: "81018",
  });
  assert.equal(parseMerchantOrderReference("EN-81018"), null);
});


test("queue recovery matches hashes and normalizes error fields", () => {
  const row = findDeliveryQueueRow([
    { id: 1, orderName: "#99999" },
    { queue_row_id: 52189, order_name: "#81018", has_error: true, error_type: "city" },
  ], "81018");

  assert.equal(row.id, 52189);
  assert.equal(row.orderName, "#81018");
  assert.equal(row.hasError, true);
  assert.equal(row.errorType, "city");
});


test("non-array queue payloads cannot crash recovery", () => {
  assert.equal(findDeliveryQueueRow(null, "81018"), null);
  assert.equal(findDeliveryQueueRow({ items: [] }, "81018"), null);
});


test("a city error is derived even when the queue omits has_error", () => {
  const row = findDeliveryQueueRow([
    { queue_row_id: 48406, order_name: "#161660", error_type: "city" },
  ], "161660");

  assert.equal(row.hasError, true);
  assert.equal(row.errorType, "city");
});


test("empty update errors are successful and populated errors are not", () => {
  assert.equal(hasDeliveryUpdateErrors({ success: true, errors: [] }), false);
  assert.equal(hasDeliveryUpdateErrors({ ok: true, errors: {} }), false);
  assert.equal(hasDeliveryUpdateErrors({ success: false, errors: [] }), true);
  assert.equal(hasDeliveryUpdateErrors({ errors: [{ field: "city" }] }), true);
});


test("duplicate add responses can expose the existing delivery order", () => {
  assert.equal(findCreatedDeliveryOrderId({
    results: [{ queueRowId: 48406, status: "duplicate", existingOrderId: 91234 }],
  }, 48406), 91234);
  assert.equal(findCreatedDeliveryOrderId({
    results: [{ queue_row_id: 48406, status: "added", order_id: 91235 }],
  }, 48406), 91235);
});
