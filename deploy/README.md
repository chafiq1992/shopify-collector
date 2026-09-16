# Netcup deployment

Files for running shopify-collector on the Netcup box (`159.195.204.91`)
alongside the delivery app in `/opt/apex/` and whatsapp-last in
`/opt/whatsapp/`.

```
deploy/
├── pull-env.sh                 live Cloud Run env + 4 secrets -> /opt/collector/app.env
├── push-source.sh              source -> /opt/collector/src (the box builds it)
├── collector/                  -> /opt/collector/
│   ├── compose.yaml
│   ├── compose.env.example     -> /opt/collector/.env      (Compose substitution)
│   ├── app.env.example         -> /opt/collector/app.env   (runtime environment)
│   └── deploy.sh               -> /opt/collector/deploy.sh
└── edge/
    └── sites/collector.caddy   -> /opt/edge/sites/  (only once DNS points here)
```

Nothing outside `/opt/collector/` is touched except that one Caddy site file.

## Validated on 2026-09-16

Live for validation at **https://shopify-collector.chattbase.site** while
Cloud Run keeps serving everything real.

| check | result |
|---|---|
| `/api/health` over HTTPS | `{"ok":true,"db":{"configured":true,"ok":true},"worker_loops":false}` |
| Let's Encrypt certificate | obtained first try, `tls-alpn-01` |
| `/pull` with valid PC credentials | `503 print relay disabled on this deployment` |
| `/assets/*` | `public, max-age=31536000, immutable` |
| `/index.html` | `no-cache`, HSTS + nosniff + SAMEORIGIN, `Server` stripped |
| `Africa/Casablanca` inside the image | resolves (the inventory helper needs it) |
| limits applied | 768 MiB, 2.0 CPU, 512 pids, **no published ports** |
| other two apps | `apex-maroc.com`, `v2.apex-maroc.com`, `wtp.chattbase.site` all 200 |

One process note: create the DNS record first, then verify it against the
**authoritative** nameserver (`nslookup -type=A <host> dns1.registrar-servers.com`),
not a recursive resolver. A recursive lookup made before the record has
published caches the NXDOMAIN — this zone's SOA negative TTL is 3601 s.

## One service, and why that is enough here

The other two apps on this box are split into `web` and `worker` because their
schedulers must have exactly one owner. **This app has no schedulers and no
cron.** Every `while True` in it is either Shopify GraphQL pagination inside a
request handler or the `/pull` long-poll with a 25 s deadline, and the only
`@app.on_event("startup")` handlers are `create_all`, a route dump, and a
default-admin check that no-ops once an admin exists.

So there is one `web` service, and `WORKER_LOOPS` gates exactly one thing.

## `WORKER_LOOPS` gates the print queue

`/pull` is the one piece of queue-consuming work. It claims jobs with a
`SELECT` of rows in `pending` followed by a separate mutation to `inflight` —
no `FOR UPDATE SKIP LOCKED`, no atomic claim. Two deployments polling the same
database can hand the same job to two printers, which prints the order twice.

| | `WORKER_LOOPS=0` | `WORKER_LOOPS=1` |
|---|---|---|
| Netcup | serves HTTP; `/pull` answers **503** | owns the print queue |
| Cloud Run | owns the print queue | must be stopped first |

It defaults to **on** in code, so the Cloud Run service — which does not set
it — is completely unaffected. Keep it at `0` for the whole validation window.

`/pull` refuses loudly rather than returning an empty job list, so a print
agent accidentally pointed at the box is obvious instead of silently idle.

Check who owns it:

```bash
curl -s https://<host>/api/health | jq '{worker_loops, db}'
```

## The web service runs exactly one uvicorn worker, permanently

Not a tuning choice. Two in-process structures make a second worker incorrect:

- **`/ws` broadcasts** go through an in-process `ConnectionManager`. There is
  no Redis pub/sub behind it, so a second worker's clients would never see an
  update raised on the first.
- **`_DEDUP_CACHE` and `RECENT_ENQUEUED_ORDERS`** are plain dicts, so the 10 s
  duplicate-print guard only holds inside one process.

This is the same trap that bit the delivery app's migration, and unlike
whatsapp-last it does apply here — there is no pub/sub to fan events out.
`compose.yaml` states `--workers 1` explicitly rather than inheriting it from
the image's `CMD`, so the constraint is greppable.

## It uses no Redis at all

Nothing in `requirements.txt`, no client anywhere in `backend/`. So it joins
`edge` and its own `internal` network and nothing else: **no `redisnet`, and no
new line in `/opt/redis/users.acl`.** That step of the migration brief does not
apply to this app.

## Supabase is IPv6-only, and that is load-bearing

`DATABASE_URL` is the **direct** host, `db.qkomhpjcxgnoyhjdvlgb.supabase.co`
(a different project from the other two apps). It has an `AAAA` record and no
`A` record. Measured on this box, all three cases:

| network | result |
|---|---|
| Docker's default bridge | connects (the daemon sets `"ipv6": true`) |
| a plain user-defined bridge — **what Compose creates** | `OSError: [Errno 101] Network is unreachable` |
| `enable_ipv6: true` | connects |

So `enable_ipv6: true` on the `internal` network is mandatory, and its absence
would look like an application bug while `psql` from the shell worked fine.
`backend/migrate.py` probes connectivity before touching the schema, so this
surfaces as "cannot reach the database" rather than a half-applied migration.

## Releasing

CI publishes only to Google Artifact Registry, and pulling from it would mean
putting long-lived GCP credentials on the box, so the box builds the image
itself from pushed source:

```bash
./deploy/push-source.sh deploy@159.195.204.91          # working tree
ssh deploy@159.195.204.91 '/opt/collector/deploy.sh <tag>'
```

`deploy.sh` builds, gates on `python -m backend.migrate`, then restarts with
`--wait`.

That migration step exists because this app has **no Alembic**: its schema is
`create_all` plus a list of additive `ALTER TABLE ... IF NOT EXISTS`, applied
by a startup handler that **catches every exception and merely prints it**. On
Cloud Run a revision that fails to boot never receives traffic; here, `up -d`
has already replaced the running container, and because the failure is
swallowed the new one reports itself healthy and serves 500s.
`backend/migrate.py` does the identical work in a throwaway container and exits
non-zero, leaving the running container untouched.

The healthcheck reads `db.ok` from `/api/health`'s **body**. The endpoint
answers `200` whenever the process is up, so a status-code check would gate on
nothing.

`push-source.sh` sends only what the Dockerfile copies. That matters more here
than in the other repos: `frontend/node_modules` is **committed** (8479 files),
so `.gitignore` cannot filter it, and the untracked-but-unignored material
(`.claude/worktrees` at 382 MB, two `.rar` archives, `print-agent/`) would ride
along too. Unfiltered, a deploy pushes ~440 MB instead of 1.8 MB.

## Running in parallel with Cloud Run

Both deployments may serve HTTP against the same Supabase database. Three
things must stay pointed at Cloud Run until cutover:

- **`BASE_URL`** — `shopify_oauth_routes.py` builds the Shopify OAuth redirect
  as `f"{BASE_URL}/api/shopify/oauth/callback"`, and that exact string is
  whitelisted per Shopify app. Changing it without adding the new callback URL
  in every Partner dashboard breaks store installs.
- **`VITE_PRINT_RELAY_URL`** — compiled into the bundle. The print agents on
  the shop PCs are configured against the Cloud Run URL; repointing the bundle
  while Cloud Run still owns the queue means two deployments serving `/pull`.
- **`DELVERY_BACKEND_URL`** — still the delivery app's `run.app` URL. Both
  apps are now on this box and could talk over the Docker network as
  `http://apex-web:8080`, but only once this deployment is the live one.

`ALLOWED_ORIGINS` is the exception: the test hostname is **appended**, never
substituted, so the Cloud Run UI keeps working throughout.

## Things worth fixing (found during this migration, not caused by it)

- **`/pull` has no atomic claim.** Cloud Run runs at `maxScale=5`, so two
  instances can already lease the same print job today. `WORKER_LOOPS`
  contains the problem across deployments; it does not fix the underlying
  race. `UPDATE ... WHERE status='pending' ... RETURNING`, or
  `FOR UPDATE SKIP LOCKED` on the select, would.
- **`/ws` and the print dedup cache are per-process**, and Cloud Run scales to
  5 instances. Order updates already reach only the agents whose socket landed
  on the same instance, and the 10 s duplicate-print guard is per-instance.
- **Runtime DDL on every boot, failures swallowed.** `init_db()` issues the
  full `create_all` plus ~10 `ALTER TABLE`s against production at every start
  of every instance, inside a `try/except` that prints and continues.
- **Secrets are mostly plaintext env vars.** 35 of 39 variables on the Cloud
  Run service — including `JWT_SECRET`, the Supabase password,
  `ADMIN_DEFAULT_PASSWORD`, `DELVERY_ADMIN_TOKEN` and four Shopify client
  secrets — are stored as plain `--set-env-vars` rather than Secret Manager
  references. Anyone with `run.services.get` can read all of them.
- **`frontend/node_modules` is committed** — 8479 files.
- **Duplicate env vars on the service**, including one named literally
  `"VITE_PRINT_RELAY_PC_ID "` with a trailing space, which nothing can read.
- **`ordercollector`** in `europe-west1` is a dead `gcr.io/cloudrun/placeholder`
  service from 2025-09 carrying a stale Shopify token in its env. Not this app.
