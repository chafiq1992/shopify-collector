"""Batch read-only customer confirmation metadata, kept off Shopify writes."""
import logging
import os
import time
import httpx

WORKSPACES = {'irrakids': 'irrakids', 'irranova': 'irranovachat'}
_cache = {}


async def enrich(store, orders):
    workspace = WORKSPACES.get(str(store).lower())
    ids = sorted({o['web_confirmation']['session_id'] for o in orders if o.get('web_confirmation')})
    secret = os.getenv('CHAT_INTAKE_SECRET', '')
    if not workspace or not ids or not secret:
        return orders
    key = (workspace, tuple(ids))
    cached = _cache.get(key)
    if cached and cached[0] > time.monotonic():
        states = cached[1]
    else:
        try:
            states = {}
            async with httpx.AsyncClient(timeout=2, follow_redirects=False) as client:
                for offset in range(0, len(ids), 100):
                    response = await client.post(os.getenv('CHAT_VIEW_BASE_URL', 'https://wtp.chattbase.site').rstrip('/') + '/integrations/order-confirmation-status',
                        headers={'X-Chat-Intake-Key': secret, 'User-Agent': 'Mozilla/5.0 (compatible; ChattbaseCollector/1.0)'},
                        json={'workspace': workspace, 'session_ids': ids[offset:offset+100]})
                    response.raise_for_status()
                    states.update(response.json().get('sessions') or {})
            if len(_cache) >= 1000:
                _cache.clear()
            _cache[key] = (time.monotonic() + 10, states)
        except Exception as error:
            logging.getLogger(__name__).warning('confirmation_status_unavailable error_type=%s', type(error).__name__)
            return orders
    for order in orders:
        attached = order.get('web_confirmation')
        status = states.get(attached['session_id']) if attached else None
        if isinstance(status, dict):
            order['web_confirmation'] = {**attached, **{k: status[k] for k in ['customer_confirmed','customer_decision','decision_at','inbox_url','inbox_channel'] if k in status}}
    return orders
