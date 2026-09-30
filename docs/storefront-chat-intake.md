# Storefront chat intake

`POST /api/integrations/chat-requests` accepts server-to-server callback leads with `X-Chat-Intake-Key` matching `CHAT_INTAKE_SECRET`. It rejects requests when the key is missing/unconfigured. Configure the same key in the Inbox server; never put it in a theme or browser bundle.

Payload: `store`, `phone`, optional `name`, full `message` transcript (up to 2 million characters; larger requests are rejected, never silently truncated), product_title/url/image, variant_title, page_url, optional order_ref and required stable source_id. The Inbox sends `storefront:<session_id>:<revision>[:draft]`. Trusted traffic bypasses the public per-IP limit. A transaction lock serializes same-store/phone intake on PostgreSQL; open leads merge and exact source-ID retries return the original lead even after closure.

`POST /api/integrations/chat-requests/complete` accepts `store`, `phone`, a 32-character hexadecimal session_id and completed order_ref under the same authentication. It marks an open callback ordered only when its audit history contains that storefront session. Repeated calls are safe; unrelated leads stay open.

The existing public form endpoint keeps its honeypot, 2,000-character message limit and rate limit. Existing agent queues, attempts, badges, outcomes and access controls are unchanged. Full integration transcripts use the existing Text column and appear in the Chat confirmation tab without a schema migration.
