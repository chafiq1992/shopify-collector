import test from 'node:test';
import assert from 'node:assert/strict';
import { customerOrderFields, duplicateOrderSeed, initialOrderForm, orderCartIssue, createOrderPayload } from '../src/lib/confirmationOrderForm.js';

test('customer selection uses address data with customer fallbacks and clears previous blanks', () => {
  const selected=customerOrderFields({id:'customer1',name:'Test Customer',first_name:'Test',last_name:'Customer',email:'',phone:'0612345678',address:{first_name:'Delivery',city:'Rabat',company:'Company'}});
  assert.equal(selected.shipping.first_name,'Delivery'); assert.equal(selected.shipping.last_name,'Customer');
  assert.equal(selected.shipping.phone,'0612345678'); assert.equal(selected.shipping.address1,'');
  assert.equal(selected.shipping.country,'Morocco'); assert.equal(selected.email,'');
  assert.equal(selected.customer.id,'customer1');
});
const template={source_order_id:'order1',source_order_name:'#123',customer_id:'customer1',customer:{id:'customer1',name:'Name'},shipping_address:{first_name:'Name',city:'Rabat'},email:'test@example.test',shipping_price:'20',currency:'MAD',items:[{id:'variant1',source_line_id:'line1',product_title:'Product',price:'100',quantity:2},{id:'variant1',source_line_id:'line2',product_title:'Product',price:'100',quantity:3},{id:null,source_line_id:'line3',product_title:'Deleted',price:'40',quantity:1,unavailable:true,needs_review:true},{id:null,source_line_id:'line4',product_title:'Custom',price:'10',quantity:1,unavailable:true,needs_review:true}],warnings:['Review unavailable items'],note:'Old note',tags:['cod'],discounts:['offer'],financial_status:'paid'};
test('duplicate seed retains all source quantities, unique unavailable rows and warnings without payment or tags', () => {
  const seed=duplicateOrderSeed(template);
  assert.equal(seed.items.length,3); assert.equal(seed.items[0].quantity,5);
  assert.notEqual(seed.items[1].row_key,seed.items[2].row_key); assert.equal(seed.note,'');
  assert.equal(seed.customer.id,'customer1'); assert.equal(seed.shippingPrice,'20');
  assert.deepEqual(seed.source.warnings,['Review unavailable items']);
  assert.equal(seed.financial_status,undefined); assert.equal(seed.tags,undefined); assert.equal(seed.discounts,undefined);
  assert.match(orderCartIssue(seed.items),/unavailable/);
  assert.equal(orderCartIssue(seed.items.slice(0,1)),'');
});
test('aggregated quantities are exact and require review instead of silently clamping', () => {
  const seed=duplicateOrderSeed({...template,items:[{id:'v1',quantity:600},{id:'v1',quantity:600}]});
  assert.equal(seed.items[0].quantity,1200); assert.match(orderCartIssue(seed.items),/999/);
  seed.items[0].quantity=900; assert.equal(orderCartIssue(seed.items),'');
});
test('cancelled source keeps original products, exact variants and quantities when current quantity is zero', () => {
  const seed=duplicateOrderSeed({...template,items:[
    {id:'gid://shopify/ProductVariant/101',product_title:'Boots',variant_title:'Black / 33',sku:'BOOT-33',image:'https://example.test/boots.jpg',price:'239.99',quantity:1,current_quantity:0},
    {id:'gid://shopify/ProductVariant/102',product_title:'Boots',variant_title:'Black / 34',sku:'BOOT-34',image:'https://example.test/boots.jpg',price:'239.99',quantity:2,current_quantity:0},
  ],warnings:['The source was cancelled. Original quantities were copied.']});
  assert.equal(seed.items.length,2);
  assert.deepEqual(seed.items.map(item=>({id:item.id,variant:item.variant_title,quantity:item.quantity})),[
    {id:'gid://shopify/ProductVariant/101',variant:'Black / 33',quantity:1},
    {id:'gid://shopify/ProductVariant/102',variant:'Black / 34',quantity:2},
  ]);
  assert.equal(seed.items[0].image,'https://example.test/boots.jpg');
  assert.equal(seed.items[1].sku,'BOOT-34');
  assert.equal(orderCartIssue(seed.items),'');
  assert.deepEqual(createOrderPayload({store:'s',actionId:'new',...seed}).additions,[
    {variant_id:'gid://shopify/ProductVariant/101',quantity:1},
    {variant_id:'gid://shopify/ProductVariant/102',quantity:2},
  ]);
});
test('pending creation overrides fresh duplicate source and keeps original linkage/action context', () => {
  const pending={payload:{store:'store1',client_action_id:'stable',customer_id:'priorCustomer',shipping_address:{first_name:'Prior'},email:'prior@example.test',shipping_price:'0',additions:[{variant_id:'priorVariant',quantity:1}]},items:[{id:'priorVariant',quantity:1}],currency:'MAD',customer:{id:'priorCustomer',name:'Prior'}};
  const state=initialOrderForm(pending,template);
  assert.equal(state.shipping.first_name,'Prior'); assert.equal(state.customer.id,'priorCustomer');
  assert.equal(state.items.length,1); assert.equal(state.items[0].id,'priorVariant'); assert.equal(state.source,null);
});
test('creation payload links only selected customer and sends variant quantities without source metadata', () => {
  const seed=duplicateOrderSeed({...template,items:template.items.slice(0,2)});
  const payload=createOrderPayload({store:'store1',actionId:'new-action',...seed});
  assert.equal(payload.customer_id,'customer1'); assert.equal(payload.client_action_id,'new-action');
  assert.deepEqual(payload.additions,[{variant_id:'variant1',quantity:5}]);
  assert.equal(payload.source_order_id,undefined); assert.equal(payload.note,null); assert.equal(payload.tags,undefined);
  assert.equal(payload.shipping_price,'20.00');
  assert.equal(createOrderPayload({store:'s',actionId:'a',...seed,customer:null}).customer_id,undefined);
});
