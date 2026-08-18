export function groupInventoryItems(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item?.title || "Untitled product"}\u0000${item?.image_url || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: item?.title || "Untitled product",
        image_url: item?.image_url || "",
        image_alt: item?.image_alt || item?.title || "Product",
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}


export function groupInventoryColors(items = []) {
  const colors = new Map();
  for (const item of items) {
    let color = String(item?.variant_color || "").trim();
    if (!color) {
      const colorOption = (item?.selected_options || []).find((option) =>
        ["color", "colour", "couleur", "colore", "farbe", "لون"].includes(String(option?.name || "").trim().toLowerCase()),
      );
      color = String(colorOption?.value || "").trim();
    }
    if (!color) color = String(item?.variant_title || "").split("/")[0]?.trim() || "No color";
    if (!colors.has(color)) colors.set(color, { color, items: [] });
    colors.get(color).items.push(item);
  }
  return [...colors.values()];
}


export function inventoryReview(items = []) {
  return items.map((item) => {
    const found = Math.max(0, Number(item?.actual_quantity || 0));
    const applied = Math.max(0, Number(item?.inventory_applied_quantity || 0));
    return { item, found, applied, delta: found - applied };
  }).filter((entry) => entry.delta !== 0);
}


export function formatInventoryOperation(operation) {
  if (typeof operation === "string") return operation;
  if (operation?.type === "shipment_receive") {
    const quantity = Number(operation.quantity || 0);
    return `${quantity} item${quantity === 1 ? "" : "s"} received into Shopify`;
  }
  if (operation?.type === "inventory_adjustment") {
    const delta = Number(operation.delta || 0);
    const before = operation.before_quantity;
    const after = operation.after_quantity ?? operation.expected_after_quantity;
    return `${operation.title || "Variant"}: Shopify ${before} → ${after} (${delta > 0 ? "+" : ""}${delta})`;
  }
  return "Shopify inventory updated";
}
