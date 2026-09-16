#!/usr/bin/env bash
# Build /opt/collector/app.env from the live Cloud Run service, over SSH.
#
#   ./deploy/pull-env.sh deploy@159.195.204.91 [test-hostname]
#
# Needs an authenticated `gcloud` and SSH access to the box.
#
# Every value is streamed  gcloud -> python -> ssh  in one pipeline: nothing is
# printed to the terminal and nothing is written to the local disk, so no
# secret ends up in shell history, a scrollback buffer or a stray file.
#
# Unlike the other two apps on this box, this service keeps almost everything
# in plaintext env vars rather than Secret Manager — 35 of 39. Only four are
# secret references, and those are resolved here by name.
set -euo pipefail

TARGET="${1:?usage: pull-env.sh user@host [test-hostname]}"
TEST_HOST="${2:-}"

# After cutover, BASE_URL on the box is no longer the Cloud Run URL this
# script reads. Without this, re-running it would silently revert BASE_URL
# and break the Shopify OAuth redirect. Pass the live value to keep it:
#
#   BASE_URL_OVERRIDE=https://shopify-collector.chattbase.site \
#     ./deploy/pull-env.sh deploy@159.195.204.91 shopify-collector.chattbase.site
BASE_URL_OVERRIDE="${BASE_URL_OVERRIDE:-}"
SERVICE=shopify-collector
REGION=europe-west1

command -v gcloud >/dev/null || { echo "✗ gcloud not on PATH" >&2; exit 1; }

# Git-Bash on Windows ships `python`, most Linux checkouts ship `python3`.
PY_BIN="$(command -v python3 || command -v python)"
[ -n "${PY_BIN}" ] || { echo "✗ no python on PATH" >&2; exit 1; }

echo "→ reading ${SERVICE} (${REGION}) and writing ${TARGET}:/opt/collector/app.env"

gcloud run services describe "${SERVICE}" --region "${REGION}" --format=json \
| "${PY_BIN}" -c '
import json, re, subprocess, sys

# Force UTF-8 AND LF on this stream. On Windows it would otherwise be cp1252,
# which cannot encode the box-drawing characters in the header below, and it
# would also translate every line ending into CRLF - giving every value in
# app.env an invisible trailing carriage return, which Compose then passes
# straight into the container.
sys.stdout.reconfigure(encoding="utf-8", newline=chr(10))

test_host = sys.argv[1] if len(sys.argv) > 1 else ""
base_override = sys.argv[2] if len(sys.argv) > 2 else ""
svc = json.load(sys.stdin)
container = svc["spec"]["template"]["spec"]["containers"][0]

# Compose sets these itself, so app.env must not also carry them: a file that
# disagrees with what the container actually runs is a trap for the next
# person, and env_file loses to `environment:` silently.
COMPOSE_OWNED = {"PORT", "WORKER_LOOPS", "K_SERVICE"}

# Vite inlines VITE_* at BUILD time. As runtime variables they do nothing at
# all, and carrying them would suggest they could be changed with a restart.
# RELAY_URL and pc_id are read by nothing in backend/.
DROP_PREFIXES = ("VITE_",)
DROP_EXACT = {"RELAY_URL", "pc_id"}

out, seen = [], {}
for e in container.get("env", []):
    name = e["name"]
    # The live service carries one variable literally named
    # "VITE_PRINT_RELAY_PC_ID " — with a trailing space. Nothing can read it.
    if name != name.strip():
        print("  ! dropping malformed name %r" % name, file=sys.stderr)
        continue
    if name in COMPOSE_OWNED or name in DROP_EXACT or name.startswith(DROP_PREFIXES):
        continue

    if "valueFrom" in e:
        ref = e["valueFrom"]["secretKeyRef"]
        sec, ver = ref["name"], ref.get("key") or "latest"
        # shell=True so this works from Git-Bash on Windows too, where the
        # executable is gcloud.cmd and CreateProcess will not find bare
        # "gcloud". Both names come from the service definition, but they are
        # still checked before being interpolated into a command line.
        if not re.fullmatch(r"[A-Za-z0-9_-]+", sec) or not re.fullmatch(r"[A-Za-z0-9_-]+", ver):
            sys.exit("✗ refusing unsafe secret reference: %r / %r" % (sec, ver))
        val = subprocess.run(
            "gcloud secrets versions access %s --secret %s" % (ver, sec),
            shell=True, capture_output=True, text=True, check=True,
        ).stdout
        # Secret Manager payloads routinely carry a trailing newline.
        val = val.rstrip("\r\n")
        print("  secret %-28s <- %s" % (name, sec), file=sys.stderr)
    else:
        val = e.get("value", "")

    if "\n" in val or "\r" in val:
        sys.exit("✗ %s contains a newline; env_file cannot represent it" % name)

    # Later duplicates win on Cloud Run, so mirror that and keep the last.
    if name in seen:
        print("  ! %s declared twice on the service; keeping the last" % name, file=sys.stderr)
        out[seen[name]] = None
    seen[name] = len(out)
    out.append("%s=%s" % (name, val))

lines = [x for x in out if x is not None]

# ── the values that must DIFFER from Cloud Run ───────────────────────
extra = [
    "",
    "# ── set by deploy/pull-env.sh, not carried from Cloud Run ──────────",
    "# One uvicorn worker in one container, against Supabase. Stated so the",
    "# connection ceiling is a decision rather than a SQLAlchemy default.",
    "DB_POOL_SIZE=5",
    "DB_MAX_OVERFLOW=10",
    "DB_POOL_TIMEOUT=30",
    "DB_POOL_RECYCLE_SECONDS=300",
]
if base_override:
    # The OAuth redirect base. Overriding it is a cutover decision, so it is
    # never inferred from test_host - it has to be stated explicitly.
    lines = [l for l in lines if not l.startswith("BASE_URL=")]
    extra += ["", "BASE_URL=" + base_override]

if test_host:
    # APPEND. Replacing it would cut the Cloud Run UI off mid-validation,
    # and both deployments must work for the whole parallel run.
    origins = next((l.split("=", 1)[1] for l in lines if l.startswith("ALLOWED_ORIGINS=")), "")
    merged = [o for o in origins.split(",") if o.strip()]
    for host in ("https://" + test_host,):
        if host not in merged:
            merged.append(host)
    lines = [l for l in lines if not l.startswith("ALLOWED_ORIGINS=")]
    extra += ["", "ALLOWED_ORIGINS=" + ",".join(merged)]

header = [
    "# /opt/collector/app.env — generated by deploy/pull-env.sh.",
    "# Do not edit by hand: re-run the script instead.",
    "#",
    "# BASE_URL is deliberately still the Cloud Run URL. It is the Shopify",
    "# OAuth redirect base and must stay whitelisted; move it only at cutover.",
    "",
]
sys.stdout.write("\n".join(header + sorted(lines) + extra) + "\n")
' "${TEST_HOST}" "${BASE_URL_OVERRIDE}" \
| ssh -o BatchMode=yes "${TARGET}" \
    'umask 077 && mkdir -p /opt/collector && cat > /opt/collector/app.env && chmod 600 /opt/collector/app.env'

echo "✓ app.env written (chmod 600). Variables, values hidden:"
ssh -o BatchMode=yes "${TARGET}" "sed -E 's/=.*/=<set>/' /opt/collector/app.env | grep -E '^[A-Za-z]' | sort"
