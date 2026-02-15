#!/bin/bash
set -euo pipefail

# 02-install-deps.sh — Run npm install and verify key packages

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [install-deps] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

log "Running npm install"

if npm install >> "$LOG_FILE" 2>&1; then
  log "npm install succeeded"
else
  log "npm install failed"
  cat <<EOF
=== NANOCLAW SETUP: INSTALL_DEPS ===
PACKAGES: failed
STATUS: failed
ERROR: npm_install_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Verify key packages
MISSING=""
for pkg in @whiskeysockets/baileys better-sqlite3 pino qrcode; do
  if [ ! -d "$PROJECT_ROOT/node_modules/$pkg" ]; then
    MISSING="$MISSING $pkg"
  fi
done

if [ -n "$MISSING" ]; then
  log "Missing packages after install:$MISSING"
  cat <<EOF
=== NANOCLAW SETUP: INSTALL_DEPS ===
PACKAGES: failed
STATUS: failed
ERROR: missing_packages:$MISSING
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

log "All key packages verified"

cat <<EOF
=== NANOCLAW SETUP: INSTALL_DEPS ===
PACKAGES: installed
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
