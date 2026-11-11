import test from "node:test";
import assert from "node:assert/strict";
import { orderDetailsDraft, orderDetailsPatch, orderDetailsIssue } from "../src/lib/orderEditDetails.js";

const order = { id: "gid://shopify/Order/1", email: "order@example.test", customer_email: "profile@example.test", note: "Original\nStaff note", tags: ["Agent", "n1"], customer_id: "gid://shopify/Customer/2", phone: "0612345678", shipping_first_name: "Test", shipping_last_name: "Customer", shipping_address1: "Street 1", shipping_address2: "", shipping_city: "Casablanca", shipping_country: "Morocco" };

test("editing an untouched order does not rewrite its metadata", () => {
  const original = orderDetailsDraft(order);
  assert.deepEqual(orderDetailsPatch(original, structuredClone(original)), {});
  assert.equal(original.email, order.email);
  assert.equal(orderDetailsDraft({ ...order, email: null }).email, "", "do not substitute customer profile email");
});

test("note and email can be explicitly cleared without changing tags, address or customer", () => {
  const original = orderDetailsDraft(order);
  assert.deepEqual(orderDetailsPatch(original, { ...original, note: "", email: "" }), { note: "", original_note: order.note, email: null });
});

test("tag additions/removals are case-insensitive intent rather than a full replacement", () => {
  const original = orderDetailsDraft(order);
  assert.deepEqual(orderDetailsPatch(original, { ...original, tags: ["agent", "Urgent"] }), { tags_added: ["Urgent"], tags_removed: ["n1"] });
});

test("only changed delivery and customer association fields are submitted", () => {
  const original = orderDetailsDraft(order);
  const draft = { ...original, shipping: { ...original.shipping, city: "Rabat" }, customerId: "gid://shopify/Customer/3" };
  const patch = orderDetailsPatch(original, draft);
  assert.equal(patch.shipping_address.city, "Rabat");
  assert.equal(patch.customer_id, draft.customerId);
  assert.equal("note" in patch, false);
  assert.equal("email" in patch, false);
  assert.equal(orderDetailsIssue(patch), "");
});

test("incomplete old orders can receive metadata edits; new address edits must be complete", () => {
  const original = orderDetailsDraft({ ...order, phone: "", shipping_city: "" });
  const patch = orderDetailsPatch(original, { ...original, note: "Update" });
  assert.equal(orderDetailsIssue(patch), "");
  assert.match(orderDetailsIssue({ shipping_address: { ...original.shipping, address1: "New street" } }), /valid phone/);
  assert.match(orderDetailsIssue({ email: "invalid" }), /valid email/);
  assert.equal(orderDetailsIssue({ email: null }), "");
});
