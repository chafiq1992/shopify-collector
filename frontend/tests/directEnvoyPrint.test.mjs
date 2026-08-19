import test from "node:test";
import assert from "node:assert/strict";

import {
  canDirectPrintEnvoyLabel,
  isAssignedEnvoyCompany,
} from "../src/lib/directEnvoyPrint.js";


test("fallback printing requires a real assigned envoy company", () => {
  assert.equal(isAssignedEnvoyCompany("oscario"), true);
  assert.equal(isAssignedEnvoyCompany({ name: "Fast Delivery", tags: ["fast"] }), true);
  assert.equal(isAssignedEnvoyCompany({ company: "ibex" }), true);

  assert.equal(isAssignedEnvoyCompany("unassigned"), false);
  assert.equal(isAssignedEnvoyCompany({ name: "Unassigned", short: "UNAS" }), false);
  assert.equal(isAssignedEnvoyCompany(null), false);
});


test("fallback printing requires an assigned order, envoy, and failed partner send", () => {
  const company = { name: "oscario" };

  assert.equal(canDirectPrintEnvoyLabel({
    deliveryOrderId: 50820,
    envoyCode: "EN-123",
    company,
    partnerSendState: { ok: false, integrationFailure: true },
  }), true);
  assert.equal(canDirectPrintEnvoyLabel({ deliveryOrderId: 50820, company, partnerSendState: { ok: false, integrationFailure: true } }), false);
  assert.equal(canDirectPrintEnvoyLabel({ envoyCode: "EN-123", company, partnerSendState: { ok: false, integrationFailure: true } }), false);
  assert.equal(canDirectPrintEnvoyLabel({
    deliveryOrderId: 50820,
    envoyCode: "EN-123",
    company,
    partnerSendState: { ok: null },
  }), false);
  assert.equal(canDirectPrintEnvoyLabel({
    deliveryOrderId: 50820,
    envoyCode: "EN-123",
    company,
    partnerSendState: { ok: false, integrationFailure: false },
  }), false);
  assert.equal(canDirectPrintEnvoyLabel({
    deliveryOrderId: 50820,
    envoyCode: "EN-123",
    company: { name: "unassigned" },
    partnerSendState: { ok: false, integrationFailure: true },
  }), false);
});
