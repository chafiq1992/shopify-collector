const STORAGE_KEY = "orderCollectorAuth";
const STORAGE_KEY_SESSION = "orderCollectorAuthSession";

export function loadAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.access_token) return parsed;
  } catch {}
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.access_token) return parsed;
  } catch {}
  return null;
}

export function saveAuth(data, options = {}) {
  const remember = options?.remember !== false; // default true
  try {
    if (remember){
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      try { sessionStorage.removeItem(STORAGE_KEY_SESSION); } catch {}
    } else {
      sessionStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify(data));
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }
  } catch {}
}

export function clearAuth() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  try { sessionStorage.removeItem(STORAGE_KEY_SESSION); } catch {}
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

