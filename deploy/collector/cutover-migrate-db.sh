#!/usr/bin/env bash
# -> /opt/collector/cutover-migrate-db.sh   (chmod 750)
#
# Move the collector's Supabase database onto this box's Postgres.
#
#   /opt/collector/cutover-migrate-db.sh                 -> restores into `collector`
#   /opt/collector/cutover-migrate-db.sh collector_trial -> rehearsal, app untouched
#
# The rehearsal form is non-destructive: it only READS Supabase and writes to a
# throwaway database, so it can be run at any time against the live app to get
# real timings before committing to the real thing.
#
# For the REAL run, stop the app first. Anything written to Supabase after the
# dump begins is not carried over:
#
#   cd /opt/collector && docker compose stop web
#   /opt/collector/cutover-check-writes.sh      # twice, ~30s apart
#
# Safe to abort at any point: it refuses to overwrite a target database that
# already holds tables.
set -euo pipefail

cd /opt/postgres

DB="${1:-collector}"
APP_ROLE=collector
PGPW="$(cat /opt/postgres/.superuser_password)"

psu()  { docker compose exec -T -e PGPASSWORD="$PGPW" postgres psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
pgsh() { docker compose exec -T -e PGPASSWORD="$PGPW" -e SRC="$1" postgres sh -c "$2"; }

# Tables compared source-vs-target after the restore. A mismatch fails the run.
VERIFY_TABLES="order_events return_scans inventory_receipts inventory_receipt_photos print_jobs daily_user_stats users app_settings"

SRC="$(grep -m1 '^DATABASE_URL=' /opt/collector/app.env | cut -d= -f2-)"
if [ -z "$SRC" ]; then
  echo "!! DATABASE_URL not found in /opt/collector/app.env" >&2
  exit 1
fi

# The app speaks SQLAlchemy, so its URL carries a driver suffix. pg_dump and
# psql reject `postgresql+asyncpg://` outright.
SRC="${SRC/+asyncpg/}"
# Supabase's pooler on 6543 is TRANSACTION mode, which pg_dump cannot use (it
# needs a session: SET, cursors, a repeatable-read snapshot). Port 5432 on the
# same host is SESSION mode. This app already uses the direct host, but a URL
# swapped to the pooler later must not silently break the dump.
SRC="${SRC/:6543/:5432}"
SRC="${SRC%%\?*}"

DUMP="/backups/cutover_${DB}.dump"

echo "############ collector: database migration -> ${DB} ############"
date -u +'start %Y-%m-%d %H:%M:%SZ'
echo

# Refuse to clobber a database that already has data in it.
existing="$(psu -tAd "$DB" -c 'select count(*) from pg_stat_user_tables' 2>/dev/null || echo 0)"
existing="$(echo "$existing" | tr -d '[:space:]')"
if [ "${existing:-0}" != "0" ]; then
  echo "!! ${DB} already contains ${existing} tables — refusing to overwrite." >&2
  echo "   Drop it deliberately first if this is a re-run:" >&2
  echo "     docker compose -f /opt/postgres/compose.yaml exec postgres \\" >&2
  echo "       psql -U postgres -c 'drop database ${DB};'" >&2
  exit 1
fi

echo "-- dump (Supabase is IPv6-only; pgnet has enable_ipv6, verified) --"
time pgsh "$SRC" "pg_dump \"\$SRC\" --format=custom --compress=6 --schema=public \
  --no-owner --no-privileges --no-comments --file=${DUMP}"
pgsh "$SRC" "ls -lh ${DUMP} | awk '{print \"   dump size: \" \$5}'"

echo "-- restore --"
# The dump carries "CREATE SCHEMA public", which every Postgres 15+ database
# already has, so a plain restore dies on its first statement. Filter that one
# TOC entry rather than dropping --exit-on-error: a genuine failure must still
# stop the restore instead of leaving a half-populated database.
pgsh "$SRC" "pg_restore -l ${DUMP} | grep -v ' SCHEMA - public ' > ${DUMP}.toc"
time docker compose exec -T -e PGPASSWORD="$PGPW" postgres \
  pg_restore -U postgres -d "$DB" --no-owner --no-privileges \
  --jobs=4 --exit-on-error --use-list="${DUMP}.toc" "$DUMP"

# The restore ran as superuser, so every object is owned by `postgres`. GRANTs
# are not enough: this app issues DDL at every startup (create_all plus the
# additive ALTER TABLEs in init_db), and only the OWNER may do that. Without
# this the first boot logs "[DB] Failed to init tables: must be owner of ..."
# — and swallows it, so the app comes up and then fails at runtime.
#
# `reassign owned by postgres to collector` does NOT work: Postgres refuses to
# reassign objects owned by the bootstrap superuser. Walk the catalog instead.
echo "-- transfer ownership to ${APP_ROLE} --"
psu -d "$DB" -qc "
  alter schema public owner to ${APP_ROLE};
  do \$\$
  declare r record;
  begin
    for r in select tablename from pg_tables where schemaname = 'public' loop
      execute format('alter table public.%I owner to ${APP_ROLE}', r.tablename);
    end loop;
    for r in select sequencename from pg_sequences where schemaname = 'public' loop
      execute format('alter sequence public.%I owner to ${APP_ROLE}', r.sequencename);
    end loop;
    for r in select viewname from pg_views where schemaname = 'public' loop
      execute format('alter view public.%I owner to ${APP_ROLE}', r.viewname);
    end loop;
  end \$\$;
"
notowned="$(psu -tAd "$DB" -c "select count(*) from pg_tables where schemaname='public' and tableowner <> '${APP_ROLE}'" | tr -d '[:space:]')"
if [ "${notowned:-1}" != "0" ]; then
  echo "!! ${notowned} table(s) in ${DB} are still not owned by '${APP_ROLE}'." >&2
  echo "   The app runs DDL at startup and would fail silently. Fix before switching." >&2
  exit 1
fi
echo "   all objects owned by '${APP_ROLE}'"

echo "-- verify row counts against source --"
mismatch=0
for t in $VERIFY_TABLES; do
  s="$(pgsh "$SRC" "psql \"\$SRC\" -tAc 'select count(*) from public.${t}'" 2>/dev/null | tr -d '[:space:]')"
  d="$(psu -tAd "$DB" -c "select count(*) from public.${t}" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$s" ] && [ -z "$d" ]; then
    printf '   %-28s absent both sides\n' "$t"
    continue
  fi
  if [ "$s" = "$d" ]; then
    printf '   %-28s %12s  OK\n' "$t" "$s"
  else
    printf '   %-28s src=%s dst=%s  *** MISMATCH ***\n' "$t" "$s" "$d"
    mismatch=1
  fi
done

if [ "$mismatch" != "0" ]; then
  echo "!! row counts differ." >&2
  echo "   On a REAL run with the app stopped this is a genuine failure — do NOT" >&2
  echo "   switch over. On a rehearsal with the app still live it just means the" >&2
  echo "   source moved under the dump, which is expected." >&2
  exit 1
fi

psu -d "$DB" -c "select pg_size_pretty(pg_database_size('${DB}')) as restored_size;"
echo "   ANALYZE (so the planner has stats before first real traffic)"
psu -d "$DB" -qc "analyze;"

date -u +'done  %Y-%m-%d %H:%M:%SZ'
echo
if [ "$DB" = "collector" ]; then
  echo "Migrated and verified. Next: /opt/collector/cutover-switch-env.sh"
else
  echo "Rehearsal into ${DB} complete. Drop it when you are done with it:"
  echo "  docker compose -f /opt/postgres/compose.yaml exec postgres \\"
  echo "    psql -U postgres -c 'drop database ${DB};'"
fi
