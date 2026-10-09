// Exact identity within the selected store; never group missing/invalid phones.
export function confirmationPhone(value) {
  let raw = String(value || '').trim().replace(/[٠-٩۰-۹]/g, c => {
    const code = c.charCodeAt(0); return String(code >= 0x6f0 ? code - 0x6f0 : code - 0x660);
  });
  if (!/^[+\d\s()./-]+$/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^0[567]\d{8}$/.test(digits)) digits = '212' + digits.slice(1);
  else if (/^[567]\d{8}$/.test(digits)) digits = '212' + digits;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : '';
}

export function orderPhone(order) { return confirmationPhone(order.phone || order.customer_phone); }

export function groupConfirmationOrders(orders) {
  const groups = [], phones = new Map(), seen = new Set();
  for (const order of orders || []) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    const phone = orderPhone(order);
    const group = phone && phones.get(phone);
    if (group) group.relatedOrders.push(order);
    else {
      const parent = { ...order, relatedOrders: [] };
      groups.push(parent);
      if (phone) phones.set(phone, parent);
    }
  }
  return groups;
}
