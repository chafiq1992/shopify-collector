import { todayISO } from "./confirmationActions.js";

export const FULFILLMENT_OPTIONS = [["unfulfilled", "Unfulfilled"], ["partial", "Partially fulfilled"], ["fulfilled", "Fulfilled"]];
export const PAYMENT_OPTIONS = [
  ["pending", "Payment pending"], ["authorized", "Authorized"], ["paid", "Paid"], ["partially_paid", "Partially paid"],
  ["partially_refunded", "Partially refunded"], ["refunded", "Refunded"], ["voided", "Voided"],
];
export const STATUS_OPTIONS = [["open", "Open"], ["closed", "Closed"], ["cancelled", "Cancelled"]];
export const DATE_PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["last7", "Last 7 days"], ["last30", "Last 30 days"], ["custom", "Custom range"]];
export const SORT_OPTIONS = [
  ["CREATED_AT:true", "Date, newest first"], ["CREATED_AT:false", "Date, oldest first"],
  ["ORDER_NUMBER:true", "Order number, highest first"], ["ORDER_NUMBER:false", "Order number, lowest first"],
  ["TOTAL_PRICE:true", "Total, highest first"], ["TOTAL_PRICE:false", "Total, lowest first"],
  ["CUSTOMER_NAME:false", "Customer, A–Z"], ["CUSTOMER_NAME:true", "Customer, Z–A"],
  ["UPDATED_AT:true", "Last updated first"],
];
export const PAGE_SIZE = 50;

export const EMPTY_FILTERS = Object.freeze({
  q: "", fulfillment: [], payment: [], status: [], tags: [], tag_mode: "any", exclude_tags: [],
  products: [], product_title: "", date: "", date_from: "", date_to: "",
});

// Saved views like Shopify's tabs. A view replaces every filter except the search.
export const ORDER_VIEWS = [
  { key: "all", label: "All", filters: {} },
  { key: "unfulfilled", label: "Unfulfilled", filters: { fulfillment: ["unfulfilled", "partial"], status: ["open"] } },
  { key: "unpaid", label: "Unpaid", filters: { payment: ["pending", "authorized", "partially_paid"] } },
  { key: "open", label: "Open", filters: { status: ["open"] } },
  { key: "closed", label: "Closed", filters: { status: ["closed"] } },
];

const LIST_KEYS = ["fulfillment", "payment", "status", "tags", "exclude_tags"];

export function viewFilters(view, q = "") {
  return { ...EMPTY_FILTERS, ...view.filters, q };
}

function sameList(a, b) {
  return a.length === b.length && [...a].sort().join("\n").toLowerCase() === [...b].sort().join("\n").toLowerCase();
}

export function filtersEqual(a, b) {
  return LIST_KEYS.every((key) => sameList(a[key] || [], b[key] || []))
    && sameList((a.products || []).map((p) => p.id), (b.products || []).map((p) => p.id))
    && ["product_title", "date", "date_from", "date_to"].every((key) => (a[key] || "") === (b[key] || ""))
    // Any/all only changes the results when more than one tag is chosen.
    && ((a.tags || []).length > 1 ? a.tag_mode === b.tag_mode : true);
}

export function activeView(filters) {
  return ORDER_VIEWS.find((view) => filtersEqual(filters, viewFilters(view)))?.key || null;
}

function shiftDays(now, days) {
  const day = new Date(now);
  day.setDate(day.getDate() + days);
  return todayISO(day);
}

// Whole days in the agent's calendar; the server applies the store time zone.
export function dateRange(filters, now = new Date()) {
  switch (filters.date) {
    case "today": return { date_from: todayISO(now), date_to: todayISO(now) };
    case "yesterday": return { date_from: shiftDays(now, -1), date_to: shiftDays(now, -1) };
    case "last7": return { date_from: shiftDays(now, -6), date_to: todayISO(now) };
    case "last30": return { date_from: shiftDays(now, -29), date_to: todayISO(now) };
    case "custom": return { date_from: filters.date_from || "", date_to: filters.date_to || "" };
    default: return { date_from: "", date_to: "" };
  }
}

export function orderListParams({ store, filters, sort = "CREATED_AT:true", after = "", before = "", now = new Date() }) {
  const [sortKey, reverse] = sort.split(":");
  const params = new URLSearchParams({ store, first: String(PAGE_SIZE), sort_key: sortKey, reverse: String(reverse === "true") });
  if (filters.q.trim()) params.set("q", filters.q.trim());
  for (const value of filters.fulfillment) params.append("fulfillment", value);
  for (const value of filters.payment) params.append("payment", value);
  for (const value of filters.status) params.append("status", value);
  for (const value of filters.tags) params.append("tag", value);
  if (filters.tags.length > 1) params.set("tag_mode", filters.tag_mode);
  for (const value of filters.exclude_tags) params.append("exclude_tag", value);
  for (const product of filters.products) params.append("product_id", product.id);
  if (filters.product_title.trim()) params.set("product_title", filters.product_title.trim());
  const { date_from, date_to } = dateRange(filters, now);
  if (date_from) params.set("date_from", date_from);
  if (date_to) params.set("date_to", date_to);
  if (after) params.set("after", after);
  if (before) params.set("before", before);
  return params;
}

const label = (options, key) => options.find(([value]) => value === key)?.[1] || key;

// Removable chips for every applied filter, each with the patch that clears it.
export function filterChips(filters) {
  const chips = [];
  const list = (key, title, options) => {
    if (filters[key].length) chips.push({ key, label: `${title}: ${filters[key].map((value) => label(options, value)).join(", ")}`, clear: { [key]: [] } });
  };
  list("status", "Status", STATUS_OPTIONS);
  list("fulfillment", "Fulfillment", FULFILLMENT_OPTIONS);
  list("payment", "Payment", PAYMENT_OPTIONS);
  if (filters.tags.length) chips.push({ key: "tags", label: `Tagged with ${filters.tags.length > 1 ? (filters.tag_mode === "all" ? "all of" : "any of") + " " : ""}${filters.tags.join(", ")}`, clear: { tags: [], tag_mode: "any" } });
  if (filters.exclude_tags.length) chips.push({ key: "exclude_tags", label: `Not tagged with ${filters.exclude_tags.join(", ")}`, clear: { exclude_tags: [] } });
  if (filters.products.length) chips.push({ key: "products", label: `Product: ${filters.products.map((product) => product.title || product.id.split("/").pop()).join(", ")}`, clear: { products: [] } });
  if (filters.product_title.trim()) chips.push({ key: "product_title", label: `Product title: ${filters.product_title.trim()}`, clear: { product_title: "" } });
  if (filters.date) {
    const custom = filters.date === "custom" ? [filters.date_from && `from ${filters.date_from}`, filters.date_to && `to ${filters.date_to}`].filter(Boolean).join(" ") : "";
    chips.push({ key: "date", label: `Date: ${filters.date === "custom" ? custom || "custom range" : label(DATE_PRESETS, filters.date)}`, clear: { date: "", date_from: "", date_to: "" } });
  }
  return chips;
}

export function filterCount(filters) {
  return filterChips(filters).length;
}

const TITLE = (value) => String(value || "").toLowerCase().split("_").filter(Boolean).map((word, index) => index ? word : word[0].toUpperCase() + word.slice(1)).join(" ");

// Shopify admin colours: attention states are amber/yellow, settled ones grey.
export function paymentBadge(status) {
  const value = String(status || "").toUpperCase();
  if (value === "PENDING") return { label: "Payment pending", tone: "orange", hollow: true };
  if (value === "PAID") return { label: "Paid", tone: "gray" };
  if (value === "PARTIALLY_PAID") return { label: "Partially paid", tone: "yellow" };
  if (value === "AUTHORIZED") return { label: "Authorized", tone: "yellow", hollow: true };
  if (value === "PARTIALLY_REFUNDED") return { label: "Partially refunded", tone: "gray" };
  return { label: TITLE(value) || "—", tone: "gray" };
}

export function fulfillmentBadge(status) {
  const value = String(status || "").toUpperCase();
  if (value === "UNFULFILLED") return { label: "Unfulfilled", tone: "yellow", hollow: true };
  if (value === "PARTIALLY_FULFILLED") return { label: "Partially fulfilled", tone: "yellow" };
  if (value === "FULFILLED") return { label: "Fulfilled", tone: "gray" };
  if (value === "ON_HOLD") return { label: "On hold", tone: "orange" };
  return { label: TITLE(value) || "—", tone: "gray" };
}

// "Today at 4:27 pm", "Yesterday at 9:02 am", "Oct 15 at 3:21 pm", or with the year.
export function orderDateLabel(value, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  // Newer ICU puts a narrow no-break space before "PM".
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s+/g, " ").toLowerCase();
  const day = todayISO(date);
  if (day === todayISO(now)) return `Today at ${time}`;
  if (day === shiftDays(now, -1)) return `Yesterday at ${time}`;
  const options = { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) };
  return `${date.toLocaleDateString("en-US", options)} at ${time}`;
}

export function moneyLabel(amount, currency) {
  const number = Number(amount);
  const formatted = Number.isFinite(number) ? number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(amount ?? "");
  return `${currency || ""} ${formatted}`.trim();
}

export function countLabel(count, precision) {
  if (count == null) return "";
  const number = Number(count).toLocaleString("en-US");
  return `${number}${String(precision || "").toUpperCase() === "AT_LEAST" ? "+" : ""} order${Number(count) === 1 ? "" : "s"}`;
}

export function shopifyAdminOrderUrl(domain, order) {
  const shop = String(domain || "").trim().replace(/^https?:\/\//, "");
  const id = order.legacy_id || String(order.id || "").split("/").pop();
  return shop && id ? `https://${shop}/admin/orders/${id}` : null;
}
