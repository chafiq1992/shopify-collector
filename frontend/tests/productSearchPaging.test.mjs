import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductSearchPager, interleaveProductVariants, mergeProductVariants } from '../src/lib/productSearchPaging.js';

test('loading additional pages retains prior choices and deduplicates variant ids across page boundaries', async () => {
  const requests=[];
  const pager=createProductSearchPager(async (store,q,options) => {
    requests.push({store,q,...options});
    return options.after ? {variants:[{id:'v2',price:'30'},{id:'v3'}],page_info:{has_next_page:false,end_cursor:'end'}} : {variants:[{id:'v1'},{id:'v2',price:'20'}],page_info:{has_next_page:true,end_cursor:'next'}};
  },'store1','boots',()=>{});
  await pager.load(); await pager.load(true);
  assert.deepEqual(pager.snapshot().variants.map(v=>v.id),['v1','v2','v3']);
  assert.equal(pager.snapshot().variants[1].price,'30'); assert.equal(requests[1].after,'next');
  assert.equal(requests[1].store,'store1'); assert.equal(requests[1].q,'boots'); assert.equal(pager.snapshot().hasNextPage,false);
});
test('a failed next page retains loaded variants and retries the identical cursor', async () => {
  let attempts=0; const cursors=[];
  const pager=createProductSearchPager(async (_,__,options)=>{
    cursors.push(options.after);
    if(!options.after) return {variants:[{id:'1'}],page_info:{has_next_page:true,end_cursor:'cursor'}};
    if(++attempts===1) throw new Error('Temporary failure');
    return {variants:[{id:'2'}],page_info:{has_next_page:false}};
  },'s','q',()=>{});
  await pager.load(); await pager.load(true);
  assert.deepEqual(pager.snapshot().variants.map(v=>v.id),['1']); assert.match(pager.snapshot().moreError,/Temporary/);
  await pager.load(true); assert.deepEqual(cursors,[undefined,'cursor','cursor']);
  assert.deepEqual(pager.snapshot().variants.map(v=>v.id),['1','2']);
});
test('changing store or query disposes and aborts old reads even if the transport ignores abort', async () => {
  let resolve, signal; const emitted=[];
  const pager=createProductSearchPager((_,__,options)=>{signal=options.signal; return new Promise(done=>{resolve=done;});},'oldStore','oldQuery',state=>emitted.push(state));
  const loading=pager.load(); pager.dispose(); assert.equal(signal.aborted,true);
  const count=emitted.length; resolve({variants:[{id:'stale'}]}); await loading;
  assert.equal(emitted.length,count); assert.equal(pager.snapshot().variants.length,0);
});
test('rapid load more clicks send one page request and a repeated cursor is visibly retryable', async () => {
  let requests=0, resolve;
  const pager=createProductSearchPager(async (_,__,options)=>{
    requests++;
    if(!options.after) return {variants:[{id:'1'}],page_info:{has_next_page:true,end_cursor:'same'}};
    return new Promise(done=>{resolve=done;});
  },'s','q',()=>{});
  await pager.load(); const first=pager.load(true); await pager.load(true); assert.equal(requests,2);
  resolve({variants:[{id:'2'}],page_info:{has_next_page:true,end_cursor:'same'}}); await first;
  assert.match(pager.snapshot().moreError,/advance/); assert.deepEqual(pager.snapshot().variants.map(v=>v.id),['1']);
});
test('loaded matching products are interleaved instead of hidden behind one products sizes', () => {
  const result=interleaveProductVariants([{id:'a1',product_id:'a'},{id:'a2',product_id:'a'},{id:'a3',product_id:'a'},{id:'b1',product_id:'b'},{id:'c1',product_id:'c'}]);
  assert.deepEqual(result.map(v=>v.id),['a1','b1','c1','a2','a3']);
  assert.deepEqual(mergeProductVariants([{id:'a'}],[{id:'a'},{id:'b'},null]).map(v=>v.id),['a','b']);
});
