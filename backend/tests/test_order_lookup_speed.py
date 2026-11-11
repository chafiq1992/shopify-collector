"""Order display must stay fast while optional badges refresh independently."""
import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

from backend.app import main
from backend.app import lookup_aux_routes as routes
from backend.app import purchase_order_badges as po


def row(number=1, store="irrakids"):
    return SimpleNamespace(
        id=number, shopify_order_gid=f"gid://shopify/InventoryTransfer/{number}",
        po_number=f"PO-{store}-{number}", order_number=str(number), status="new",
        shopify_details_loaded=False, updated_at="v1",
        line_items=[{"variant_id":"gid://shopify/ProductVariant/1", "inventory_item_id":"gid://shopify/InventoryItem/1", "ordered_quantity":2}],
    )


def variant(number=2):
    return SimpleNamespace(id=f"gid://shopify/ProductVariant/{number}", inventory_item_id=f"gid://shopify/InventoryItem/{number}", pending_purchase_orders=[])


def membership(receipt, number=2):
    return {"nodes":[{"id":receipt.shopify_order_gid,"lineItems":{"nodes":[{"totalQuantity":4,"inventoryItem":{"id":f"gid://shopify/InventoryItem/{number}","variant":{"id":f"gid://shopify/ProductVariant/{number}"}}}],"pageInfo":{"hasNextPage":False}}}]}


@pytest_asyncio.fixture(autouse=True)
async def isolated_state():
    main.ORDERS_CACHE.clear()
    routes._tags_cache.clear()
    po._membership_cache.clear()
    po._membership_failures.clear()
    po._store_retry_after.clear()
    po._store_locks.clear()
    yield
    await routes.close_lookup_tasks()
    main.app.dependency_overrides.clear()
    main.ORDERS_CACHE.clear()
    po._membership_cache.clear()
    po._membership_failures.clear()
    po._store_locks.clear()


@pytest.mark.asyncio
async def test_fast_order_skips_blocked_badges_keeps_stock_and_separates_cache(monkeypatch):
    calls=[]
    async def resolver(_store): return ("example.myshopify.com","unused","unused")
    async def graphql(*_args,**_kwargs):
        calls.append("orders")
        return {"orders":{"edges":[{"cursor":"one","node":{}}],"pageInfo":{"hasNextPage":False}},"ordersCount":{"count":1}}
    async def on_hand(items,**_kwargs): items[0].variants[0].on_hand_quantity=7
    async def badges(*_args,**_kwargs):
        calls.append("badges")
        await asyncio.Event().wait()
    monkeypatch.setattr(main,"resolve_store_settings_effective",resolver)
    monkeypatch.setattr(main,"shopify_graphql",graphql)
    monkeypatch.setattr(main,"map_order_node",lambda _:main.OrderDTO(id="gid://shopify/Order/1",number="1",variants=[main.OrderVariant(id="gid://shopify/ProductVariant/1",qty=1,status="unfulfilled")]))
    monkeypatch.setattr(main,"_enrich_orders_with_on_hand",on_hand)
    monkeypatch.setattr(po,"enrich_orders_with_purchase_orders",badges)
    main.app.dependency_overrides[main.get_current_user]=lambda:None
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url="http://test") as client:
        response=await asyncio.wait_for(client.get('/api/orders?limit=1&search=1&store=irrakids&include_purchase_orders=false'),0.3)
        assert response.status_code==200
        assert response.json()['orders'][0]['variants'][0]['on_hand_quantity']==7
        assert calls==['orders']
        async def complete_badges(items,**_kwargs):
            calls.append('badges')
            items[0].variants[0].pending_purchase_orders=[{'id':1,'number':'PO-1','status':'new'}]
        monkeypatch.setattr(po,"enrich_orders_with_purchase_orders",complete_badges)
        # No real DB needed; enrichment requests a session but calls mocked helper.
        class Session:
            async def __aenter__(self):return self
            async def __aexit__(self,*_):pass
        monkeypatch.setattr(main,'SessionLocal',Session)
        enriched=await client.get('/api/orders?limit=1&search=1&store=irrakids&include_purchase_orders=true')
        assert enriched.status_code==200
        assert enriched.json()['orders'][0]['variants'][0]['pending_purchase_orders'][0]['number']=='PO-1'
        assert calls==['orders','orders','badges']
        cached=await client.get('/api/orders?limit=1&search=1&store=irrakids&include_purchase_orders=false')
        assert cached.json()['orders'][0]['variants'][0]['pending_purchase_orders']==[]
        assert calls==['orders','orders','badges']


@pytest.mark.asyncio
async def test_cold_snapshot_singleflight_store_isolation_then_second_product():
    receipt=row();other=row(3,'irranova');release=asyncio.Event();entered=asyncio.Event();calls=[]
    async def graphql(_query,variables,*,store,**_kwargs):
        calls.append(store);entered.set();await release.wait()
        return membership(receipt if store=='irrakids' else other)
    first=variant();start=time.monotonic()
    cold=po.purchase_order_snapshot([first],[receipt],store='irrakids',graphql=graphql,api_version='2026-07')
    repeated=po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=graphql,api_version='2026-07')
    po.purchase_order_snapshot([variant()],[other],store='irranova',graphql=graphql,api_version='2026-07')
    assert time.monotonic()-start<0.1
    assert cold=={
        'badges': {first.id: []},
        'stock': {first.id: {'pending_purchase_order_quantity': None}},
        'loading': True,
        'unavailable': False,
    }
    assert repeated['loading']
    await asyncio.wait_for(entered.wait(),.5)
    await asyncio.sleep(0)
    assert sorted(calls)==['irrakids','irranova']
    release.set();await asyncio.gather(*po._membership_tasks.values())
    warm=po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=graphql,api_version='2026-07')
    assert warm['badges'][first.id][0]['number']=='PO-irrakids-1'
    assert warm['loading'] is False
    assert warm['unavailable'] is False
    assert len(calls)==2
    completed=po.purchase_order_snapshot([variant()],[],store='irrakids',graphql=graphql,api_version='2026-07')
    assert completed['badges'][first.id]==[]


@pytest.mark.asyncio
async def test_badge_endpoint_closes_session_before_network_and_filters_active_rows(monkeypatch):
    receipt=row();closed=[]
    class Session:
        async def __aenter__(self):return self
        async def __aexit__(self,*_):closed.append(True)
        async def execute(self,statement):
            assert 'store_key' in str(statement)
            return SimpleNamespace(all=lambda:[receipt])
    async def graphql(*_args,**_kwargs):
        assert closed
        return membership(receipt)
    monkeypatch.setattr(main,'SessionLocal',Session)
    monkeypatch.setattr(main,'shopify_graphql',graphql)
    body=routes.PurchaseOrderBadgeInput(variants=[{'id':'gid://shopify/ProductVariant/2','inventory_item_id':'gid://shopify/InventoryItem/2'}])
    response=await routes.order_purchase_orders(body,store='irrakids',_user=None)
    assert closed==[True]
    assert response['loading'] is True
    await po._membership_tasks['irrakids']
    response=await routes.order_purchase_orders(body,store='irrakids',_user=None)
    assert response['badges']['gid://shopify/ProductVariant/2'][0]['number']=='PO-irrakids-1'


@pytest.mark.asyncio
async def test_failed_membership_reports_unknown_and_retries_after_backoff():
    receipt=row();calls=[]
    async def broken(*_args,**_kwargs):calls.append(True);raise RuntimeError('test upstream failure')
    po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=broken,api_version='2026-07')
    await po._membership_tasks['irrakids']
    failed=po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=broken,api_version='2026-07')
    assert failed['unavailable'] is True and failed['loading'] is False
    assert len(calls)==1
    key=('irrakids',receipt.shopify_order_gid)
    po._membership_failures[key]=0
    expires,fingerprint,members=po._membership_cache[key]
    po._membership_cache[key]=(0,fingerprint,members)
    async def recovered(*_args,**_kwargs):calls.append(True);return membership(receipt)
    retried=po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=recovered,api_version='2026-07')
    assert retried['loading']
    await po._membership_tasks['irrakids']
    final=po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=recovered,api_version='2026-07')
    assert final['unavailable'] is False and final['loading'] is False
    assert len(calls)==2


@pytest.mark.asyncio
async def test_missing_transfer_response_preserves_known_second_product_and_reports_unavailable():
    receipt=row();key=('irrakids',receipt.shopify_order_gid)
    known={'variant_id':'gid://shopify/ProductVariant/2','inventory_item_id':'gid://shopify/InventoryItem/2','ordered_quantity':3}
    po._membership_cache[key]=(0,str(receipt.updated_at),[known])
    async def missing(*_args,**_kwargs):return {'nodes':[None]}
    initial=po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=missing,api_version='2026-07')
    assert initial['badges'][variant().id][0]['number']=='PO-irrakids-1'
    await po._membership_tasks['irrakids']
    after=po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=missing,api_version='2026-07')
    assert after['unavailable'] is True
    assert after['loading'] is False
    assert after['badges'][variant().id]==initial['badges'][variant().id]


@pytest.mark.asyncio
async def test_background_deadline_is_bounded_and_cleanup_cancels(monkeypatch):
    receipt=row();cancelled=[]
    async def blocked(*_args,**_kwargs):
        try:await asyncio.Event().wait()
        finally:cancelled.append(True)
    monkeypatch.setattr(po,'_BACKGROUND_TIMEOUT_SECONDS',.02)
    po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=blocked,api_version='2026-07')
    await asyncio.wait_for(po._membership_tasks['irrakids'],.3)
    failed=po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=blocked,api_version='2026-07')
    assert failed['unavailable'] is True and not failed['loading']
    assert cancelled==[True]
    po._store_retry_after.clear()
    po.purchase_order_snapshot([variant()],[receipt],store='irrakids',graphql=blocked,api_version='2026-07')
    await asyncio.sleep(0)
    await po.close_membership_tasks()
    assert po._membership_tasks=={}


@pytest.mark.asyncio
async def test_tag_suggestions_are_lightweight_cached_singleflight_and_store_scoped(monkeypatch):
    calls=[];release=asyncio.Event()
    async def graphql(query,_variables,*,store):
        assert 'lineItems' not in query and 'inventory' not in query and 'nodes { tags }' in query
        calls.append(store);await release.wait();return {'orders':{'nodes':[{'tags':[store,'shared']},{'tags':['shared']}]}}
    monkeypatch.setattr(main,'shopify_graphql',graphql)
    requests=[asyncio.create_task(routes.order_tags(store=store,_user=None)) for store in ['irrakids','irrakids','irranova']]
    await asyncio.sleep(.01);release.set()
    results=await asyncio.gather(*requests)
    assert sorted(calls)==['irrakids','irranova']
    assert results[0]['tags']==['irrakids','shared']
    assert results[2]['tags']==['irranova','shared']
    await routes.order_tags(store='irrakids',_user=None)
    assert len(calls)==2


@pytest.mark.asyncio
async def test_new_endpoints_require_auth_and_reject_oversized_or_invalid_variant_inputs():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='http://test') as client:
        assert (await client.get('/api/order-tags?store=irrakids')).status_code==401
        assert (await client.post('/api/order-purchase-orders?store=irrakids',json={'variants':[]})).status_code==401
        main.app.dependency_overrides[main.get_current_user]=lambda:None
        bad=await client.post('/api/order-purchase-orders?store=irrakids',json={'variants':[{'id':'not-a-variant'}]})
        assert bad.status_code==422
        too_many=await client.post('/api/order-purchase-orders?store=irrakids',json={'variants':[{'id':'gid://shopify/ProductVariant/1'}]*251})
        assert too_many.status_code==422
        assert (await client.post('/api/order-purchase-orders?store=irrakids',json={'variants':[]})).json()=={
            'badges': {}, 'stock': {}, 'loading': False, 'unavailable': False,
        }
