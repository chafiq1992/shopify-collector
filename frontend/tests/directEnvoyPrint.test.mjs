import test from "node:test";
import assert from "node:assert/strict";

import {
  companyStepActionLabel,
  confirmationOutdated,
  envoyNeedsNoPartnerSend,
  isAssignedEnvoyCompany,
  noPartnerApiSendState,
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


test("a Marrakech order waits for the agent's company decision", () => {
  const marrakech = { code: "EN-20261023-marrakech-1", company: "marrakech", companyShort: "Kech", partnerId: null };

  // Arriving in the in-house envoy is not a decision: the step stays open,
  // so a Marrakech-region parcel can still go to lionex3.
  const arrived = noPartnerApiSendState(marrakech);
  assert.equal(arrived.ok, null);
  assert.equal(arrived.noPartnerApi, true);

  const confirmed = noPartnerApiSendState(marrakech, { confirmed: true, companyId: "3", cityName: "Marrakech" });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.envoyCode, "EN-20261023-marrakech-1");
});


test("changing the company or city after confirming reopens the step", () => {
  const confirmed = noPartnerApiSendState({ code: "EN-1", company: "marrakech" }, { confirmed: true, companyId: "3", cityName: "Marrakech" });
  assert.equal(confirmationOutdated(confirmed, { companyId: "3", cityName: "Marrakech" }), false);
  assert.equal(confirmationOutdated(confirmed, { companyId: "7", cityName: "Marrakech" }), true);  // moved to lionex3
  assert.equal(confirmationOutdated(confirmed, { companyId: "3", cityName: "Ait Ourir" }), true);

  // A carrier send is never reopened (no ghost parcel at the first carrier),
  // and neither is an unconfirmed state.
  assert.equal(confirmationOutdated({ ok: true, message: "Sent" }, { companyId: "9" }), false);
  assert.equal(confirmationOutdated({ ok: true, companyId: "5", cityName: "Rabat" }, { companyId: "9" }), false);
  assert.equal(confirmationOutdated(noPartnerApiSendState({ company: "marrakech" }), { companyId: "9" }), false);
});


test("the company step button says what it will do", () => {
  const marrakech = { id: 3, name: "marrakech", short: "Kech", partnerIntegrationId: null };
  const lionex = { id: 7, name: "lionex3", short: "LX", partnerIntegrationId: 12 };
  assert.equal(companyStepActionLabel(marrakech, {}), "Confirm Envoy & City");
  assert.equal(companyStepActionLabel(lionex, {}), "Send to Partner");
  assert.equal(companyStepActionLabel(lionex, { ok: false }), "Resend to Partner");
  assert.equal(companyStepActionLabel(null, { noPartnerApi: true }), "Confirm Envoy & City");
});
