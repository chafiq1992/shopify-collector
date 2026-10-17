import { useEffect, useRef, useState } from "react";
import { authFetch } from "./auth";
import { createProductSearchPager, emptyProductSearch } from "./productSearchPaging";

export const PRODUCT_SEARCH_PLACEHOLDER = "Search product title, product or variant ID, SKU, or barcode";

async function readJson(path, signal, fallback) {
  const res = await authFetch(path, { signal });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof result.detail === "string" ? result.detail : result.detail?.message || `${fallback} (${res.status})`);
  return result;
}

// Products ranked by how well their title matches; variants load per product.
export function searchConfirmationProducts(store, q, { after, signal } = {}) {
  const params = new URLSearchParams({ store, q });
  if (after) params.set("after", after);
  return readJson(`/api/agent/products/search?${params}`, signal, "Product search failed");
}

export function loadProductVariants(store, productId, { signal } = {}) {
  return readJson(`/api/agent/products/variants?${new URLSearchParams({ store, product_id: productId })}`, signal, "Could not load this product's variants");
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
  return { ...active, store, query: trimmed, loadMore: () => { if (pager.current?.scope === scope) return pager.current.session.load(true); }, retry: () => { if (pager.current?.scope === scope) return pager.current.session.load(); } };
}
