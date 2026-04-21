#!/usr/bin/env bash
# remote-deploy.sh — run on the NanoClaw droplet to upgrade to a version tag
# Usage: bash remote-deploy.sh <version-tag>   e.g. bash remote-deploy.sh v1.4.2
set -euo pipefail

VERSION="${1:?Usage: remote-deploy.sh <version-tag>  (e.g. v1.4.2)}"
NANOCLAW_DIR="${NANOCLAW_DIR:-/root/nanoclaw}"

echo "[remote-deploy] Upgrading to $VERSION in $NANOCLAW_DIR"
cd "$NANOCLAW_DIR"

git fetch --tags --quiet
git checkout "$VERSION" --quiet
echo "[remote-deploy] Checked out $VERSION"

npm ci --prefer-offline --silent
npm run build --silent
echo "[remote-deploy] Build complete"

# Full prune to avoid stale COPY cache (see CLAUDE.md Container Build Cache note)
docker builder prune -af --filter type=exec.cachemount 2>/dev/null || true
./container/build.sh
echo "[remote-deploy] Container image rebuilt"

if systemctl is-active --quiet nanoclaw 2>/dev/null; then
  systemctl restart nanoclaw
  echo "[remote-deploy] systemctl restart nanoclaw"
elif systemctl --user is-active --quiet nanoclaw 2>/dev/null; then
  systemctl --user restart nanoclaw
  echo "[remote-deploy] systemctl --user restart nanoclaw"
else
  echo "[remote-deploy] WARNING: nanoclaw service not running — start it manually" >&2
  exit 1
fi

echo "[remote-deploy] Deploy of $VERSION complete"
