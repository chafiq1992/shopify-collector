export function normalizePrintOrders(orderNumbers = []) {
  return [...new Set(orderNumbers.map(number => String(number).trim().replace(/^#/, "")).filter(Boolean))];
}

export function createPrintRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `print-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getOrCreatePrintRequest(pending, store, orders) {
  const signature = JSON.stringify([store, [...orders].sort()]);
  if (pending.current?.signature !== signature) {
    pending.current = { signature, requestId: createPrintRequestId() };
  }
  return pending.current.requestId;
}

// Claim synchronously: React state alone does not stop two clicks before a render.
export async function withPrintLock(lock, action) {
  if (lock.current) return;
  lock.current = true;
  try {
    return await action();
  } finally {
    lock.current = false;
  }
}

function responseError(data, response) {
  const detail = data?.detail || data?.error;
  return typeof detail === "string" ? detail : response.statusText || `HTTP ${response.status}`;
}

export async function sendRelayOrders({ base, body, headers, legacyHeaders, fetchFn = fetch }) {
  const send = (route, requestHeaders) => fetchFn(`${base}${route}`, {
    method: "POST", headers: requestHeaders, body, mode: "cors",
  });
  try {
    let response = await send("/api/enqueue-orders", headers);
    // A failed or interrupted enqueue can already have reached the printer.
    // Only a missing route is safe to retry through the legacy endpoint.
    if (response.status === 404 || response.status === 405) {
      response = await send("/enqueue", legacyHeaders);
    }
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      const error = responseError(data, response);
      return {
        ok: false,
        error: response.status >= 500 ? `${error}. The request may already be queued; check the print queue before retrying.` : error,
      };
    }
    if (data.status === "failed") {
      return { ok: false, error: data.error || "This print batch failed or needs review. Check the printer and print queue before retrying." };
    }
    if (data.ok !== true || typeof data.job_id !== "string" || !data.job_id.trim()) {
      throw new Error("The print relay returned an invalid receipt");
    }
    return { ok: true, job_id: data.job_id, queued: data.queued, status: data.status, dedup: data.dedup };
  } catch (error) {
    return {
      ok: false,
      error: `${error?.message || String(error)}. The request may already be queued; check the print queue before retrying.`,
    };
  }
}

export async function sendLocalOrders({ base, body, headers, fetchFn = fetch, schedule = setTimeout, cancel = clearTimeout }) {
  const controller = new AbortController();
  // Rendering and fetching a large batch can take longer than six seconds.
  const timeout = schedule(() => controller.abort(), 120000);
  try {
    const response = await fetchFn(`${base}/print/orders`, {
      method: "POST", headers, body, mode: "cors", signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) return { ok: false, error: data.error || response.statusText };
    return { ok: true, results: data.results };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError"
        ? "Local print response timed out; the batch may still be printing. Check the printer before retrying."
        : String(error),
    };
  } finally {
    cancel(timeout);
  }
}

export async function submitPrintOrders({ orders, store, requestId, relayConfigured, enqueueRelay, printLocal }) {
  const list = normalizePrintOrders(orders);
  if (!list.length) throw new Error("Select at least one order to print.");
  if (relayConfigured) {
    const result = await enqueueRelay(list, 1, undefined, store, requestId);
    if (!result.ok) throw new Error(result.error || "Print request failed; check the print queue before retrying.");
    if (result.status === "completed") {
      return { title: "Already sent to printer", message: `${list.length} order(s) were already sent to printer` };
    }
    // Relay `queued` counts jobs, not labels/orders.
    return { title: "Queued to print", message: `Queued ${list.length} order(s) for printing` };
  }
  const result = await printLocal(list, 1, store, requestId);
  if (!result.ok) throw new Error(result.error || "Local print request failed.");
  const failed = result.results?.filter(item => !item.printed) || [];
  if (failed.length) throw new Error(`${failed.length} order(s) could not be printed. Check the printer before retrying.`);
  return { title: "Sent to printer", message: `Sent ${result.results?.length ?? list.length} order(s) to printer` };
}
