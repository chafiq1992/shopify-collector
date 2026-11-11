const inventoryFields = ["on_hand_quantity", "committed_quantity", "pending_purchase_order_quantity"];

export function applyVariantStock(variant, snapshot) {
  if (!snapshot) return variant;
  const updates = {};
  for (const field of inventoryFields) {
    const value = snapshot[field];
    if (value === null || Number.isInteger(value)) updates[field] = value;
  }
  if (Array.isArray(snapshot.pending_purchase_orders)) {
    updates.pending_purchase_orders = snapshot.pending_purchase_orders;
  }
  return { ...variant, ...updates };
}

export function subscribeToPurchaseOrderChanges(store, refresh) {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    return () => {};
  }
  socket.onmessage = (event) => {
    let update;
    try { update = JSON.parse(event.data); } catch { return; }
    if (update?.type === "inventory.purchase_orders_changed" && update.store === store) refresh();
  };
  return () => socket.close();
}
