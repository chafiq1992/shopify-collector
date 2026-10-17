import test from 'node:test';
import assert from 'node:assert/strict';
import { autoExpandedProductId, createProductSearchPager, mergeById, productSummaryLabels } from '../src/lib/productSearchPaging.js';

test('loading additional pages retains prior products and deduplicates product ids across page boundaries', async () => {
  const requests=[];
  const pager=createProductSearchPager(async (store,q,options) => {
    requests.push({store,q,...options});
    return options.after ? {products:[{id:'p2',title:'new'},{id:'p3'}],page_info:{has_next_page:false,end_cursor:'end'}} : {products:[{id:'p1'},{id:'p2',title:'old'}],page_info:{has_next_page:true,end_cursor:'next'}};
  },'store1','boots',()=>{});
  await pager.load(); await pager.load(true);
  assert.deepEqual(pager.snapshot().products.map(p=>p.id),['p1','p2','p3']);
  assert.equal(pager.snapshot().products[1].title,'new'); assert.equal(requests[1].after,'next');
  assert.equal(requests[1].store,'store1'); assert.equal(requests[1].q,'boots'); assert.equal(pager.snapshot().hasNextPage,false);
});
test('a failed next page retains loaded variants and retries the identical cursor', async () => {
  let attempts=0; const cursors=[];
  const pager=createProductSearchPager(async (_,__,options)=>{
    cursors.push(options.after);
    if(!options.after) return {products:[{id:'1'}],page_info:{has_next_page:true,end_cursor:'cursor'}};
    if(++attempts===1) throw new Error('Temporary failure');
    return {products:[{id:'2'}],page_info:{has_next_page:false}};
  },'s','q',()=>{});
  await pager.load(); await pager.load(true);
  assert.deepEqual(pager.snapshot().products.map(p=>p.id),['1']); assert.match(pager.snapshot().moreError,/Temporary/);
  await pager.load(true); assert.deepEqual(cursors,[undefined,'cursor','cursor']);
  assert.deepEqual(pager.snapshot().products.map(p=>p.id),['1','2']);
});
test('changing store or query disposes and aborts old reads even if the transport ignores abort', async () => {
  let resolve, signal; const emitted=[];
  const pager=createProductSearchPager((_,__,options)=>{signal=options.signal; return new Promise(done=>{resolve=done;});},'oldStore','oldQuery',state=>emitted.push(state));
  const loading=pager.load(); pager.dispose(); assert.equal(signal.aborted,true);
  const count=emitted.length; resolve({products:[{id:'stale'}]}); await loading;
  assert.equal(emitted.length,count); assert.equal(pager.snapshot().products.length,0);
});
test('rapid load more clicks send one page request and a repeated cursor is visibly retryable', async () => {
  let requests=0, resolve;
  const pager=createProductSearchPager(async (_,__,options)=>{
    requests++;
    if(!options.after) return {products:[{id:'1'}],page_info:{has_next_page:true,end_cursor:'same'}};
    return new Promise(done=>{resolve=done;});
  },'s','q',()=>{});
  await pager.load(); const first=pager.load(true); await pager.load(true); assert.equal(requests,2);
  resolve({products:[{id:'2'}],page_info:{has_next_page:true,end_cursor:'same'}}); await first;
  assert.match(pager.snapshot().moreError,/advance/); assert.deepEqual(pager.snapshot().products.map(p=>p.id),['1']);
});
test('merging keeps first positions and skips empty rows', () => {
  assert.deepEqual(mergeById([{id:'a'}],[{id:'a'},{id:'b'},null]).map(p=>p.id),['a','b']);
});
test('a collapsed product summarises its variants, price range and stock', () => {
  assert.deepEqual(productSummaryLabels({variants_count:3,price_min:'99.9',price_max:'124.9',currency:'MAD',tracks_inventory:true,total_inventory:12}),
    {variants:'3 variants',price:'99.90 – 124.90 MAD',stock:{label:'12 available',tone:'good'}});
  const single=productSummaryLabels({has_only_default_variant:true,price_min:'50',price_max:'50',tracks_inventory:true,total_inventory:0},'MAD');
  assert.equal(single.variants,'Single variant'); assert.equal(single.price,'50.00 MAD'); assert.equal(single.stock.label,'Out of stock');
  assert.equal(productSummaryLabels({tracks_inventory:false}).stock.label,'Stock not tracked');
});
test('a single result or an ID/SKU match opens automatically', () => {
  assert.equal(autoExpandedProductId([{id:'only'}]),'only');
  assert.equal(autoExpandedProductId([{id:'a',match_kind:'exact'},{id:'b',match_kind:'identifier'}]),'b');
  assert.equal(autoExpandedProductId([{id:'a',match_kind:'exact'},{id:'b',match_kind:'title'}]),null);
});
