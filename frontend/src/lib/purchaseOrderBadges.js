import { applyVariantStock } from "./variantStock.js";

// Keep optional badge refreshes independent of lookup and fulfillment state.
export function badgeVariantInputs(variants = []) {
  return variants.filter((variant) => /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/.test(variant?.id || ""))
    .map(({ id, inventory_item_id }) => ({
      id,
      inventory_item_id: /^gid:\/\/shopify\/InventoryItem\/[0-9]+$/.test(inventory_item_id || "") ? inventory_item_id : null,
    }));
}

export function applyPurchaseOrderBadges(order, badges = {}, stock = {}) {
  return {
    ...order,
    variants: (order.variants || []).map((variant) => applyVariantStock(variant, {
      ...stock?.[variant.id],
      pending_purchase_orders: badges[variant.id],
    })),
  };
}

export function createPurchaseOrderWatcher({
  fetchBadges, onResult, onState,
  isVisible = () => true,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let active = true;
  let inFlight = false;
  let refreshAgain = false;
  let timer = null;
  const controller = new AbortController();

  function schedule(delay) {
    if (!active) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(refresh, delay);
  }

  async function refresh() {
    if (!active) return;
    if (inFlight) { refreshAgain = true; return; }
    if (!isVisible()) { schedule(60000); return; }
    if (timer !== null) { clearTimer(timer); timer = null; }
    inFlight = true;
    try {
      const result = await fetchBadges(controller.signal);
      if (!active) return;
      if (!result || typeof result.badges !== "object" || result.badges === null || Array.isArray(result.badges)) {
        throw new Error("Purchase-order status is unavailable");
      }
      onResult(result.badges, result.stock);
      onState(result.unavailable ? "unavailable" : result.loading ? "loading" : "ready");
      schedule(result.unavailable ? 10000 : result.loading ? 1500 : 60000);
    } catch (error) {
      if (!active) return;
      onState("unavailable");
      schedule(10000);
    } finally {
      inFlight = false;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  }

  onState("loading");
  void refresh();
  return {
    refresh,
    stop() {
      active = false;
      controller.abort();
      if (timer !== null) clearTimer(timer);
    },
  };
}
