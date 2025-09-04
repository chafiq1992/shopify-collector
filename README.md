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

