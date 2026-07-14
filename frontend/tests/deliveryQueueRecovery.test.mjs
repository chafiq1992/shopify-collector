import test from "node:test";
import assert from "node:assert/strict";

import {
  findDeliveryQueueRow,
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
