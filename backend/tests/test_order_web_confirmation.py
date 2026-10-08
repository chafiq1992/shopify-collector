"""COD form orders confirmed in the store's chat: the order card gets the chat, other orders nothing."""
import asyncio
import hashlib
import hmac
import os
import re
import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from backend.app.chat_request_routes import order_confirmation_chat
from backend.app.confirmation_routes import _flatten_order

SID = 'b' * 32


def order(attributes):
    return {'id': 'gid://shopify/Order/1', 'name': '#1001', 'tags': ['easysell_cod_form'], 'customAttributes': attributes,
            'lineItems': {'edges': []}, 'currentTotalPriceSet': {'shopMoney': {'amount': '199.00', 'currencyCode': 'MAD'}}}


class OrderWebConfirmationTests(unittest.TestCase):
    def test_orders_carry_their_confirmation_chat_only_when_it_is_a_real_chat_id(self):
        self.assertEqual(_flatten_order(order([{'key': 'Inbox workspace', 'value': 'irrakids'}, {'key': 'Chattbase confirmation', 'value': SID}]))['web_confirmation'],
                         {'session_id': SID})
        self.assertIsNone(_flatten_order(order([{'key': 'Inbox workspace', 'value': 'irrakids'}]))['web_confirmation'])
        self.assertIsNone(_flatten_order(order([{'key': 'Chattbase confirmation', 'value': '../x'}]))['web_confirmation'])
        self.assertIsNone(_flatten_order(order(None))['web_confirmation'])

    def test_the_chat_link_is_signed_short_lived_and_needs_a_valid_id(self):
        with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'shared-test-key', 'CHAT_VIEW_BASE_URL': 'https://chat.example'}):
            result = asyncio.run(order_confirmation_chat(session_id=SID, user=None))
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(order_confirmation_chat(session_id='not-a-chat', user=None))
        self.assertEqual(caught.exception.status_code, 404)
        match = re.fullmatch(r'https://chat\.example/storefront/chat-view/' + SID + r'\?token=(\d+)\.([a-f0-9]{64})', result['url'])
        self.assertIsNotNone(match)
        expires = int(match[1])
        self.assertTrue(time.time() < expires <= time.time() + 12 * 3600 + 5)
        self.assertEqual(match[2], hmac.new(b'shared-test-key', f'chat-view:{SID}:{expires}'.encode(), hashlib.sha256).hexdigest())


if __name__ == '__main__':
    unittest.main()
