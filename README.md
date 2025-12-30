# Order Collector (Shopify + FastAPI + React + WebSockets)

A clean, swipe-first app for warehouse/employee order collection:
- Filter orders, see total count
- Carousel-like cards with big variant images, SKU & Qty
- `Collected` → adds **pc** tag to the order
- `OUT` → requires selecting missing variants and appends `OUT: <SKUs>` to the order note
- Live updates via WebSockets
- Single Dockerfile (multi-stage) → deploy to Cloud Run

## 1) Shopify prerequisites

This repo supports **mixed-mode Shopify auth** for two stores:

- **irrakids**: keeps the “old method” — static Admin API token from env (sent as `X-Shopify-Access-Token`).
- **irranova**: uses **public app OAuth** (Shopify Dev Dashboard Client ID + Secret) to mint and persist a per-store Admin API token in the DB.

### Old method (env token)

Create a **custom app** in Shopify admin (or use your existing token) with Admin API scopes like:
- `read_orders`, `write_orders` (plus any other features you use)

Copy the **Admin API access token** and set env vars below.

### New method (public app OAuth) — Irranova only

In the Shopify Dev Dashboard:

- Create a **public app**
- Add the exact redirect URL to the allowlist:
  - `{BASE_URL}/api/shopify/oauth/callback` (must match exactly, not just the domain)
- Set env vars below (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_OAUTH_SCOPES`, `BASE_URL`)

Then in the app UI, open `/shopify-connect` and run the install flow for `irranova`.

Important lessons:

- Do **not** paste or refresh the callback URL manually — OAuth codes are **one-time-use**. Always go through “Connect” → approve in Shopify.
- If you hit a production HMAC mismatch, you can temporarily set `SHOPIFY_OAUTH_SKIP_HMAC=1` to unblock install (still verifies signed `state`). Remove it after successful install.

## 2) Environment variables

- `IRRAKIDS_STORE_DOMAIN` — e.g., `yourstore.myshopify.com`
- `SHOPIFY_PASSWORD` — Admin API access token or Private App password
- `SHOPIFY_API_KEY` — optional; if set with `SHOPIFY_PASSWORD`, basic auth is used
- `SHOPIFY_API_VERSION` — default `2025-01`

Auth + collector analytics (recommended for production):

- `DATABASE_URL` — SQLAlchemy URL. **For production on Cloud Run, use a persistent DB (e.g. Cloud SQL Postgres).**
- `JWT_SECRET` — secret used to sign login tokens.

Important:

- Cloud Run containers can restart and scale to multiple instances. If you keep `DATABASE_URL` as SQLite (`sqlite+aiosqlite:///./local.db`), collector analytics can be **missing/incomplete** because data is not durable and can differ per instance.

Multi-store (optional):

- `IRRAKIDS_SHOPIFY_PASSWORD`, `IRRAKIDS_SHOPIFY_API_KEY` — overrides for Irrakids, if different
- `IRRANOVA_STORE_DOMAIN` — e.g., `your-second-store.myshopify.com`
- `IRRANOVA_SHOPIFY_PASSWORD`, `IRRANOVA_SHOPIFY_API_KEY` — credentials for Irranova

If per-store passwords are not set, the app will fall back to `SHOPIFY_PASSWORD`/`SHOPIFY_API_KEY`.

### Shopify OAuth (public app) env vars (Irranova)

- `BASE_URL` — public Cloud Run URL used to build redirect URI exactly: `{BASE_URL}/api/shopify/oauth/callback`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET` (starts with `shpss_...`)
- `SHOPIFY_OAUTH_SCOPES` — comma-separated
- `SHOPIFY_OAUTH_STORES` — comma-separated store labels allowed to use OAuth (default behavior enables **only** `irranova`)
- Optional: `SHOPIFY_OAUTH_SKIP_HMAC=1` (emergency unblock only)

### Mixed-mode resolver behavior

When resolving Shopify credentials for a store:

- Prefer env `SHOPIFY_SHOP_DOMAIN_<STORE>` + `SHOPIFY_ACCESS_TOKEN_<STORE>` (for all stores).
- If the store is OAuth-enabled (default `irranova`) **and** env credentials are missing, fall back to the DB record stored by the OAuth install.

Reference: [Shopify OAuth getting started](https://shopify.dev/apps/auth/oauth/getting-started) and [Shopify API authentication (HMAC verification)](https://shopify.dev/docs/api/usage/authentication).

## 3) Local development

```bash
# Frontend dev (hot reload)
cd frontend
npm install
npm run dev

# Backend dev (another terminal)
cd ..
pip install -r requirements.txt
# On Windows PowerShell:
# setx IRRAKIDS_STORE_DOMAIN "yourstore.myshopify.com"
# setx SHOPIFY_PASSWORD "shpat_or_private_app_password"
# setx SHOPIFY_API_KEY ""
# setx SHOPIFY_API_VERSION "2025-01"
# Optionally set Irranova envs as well:
# setx IRRANOVA_STORE_DOMAIN "your-second-store.myshopify.com"
# setx IRRANOVA_SHOPIFY_PASSWORD "shpat_or_private_app_password_for_irranova"
# setx IRRANOVA_SHOPIFY_API_KEY ""
# Then restart terminal to load env vars
uvicorn backend.app.main:app --reload
# Open http://localhost:8000 once you build production bundle below

# To preview production-like setup:
cd frontend && npm run build && cd ..
uvicorn backend.app.main:app --reload
```

## 4) Docker build & run (single image)

```bash
docker build -t order-collector:local .
docker run -p 8080:8080 \
  -e IRRAKIDS_STORE_DOMAIN=yourstore.myshopify.com \
  -e SHOPIFY_PASSWORD=shpat_or_private_app_password \
  -e SHOPIFY_API_KEY= \
  -e SHOPIFY_API_VERSION=2025-01 \
  -e IRRANOVA_STORE_DOMAIN=your-second-store.myshopify.com \
  -e IRRANOVA_SHOPIFY_PASSWORD= \
  -e IRRANOVA_SHOPIFY_API_KEY= \
  order-collector:local
# Open http://localhost:8080
```

## 5) Deploy to Cloud Run (manual)

```bash
gcloud builds submit --tag gcr.io/$(gcloud config get-value project)/order-collector:latest

gcloud run deploy order-collector \
  --image gcr.io/$(gcloud config get-value project)/order-collector:latest \
  --platform managed \
  --region europe-west1 \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars IRRAKIDS_STORE_DOMAIN=yourstore.myshopify.com,SHOPIFY_PASSWORD=shpat_or_private_app_password,SHOPIFY_API_KEY=,SHOPIFY_API_VERSION=2025-01
```

> Cloud Run supports **WebSockets** out of the box. For multi-instance fan-out, back WebSocket events with Pub/Sub or Redis instead of in-memory list.

### Collector analytics reliability (Cloud Run)

For accurate per-collector `Collected`/`OUT` analytics:

- Set `DATABASE_URL` to a persistent database (Cloud SQL Postgres strongly recommended).
- The backend prevents **double counting** by treating repeated `Collected`/`OUT` actions for the same order as idempotent.
- Admin “OUT orders details” are available via `GET /api/admin/out-events` and are shown in `/admin`.

## 6) GitHub → Cloud Run (CI/CD example)

If your environment allows dot-directories, place this file at `.github/workflows/deploy.yml`. If not, use `workflows/deploy.yml` and move it later.

- `GCP_WORKLOAD_ID_PROVIDER` — resource name of your provider
- `GCP_RUN_SA_EMAIL` — deploy service account email
- `GCP_ARTIFACT_REPO` — Artifact Registry repo, like `europe-west1-docker.pkg.dev/<project>/<repo>`
- `IRRAKIDS_STORE_DOMAIN`, `SHOPIFY_PASSWORD`, `SHOPIFY_API_KEY` — your secrets

```yaml
name: Deploy to Cloud Run
on:
  push:
    branches: [ "main" ]

jobs:
  build-and-deploy:
    permissions:
      contents: 'read'
      id-token: 'write'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: auth
        uses: 'google-github-actions/auth@v2'
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_ID_PROVIDER }}
          service_account: ${{ secrets.GCP_RUN_SA_EMAIL }}
      - name: Set up gcloud
        uses: google-github-actions/setup-gcloud@v2
      - name: Build & Push
        run: |
          gcloud builds submit --tag ${{ secrets.GCP_ARTIFACT_REPO }}/order-collector:${{ github.sha }}
      - name: Deploy
        run: |
          gcloud run deploy order-collector \
            --image ${{ secrets.GCP_ARTIFACT_REPO }}/order-collector:${{ github.sha }} \
            --region europe-west1 \
            --platform managed \
            --port 8080 \
            --allow-unauthenticated \
            --set-env-vars IRRAKIDS_STORE_DOMAIN=${{ secrets.IRRAKIDS_STORE_DOMAIN }},SHOPIFY_PASSWORD=${{ secrets.SHOPIFY_PASSWORD }},SHOPIFY_API_KEY=${{ secrets.SHOPIFY_API_KEY }},SHOPIFY_API_VERSION=2025-01
```

## 7) Notes on scaling & speed

- **WebSockets:** For multiple Cloud Run instances, consider pushing update events (tag added / note updated) through Pub/Sub or Redis so all clients get them regardless of instance.
- **Performance:** The `/api/orders` GraphQL call fetches line items with variant images in one round-trip. Add pagination via `cursor` if your lists are big.
- **Security:** Keep Admin token server-side only. Frontend calls your API.
- **Styling:** Buttons and chips are large and high-contrast; tweak Tailwind classes to your brand (e.g., `#004AAD`).

## 8) Auto-tag orders by delivery zone (Order Tagger)

This service can automatically tag newly created Shopify orders based on their geocoded location and polygon zones you control.

- Webhook: `POST /api/shopify/webhooks/orders/create`
- HMAC: validated using the same per-store secrets as `orders/update`:
  - `SHOPIFY_WEBHOOK_SECRET` (default)
  - `IRRAKIDS_SHOPIFY_WEBHOOK_SECRET` (for `*.irrakids.*` shop domains)
  - `IRRANOVA_SHOPIFY_WEBHOOK_SECRET` (for `*.irranova.*` shop domains)

Environment variables:

- `AUTO_TAGGING_ENABLED` — set to `1` to actually write tags; when unset/0, the service logs what it would tag but does not modify orders.
- `GOOGLE_MAPS_API_KEY` — required for geocoding. Requests are sent with `region=ma` (Morocco).

Endpoints:

- `GET /api/order-tagger/status` — returns the feature flag and loaded zones summary.
- Frontend page: open `/order-tagger` in the app to view status and basic instructions.

Zones data:

- File: `backend/app/zones.geojson`
- Format: GeoJSON FeatureCollection with Features having `properties.tag` and `geometry` of type `Polygon` or `MultiPolygon` (coordinates are `[lng, lat]`).

How to add a new zone:

1. Edit `backend/app/zones.geojson`. Add a new Feature with `properties: { "name": "...", "tag": "..." }` and a valid `geometry` polygon/multipolygon. The first ring is treated as the outer boundary; subsequent rings are holes.
2. Deploy/restart the backend. No code changes are required.
3. Ensure `AUTO_TAGGING_ENABLED=1` in your environment to apply tags.

Behavior:

- On `orders/create`, the backend builds an address string from `address1, address2, city, province, zip, "Morocco"`. On geocode failure, it retries with `city + "Morocco"`.
- If geocoding succeeds, the lat/lng is tested against loaded polygons. On first match, the order is tagged with that zone’s `properties.tag` (idempotent; skips if already present).
- If geocoding fails or no zone contains the point, the order is skipped. Processing never blocks or fails the webhook.
- Results are logged with: `order_id, order_name, address_string, lat, lng, corrected_city, matched_tag, status (tagged|skipped), reason`.
- Geocoding responses are cached in-memory for 7 days to reduce API calls.

Acceptance checks:

- A Casablanca-area address outside the polygon → skipped with `reason=no_zone`.
- A Rabat/Salé/Témara-area address inside the polygon → tagged once with `fast`.
- Arabic-only or partial addresses should still geocode when within the polygon.
- Invalid HMAC → HTTP 401; no processing is performed.
- Replaying the same webhook does not duplicate tags.

