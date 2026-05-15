export const DEFAULT_STORE = "irrakids";

export function normalizeStoreKey(value, fallback = DEFAULT_STORE) {
  const raw = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(raw) ? raw : fallback;
}

export function readCurrentStore({ allowAll = false, fallback = DEFAULT_STORE } = {}) {
  const readOne = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (allowAll && raw === "all") return "all";
    return normalizeStoreKey(raw, "");
  };

  try {
    const params = new URLSearchParams(location.search);
    const fromUrl = readOne(params.get("store"));
    if (fromUrl) return fromUrl;
  } catch {}

  try {
    const fromSession = readOne(sessionStorage.getItem("orderCollectorStore"));
    if (fromSession) return fromSession;
  } catch {}

  return fallback;
}

export function persistStoreSelection(store) {
  const key = normalizeStoreKey(store);
  try { sessionStorage.setItem("orderCollectorStore", key); } catch {}
  try {
    const params = new URLSearchParams(location.search);
    if ((params.get("store") || "").trim().toLowerCase() !== key) {
      params.set("store", key);
      const qs = params.toString();
      history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash || ""}`);
    }
  } catch {}
}

export function titleStore(store) {
  return String(store || "")
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || DEFAULT_STORE;
}
