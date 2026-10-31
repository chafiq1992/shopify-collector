import test from "node:test";
import assert from "node:assert/strict";

import {
  additionUnitPrice,
  estimateEditedTotal,
  formatMoney,
  summarizeDiscounts,
} from "../src/lib/orderEditPricing.js";

// Order #103671: three free sneakers and one 239.99 sneaker sold at 229.00.
const line = (original, discounted, itemDiscount) => ({
  original_unit_price: original, discounted_unit_price: discounted,
  unit_discount: (original - discounted).toFixed(2), item_unit_discount: itemDiscount, discounts: [],
});
const pricing = {
  shipping: "0.00",
  total: "229.00",
  discounts: [
    { label: "Item discount", applies_to: "item", is_code: false, amount: "249.99" },
    { label: "Item discount", applies_to: "item", is_code: false, amount: "249.99" },
    { label: "Item discount", applies_to: "item", is_code: false, amount: "249.99" },
    { label: "Item discount", applies_to: "item", is_code: false, amount: "10.99" },
    { label: "SUMMER", applies_to: "order", is_code: true, amount: "0.00" },
  ],
  line_items: {
    a: line(249.99, 0, "249.99"),
    b: line(249.99, 0, "249.99"),
    c: line(249.99, 0, "249.99"),
    d: line(239.99, 229, "10.99"),
  },
};
const items = ["a", "b", "c", "d"].map((id) => ({ id, quantity: 1, unit_price: pricing.line_items[id].original_unit_price }));

test("discounts with the same name are added together", () => {
  assert.deepEqual(summarizeDiscounts(pricing), [
    { label: "Item discount", appliesTo: "item", isCode: false, cents: 76096 },
  ]);
});

test("unchanged order estimates the current total", () => {
  assert.equal(formatMoney(estimateEditedTotal({ pricing, items, quantities: {}, additions: [] })), "229.00");
});

test("removing a free item does not change the total", () => {
  assert.equal(estimateEditedTotal({ pricing, items, quantities: { a: 0 }, additions: [] }), 22900);
});

test("a replacement keeps the replaced item's discount unless the agent drops it", () => {
  const kept = { replaces: "a", keepDiscount: true, price: "249.99", quantity: 1 };
  assert.equal(additionUnitPrice(pricing, kept), 0);
  assert.equal(estimateEditedTotal({ pricing, items, quantities: { a: 0 }, additions: [kept] }), 22900);

  const dropped = { ...kept, keepDiscount: false };
  assert.equal(estimateEditedTotal({ pricing, items, quantities: { a: 0 }, additions: [dropped] }), 47899);
});

test("a carried discount never makes the new price negative", () => {
  assert.equal(additionUnitPrice(pricing, { replaces: "d", price: "5.00", quantity: 1 }), 0);
});

test("no estimate until pricing has loaded", () => {
  assert.equal(estimateEditedTotal({ pricing: null, items, quantities: {}, additions: [] }), null);
});
