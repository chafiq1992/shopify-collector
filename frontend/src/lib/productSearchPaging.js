export function mergeProductVariants(current, incoming) {
  const merged = new Map(current.filter((item) => item?.id).map((item) => [item.id, item]));
  for (const item of incoming || []) if (item?.id) merged.set(item.id, item);
  return [...merged.values()];
}

// Show the first variant of each loaded product before its second variant, so a
// product with many sizes does not bury other matching products already loaded.
export function interleaveProductVariants(variants) {
  const groups = new Map();
  for (const variant of variants) {
    const key = variant.product_id || variant.product_title || variant.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(variant);
  }
  const rows = [...groups.values()];
  const result = [];
  for (let index = 0; rows.some((group) => index < group.length); index += 1) {
    for (const group of rows) if (group[index]) result.push(group[index]);
  }
  return result;
}

export function emptyProductSearch() {
  return { variants: [], currency: "", warnings: [], loading: false, loadingMore: false, error: "", moreError: "", hasNextPage: false, endCursor: null };
}

// One pager belongs to one store/query. Disposal invalidates even an upstream
// callback that ignores AbortSignal, so old results cannot enter a new search.
export function createProductSearchPager(search, store, query, onState) {
  let state = emptyProductSearch();
  let disposed = false;
  let controller = null;
  const publish = (patch) => { state = { ...state, ...patch }; if (!disposed) onState(state); };
  async function load(append = false) {
    if (disposed || state.loading || state.loadingMore || (append && !state.hasNextPage)) return;
    const after = append ? state.endCursor : null;
    controller = new AbortController();
    const active = controller;
    publish(append ? { loadingMore: true, moreError: "" } : { loading: true, error: "" });
    try {
      const result = await search(store, query, { ...(after ? { after } : {}), signal: active.signal });
      if (disposed || active.signal.aborted) return;
      const pageInfo = result.page_info || {};
      if (pageInfo.has_next_page && (!pageInfo.end_cursor || pageInfo.end_cursor === after)) throw new Error("Product search could not advance to the next page. Retry this page.");
      publish({ variants: mergeProductVariants(append ? state.variants : [], result.variants), currency: result.currency || state.currency, warnings: [...new Set([...(append ? state.warnings : []), ...(result.warnings || [])])], hasNextPage: Boolean(pageInfo.has_next_page), endCursor: pageInfo.end_cursor || null });
    } catch (error) {
      if (!disposed && !active.signal.aborted) publish(append ? { moreError: error.message || "Could not load more products." } : { error: error.message || "Product search failed." });
    } finally {
      if (!disposed && !active.signal.aborted) publish({ loading: false, loadingMore: false });
    }
  }
  return { load, dispose() { disposed = true; controller?.abort(); }, snapshot() { return state; } };
}
