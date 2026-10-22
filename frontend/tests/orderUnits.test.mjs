import assert from "node:assert/strict";
import test from "node:test";
import { applyFulfillmentQuantities, expandOrderUnits } from "../src/lib/orderUnits.js";

test("two of the same variant produce distinct one-unit cards without changing mutation ids", () => {
  const variant = { id: "variant-1", qty: 2, unfulfilled_qty: 2, status: "UNFULFILLED", unit_price: 80 };
  const units = expandOrderUnits([variant]);
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((v) => [v.id, v.qty, v.unfulfilled_qty, v.unitIndex]), [["variant-1", 1, 1, 0], ["variant-1", 1, 1, 1]]);
  assert.equal(new Set(units.map((v) => v.displayKey)).size, 2);
  assert.ok(units.every((v) => v.sourceVariant === variant && v.unitCount === 2));
  assert.equal(variant.qty, 2);
});

test("partial fulfillment shows precisely one active and one fulfilled card", () => {
  const units = expandOrderUnits([{ id: "variant-1", qty: 2, unfulfilled_qty: 1, status: "unfulfilled" }]);
  assert.deepEqual(units.map((v) => v.status), ["unfulfilled", "fulfilled"]);
  assert.deepEqual(units.map((v) => v.unfulfilled_qty), [1, 0]);
});

test("fulfilled fallback, missing remaining count, removed and duplicate lines remain distinguishable", () => {
  const units = expandOrderUnits([
    { id: "same", qty: 2, status: "FULFILLED" },
    { id: "same", qty: 1, status: "UNFULFILLED", unfulfilled_qty: null },
    { id: "removed", qty: 0, original_qty: 2 },
    { id: "restocked", qty: 2, status: "Restocked" },
  ]);
  assert.equal(units.length, 5);
  assert.equal(new Set(units.map((v) => v.displayKey)).size, 5);
  assert.deepEqual(units.map((v) => v.status), ["fulfilled", "fulfilled", "unfulfilled", "removed", "removed"]);
});

test("remaining count is clamped to live quantity and invalid inputs do not create phantom cards", () => {
  assert.deepEqual(expandOrderUnits(null), []);
  assert.deepEqual(expandOrderUnits([null]), []);
  assert.equal(expandOrderUnits([{ qty: 2, unfulfilled_qty: 20 }]).length, 2);
  assert.equal(expandOrderUnits([{ qty: 2, unfulfilled_qty: -1 }]).filter((v) => v.status === "unfulfilled").length, 0);
});

test("fulfilling one fulfillment line reduces one unit without fulfilling a whole duplicate variant", () => {
  const variants = [
    { id: "same", qty: 2, unfulfilled_qty: 2 },
    { id: "same", qty: 1, unfulfilled_qty: 1 },
    { id: "other", qty: 1, unfulfilled_qty: 1 },
  ];
  const result = applyFulfillmentQuantities(variants, new Map([["same", 1]]));
  assert.deepEqual(result.map((v) => v.unfulfilled_qty), [1, 1, 1]);
  assert.equal(expandOrderUnits(result).filter((v) => v.status === "fulfilled").length, 1);
  assert.deepEqual(variants.map((v) => v.unfulfilled_qty), [2, 1, 1]);
});

test("selected quantities are consumed once across duplicate Shopify variant lines", () => {
  const result = applyFulfillmentQuantities([
    { id: "same", qty: 2, unfulfilled_qty: 2 },
    { id: "same", qty: 2, unfulfilled_qty: 2 },
    { id: "same", qty: 0, status: "removed" },
  ], new Map([["same", 3]]));
  assert.deepEqual(result.map((v) => v.unfulfilled_qty), [0, 1, undefined]);
  assert.equal(result[2].status, "removed");
});
