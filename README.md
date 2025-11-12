# Order Collector (Shopify + FastAPI + React + WebSockets)

A clean, swipe-first app for warehouse/employee order collection:
- Filter orders, see total count
- Carousel-like cards with big variant images, SKU & Qty
- `Collected` → adds **pc** tag to the order
- `OUT` → requires selecting missing variants and appends `OUT: <SKUs>` to the order note
- Live updates via WebSockets
- Single Dockerfile (multi-stage) → deploy to Cloud Run

## 1) Shopify prerequisites

Create a **custom app** in Shopify admin with Admin API scopes:
- `read_orders`
- `write_orders`

Copy the **Admin API access token** and set env vars below.

## 2) Environment variables

- `IRRAKIDS_STORE_DOMAIN` — e.g., `yourstore.myshopify.com`
- `SHOPIFY_PASSWORD` — Admin API access token or Private App password
- `SHOPIFY_API_KEY` — optional; if set with `SHOPIFY_PASSWORD`, basic auth is used
- `SHOPIFY_API_VERSION` — default `2025-01`

Multi-store (optional):

- `IRRAKIDS_SHOPIFY_PASSWORD`, `IRRAKIDS_SHOPIFY_API_KEY` — overrides for Irrakids, if different
- `IRRANOVA_STORE_DOMAIN` — e.g., `your-second-store.myshopify.com`
- `IRRANOVA_SHOPIFY_PASSWORD`, `IRRANOVA_SHOPIFY_API_KEY` — credentials for Irranova

If per-store passwords are not set, the app will fall back to `SHOPIFY_PASSWORD`/`SHOPIFY_API_KEY`.

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

