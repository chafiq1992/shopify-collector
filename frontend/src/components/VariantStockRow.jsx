import React from "react";

export default function VariantStockRow({ variant, className = "" }) {
  const onHand = variant.on_hand_quantity;
  const committed = variant.committed_quantity;
  const pending = variant.pending_purchase_order_quantity;
  const refs = variant.pending_purchase_orders || [];
  const knownPending = refs.reduce((sum, po) => (
    Number.isInteger(po.quantity) && po.quantity > 0 ? sum + po.quantity : sum
  ), 0);
  const pendingIsPartial = pending == null && knownPending > 0;
  const pendingValue = pendingIsPartial ? `+${knownPending}…` : pending > 0 ? `+${pending}` : pending ?? "—";
  const pendingAccessible = pendingIsPartial ? `At least ${knownPending}. Checking for more purchase orders.` : pending;
  const purchaseOrders = refs.map((po) => (
    `${po.number || po.id}${Number.isInteger(po.quantity) ? ` (+${po.quantity})` : ""}`
  ));
  const quantities = [
    { label: "OH", name: "On hand", value: Number.isInteger(onHand) && onHand !== 0 ? onHand : "—", accessible: onHand },
    { label: "COM", name: "Committed", value: committed ?? "—", accessible: committed },
    { label: "PO", name: "Pending purchase orders", value: pendingValue, accessible: pendingAccessible },
  ];

  return (
    <dl aria-label="Variant inventory" className={`inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-slate-200 bg-white/95 px-1.5 py-1 text-[10px] leading-none shadow-sm ${className}`}>
      {quantities.map(({ label, name, value, accessible }) => (
        <div key={label} className={`flex items-center gap-0.5 whitespace-nowrap ${label === "PO" && (pending > 0 || pendingIsPartial) ? "text-amber-900" : "text-slate-700"}`}
          title={label === "PO" && purchaseOrders.length
            ? `${name}${pendingIsPartial ? " (partial)" : ""}: ${purchaseOrders.join(", ")}`
            : name}>
          <dt className="font-semibold"><span className="sr-only">{name}</span><span aria-hidden="true">{label}</span></dt>
          <dd className="font-bold tabular-nums">
            <span className="sr-only">{accessible ?? "Unavailable"}</span>
            <span aria-hidden="true">{value}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
