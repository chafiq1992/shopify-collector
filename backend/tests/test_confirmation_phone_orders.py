import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ['DATABASE_URL']='sqlite+aiosqlite:///:memory:'
from backend.app.confirmation_routes import phone_orders, PHONE_SCAN_GQL, PHONE_ORDERS_GQL, _PHONE_SCAN_CACHE
from fastapi import HTTPException


def order(oid, phone):
    return {'id':'gid://shopify/Order/'+oid,'name':'#'+oid,'shippingAddress':{'phone':phone},'customer':{'phone':''},'lineItems':{'edges':[]}}


def page(orders, more=False):
    return {'orders':{'edges':[{'cursor':'cursor-'+o['name'],'node':o} for o in orders], 'pageInfo':{'hasNextPage':more}}}


class PhoneOrderTests(unittest.TestCase):
    def setUp(self):
        _PHONE_SCAN_CACHE.clear()

    def test_blank_customer_profiles_still_find_same_delivery_phone_orders(self):
        first,second,other=order('22','0784314967'),order('21','+212784314967'),order('20','+33784314967')
        query=AsyncMock(side_effect=[page([first,second,other]),{'nodes':[second,first]}])
        with patch('backend.app.main.shopify_graphql',query):
            result=asyncio.run(phone_orders(store='irrakids',phone='00212784314967',first=20,after=None,user=None))
        self.assertEqual([o['number'] for o in result['orders']],['22','21'])
        self.assertFalse(result['page_info']['has_next_page'])
        self.assertEqual(query.call_args_list[0].args[0],PHONE_SCAN_GQL)
        self.assertEqual(query.call_args_list[1].args[0],PHONE_ORDERS_GQL)
        self.assertEqual(query.call_args_list[1].args[1]['ids'],[first['id'],second['id']])
        self.assertTrue(all(call.kwargs['store']=='irrakids' for call in query.call_args_list))

    def test_cursor_stops_at_last_returned_match_without_skipping_next_order(self):
        first,second=order('22','0784314967'),order('21','0784314967')
        query=AsyncMock(side_effect=[page([first,second]),{'nodes':[first]}])
        with patch('backend.app.main.shopify_graphql',query):
            result=asyncio.run(phone_orders(store='irrakids',phone='0784314967',first=1,after='previous',user=None))
        self.assertEqual(result['page_info'],{'has_next_page':True,'end_cursor':'cursor-#22'})
        self.assertEqual(query.call_args_list[0].args[1]['after'],'previous')

    def test_scan_is_bounded_and_can_continue_when_first_four_pages_have_no_match(self):
        query=AsyncMock(return_value=page([order('22','0611111111')],more=True))
        with patch('backend.app.main.shopify_graphql',query):
            result=asyncio.run(phone_orders(store='irranova',phone='0612345678',first=20,after=None,user=None))
        self.assertEqual(result['orders'],[])
        self.assertTrue(result['page_info']['has_next_page'])
        self.assertEqual(result['scanned_orders'],4)
        self.assertLessEqual(query.call_count,4)

    def test_same_store_scan_pages_are_reused_but_full_order_phone_is_rechecked(self):
        first=order('22','0784314967')
        query=AsyncMock(side_effect=[page([first]),{'nodes':[first]},{'nodes':[order('22','0611111111')]}])
        with patch('backend.app.main.shopify_graphql',query):
            asyncio.run(phone_orders(store='irrakids',phone='0784314967',first=20,after=None,user=None))
            result=asyncio.run(phone_orders(store='irrakids',phone='0784314967',first=20,after=None,user=None))
        self.assertEqual(result['orders'],[])
        self.assertEqual(sum(call.args[0]==PHONE_SCAN_GQL for call in query.call_args_list),1)

    def test_invalid_phone_never_queries_shopify(self):
        query=AsyncMock()
        with patch('backend.app.main.shopify_graphql',query),self.assertRaises(HTTPException):
            asyncio.run(phone_orders(store='irrakids',phone='123',first=20,after=None,user=None))
        query.assert_not_called()
