#!/usr/bin/env bash
# -> /opt/collector/cutover-switch-env.sh   (chmod 750)
#
# Point the app at the local Postgres instead of Supabase.
#
# THIS IS THE POINT OF NO RETURN. Once the app writes to the local database
# there is no merge path back to Supabase: rolling back loses everything
# written since. Run cutover-migrate-db.sh first and read its verification.
#
# Keeps a timestamped copy of app.env so the previous DSN is recoverable.
set -euo pipefail

cd /opt/collector

if [ ! -f /opt/collector/.dbpassword ]; then
  echo "!! /opt/collector/.dbpassword is missing — the collector role has no known password" >&2
  exit 1
fi
APPPW="$(cat /opt/collector/.dbpassword)"

CURRENT="$(grep -m1 '^DATABASE_URL=' app.env | cut -d= -f2-)"
case "$CURRENT" in
  *@postgres:*)
    echo "Already pointed at the local Postgres. Nothing to do."
    exit 0
    ;;
esac

BACKUP="app.env.pre-dbswitch.$(date -u +%Y%m%dT%H%M%SZ)"
cp app.env "$BACKUP"
echo "→ previous app.env kept as ${BACKUP}"

# asyncpg is what the app's SQLAlchemy engine expects; the driver suffix stays.
NEW="postgresql+asyncpg://collector:${APPPW}@postgres:5432/collector"
python3 - "$NEW" <<'PY'
import io, sys
new = sys.argv[1]
lines = io.open("/opt/collector/app.env", encoding="utf-8").read().split("\n")
out, seen = [], False
for l in lines:
    if l.startswith("DATABASE_URL="):
        out.append("DATABASE_URL=" + new); seen = True
    else:
        out.append(l)
if not seen:
    out.append("DATABASE_URL=" + new)
io.open("/opt/collector/app.env", "w", encoding="utf-8", newline="\n").write("\n".join(out))
PY
chmod 600 app.env

# Pool sizing changes meaning once the database is 200 metres away instead of
# in another country. Against Supabase the round trip was ~9 ms and the pool
# existed to hide it, under a 60-connection account ceiling. Locally the round
# trip is ~0.05 ms, so fewer connections do strictly more work, and the
# instance allows max_connections=200 shared across all three apps.
sed -i 's|^DB_POOL_SIZE=.*|DB_POOL_SIZE=5|'        app.env
sed -i 's|^DB_MAX_OVERFLOW=.*|DB_MAX_OVERFLOW=5|'  app.env
# pool_recycle guarded against Supabase's proxy dropping idle connections.
# There is no proxy in front of the local instance, so recycling every 5
# minutes is pure churn; 30 minutes still protects against anything stale.
sed -i 's|^DB_POOL_RECYCLE_SECONDS=.*|DB_POOL_RECYCLE_SECONDS=1800|' app.env

echo "→ app.env now reads:"
grep -E '^(DATABASE_URL|DB_POOL_SIZE|DB_MAX_OVERFLOW|DB_POOL_TIMEOUT|DB_POOL_RECYCLE_SECONDS)=' app.env \
  | sed -E 's#://[^@]*@#://<cred>@#'

echo
echo "Now release, which re-runs the schema step fail-closed against the new"
echo "database before it replaces the running container:"
echo "    /opt/collector/deploy.sh db-local"
echo
echo "Then check:  curl -s https://shopify-collector.chattbase.site/api/health"
echo "Keep the Supabase project running and untouched for at least a week. It"
echo "is a complete, consistent snapshot of the cutover moment."
