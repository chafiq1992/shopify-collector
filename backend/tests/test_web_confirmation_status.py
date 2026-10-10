import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from backend.app.web_confirmation_status import enrich, _cache

SID = 'a' * 32


class WebConfirmationStatusTests(unittest.TestCase):
    def setUp(self):
        _cache.clear()

    def test_batches_unique_sessions_and_caches_without_crossing_stores(self):
        states = {'sessions': {SID: {'customer_confirmed': True, 'inbox_url': 'https://wtp.chattbase.site/#workspace=irrakids&chat=web_' + SID}}}
        response = httpx.Response(200, json=states, request=httpx.Request('POST', 'https://wtp.chattbase.site'))
        post = AsyncMock(return_value=response)
        orders = [{'web_confirmation': {'session_id': SID}}, {'web_confirmation': {'session_id': SID}}, {'web_confirmation': None}]
        with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'test-secret'}), patch('httpx.AsyncClient.post', post):
            result = asyncio.run(enrich('irrakids', orders))
            asyncio.run(enrich('irrakids', orders))
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.kwargs['json'], {'workspace': 'irrakids', 'session_ids': [SID]})
            self.assertTrue(result[0]['web_confirmation']['customer_confirmed'])
            self.assertIsNone(result[2]['web_confirmation'])
            asyncio.run(enrich('irranova', orders))
            self.assertEqual(post.call_args.kwargs['json']['workspace'], 'irranovachat')

    def test_metadata_outage_never_blocks_order_queue_or_claims_confirmation(self):
        orders = [{'web_confirmation': {'session_id': SID}}]
        with patch.dict(os.environ, {'CHAT_INTAKE_SECRET': 'test-secret'}), patch('httpx.AsyncClient.post', AsyncMock(side_effect=httpx.ConnectError('unavailable'))):
            self.assertIs(asyncio.run(enrich('irrakids', orders)), orders)
        self.assertNotIn('customer_confirmed', orders[0]['web_confirmation'])
