import { useEffect, useRef, useState } from "react";
import { authFetch } from "./auth";
import { createProductSearchPager, emptyProductSearch } from "./productSearchPaging";

export const PRODUCT_SEARCH_PLACEHOLDER = "Search product title, product or variant ID, SKU, or barcode";

export async function searchConfirmationProducts(store, q, { after, signal } = {}) {
  const params = new URLSearchParams({ store, q, first: "30" });
  if (after) params.set("after", after);
  const res = await authFetch(`/api/agent/product-variants/search?${params}`, { signal });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof result.detail === "string" ? result.detail : result.detail?.message || `Product search failed (${res.status})`);
  return result;
}

export default function useConfirmationProductSearch(store, query, { search = searchConfirmationProducts, enabled = true } = {}) {
  const trimmed = query.trim();
  const scope = `${store}\0${trimmed}\0${enabled}`;
  const pager = useRef(null);
  const [result, setResult] = useState({ scope, ...emptyProductSearch() });
  useEffect(() => {
    if (!enabled || trimmed.length < 2) { setResult({ scope, ...emptyProductSearch() }); return; }
    setResult({ scope, ...emptyProductSearch(), loading: true });
    const session = createProductSearchPager(search, store, trimmed, (state) => setResult({ scope, ...state }));
    pager.current = { scope, session };
    const timer = setTimeout(() => session.load(), 250);
    return () => { clearTimeout(timer); session.dispose(); if (pager.current?.session === session) pager.current = null; };
  }, [store, trimmed, search, enabled, scope]);
  const active = result.scope === scope ? result : { ...emptyProductSearch(), loading: enabled && trimmed.length >= 2 };
  return { ...active, loadMore: () => { if (pager.current?.scope === scope) return pager.current.session.load(true); }, retry: () => { if (pager.current?.scope === scope) return pager.current.session.load(); } };
}
