import React, { useEffect, useMemo, useState } from "react";
import { authFetch, authHeaders } from "../lib/auth";

function useQueryParam(name) {
  try {
    const params = new URLSearchParams(location.search);
    return params.get(name);
  } catch {
    return null;
  }
}

export default function ShopifyConnect({ store, setStore }) {
  const connectedFlag = useQueryParam("connected");
  const [shop, setShop] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const canOAuth = useMemo(() => (store === "irranova"), [store]);

  useEffect(() => {
    // per-store remembered shop input
    try {
      const key = `shopifyConnectShop:${store}`;
      const prev = (localStorage.getItem(key) || "").trim();
      if (prev) setShop(prev);
    } catch {}
  }, [store]);

  useEffect(() => {
    try {
      const key = `shopifyConnectShop:${store}`;
      localStorage.setItem(key, String(shop || ""));
    } catch {}
  }, [store, shop]);

  async function refreshStatus() {
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(`/api/shopify/oauth/status?store=${encodeURIComponent(store)}`, {
        headers: authHeaders(),
      });
      const js = await res.json();
      setStatus(js);
      if (!res.ok) setErr(js?.detail || "Failed to fetch status");
    } catch (e) {
      setErr(e?.message || "Failed to fetch status");
    } finally {
      setBusy(false);
    }
  }

  function startOAuth() {
    setErr(null);
    if (!canOAuth) {
      setErr("OAuth install is disabled for this store (irrakids stays on the old env token method).");
      return;
    }
    if (!String(shop || "").trim()) {
      setErr("Enter a shop domain like irranova.myshopify.com");
      return;
    }
    const url = `/api/shopify/oauth/start?store=${encodeURIComponent(store)}&shop=${encodeURIComponent(shop)}`;
    // Full page navigation (Shopify install requires redirects)
    window.location.href = url;
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-extrabold tracking-tight">Shopify Connect</h1>
            <p className="text-sm text-gray-600 mt-1">
              Connect the public app (OAuth) for <span className="font-semibold">irranova</span>. Irrakids stays on the old env token method.
            </p>
          </div>
          <button
            className="text-sm px-3 py-2 rounded-xl border border-gray-300 bg-white hover:bg-gray-50"
            onClick={() => {
              try { history.pushState(null, "", "/"); } catch { location.href = "/"; }
            }}
          >
            Back
          </button>
        </div>

        {connectedFlag === "1" && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm">
            Install completed. Click <span className="font-semibold">Refresh status</span> to confirm.
          </div>
        )}

        <div className="mt-5 rounded-2xl border border-gray-200 bg-white p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs font-semibold text-gray-600">Store</div>
              <select
                value={store}
                onChange={(e) => setStore(e.target.value)}
                className="mt-1 w-full text-sm border border-gray-300 rounded-xl px-3 py-2 bg-white"
              >
                <option value="irrakids">irrakids</option>
                <option value="irranova">irranova</option>
              </select>
            </label>
            <label className="block">
              <div className="text-xs font-semibold text-gray-600">Shop domain</div>
              <input
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                placeholder="irranova.myshopify.com"
                className="mt-1 w-full text-sm border border-gray-300 rounded-xl px-3 py-2"
              />
              {!canOAuth && (
                <div className="mt-1 text-[11px] text-gray-500">
                  OAuth is disabled for this store. Use env token config for irrakids.
                </div>
              )}
            </label>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={startOAuth}
              className={`px-4 py-2 rounded-xl text-sm font-semibold text-white ${canOAuth ? "bg-blue-600 hover:bg-blue-700" : "bg-gray-400"}`}
            >
              Connect (OAuth install)
            </button>
            <button
              onClick={refreshStatus}
              disabled={busy}
              className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-60"
            >
              {busy ? "Refreshing…" : "Refresh status"}
            </button>
          </div>

          {err && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 text-sm">
              {err}
            </div>
          )}

          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-600">Status</div>
            <pre className="mt-2 text-[12px] bg-gray-900 text-gray-100 rounded-xl p-3 overflow-x-auto">
              {JSON.stringify(status || { connected: false, shop: null, scopes: null }, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}


