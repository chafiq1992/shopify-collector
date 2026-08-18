import assert from "node:assert/strict";
import test from "node:test";

import {
  formatInventoryOperation,
  groupInventoryColors,
  groupInventoryItems,
  inventoryReview,
} from "../src/lib/inventoryHelper.js";


test("a saved count of two changed to zero plans a minus-two correction", () => {
  const review = inventoryReview([
    {
      id: "red-21",
      title: "Kids shoe",
      actual_quantity: 0,
      inventory_applied_quantity: 2,
    },
  ]);

  assert.equal(review.length, 1);
  assert.equal(review[0].delta, -2);
});


test("product variants are grouped under one compact product heading", () => {
  const groups = groupInventoryItems([
    { id: "red-21", title: "Kids shoe", image_url: "shoe.jpg" },
    { id: "red-22", title: "Kids shoe", image_url: "shoe.jpg" },
    { id: "hat", title: "Hat", image_url: "hat.jpg" },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map((item) => item.id), ["red-21", "red-22"]);
});


test("sizes are collapsed under their color group", () => {
  const colors = groupInventoryColors([
    { id: "red-21", variant_color: "Red", variant_size: "21" },
    { id: "red-22", variant_color: "Red", variant_size: "22" },
    { id: "blue-21", variant_color: "Blue", variant_size: "21" },
  ]);

  assert.equal(colors.length, 2);
  assert.deepEqual(colors[0].items.map((item) => item.id), ["red-21", "red-22"]);
});


test("verified Shopify adjustment describes the exact before and after", () => {
  assert.equal(
    formatInventoryOperation({
      type: "inventory_adjustment",
      title: "Kids shoe",
      delta: -2,
      before_quantity: 3,
      after_quantity: 1,
    }),
    "Kids shoe: Shopify 3 → 1 (-2)",
  );
});
