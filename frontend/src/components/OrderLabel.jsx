import React from "react";

// QR-free riff on the autoprint 2026 thermal label. Rendered off-screen and
// captured to PNG via html-to-image so the agent can paste it into chat.
//
// Sized for screenshot-to-WhatsApp readability: 800x800 logical pixels
// rendered at 2x (1600x1600 actual) by the capture util.

const W = 800;

export default function OrderLabel({ order, store }) {
  const items = (order.line_items || []).filter((li) => Number(li.quantity || 0) > 0);
  const subtotal = items.reduce((acc, li) => acc + Number(li.unit_price || 0) * Number(li.quantity || 0), 0);
  const total = Number(order.total_price || 0);
  const currency = order.currency || "MAD";
  const created = order.created_at ? new Date(order.created_at) : null;

  const shippingLines = [
    order.shipping_address1,
    order.shipping_address2,
    [order.shipping_city, order.shipping_zip].filter(Boolean).join(" "),
    order.shipping_country,
  ].filter((s) => String(s || "").trim());

  const storeLabel = (store || "").toString();

  return (
    <div
      style={{
        width: W,
        background: "#fff",
        color: "#000",
        fontFamily: "Arial, Helvetica, sans-serif",
        fontWeight: 700,
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, letterSpacing: 1, opacity: 0.7, textTransform: "uppercase" }}>{storeLabel}</div>
          <div style={{ fontSize: 36, fontWeight: 900, marginTop: 4 }}>{order.name || `#${order.number}`}</div>
          <div style={{ fontSize: 14, marginTop: 4, opacity: 0.8 }}>
            {created ? created.toLocaleString() : ""}
          </div>
        </div>
        <div style={{ textAlign: "right", flex: 1, fontSize: 15, lineHeight: 1.35 }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{order.customer_name || "—"}</div>
          <div style={{ fontFamily: "monospace", marginTop: 2 }}>
            {order.phone || order.customer_phone || ""}
          </div>
          <div style={{ marginTop: 6 }}>
            {shippingLines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ borderTop: "2px dashed #000", margin: "14px 0" }} />

      {/* Line items grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {items.map((li, idx) => (
          <div key={idx} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            {li.image ? (
              <img
                src={li.image}
                alt=""
                crossOrigin="anonymous"
                style={{
                  width: 64,
                  height: 64,
                  objectFit: "cover",
                  border: "1px solid #000",
                  flexShrink: 0,
                }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  border: "1px solid #000",
                  flexShrink: 0,
                  background: "#f5f5f5",
                }}
              />
            )}
            <div style={{ fontSize: 13, lineHeight: 1.25, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{li.title || "—"}</div>
              {li.variant_title && (
                <div style={{ fontWeight: 600 }}>{li.variant_title}</div>
              )}
              {(li.options || []).length > 0 && (
                <div style={{ fontWeight: 600, fontSize: 12 }}>
                  {(li.options || []).map((o) => `${o.name}: ${o.value}`).join(" · ")}
                </div>
              )}
              <div style={{ marginTop: 2, fontFamily: "monospace", fontSize: 12 }}>
                Qty {li.quantity}  ·  {li.unit_price} {li.currency || currency}
              </div>
              {li.sku && (
                <div style={{ fontSize: 11, opacity: 0.7, fontFamily: "monospace" }}>SKU {li.sku}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ borderTop: "2px dashed #000", margin: "14px 0" }} />

      {/* Summary */}
      <div style={{ fontSize: 15 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Items subtotal</span>
          <span>{subtotal.toFixed(2)} {currency}</span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "3px solid #000",
            paddingTop: 6,
            marginTop: 4,
            fontSize: 22,
            fontWeight: 900,
          }}
        >
          <span>TOTAL</span>
          <span>{total.toFixed(2)} {currency}</span>
        </div>
      </div>

      {/* Tags row (purely informational) */}
      {(order.tags || []).length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, opacity: 0.75 }}>
          {(order.tags || []).join("  ·  ")}
        </div>
      )}
    </div>
  );
}
