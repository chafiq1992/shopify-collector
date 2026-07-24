import test from "node:test";
import assert from "node:assert/strict";

import {
  canDirectPrintEnvoyLabel,
  isDirectEnvoyPrintCompany,
} from "../src/lib/directEnvoyPrint.js";


test("direct label printing recognizes only Oscario and Marrakech identities", () => {
  assert.equal(isDirectEnvoyPrintCompany("oscario"), true);
  assert.equal(isDirectEnvoyPrintCompany({ name: "Marrakech", short: "Kech", tags: ["K"] }), true);
  assert.equal(isDirectEnvoyPrintCompany({ company: "marrakech" }), true);
  assert.equal(isDirectEnvoyPrintCompany({ companyShort: "OSCARIO" }), true);

  assert.equal(isDirectEnvoyPrintCompany("ibex"), false);
  assert.equal(isDirectEnvoyPrintCompany({ name: "Fast Delivery", tags: ["fast"] }), false);
  assert.equal(isDirectEnvoyPrintCompany(null), false);
});


test("direct printing still requires an assigned delivery order and envoy", () => {
  const company = { name: "oscario" };

  assert.equal(canDirectPrintEnvoyLabel({
    deliveryOrderId: 50820,
    envoyCode: "EN-123",
    company,
  }), true);
  assert.equal(canDirectPrintEnvoyLabel({ deliveryOrderId: 50820, company }), false);
  assert.equal(canDirectPrintEnvoyLabel({ envoyCode: "EN-123", company }), false);
  assert.equal(canDirectPrintEnvoyLabel({
    deliveryOrderId: 50820,
    envoyCode: "EN-123",
    company: { name: "ibex" },
  }), false);
});
