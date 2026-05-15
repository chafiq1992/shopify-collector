# Order Collector (Shopify + FastAPI + React + WebSockets)

A clean, swipe-first app for warehouse/employee order collection:
- Filter orders, see total count
- Carousel-like cards with big variant images, SKU & Qty
- `Collected` → adds **pc** tag to the order
- `OUT` → requires selecting missing variants and appends `OUT: <SKUs>` to the order note
- Live updates via WebSockets
- Single Dockerfile (multi-stage) → deploy to Cloud Run

## 1) Shopify prerequisites

This repo supports Shopify public-app OAuth for adding stores:

- `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` come from the Shopify Dev Dashboard.
- `SHOPIFY_STORE_KEYS` is the store-key list allowed to connect, for example `irrakids,irranova,newstore` or `*`.
- New stores connect through `/shopify-connect`; Shopify mints the Admin API token during OAuth and the app stores it in the DB.
- No manually pasted `SHOPIFY_ACCESS_TOKEN_*` or `SHOPIFY_PASSWORD` is needed for new stores.

### Legacy method (static token fallback)

Create a **custom app** in Shopify admin (or use your existing token) with Admin API scopes like:
- `read_orders`, `write_orders` (plus any other features you use)

This fallback is still supported for older stores, but new stores should use OAuth with `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, and a store key.

### Public app OAuth

In the Shopify Dev Dashboard:

- Create a **public app**
- Add the exact redirect URL to the allowlist:
  - `{BASE_URL}/api/shopify/oauth/callback` (must match exactly, not just the domain)
- Set env vars below (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_STORE_KEYS`, `SHOPIFY_OAUTH_SCOPES`, `BASE_URL`)

Then in the app UI, open `/shopify-connect`, enter a store key such as `newstore`, enter `newstore.myshopify.com`, and run the install flow.

Important lessons:

- Do **not** paste or refresh the callback URL manually — OAuth codes are **one-time-use**. Always go through “Connect” → approve in Shopify.
- If you hit a production HMAC mismatch, you can temporarily set `SHOPIFY_OAUTH_SKIP_HMAC=1` to unblock install (still verifies signed `state`). Remove it after successful install.

## 2) Environment variables

- `SHOPIFY_API_VERSION` — default `2025-01`

Auth + collector analytics (recommended for production):

- `DATABASE_URL` — SQLAlchemy URL. **For production on Cloud Run, use a persistent DB (e.g. Cloud SQL Postgres).**
- `JWT_SECRET` — secret used to sign login tokens.

Important:

- Cloud Run containers can restart and scale to multiple instances. If you keep `DATABASE_URL` as SQLite (`sqlite+aiosqlite:///./local.db`), collector analytics can be **missing/incomplete** because data is not durable and can differ per instance.

Legacy static-token fallback (optional):

- `IRRAKIDS_SHOPIFY_PASSWORD`, `IRRAKIDS_SHOPIFY_API_KEY` — overrides for Irrakids, if different
- `IRRANOVA_STORE_DOMAIN` — e.g., `your-second-store.myshopify.com`
- `IRRANOVA_SHOPIFY_PASSWORD`, `IRRANOVA_SHOPIFY_API_KEY` — credentials for Irranova

Leave these unset for OAuth-only stores. If per-store passwords are not set, the app will use the OAuth token saved in the DB.

### Shopify OAuth (public app) env vars

- `BASE_URL` — public Cloud Run URL used to build redirect URI exactly: `{BASE_URL}/api/shopify/oauth/callback`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET` (starts with `shpss_...`)
- `SHOPIFY_STORE_KEYS` — comma-separated store keys allowed to use OAuth, or `*` to allow adding new store keys from `/shopify-connect`
- `SHOPIFY_OAUTH_SCOPES` — comma-separated
- `SHOPIFY_OAUTH_STORES` — optional backward-compatible alias for `SHOPIFY_STORE_KEYS`
- Optional: `SHOPIFY_OAUTH_SKIP_HMAC=1` (emergency unblock only)

### Credential resolver behavior

When resolving Shopify credentials for a store:

- Use the DB record stored by the OAuth install for OAuth stores.
- Legacy static-token env vars are still supported only as a fallback for older stores.
- Store keys are lowercase slugs such as `irrakids`, `irranova`, or `newstore`. The same key is passed through order lookup, order browser, product orders, printing, fulfillment, and analytics.

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
# setx BASE_URL "http://localhost:8000"
# setx SHOPIFY_CLIENT_ID "your_public_app_client_id"
# setx SHOPIFY_CLIENT_SECRET "shpss_..."
# setx SHOPIFY_STORE_KEYS "*"
# setx SHOPIFY_OAUTH_SCOPES "read_orders,write_orders,read_products,write_products,read_content,write_content,read_inventory,write_inventory"
# setx SHOPIFY_API_VERSION "2025-01"
# Then restart terminal to load env vars
uvicorn backend.app.main:app --reload
# Open http://localhost:8000 once you build production bundle below

# To preview production-like setup:
cd frontend && npm run build && cd ..
uvicorn backend.app.main:app --reload
```

## 3.1) LAN “virtual printer” (other PC → auto-print PC) via PDF

If you want another PC to use the normal Windows **Print** dialog and send the job to your auto-print PC, the practical way is:

- Install a **virtual PDF printer** on the other PC (recommended: PDFCreator) so it appears in the print dialog.
- Configure it to **auto-save PDFs** into a fixed folder (no “Save As” prompt).
- Run the included **LAN sender** to watch that folder and upload new PDFs to the auto-print PC.
- Run the included **LAN receiver** on the auto-print PC to print the uploaded PDFs via **SumatraPDF** (silent printing).

Files added in this repo:

- `lan_print/receiver.py` + `lan_print/run-receiver.ps1` (run on the auto-print PC)
- `lan_print/sender.py` + `lan_print/run-sender.ps1` (run on the other PC)

### Auto-print PC setup

1. Install **SumatraPDF** (so printing can be silent).
2. (Optional but recommended) set an API key so random devices on LAN can’t print:
   - Set env: `LAN_PRINT_API_KEY`
3. Start receiver:

```powershell
.\lan_print\run-receiver.ps1
```

Or **double-click**:

- `lan_print\run-receiver.cmd`

By default it listens on `http://0.0.0.0:8790`.

### Other PC setup

1. Install/configure a virtual PDF printer to auto-save PDFs to `C:\AutoPrint\outbox` (or change `LAN_PRINT_WATCH_DIR`).
2. Point the sender to the auto-print PC IP:
   - Set env: `LAN_PRINT_DEST_URL=http://<AUTO_PRINT_PC_IP>:8790`
   - If you set a key on receiver, set the same `LAN_PRINT_API_KEY` here.
3. Start sender:

```powershell
.\lan_print\run-sender.ps1
```

Or **double-click**:

- `lan_print\run-sender.cmd`

## 4) Docker build & run (single image)

```bash
docker build -t order-collector:local .
docker run -p 8080:8080 \
  -e BASE_URL=http://localhost:8080 \
  -e SHOPIFY_CLIENT_ID=your_public_app_client_id \
  -e SHOPIFY_CLIENT_SECRET=shpss_... \
  -e SHOPIFY_STORE_KEYS=* \
  -e SHOPIFY_OAUTH_SCOPES=read_orders,write_orders,read_products,write_products,read_content,write_content,read_inventory,write_inventory \
  -e SHOPIFY_API_VERSION=2025-01 \
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
  --set-env-vars BASE_URL=https://your-cloud-run-url.a.run.app,SHOPIFY_CLIENT_ID=your_public_app_client_id,SHOPIFY_CLIENT_SECRET=shpss_...,SHOPIFY_STORE_KEYS=*,SHOPIFY_OAUTH_SCOPES=read_orders,write_orders,read_products,write_products,read_content,write_content,read_inventory,write_inventory,SHOPIFY_API_VERSION=2025-01
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
- `BASE_URL`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_STORE_KEYS`, `SHOPIFY_OAUTH_SCOPES` — your Shopify OAuth config

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
            --set-env-vars BASE_URL=${{ secrets.BASE_URL }},SHOPIFY_CLIENT_ID=${{ secrets.SHOPIFY_CLIENT_ID }},SHOPIFY_CLIENT_SECRET=${{ secrets.SHOPIFY_CLIENT_SECRET }},SHOPIFY_STORE_KEYS=${{ secrets.SHOPIFY_STORE_KEYS }},SHOPIFY_OAUTH_SCOPES=${{ secrets.SHOPIFY_OAUTH_SCOPES }},SHOPIFY_API_VERSION=2025-01
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
