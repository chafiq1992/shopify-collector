import test from "node:test";
import assert from "node:assert/strict";


function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}


globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();
const dispatchedEvents = [];
globalThis.window = {
  dispatchEvent(event) { dispatchedEvents.push(event); },
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

const { authFetch, loadAuth, saveAuth } = await import("../src/lib/auth.js");


test("authFetch clears the login for an application 401", async () => {
  saveAuth({ access_token: "app-token" });
  dispatchedEvents.length = 0;
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

  await authFetch("/api/auth/me");

  assert.equal(loadAuth(), null);
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].type, "orderCollectorAuthCleared");
});


test("authFetch can preserve the login for a proxied upstream 401", async () => {
  saveAuth({ access_token: "app-token" });
  dispatchedEvents.length = 0;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer app-token");
    assert.equal("clearAuthOn401" in options, false);
    return new Response("upstream unauthorized", { status: 401 });
  };

  const response = await authFetch("/api/delivery/ext/admin/merchants", {
    clearAuthOn401: false,
  });

  assert.equal(response.status, 401);
  assert.equal(loadAuth()?.access_token, "app-token");
  assert.equal(dispatchedEvents.length, 0);
});
