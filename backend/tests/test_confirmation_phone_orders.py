import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ['DATABASE_URL']='sqlite+aiosqlite:///:memory:'
from backend.app.confirmation_routes import phone_orders, PHONE_CUSTOMERS_GQL, PHONE_ORDERS_GQL
from fastapi import HTTPException


def order(oid, phone):
    return {'id':'gid://shopify/Order/'+oid,'name':'#'+oid,'shippingAddress':{'phone':phone},'lineItems':{'edges':[]}}


class PhoneOrderTests(unittest.TestCase):
    def test_same_phone_customers_are_combined_but_different_shipping_phone_is_excluded(self):
        query=AsyncMock(side_effect=[{'customers':{'nodes':[
            {'id':'gid://shopify/Customer/1','phone':'0784314967'},
            {'id':'gid://shopify/Customer/2','phone':'+212784314967'},
            {'id':'gid://shopify/Customer/3','phone':'+33784314967'}], 'pageInfo':{'hasNextPage':False}}},
            {'orders':{'edges':[{'node':order('22','0784314967')},{'node':order('21','+212784314967')},{'node':order('20','0611111111')}],
                       'pageInfo':{'hasNextPage':True,'endCursor':'next'}}}])
        with patch('backend.app.main.shopify_graphql',query):
            result=asyncio.run(phone_orders(store='irrakids',phone='00212784314967',first=20,after='previous',user=None))
        self.assertEqual([o['number'] for o in result['orders']],['22','21'])
        self.assertTrue(result['page_info']['has_next_page'])
        self.assertEqual(result['page_info']['end_cursor'],'next')
        self.assertEqual(query.call_args_list[0].args[0],PHONE_CUSTOMERS_GQL)
        self.assertEqual(query.call_args_list[1].args[0],PHONE_ORDERS_GQL)
        self.assertEqual(query.call_args_list[1].args[1]['query'],'(customer_id:1) OR (customer_id:2)')
        self.assertEqual(query.call_args_list[1].args[1]['after'],'previous')
        self.assertTrue(all(call.kwargs['store']=='irrakids' for call in query.call_args_list))

    def test_customer_lookup_pages_are_not_silently_truncated(self):
        query=AsyncMock(side_effect=[{'customers':{'nodes':[], 'pageInfo':{'hasNextPage':True,'endCursor':'c1'}}},
                                     {'customers':{'nodes':[], 'pageInfo':{'hasNextPage':False}}}])
        with patch('backend.app.main.shopify_graphql',query):
            result=asyncio.run(phone_orders(store='irranova',phone='0612345678',first=20,after=None,user=None))
        self.assertEqual(result['orders'],[])
        self.assertEqual(query.call_args_list[1].args[1]['after'],'c1')

    def test_invalid_phone_never_queries_shopify(self):
        query=AsyncMock()
        with patch('backend.app.main.shopify_graphql',query),self.assertRaises(HTTPException):
            asyncio.run(phone_orders(store='irrakids',phone='123',first=20,after=None,user=None))
        query.assert_not_called()
