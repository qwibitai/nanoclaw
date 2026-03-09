#!/bin/bash
# Safe restart for NanoClaw after making updates.
#
# What it does (in order):
#   1. Stops all running nanoclaw agent containers (they hold old code/image)
#   2. Builds host TypeScript (npm run build)
#   3. Rebuilds container image with --no-cache (build cache doesn't invalidate COPY steps)
#   4. Optionally clears agent sessions (needed when MCP tools change)
#   5. Restarts the launchd service
#   6. Verifies the service started
#
# Usage:
#   ./scripts/restart.sh              # rebuild everything
#   ./scripts/restart.sh --quick      # skip container rebuild (host-only changes)
#   ./scripts/restart.sh --reset      # also clear sessions (new MCP tools, schema changes)
#   ./scripts/restart.sh --host-only  # alias for --quick

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

CONTAINER_RUNTIME="container"
IMAGE_NAME="nanoclaw-agent"
LAUNCHD_LABEL="com.nanoclaw"
LOG_FILE="logs/nanoclaw.log"
QUICK=false
RESET_SESSIONS=false

for arg in "$@"; do
  case "$arg" in
    --quick|--host-only) QUICK=true ;;
    --reset) RESET_SESSIONS=true ;;
    --help|-h)
      echo "Usage: $0 [--quick] [--reset]"
      echo ""
      echo "  --quick       Skip container image rebuild (host-only changes)"
      echo "  --reset       Clear agent sessions (forces new MCP tool discovery)"
      echo ""
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}→ $1${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; exit 1; }

echo -e "${CYAN}━━━ NanoClaw Restart ━━━${NC}"
echo "  Project: $PROJECT_DIR"
echo "  Quick:   $QUICK"
echo "  Reset:   $RESET_SESSIONS"

# ── 1. Stop running agent containers ──
step "Stopping running agent containers..."
CONTAINERS=$($CONTAINER_RUNTIME list 2>/dev/null | grep "nanoclaw-" | awk '{print $1}' || true)
if [ -n "$CONTAINERS" ]; then
  COUNT=0
  for c in $CONTAINERS; do
    $CONTAINER_RUNTIME stop "$c" >/dev/null 2>&1 || true
    COUNT=$((COUNT + 1))
  done
  ok "Stopped $COUNT container(s)"
else
  ok "No running containers"
fi

# ── 2. Build host TypeScript ──
step "Building host TypeScript..."
if npm run build 2>&1; then
  ok "Host build complete"
else
  fail "Host build failed"
fi

# ── 3. Rebuild container image ──
if [ "$QUICK" = false ]; then
  step "Rebuilding container image (--no-cache)..."
  # --no-cache is critical: Apple Container's buildkit caches COPY steps
  # aggressively, so source changes won't be picked up without it.
  if $CONTAINER_RUNTIME build --dns 8.8.8.8 --no-cache -t "${IMAGE_NAME}:latest" ./container/ 2>&1 | tail -5; then
    ok "Container image rebuilt"
  else
    fail "Container build failed"
  fi
else
  warn "Skipping container rebuild (--quick)"
fi

# ── 4. Clear sessions if requested ──
if [ "$RESET_SESSIONS" = true ]; then
  step "Clearing agent sessions..."
  # When MCP tools change, old sessions cache the tool list.
  # Clearing forces new tool discovery on next run.
  node -e "
    const Database = require('better-sqlite3');
    const db = new Database('./store/messages.db');
    const rows = db.prepare('SELECT * FROM sessions').all();
    db.prepare('DELETE FROM sessions').run();
    db.close();
    console.log('Cleared ' + rows.length + ' session(s)');
  " 2>/dev/null && ok "Sessions cleared" || warn "Could not clear sessions (DB may not exist yet)"
fi

# ── 5. Restart launchd service ──
step "Restarting launchd service..."
if launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null; then
  ok "Service restart triggered"
else
  # Try load if not loaded
  PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
  if [ -f "$PLIST" ]; then
    launchctl load "$PLIST" 2>/dev/null || true
    ok "Service loaded from plist"
  else
    fail "Cannot restart service — plist not found at $PLIST"
  fi
fi

# ── 6. Verify startup ──
step "Verifying service started..."
sleep 3

if [ -f "$LOG_FILE" ]; then
  LAST_LINES=$(tail -10 "$LOG_FILE" 2>/dev/null || true)

  if echo "$LAST_LINES" | grep -q "NanoClaw running"; then
    ok "Service is running"
    # Show key info
    echo "$LAST_LINES" | grep -E "bot connected|running|Dashboard" | sed 's/^/  /' || true
  elif echo "$LAST_LINES" | grep -q "Failed to start\|Error"; then
    fail "Service failed to start. Check: tail -30 $LOG_FILE"
  else
    warn "Service may still be starting. Check: tail -30 $LOG_FILE"
  fi
else
  warn "Log file not found — service may still be starting"
fi

# ── Summary ──
echo ""
echo -e "${GREEN}━━━ Restart complete ━━━${NC}"
echo "  Dashboard:  http://localhost:3456"
echo "  Trace:      http://localhost:3456 → Trace tab"
echo "  Logs:       tail -f $LOG_FILE"
