import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_FILTERS, ORDER_VIEWS, activeView, countLabel, dateRange, filterChips, fulfillmentBadge, moneyLabel,
  orderDateLabel, orderListParams, paymentBadge, shopifyAdminOrderUrl, viewFilters,
} from '../src/lib/confirmationOrdersList.js';
import { addTags, codDateTags, rankTagSuggestions, splitTags, tagProblem } from '../src/lib/orderTags.js';
import { createOrderPayload, initialOrderForm } from '../src/lib/confirmationOrderForm.js';

const filters = (patch = {}) => ({ ...EMPTY_FILTERS, ...patch });

test('filters become repeated query parameters the orders endpoint understands', () => {
  const params = orderListParams({
    store: 'irrakids', sort: 'TOTAL_PRICE:false', after: 'cursor-2',
    filters: filters({ q: ' #174163 ', fulfillment: ['unfulfilled', 'partial'], payment: ['pending'], status: ['open'], tags: ['fz', 'meta'], tag_mode: 'all',
      exclude_tags: ['cod 19/10/26'], products: [{ id: 'gid://shopify/Product/7', title: 'Boots' }], product_title: 'sneakers', date: 'custom', date_from: '2026-10-01', date_to: '2026-10-17' }),
  });
  assert.equal(params.get('q'), '#174163');
  assert.deepEqual(params.getAll('fulfillment'), ['unfulfilled', 'partial']);
  assert.deepEqual(params.getAll('tag'), ['fz', 'meta']);
  assert.equal(params.get('tag_mode'), 'all');
  assert.deepEqual(params.getAll('exclude_tag'), ['cod 19/10/26']);
  assert.deepEqual(params.getAll('product_id'), ['gid://shopify/Product/7']);
  assert.equal(params.get('product_title'), 'sneakers');
  assert.equal(params.get('date_from'), '2026-10-01');
  assert.equal(params.get('sort_key'), 'TOTAL_PRICE');
  assert.equal(params.get('reverse'), 'false');
  assert.equal(params.get('first'), '50');
  assert.equal(params.get('after'), 'cursor-2');
  assert.equal(orderListParams({ store: 's', filters: filters({ tags: ['one'], tag_mode: 'all' }) }).get('tag_mode'), null);
});

test('date presets cover whole days ending today', () => {
  const now = new Date(2026, 9, 17, 16, 30);
  assert.deepEqual(dateRange(filters({ date: 'today' }), now), { date_from: '2026-10-17', date_to: '2026-10-17' });
  assert.deepEqual(dateRange(filters({ date: 'yesterday' }), now), { date_from: '2026-10-16', date_to: '2026-10-16' });
  assert.deepEqual(dateRange(filters({ date: 'last7' }), now), { date_from: '2026-10-11', date_to: '2026-10-17' });
  assert.deepEqual(dateRange(filters({ date: 'last30' }), now), { date_from: '2026-09-18', date_to: '2026-10-17' });
  assert.deepEqual(dateRange(filters(), now), { date_from: '', date_to: '' });
});

test('views are presets, and editing a filter leaves the view', () => {
  const unfulfilled = ORDER_VIEWS.find((view) => view.key === 'unfulfilled');
  const applied = viewFilters(unfulfilled, 'imane');
  assert.equal(applied.q, 'imane');
  assert.equal(activeView(applied), 'unfulfilled');
  assert.equal(activeView(filters()), 'all');
  assert.equal(activeView({ ...applied, payment: ['pending'] }), null);
  assert.equal(activeView(filters({ status: ['open'], tag_mode: 'all' })), 'open');
});

test('every applied filter has a removable chip that clears only itself', () => {
  const chips = filterChips(filters({ payment: ['pending', 'paid'], tags: ['a', 'b'], exclude_tags: ['x'], date: 'last7' }));
  assert.deepEqual(chips.map((chip) => chip.label), ['Payment: Payment pending, Paid', 'Tagged with any of a, b', 'Not tagged with x', 'Date: Last 7 days']);
  assert.deepEqual(chips[1].clear, { tags: [], tag_mode: 'any' });
  assert.deepEqual(filterChips(filters()), []);
});

test('statuses, dates, money and counts read like the Shopify orders list', () => {
  assert.deepEqual(paymentBadge('PENDING'), { label: 'Payment pending', tone: 'orange', hollow: true });
  assert.equal(paymentBadge('PARTIALLY_REFUNDED').label, 'Partially refunded');
  assert.equal(paymentBadge('VOIDED').label, 'Voided');
  assert.equal(fulfillmentBadge('UNFULFILLED').tone, 'yellow');
  assert.equal(fulfillmentBadge('IN_PROGRESS').label, 'In progress');
  const now = new Date(2026, 9, 17, 18, 0);
  assert.equal(orderDateLabel(new Date(2026, 9, 17, 16, 27).toISOString(), now), 'Today at 4:27 pm');
  assert.equal(orderDateLabel(new Date(2026, 9, 16, 9, 5).toISOString(), now), 'Yesterday at 9:05 am');
  assert.equal(orderDateLabel(new Date(2025, 0, 2, 9, 5).toISOString(), now), 'Jan 2, 2025 at 9:05 am');
  assert.equal(moneyLabel('1179.9', 'MAD'), 'MAD 1,179.90');
  assert.equal(countLabel(10000, 'AT_LEAST'), '10,000+ orders');
  assert.equal(countLabel(1, 'EXACT'), '1 order');
  assert.equal(shopifyAdminOrderUrl('https://irrakids.myshopify.com', { id: 'gid://shopify/Order/55' }), 'https://irrakids.myshopify.com/admin/orders/55');
});

test('tag suggestions rank prefix matches first and leave out chosen tags', () => {
  const all = ['inbox_channels', 'cod 19/10/26', 'cod 18/10/26', 'fz', 'ok_wtp', 'easysell_cod_form'];
  assert.deepEqual(rankTagSuggestions(all, 'cod', ['cod 18/10/26']), ['cod 19/10/26', 'easysell_cod_form']);
  assert.deepEqual(rankTagSuggestions(all, '', [], 3), ['inbox_channels', 'cod 19/10/26', 'cod 18/10/26']);
  assert.deepEqual(rankTagSuggestions(['FZ', 'fz'], 'f'), ['FZ']);
  assert.deepEqual(addTags(['fz'], ['FZ', 'meta']), ['fz', 'meta']);
  assert.deepEqual(splitTags(' a , b,, c '), ['a', 'b', 'c']);
  assert.match(tagProblem('x'.repeat(41)), /40 characters/);
  assert.equal(tagProblem('x'.repeat(40)), '');
  assert.deepEqual(codDateTags(new Date(2026, 9, 31, 12)), ['cod 31/10/26', 'cod 01/11/26']);
});

test('chosen tags are sent only when present and restored from a pending request', () => {
  const base = { store: 's', actionId: 'action-1', shipping: {}, email: '', note: '', shippingPrice: '0', items: [{ id: 'v1', quantity: 1 }], customer: null };
  assert.equal('tags' in createOrderPayload(base), false);
  assert.deepEqual(createOrderPayload({ ...base, tags: ['fz'] }).tags, ['fz']);
  const pending = { payload: { ...createOrderPayload({ ...base, tags: ['fz'] }) }, items: [] };
  assert.deepEqual(initialOrderForm(pending).tags, ['fz']);
  assert.deepEqual(initialOrderForm(null).tags, []);
  assert.deepEqual(initialOrderForm(null, { items: [], shipping_address: {} }).tags, []);
});
