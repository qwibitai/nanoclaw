#!/bin/bash
# Restore NanoClaw v2 from a daily backup zip.
#
# Usage:
#   scripts/restore-from-backup.sh path/to/nanoclaw-v2-2026-05-04-2300-host.zip
#
# Stops the launchd service, unzips into the repo root (overwriting in place),
# then prompts you to manually restart the service.
#
# Designed for "fresh Mac, install NanoClaw, restore" — assumes the v2 install
# already exists at /Users/<user>/nanoclaw-v2 with .env credentials.

set -eu

if [ $# -ne 1 ]; then
  echo "Usage: $0 <backup.zip>" >&2
  exit 2
fi

BACKUP="$1"
REPO=/Users/ilansolot/nanoclaw-v2

if [ ! -f "${BACKUP}" ]; then
  echo "Backup file not found: ${BACKUP}" >&2
  exit 1
fi

# Find launchd service
SERVICE=$(launchctl list 2>/dev/null | awk '/com\.nanoclaw-v2/ {print $3}' | head -n1)
if [ -n "${SERVICE}" ]; then
  echo "[restore] stopping ${SERVICE}"
  launchctl unload "${HOME}/Library/LaunchAgents/${SERVICE}.plist" 2>/dev/null || true
fi

echo "[restore] unpacking ${BACKUP} into ${REPO}"
cd "${REPO}"
unzip -o -q "${BACKUP}"

echo "[restore] done. Verify state:"
echo "  groups/: $(find groups -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ') groups"
echo "  data/v2.db: $([ -f data/v2.db ] && echo 'present' || echo 'MISSING')"
echo "  data/v2-sessions/: $(find data/v2-sessions -maxdepth 2 -name 'inbound.db' 2>/dev/null | wc -l | tr -d ' ') sessions"
echo ""
echo "Restart the service when ready:"
if [ -n "${SERVICE}" ]; then
  echo "  launchctl load ${HOME}/Library/LaunchAgents/${SERVICE}.plist"
fi
