import test from "node:test";
import assert from "node:assert/strict";

import { parseExplicitDeliveryOrderId } from "../src/lib/deliveryOrderReference.js";


test("plain Shopify order numbers are not treated as internal IDs", () => {
  assert.equal(parseExplicitDeliveryOrderId("81381"), null);
});


test("explicit internal IDs require the id prefix", () => {
  assert.equal(parseExplicitDeliveryOrderId("id:48768"), 48768);
  assert.equal(parseExplicitDeliveryOrderId(" ID : 48768 "), 48768);
});


test("invalid internal IDs are rejected", () => {
  assert.equal(parseExplicitDeliveryOrderId("id:0"), null);
  assert.equal(parseExplicitDeliveryOrderId("id:not-a-number"), null);
});
