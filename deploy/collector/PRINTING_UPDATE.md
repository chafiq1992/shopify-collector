# Label printing update — 13 October 2026

The collector frontend, backend print relay, and `autoprint 2026` agent must be updated together. Pushing this update to GitHub `main` starts the existing **Deploy to Netcup** workflow. Wait for that workflow to succeed before starting the updated warehouse agent. The printer laptop still needs the manual update below.

## What changed

- Print submits the selected orders immediately. The collector no longer waits for a tag request for every order and a webhook delay.
- One browser submission retains the same request ID on an uncertain retry. Repeated order numbers are removed, and a synchronous click lock prevents concurrent submissions.
- A relay failure does not silently trigger another print through the local agent. Older-route fallback is restricted to missing routes.
- Queue claims use conditional database updates. Only one consumer receives a job, and claim generations prevent an expired agent from renewing or changing a newer claim.
- The agent renews long-running leases. Completed queue receipts and durable local spool receipts suppress redelivery after a lost acknowledgement or restart.
- Submitted batch parts are skipped on retry. An interrupted or partially accepted spool submission is held for manual review, rather than automatically printing another copy.
- Sumatra receives an explicit copy count, including `1x` for one copy, in one process invocation.
- Each label has its own page wrapper. Orders in a batch are rendered into a combined PDF, with the template's dimensions applied to each label.
- The default artificial post-print delay is zero. Existing configured delays remain in effect until explicitly changed.

## Rollout

1. Release the updated backend and frontend through the existing deployment workflow. The new agent requires the backend's `/renew` endpoint. The existing `print_jobs` columns support these changes without a new schema migration.
2. Stop the current print programs on the warehouse PC. Download `autoprint2026-2026.10.13-print-fix.zip` from the repository's `autoprint 2026` folder and extract it to a temporary folder. Copy its updated `app` folder into the laptop's existing `autoprint 2026` installation, replacing the old application files. Keep the laptop's real `config.yaml`, custom `templates`, `logos`, printer `tools`, `.venv`, and `state` folder. The archive contains an example configuration only; do not use it to replace the real configuration.
3. Keep the existing printer, store credentials, relay URLs, PC ID, and PC secret. Edit the existing `config.yaml` so `post_print_delay_seconds: 0` and `max_orders_per_batch: 0` (add the keys if absent). The latter keeps all selected orders in one combined PDF. Retain a larger delay only if that printer driver needs it.
4. Start one updated agent in that installation. Its version is `2026.10.13-print-receipts`. Do not also leave the old `agent/poller.py`, `print-agent/poller.py`, or another old installation consuming the same PC's queue. Legacy agents do not have the new durable receipts and lease-generation protection.
5. Check one label's size, images, barcode/QR code, and copy count. Then print 30 distinct orders with one copy and confirm exactly 30 physical labels. Measure time from Confirm to first label and to final label on the actual printer.

Start the updated agent using the laptop's existing `start_agent.bat` or `run_agent.bat` shortcut. Its startup output should show `2026.10.13-print-receipts`. If the collector was already open, reload it after deployment so it uses the updated print button.

## Interrupted submissions

The agent stores its local journal at `autoprint 2026/state/print-jobs.sqlite3`. Preserve this file across updates. Successful spool submission means Windows accepted the print request; it does not prove that paper physically exited the printer.

If the agent reports an uncertain submission, check the Windows queue and physical output before explicitly reprinting missing labels. A fresh, deliberate print request is separate from retrying the same request. The relay also suppresses identical batches for a short 30-second window, and while the original batch is still pending or printing.

Completed, failed, and request-alias rows are retained as idempotency receipts. Do not delete recent print receipts during routine queue cleanup. Retention policy can be added separately once the required retry/history period is defined.

## Verification boundaries

Regression checks cover concurrent queue claims, repeated submissions, response loss, expired claims, acknowledgements, partial batch retries, explicit copy counts, and the frontend error paths. Backend concurrency was exercised with isolated SQLite databases; live PostgreSQL and physical printer throughput remain rollout checks.

Verification completed: 85 backend/route-auth checks, 53 frontend checks, and 15 agent checks passed; the frontend production build passed. Edge rendered 30 synthetic labels for each bundled template: exactly 30 pages, every order number once, zero blank pages, with images and QR codes present. Each combined PDF rendered in approximately 1.6 seconds in this local fixture test. That timing excludes Shopify fetching and physical printing. The previous layout also produced 30 pages for this fixture, so template layout was not reproduced as the cause of doubled orders.
