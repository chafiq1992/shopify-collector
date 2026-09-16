#!/usr/bin/env bash
# -> /opt/collector/cutover-check-writes.sh   (chmod 750)
#
# Is anything still writing to Supabase?
#
# Run it twice, about 30 seconds apart, with the app stopped. Identical numbers
# both times mean the dump will be a complete, consistent copy. A number that
# moves means something is still writing — usually the app was not actually
# stopped, or a Shopify webhook is still arriving somewhere.
#
#   cd /opt/collector && docker compose stop web
#   /opt/collector/cutover-check-writes.sh
#   sleep 30
#   /opt/collector/cutover-check-writes.sh
set -euo pipefail

cd /opt/postgres
PGPW="$(cat /opt/postgres/.superuser_password)"

SRC="$(grep -m1 '^DATABASE_URL=' /opt/collector/app.env | cut -d= -f2-)"
SRC="${SRC/+asyncpg/}"
SRC="${SRC/:6543/:5432}"
SRC="${SRC%%\?*}"

echo "############ collector: writes to Supabase — $(date -u +%H:%M:%SZ) ############"

docker compose exec -T -e PGPASSWORD="$PGPW" -e SRC="$SRC" postgres sh -c 'psql "$SRC" -P pager=off -c "
  SELECT
    (SELECT count(*) FROM order_events)              AS order_events,
    (SELECT max(id)  FROM order_events)              AS max_order_event_id,
    (SELECT count(*) FROM return_scans)              AS return_scans,
    (SELECT count(*) FROM inventory_receipts)        AS inventory_receipts,
    (SELECT count(*) FROM print_jobs)                AS print_jobs;
"'

echo "-- connections currently open to the source --"
docker compose exec -T -e PGPASSWORD="$PGPW" -e SRC="$SRC" postgres sh -c 'psql "$SRC" -P pager=off -tAc "
  SELECT count(*) || \" total, \" || count(*) FILTER (WHERE state = \x27active\x27) || \" active\"
  FROM pg_stat_activity WHERE datname = current_database();
"'

echo
echo "Run again in ~30s. Identical counts = safe to dump."
