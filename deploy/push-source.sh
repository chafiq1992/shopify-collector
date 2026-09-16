#!/usr/bin/env bash
# Ship source to the box so deploy.sh can build it.
#
#   ./deploy/push-source.sh deploy@159.195.204.91           working tree
#   ./deploy/push-source.sh deploy@159.195.204.91 HEAD      a committed ref
#
# The repo is private and the box holds no deploy key, which is why the source
# is pushed rather than cloned.
#
# Default is the WORKING TREE, so a change can be validated on the box before
# it is committed. Pass a ref for a reproducible release build.
#
# Only what the Dockerfile COPYs is sent, and the excludes below are not
# cosmetic:
#
#   * frontend/node_modules is COMMITTED to this repo - 8479 files - so
#     .gitignore cannot filter it and `git ls-files` lists every one. The
#     image installs its own deps with `npm ci` and .dockerignore drops the
#     directory anyway, so sending it is pure waste.
#   * the untracked-but-not-ignored material here (.claude/worktrees at
#     382 MB, two .rar archives, print-agent/) is excluded simply by not
#     being in BUILD_INPUTS.
#
# Without both, a deploy pushes ~440 MB to the box instead of a few MB.
set -euo pipefail

TARGET="${1:?usage: push-source.sh user@host [git-ref]}"
REF="${2:-}"

BUILD_INPUTS=(
  Dockerfile
  requirements.txt
  backend
  frontend
  ':(exclude)**/node_modules/**'
  ':(exclude)**/__pycache__/**'
  ':(exclude)**/.pytest_cache/**'
  ':(exclude)frontend/dist/**'
)

REMOTE_UNPACK='rm -rf /opt/collector/src.new && mkdir -p /opt/collector/src.new \
  && tar -x -C /opt/collector/src.new \
  && rm -rf /opt/collector/src && mv /opt/collector/src.new /opt/collector/src'

if [ -n "${REF}" ]; then
  SHA="$(git rev-parse --short "${REF}")"
  echo "→ sending committed ${REF} (${SHA}) to ${TARGET}:/opt/collector/src"
  git archive --format=tar "${REF}" -- "${BUILD_INPUTS[@]}" \
    | ssh "${TARGET}" "${REMOTE_UNPACK}"
else
  SHA="$(git rev-parse --short HEAD)-dirty"
  echo "→ sending working tree (on top of $(git rev-parse --short HEAD)) to ${TARGET}:/opt/collector/src"
  git ls-files -z --cached --others --exclude-standard -- "${BUILD_INPUTS[@]}" \
    | tar --null -T - -cf - \
    | ssh "${TARGET}" "${REMOTE_UNPACK}"
fi

echo "✓ source in place (${SHA}). Release it with:"
echo "    ssh ${TARGET} '/opt/collector/deploy.sh ${SHA}'"
