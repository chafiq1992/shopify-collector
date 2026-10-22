import test from "node:test";
import assert from "node:assert/strict";

import {
  confirmWarning,
  lineItemTagStatus,
  orderProductStatus,
  parseProductTag,
} from "../src/lib/productTagStatus.js";

const line = (product_tags, stock = {}) => ({ title: "Shirt", product_tags, ...stock });

test("parses test, change and day-range product tags in their written variants", () => {
  assert.equal(parseProductTag("Test").kind, "test");
  assert.equal(parseProductTag("cod/change").kind, "change");
  assert.equal(parseProductTag("COD-change").kind, "change");
  assert.deepEqual(parseProductTag("cod-3/4"), { kind: "days", from: 3, to: 4, label: "COD 3-4 DAYS" });
  assert.equal(parseProductTag("cod/4-5").to, 5);
  assert.equal(parseProductTag("cod/15-16").from, 15);
  // Order confirmation tags carry a full date and are not product holds.
  assert.equal(parseProductTag("cod 18/05/26"), null);
  assert.equal(parseProductTag("summer"), null);
});

test("a product's most severe tag wins, and the longest hold among day ranges", () => {
  assert.equal(lineItemTagStatus(line(["cod/3-4", "test"])).kind, "test");
  assert.equal(lineItemTagStatus(line(["cod/3-4", "cod/change"])).kind, "change");
  assert.equal(lineItemTagStatus(line(["cod/3-4", "cod/10-11"])).label, "COD 10-11 DAYS");
  assert.equal(lineItemTagStatus(line([])).kind, "ready");
});

test("orders take the most severe product status and flag mixed products", () => {
  const single = orderProductStatus({ line_items: [line(["cod/6-7"]), line(["cod/6-7"])] });
  assert.equal(single.kind, "days");
  assert.equal(single.mixed, false);

  const mixed = orderProductStatus({ line_items: [line(["cod/change"]), line([])] });
  assert.equal(mixed.kind, "change");
  assert.equal(mixed.mixed, true);

  assert.equal(orderProductStatus({ line_items: [] }).kind, "ready");
});

test("only tracked variants with negative available stock are flagged", () => {
  const status = orderProductStatus({ line_items: [
    line([], { inventory_tracked: true, available_quantity: -1 }),
    line([], { inventory_tracked: true, available_quantity: 0 }),
    line([], { inventory_tracked: false, available_quantity: -5 }),
    line([], { inventory_tracked: true, available_quantity: null }),
  ] });
  assert.equal(status.negativeStock.length, 1);
  assert.equal(status.kind, "ready");
});

test("confirming warns about holds and stock, and stays silent for a ready order", () => {
  assert.equal(confirmWarning({ line_items: [line([], { inventory_tracked: true, available_quantity: 3 })] }), "");
  assert.match(confirmWarning({ line_items: [line(["test"])] }), /don't touch/);
  assert.match(
    confirmWarning({ line_items: [line([], { inventory_tracked: true, available_quantity: -2, variant_title: "M" })] }),
    /Negative stock.*Shirt \(M\)/,
  );
});
