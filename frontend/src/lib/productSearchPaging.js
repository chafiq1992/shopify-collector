// A product repeated on a later page keeps its first position with fresh details.
export function mergeById(current, incoming) {
  const merged = new Map(current.filter((item) => item?.id).map((item) => [item.id, item]));
  for (const item of incoming || []) if (item?.id) merged.set(item.id, item);
  return [...merged.values()];
}

function amount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : String(value ?? "");
}

// One-line summary of a collapsed product: variant count, price and stock.
export function productSummaryLabels(product, currency = "") {
  const unit = product.currency || currency;
  const count = Number(product.variants_count);
  const variants = product.has_only_default_variant ? "Single variant" : Number.isFinite(count) && count > 0 ? `${count} variant${count === 1 ? "" : "s"}` : "Variants";
  const low = product.price_min, high = product.price_max;
  const price = low == null ? "" : `${amount(low)}${high != null && Number(high) !== Number(low) ? ` – ${amount(high)}` : ""} ${unit}`.trim();
  const stock = product.tracks_inventory === false ? { label: "Stock not tracked", tone: "muted" }
    : product.total_inventory == null ? { label: "", tone: "muted" }
    : Number(product.total_inventory) > 0 ? { label: `${product.total_inventory} available`, tone: "good" }
    : { label: "Out of stock", tone: "bad" };
  return { variants, price, stock };
}

// Open a product straight away when it is the only match, or when the agent
// typed its ID, SKU or barcode, so the matching variant is one click away.
export function autoExpandedProductId(products) {
  if (products.length === 1) return products[0].id;
  const direct = products.find((product) => product.match_kind === "id" || product.match_kind === "identifier");
  return direct ? direct.id : null;
}

export function emptyProductSearch() {
  return { products: [], currency: "", warnings: [], loading: false, loadingMore: false, error: "", moreError: "", hasNextPage: false, endCursor: null };
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
      publish({ products: mergeById(append ? state.products : [], result.products), currency: result.currency || state.currency, warnings: [...new Set([...(append ? state.warnings : []), ...(result.warnings || [])])], hasNextPage: Boolean(pageInfo.has_next_page), endCursor: pageInfo.end_cursor || null });
    } catch (error) {
      if (!disposed && !active.signal.aborted) publish(append ? { moreError: error.message || "Could not load more products." } : { error: error.message || "Product search failed." });
    } finally {
      if (!disposed && !active.signal.aborted) publish({ loading: false, loadingMore: false });
    }
  }
  return { load, dispose() { disposed = true; controller?.abort(); }, snapshot() { return state; } };
}
