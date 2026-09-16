#!/usr/bin/env bash
# -> /opt/collector/deploy.sh   (chmod 750, owned by deploy)
#
# Release shopify-collector on this box.
#   /opt/collector/deploy.sh <tag>    build and release that tag
#   /opt/collector/deploy.sh          re-release as :latest
#
# The image is built here from /opt/collector/src rather than pulled: CI
# publishes only to Google Artifact Registry, and pulling from it would mean
# putting long-lived GCP credentials on this box. Push the source first with
# deploy/push-source.sh from a checkout.
set -euo pipefail
cd /opt/collector

TAG="${1:-latest}"
SRC=/opt/collector/src

if [ ! -f "${SRC}/Dockerfile" ]; then
  echo "✗ no source at ${SRC} — run deploy/push-source.sh from a checkout first" >&2
  exit 1
fi

sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${TAG}/" /opt/collector/.env

# The frontend is compiled into the image and Vite inlines VITE_* at build
# time, so this is `compose build` rather than a bare `docker build`: it picks
# the build args up from /opt/collector/.env instead of repeating them here.
echo "→ building shopify-collector:${TAG}"
docker compose build web
docker tag "shopify-collector:${TAG}" shopify-collector:latest

# Fail-closed schema gate. This app applies its schema from a FastAPI startup
# handler that CATCHES every exception and merely prints it, so a database it
# cannot reach or a rejected ALTER would otherwise leave a container that
# boots, reports itself healthy and then serves 500s — after `up -d` had
# already replaced the working one. backend.migrate does the identical work in
# a throwaway container and exits non-zero, leaving the running container
# untouched.
echo "→ schema (python -m backend.migrate)"
docker compose run --rm --no-deps web python -m backend.migrate

# --wait blocks on the healthcheck, and that healthcheck reads db.ok out of
# /api/health's BODY rather than its status code — the endpoint answers 200
# whenever the process is up, so a status check would gate on nothing. Caddy's
# lb_try_duration holds requests across the swap instead of returning 502.
echo "→ restarting"
docker compose up -d --wait

docker image prune -f
echo "✓ released ${TAG}"
echo
echo "  print queue owner: $(grep -E '^WORKER_LOOPS=' /opt/collector/.env)"
echo "  reported by app:   $(docker compose exec -T web python -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=8)); print('worker_loops=%s db_ok=%s' % (d.get('worker_loops'), (d.get('db') or {}).get('ok')))" 2>/dev/null || echo '?')"
