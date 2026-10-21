import test from "node:test";
import assert from "node:assert/strict";

import {
  envoyNeedsNoPartnerSend,
  isAssignedEnvoyCompany,
} from "../src/lib/directEnvoyPrint.js";


test("printing requires a real assigned envoy company", () => {
  assert.equal(isAssignedEnvoyCompany("oscario"), true);
  assert.equal(isAssignedEnvoyCompany({ name: "Fast Delivery", tags: ["fast"] }), true);
  assert.equal(isAssignedEnvoyCompany({ company: "ibex" }), true);

  assert.equal(isAssignedEnvoyCompany("unassigned"), false);
  assert.equal(isAssignedEnvoyCompany({ name: "Unassigned", short: "UNAS" }), false);
  assert.equal(isAssignedEnvoyCompany(null), false);
});


test("only a company without a partner API can print without a partner send", () => {
  // In-house drivers: Delivery resolves no connected partner for the envoy.
  assert.equal(envoyNeedsNoPartnerSend({ code: "EN-1", company: "Kech", companyShort: "KECH", partnerId: null }), true);

  // A partner company must accept the order first, even after its API failed.
  assert.equal(envoyNeedsNoPartnerSend({ code: "EN-2", company: "glog", companyShort: "GLOG", partnerId: 24 }), false);
  assert.equal(envoyNeedsNoPartnerSend({ code: "EN-3", company: "Unassigned", companyShort: "UNAS", partnerId: null }), false);
  assert.equal(envoyNeedsNoPartnerSend(null), false);
});
