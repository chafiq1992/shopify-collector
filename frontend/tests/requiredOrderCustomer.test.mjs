import test from "node:test";
import assert from "node:assert/strict";
import { requiredOrderCustomer } from "../src/lib/requiredOrderCustomer.js";

const complete = { first_name: "Amal", phone: "0612345678", address1: "10 Test Street", city: "Rabat" };
test("one name and one address suffice without surname, apartment or email", () => {
  assert.ok(Object.values(requiredOrderCustomer(complete)).every((value) => !value));
  assert.ok(Object.values(requiredOrderCustomer({ ...complete, first_name: " ", last_name: "Amal" })).every((value) => !value));
});
test("each absent or whitespace-only required field blocks even a selected customer", () => {
  for (const field of ["first_name", "phone", "address1", "city"]) {
    for (const value of [undefined, "", "   "]) {
      assert.equal(requiredOrderCustomer({ ...complete, customer_id: "gid://shopify/Customer/77", [field]: value })[field], true);
    }
  }
});
test("phone must contain enough digits and no more than fifteen", () => {
  for (const phone of ["12", "+ ()", "1234567890123456"]) assert.equal(requiredOrderCustomer({ ...complete, phone }).phone, true);
  assert.equal(requiredOrderCustomer({ ...complete, phone: "+212 612 345 678" }, 9).phone, false);
});
