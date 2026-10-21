import test from "node:test";
import assert from "node:assert/strict";

import { unsentAgeLabel, unsentReasonLabel } from "../src/lib/unsentDelivery.js";


test("unsent reasons say what still blocks the order", () => {
  assert.equal(
    unsentReasonLabel({ kind: "queue_error", hasError: true, errorType: "city", cityRaw: "Résidence Zineb, Ifrane" }),
    'City not recognised: "Résidence Zineb, Ifrane"',
  );
  assert.equal(unsentReasonLabel({ kind: "queue_error", hasError: true, errorType: "phone" }), "Phone number is invalid");
  assert.equal(unsentReasonLabel({ kind: "queue_new", hasError: false }), "Waiting in the merchant queue; not sent yet");
  assert.match(unsentReasonLabel({ kind: "not_in_delivery", hasError: true }), /Never reached Delivery/);
});


test("unsent age reads Delivery's naive timestamps as UTC", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.equal(unsentAgeLabel("2026-10-21T11:30:00", now), "30 min ago");
  assert.equal(unsentAgeLabel("2026-10-21T09:00:00+00:00", now), "3 h ago");
  assert.equal(unsentAgeLabel("2026-10-13T16:34:03.429151", now), "8 days ago");
  assert.equal(unsentAgeLabel("", now), "");
});
