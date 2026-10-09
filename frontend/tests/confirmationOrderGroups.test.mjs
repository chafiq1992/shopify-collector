import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationPhone, groupConfirmationOrders } from '../src/lib/confirmationOrderGroups.js';

test('repeat orders share a row across Moroccan phone formats, while each order stays intact', () => {
  const orders = [{id:'2',phone:'0784314967',tags:['n2']}, {id:'1',phone:'+212784314967',tags:['new']}, {id:'3',phone:'0612345678'}];
  const groups = groupConfirmationOrders(orders);
  assert.equal(groups.length,2);
  assert.equal(groups[0].id,'2');
  assert.equal(groups[0].relatedOrders[0],orders[1]);
  assert.deepEqual(groups[0].tags,['n2']);
  assert.equal(orders[0].relatedOrders,undefined);
});

test('missing or invalid phones and other countries never collapse into one customer', () => {
  const orders = [{id:'1',phone:''},{id:'2',phone:''},{id:'3',phone:'not-a-phone'},{id:'4',phone:'+33784314967'},{id:'5',phone:'0784314967'}];
  assert.equal(groupConfirmationOrders(orders).length,5);
  assert.equal(confirmationPhone('٠٧٨٤٣١٤٩٦٧'),'212784314967');
  assert.equal(confirmationPhone('00212784314967'),'212784314967');
});

test('duplicate API order ids are ignored, and customer phone is a fallback', () => {
  const groups = groupConfirmationOrders([{id:'1',phone:'',customer_phone:'0784314967'},{id:'1',phone:'0784314967'},{id:'2',phone:'784314967'}]);
  assert.equal(groups.length,1);
  assert.deepEqual(groups[0].relatedOrders.map(order=>order.id),['2']);
});
