import test from "node:test";
import assert from "node:assert/strict";

import {
  confirmationRetryDelay,
  firstReadyQueueIndex,
  isBlockingConfirmationStatus,
  shouldRekeyConfirmationAction,
} from "../src/lib/confirmationSyncPolicy.js";


test("confirmation actions stay FIFO while the first action backs off", () => {
  const items = [
    { id: "remove-n1", actorId: "agent-1", nextAttemptAt: 5_000 },
    { id: "add-n2", actorId: "agent-1", nextAttemptAt: 0 },
  ];
  assert.equal(firstReadyQueueIndex(items, "agent-1", 4_000), -1);
  assert.equal(firstReadyQueueIndex(items, "agent-1", 5_000), 0);
});


test("another user's queued action does not block the active agent", () => {
  const items = [
    { id: "other", actorId: "agent-2", nextAttemptAt: 0 },
    { id: "mine", actorId: "agent-1", nextAttemptAt: 0 },
  ];
  assert.equal(firstReadyQueueIndex(items, "agent-1", 1_000), 1);
});


test("authorization failures remain visible and retryable", () => {
  assert.equal(isBlockingConfirmationStatus(401), true);
  assert.equal(isBlockingConfirmationStatus(403), true);
  assert.equal(isBlockingConfirmationStatus(500), false);
  assert.equal(confirmationRetryDelay(1), 1_000);
  assert.equal(confirmationRetryDelay(20), 60_000);
});


test("only a true id collision receives a new client action id", () => {
  assert.equal(shouldRekeyConfirmationAction(409, "client_action_id was already used for a different action"), true);
  assert.equal(shouldRekeyConfirmationAction(409, "queued action belongs to another agent"), false);
});
