import test from 'node:test';
import assert from 'node:assert/strict';
import { draftChanges, draftEditor, draftValidation, draftListParams, readDraftCompletion, draftStockWarning } from '../src/lib/confirmationDrafts.js';

const draft = { id:'draft1', email:'test@example.test', tags:['qa'], total_shipping:'0.00', line_items:[{id:'line1',variant_id:'v1',quantity:2,unit_price:'100.00',applied_discount:{value:'10'},custom:false},{id:'line2',title:'Custom',quantity:1,unit_price:'12.00',custom:true}], shipping_address:{first_name:'Test',city:'Casablanca',country:'Morocco'} };

test('opening and saving an untouched draft sends no changes or line replacements', () => {
  assert.deepEqual(draftChanges(draft, draftEditor(draft)), {});
  assert.equal(draftEditor(draft).billing_address.address1,'');
});
test('billing edits are sparse and do not replace shipping or customer details', () => {
  const editor=draftEditor(draft); editor.billing_address.city='Rabat';
  const changes=draftChanges(draft,editor);
  assert.deepEqual(Object.keys(changes),['billing_address']);
  assert.equal(changes.billing_address.city,'Rabat');
});
test('stock warning distinguishes sold out from unknown and untracked variants', () => {
  assert.equal(draftStockWarning({inventory_tracked:true,available_quantity:0}),true);
  assert.equal(draftStockWarning({inventory_tracked:true,available_quantity:-2}),true);
  assert.equal(draftStockWarning({inventory_tracked:false,available_quantity:0}),false);
  assert.equal(draftStockWarning({available_quantity:null,inventory_quantity:0}),false);
  assert.equal(draftStockWarning({}),false);
});
test('note-only edits preserve existing lines, discounts, customer and shipping settings', () => {
  const editor=draftEditor(draft); editor.note='Agent note';
  assert.deepEqual(draftChanges(draft,editor),{note:'Agent note'});
});
test('quantity edits, removals and additions send identity for saved lines and preserve opaque fields server-side', () => {
  const editor=draftEditor(draft); editor.line_items[0].quantity=3;
  editor.line_items.pop();
  editor.line_items.push({is_new:true,variant_id:'v2',title:'Variant',quantity:2,unit_price:'150'});
  editor.line_items.push({is_new:true,title:'Gift wrap',quantity:1,unit_price:'10'});
  assert.deepEqual(draftChanges(draft,editor),{line_items:[{id:'line1',quantity:3},{variant_id:'v2',quantity:2},{title:'Gift wrap',unit_price:'10.00',quantity:1}]});
  assert.equal(draft.line_items[0].quantity,2);
  assert.deepEqual(draft.line_items[0].applied_discount,{value:'10'});
});
test('zero shipping is valid and removing an order discount explicitly sends null', () => {
  const original={...draft,shipping_line:{title:'Courier',price:'20'},applied_discount:{title:'Offer',value:'5',value_type:'PERCENTAGE'}};
  const editor=draftEditor(original); editor.shipping_line.price='0'; editor.applied_discount=null;
  assert.deepEqual(draftChanges(original,editor),{applied_discount:null,shipping_line:{title:'Courier',price:'0.00'}});
  assert.equal(draftValidation(editor),'');
});
test('invalid quantities, empty products, shipping and discounts prevent save/complete', () => {
  for(const quantity of [0,1.5,1000,NaN]) {
    const editor=draftEditor(draft); editor.line_items[0].quantity=quantity;
    assert.match(draftValidation(editor),/quantity/i);
  }
  const editor=draftEditor(draft); editor.line_items=[]; assert.match(draftValidation(editor),/product/);
  editor.line_items=draftEditor(draft).line_items; editor.shipping_line.price='invalid'; assert.match(draftValidation(editor),/shipping/);
  editor.shipping_line.price='0'; editor.applied_discount={value:'101',value_type:'PERCENTAGE'}; assert.match(draftValidation(editor),/discount/);
});
test('server filters and cursors are encoded without narrowing sort to the current page', () => {
  const params=draftListParams({store:'store a',q:'  #D12  ',status:'OPEN',sort_key:'TOTAL_PRICE',reverse:false,tag:'agent one',before:'cursor+/='});
  assert.equal(params.get('q'),'#D12'); assert.equal(params.get('before'),'cursor+/=');
  assert.equal(params.get('sort_key'),'TOTAL_PRICE'); assert.equal(params.get('reverse'),'false'); assert.equal(params.has('after'),false);
});
test('pending completion cannot be recovered for a different store or draft', () => {
  const payload={store:'a',draft_id:'1',client_action_id:'action',expected_updated_at:'time'};
  const storage={getItem:()=>JSON.stringify(payload)};
  assert.deepEqual(readDraftCompletion(storage,'key','a','1'),payload);
  assert.equal(readDraftCompletion(storage,'key','b','1'),null);
  assert.equal(readDraftCompletion(storage,'key','a','2'),null);
  assert.equal(readDraftCompletion({getItem:()=>'{broken'},'key','a','1'),null);
});
