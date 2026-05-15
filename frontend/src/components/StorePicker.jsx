import React, { useEffect, useMemo, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";
import { normalizeStoreKey, titleStore } from "../lib/stores";

export default function StorePicker({ value, onChange, includeAll = false, allowCustom = true, className = "" }) {
  const [stores, setStores] = useState([]);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadStores() {
      try {
        const res = await authFetch("/api/shopify/stores", { headers: authHeaders({ "Accept": "application/json" }) });
        const js = await res.json().catch(() => ({}));
        if (cancelled) return;
        const list = Array.isArray(js?.stores) ? js.stores : [];
        setStores(list.map((s) => ({ ...s, key: normalizeStoreKey(s.key, "") })).filter((s) => s.key));
      } catch {
        if (!cancelled) setStores([]);
      }
    }
    loadStores();
    return () => { cancelled = true; };
  }, []);

  const options = useMemo(() => {
    const seen = new Set();
    const list = [];
    if (includeAll) {
      list.push({ key: "all", label: "All" });
      seen.add("all");
    }
    for (const store of stores) {
      if (!store.key || seen.has(store.key)) continue;
      seen.add(store.key);
      list.push({ key: store.key, label: store.label || titleStore(store.key), connected: store.connected });
    }
    const current = normalizeStoreKey(value, "");
    if (current && current !== "all" && !seen.has(current)) {
      list.push({ key: current, label: titleStore(current), connected: false });
    }
    return list;
  }, [includeAll, stores, value]);

  function choose(next) {
    if (next === "__custom__") return;
    if (next === "all" && includeAll) {
      onChange?.("all");
      return;
    }
    const key = normalizeStoreKey(next, "");
    if (key) onChange?.(key);
  }

  function applyCustom() {
    const key = normalizeStoreKey(custom, "");
    if (!key) return;
    onChange?.(key);
    setCustom("");
  }

  return (
    <div className={`inline-flex items-center gap-1 rounded-xl border border-gray-300 p-1 bg-white ${className}`}>
      <select
        value={value || "irrakids"}
        onChange={(e) => choose(e.target.value)}
        className="text-xs font-medium bg-transparent px-2 py-1 outline-none"
      >
        {options.map((store) => (
          <option key={store.key} value={store.key}>
            {store.label || titleStore(store.key)}{store.connected === false && store.key !== "all" ? " (not connected)" : ""}
          </option>
        ))}
      </select>
      {allowCustom && (
        <>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }}
            placeholder="new-store"
            className="w-24 text-xs border-l border-gray-200 px-2 py-1 outline-none"
          />
          <button
            type="button"
            onClick={applyCustom}
            className="px-2 py-1 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-100"
          >
            Use
          </button>
        </>
      )}
    </div>
  );
}
