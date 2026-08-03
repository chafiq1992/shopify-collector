export const MAX_CONFIRMATION_BACKOFF_MS = 60_000;

export function queueItemBelongsToActor(item, actorId) {
  const queuedActor = String(item?.actorId || "").trim();
  const activeActor = String(actorId || "").trim();
  return !queuedActor || (!!activeActor && queuedActor === activeActor);
}

export function firstReadyQueueIndex(items, actorId, now = Date.now()) {
  const index = (items || []).findIndex((item) => queueItemBelongsToActor(item, actorId));
  if (index < 0) return -1;
  // Strict FIFO: if the first action is backing off, later actions wait.
  return Number(items[index]?.nextAttemptAt || 0) <= now ? index : -1;
}

export function confirmationRetryDelay(attempts) {
  const safeAttempts = Math.max(1, Number(attempts || 1));
  return Math.min(
    MAX_CONFIRMATION_BACKOFF_MS,
    1000 * 2 ** Math.min(6, safeAttempts - 1),
  );
}

export function isBlockingConfirmationStatus(status) {
  return status === 401 || status === 403 || status === 409 || status === "wrong-agent";
}

export function shouldRekeyConfirmationAction(status, detail) {
  return status === 409 && /already used for a different action/i.test(String(detail || ""));
}
