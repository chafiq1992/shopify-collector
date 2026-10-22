// Manual browser regression fixture. No live store or backend is contacted.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App.jsx';
import '../src/index.css';
const image = color => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 480"><rect width="400" height="480" fill="#f8fafc"/><path d="M130 70 70 110 25 205 95 240 123 185 112 410 288 410 277 185 305 240 375 205 330 110 270 70 235 95 165 95Z" fill="${color}"/><path d="M165 83q35 48 70 0" stroke="#fff" stroke-width="14" fill="none"/><path d="M200 120v270" stroke="#fff" stroke-opacity=".15" stroke-width="3"/><text x="200" y="270" fill="white" font-family="sans-serif" font-size="30" text-anchor="middle">IRRAKIDS</text></svg>`);
const orders = Array.from({length:36}, (_,i)=>({
  id:`gid://shopify/Order/${1000+i}`, number:`#${7100+i}`, customer:'Sample customer with a longer name', shipping_city:'Casablanca', note:'Check each item before collecting. Sample order for mobile layout verification.',
  tags:['cod 22/10/26','urgent','delivery-casablanca','en att b'],
  variants:[{ id:'gid://shopify/ProductVariant/1', line_item_id:`line-${i}-1`, product_id:'1234567', title:'Sweatshirt / Bleu / 6 ans', sku:'IRRA-2408-BL-06', qty:2, unfulfilled_qty:2,status:'unfulfilled', image:image('#7094be'),on_hand_quantity:8,pending_purchase_orders:[{id:1,number:'PO-1028',status:'pending'}] },{id:'gid://shopify/ProductVariant/2',line_item_id:`line-${i}-2`,product_id:'1234568',title:'Sweatshirt / Rose / 8 ans',sku:'IRRA-2408-RS-08',qty:1,unfulfilled_qty:1,status:'unfulfilled',image:image('#c68f9d'),on_hand_quantity:3,pending_purchase_orders:[]}],
}));
localStorage.setItem('orderCollectorAuth', JSON.stringify({access_token:'fixture-only',user:{id:1,email:'mobile-qa@example.test',role:'collector'}}));
localStorage.setItem('orderCollectorSelected_irrakids',JSON.stringify(orders.slice(1,25).map(o=>o.number)));
localStorage.removeItem('orderCollectorProfile');
let failTag=false, offline=false;
const sockets=[];
window.WebSocket=class {constructor(){sockets.push(this);queueMicrotask(()=>this.onopen?.())}close(){this.onclose?.()} };
const emit=data=>sockets.forEach(socket=>socket.onmessage?.({data:JSON.stringify(data)}));
const originalFetch=window.fetch;
window.fetch=async(url,options={})=>{
  const path=String(url);
  if(!path.startsWith('/api/'))return originalFetch(url,options);
  if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
  let body={}, status=200;
  if(path.startsWith('/api/orders?')){
    if(offline)throw new TypeError('Network unavailable');
    const q=new URL(path,location.origin).searchParams.get('search');
    const rows=q?orders.filter(o=>o.number.includes(q)):orders;
    body={orders:rows,tags:[...new Set(rows.flatMap(o=>o.tags))],totalCount:rows.length,pageInfo:{hasNextPage:false}};
  }else if(path.includes('/replace-tag')){
    const id=decodeURIComponent(path.split('/api/orders/')[1].split('/replace-tag')[0]);
    const payload=JSON.parse(options.body);
    if(failTag){failTag=false;status=502;body={detail:'Sample save failure. Original tag retained. Try again.'}}
    else{const order=orders.find(o=>o.id===id);order.tags=order.tags.map(t=>t===payload.old_tag?payload.new_tag:t);body={ok:true,tags:order.tags}}
  }else if(path==='/api/shopify/stores')body={stores:[{key:'irrakids',label:'Irrakids',connected:true}]};
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
};
window.addEventListener('message',event=>{
  if(event.origin!==location.origin)return;
  if(event.data.testAction==='complete-po'){orders.forEach(o=>o.variants.forEach(v=>v.pending_purchase_orders=[]));emit({type:'inventory.purchase_orders_changed',store:'irrakids'})}
  if(event.data.testAction==='fail-tag')failTag=true;
  if(event.data.testAction==='offline'){offline=true;emit({type:'order.tag_added',id:'external',store:'irrakids'})}
  if(event.data.testAction==='online'){offline=false;window.dispatchEvent(new Event('online'))}
  if(event.data.testAction==='many-tags'){orders.forEach(o=>o.tags=[...new Set([...o.tags,...Array.from({length:12},(_,i)=>`Additional warehouse tag ${i+1}`)])]);emit({type:'order.tag_added',id:'external',store:'irrakids'})}
});
createRoot(document.getElementById('root')).render(<App />);

// Measure real rendered bounds at every viewport change, including selection changes.
function reportLayout() {
  const main=document.querySelector('.collector-main');
  const card=document.querySelector('.collector-order');
  const footer=document.querySelector('.collector-actions');
  const photo=document.querySelector('.collector-photo');
  const image=photo?.querySelector('img');
  if(!main||!card||!footer||!photo)return;
  const c=card.getBoundingClientRect(),f=footer.getBoundingClientRect(),p=photo.getBoundingClientRect();
  parent.postMessage({fixtureMetrics:{width:innerWidth,height:innerHeight,photoHeight:Math.round(p.height),footerHeight:Math.round(f.height),noVerticalScroll:main.scrollHeight<=main.clientHeight+1&&document.documentElement.scrollHeight<=innerHeight+1,fullCardFits:c.top>=main.getBoundingClientRect().top-1&&c.bottom<=f.top+1&&p.height>0,containedImage:!image||getComputedStyle(image).objectFit==='contain'}},location.origin);
}
const layoutObserver=new ResizeObserver(()=>requestAnimationFrame(reportLayout));
layoutObserver.observe(document.getElementById('root'));
const layoutMutations=new MutationObserver(()=>{const main=document.querySelector('.collector-main');if(main)layoutObserver.observe(main);const footer=document.querySelector('.collector-actions');if(footer)layoutObserver.observe(footer);reportLayout()});
layoutMutations.observe(document.getElementById('root'),{childList:true,subtree:true});
window.addEventListener('resize',reportLayout);
