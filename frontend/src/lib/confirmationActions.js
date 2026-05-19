// Helpers for the call-center confirmation page: phone formatting, tag cycling,
// and clipboard copy.

export const PHONE_TAGS = ["n1", "n2", "n3", "n4"];
export const NOWTP_TAG = "nowtp";

const PHONE_SET = new Set(PHONE_TAGS);

export function nextInCycle(currentTags, cycle) {
  // Find the highest tag in `cycle` already on the order; return the next one.
  // Locks at the last entry if already there.
  const lower = (currentTags || []).map((t) => String(t || "").toLowerCase());
  let highest = -1;
  cycle.forEach((tag, i) => { if (lower.includes(tag)) highest = i; });
  if (highest < 0) return cycle[0];
  if (highest >= cycle.length - 1) return cycle[cycle.length - 1];
  return cycle[highest + 1];
}

export function tagsInCycle(currentTags, cycle) {
  const lower = (currentTags || []).map((t) => String(t || "").toLowerCase());
  return cycle.filter((t) => lower.includes(t));
}

export function isPhoneTag(tag) {
  return PHONE_SET.has(String(tag || "").toLowerCase());
}
export function isNowtpTag(tag) {
  return String(tag || "").trim().toLowerCase() === NOWTP_TAG;
}
export function hasNowtpTag(tags) {
  return (tags || []).some(isNowtpTag);
}

export function moroccoInternational(phone) {
  // Convert local Moroccan format "0XXXXXXXXX" -> "212XXXXXXXXX".
  // Strip non-digits, non-+ characters first. Pass through anything else.
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("0")) return `212${digits.slice(1)}`;
  if (digits.startsWith("+")) return digits.slice(1);
  return digits;
}

export async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // Fallback for older browsers / insecure contexts.
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch { return false; }
}

export function todayDDMMYY(date = new Date()) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = String(date.getFullYear()).slice(2);
  return `${d}/${m}/${y}`;
}

export function isoToDDMMYY(iso) {
  // iso = "YYYY-MM-DD" from <input type="date">
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y.slice(2)}`;
}

export function todayISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isCodTag(tag) {
  return /^cod\s+\d{2}\/\d{2}\/\d{2}$/i.test(String(tag || "").trim());
}
