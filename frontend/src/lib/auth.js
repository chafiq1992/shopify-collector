const STORAGE_KEY = "orderCollectorAuth";

export function loadAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.access_token) return parsed;
  } catch {}
  return null;
}

export function saveAuth(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

export function clearAuth() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export function authHeaders(extra = {}) {
  const auth = loadAuth();
  const token = auth?.access_token;
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

export async function authFetch(url, options = {}) {
  const headers = authHeaders(options.headers || {});
  const resp = await fetch(url, { ...options, headers });
  if (resp.status === 401) {
    clearAuth();
  }
  return resp;
}

