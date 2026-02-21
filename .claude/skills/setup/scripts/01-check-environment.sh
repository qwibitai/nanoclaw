#!/bin/bash
set -euo pipefail

# 01-check-environment.sh — Detect OS, Node, container runtimes, existing config

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [check-environment] $*" >> "$LOG_FILE"; }

log "Starting environment check"

# Detect platform
UNAME=$(uname -s)
case "$UNAME" in
  Darwin*) PLATFORM="macos" ;;
  Linux*)  PLATFORM="linux" ;;
  *)       PLATFORM="unknown" ;;
esac
log "Platform: $PLATFORM ($UNAME)"

# Check Node
NODE_OK="false"
NODE_VERSION="not_found"
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//')
  MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$MAJOR" -ge 20 ] 2>/dev/null; then
    NODE_OK="true"
  fi
  log "Node $NODE_VERSION found (major=$MAJOR, ok=$NODE_OK)"
else
  log "Node not found"
fi

# Check Apple Container
APPLE_CONTAINER="not_found"
if command -v container >/dev/null 2>&1; then
  APPLE_CONTAINER="installed"
  log "Apple Container: installed ($(which container))"
else
  log "Apple Container: not found"
fi

# Check Docker
DOCKER="not_found"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    DOCKER="running"
    log "Docker: running"
  else
    DOCKER="installed_not_running"
    log "Docker: installed but not running"
  fi
else
  log "Docker: not found"
fi

# Check existing config
HAS_ENV="false"
if [ -f "$PROJECT_ROOT/.env" ]; then
  HAS_ENV="true"
  log ".env file found"
fi

HAS_AUTH="false"
if [ -d "$PROJECT_ROOT/store/auth" ] && [ "$(ls -A "$PROJECT_ROOT/store/auth" 2>/dev/null)" ]; then
  HAS_AUTH="true"
  log "WhatsApp auth credentials found"
fi

HAS_REGISTERED_GROUPS="false"
if [ -f "$PROJECT_ROOT/data/registered_groups.json" ]; then
  HAS_REGISTERED_GROUPS="true"
  log "Registered groups config found (JSON)"
elif [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  RG_COUNT=$(sqlite3 "$PROJECT_ROOT/store/messages.db" "SELECT COUNT(*) FROM registered_groups" 2>/dev/null || echo "0")
  if [ "$RG_COUNT" -gt 0 ] 2>/dev/null; then
    HAS_REGISTERED_GROUPS="true"
    log "Registered groups found in database ($RG_COUNT)"
  fi
fi

# Detect iMessage availability (macOS only)
IMESSAGE_AVAILABLE="false"
HAS_IMESSAGE_ACCESS="false"
if [ "$PLATFORM" = "macos" ] && [ -f "$HOME/Library/Messages/chat.db" ]; then
  IMESSAGE_AVAILABLE="true"
  log "iMessage: chat.db found"
  if [ -r "$HOME/Library/Messages/chat.db" ]; then
    HAS_IMESSAGE_ACCESS="true"
    log "iMessage: chat.db readable (Full Disk Access granted)"
  else
    log "iMessage: chat.db exists but not readable (Full Disk Access needed)"
  fi
else
  log "iMessage: not available (platform=$PLATFORM)"
fi

# Detect configured channel from registered groups
CONFIGURED_CHANNEL="none"
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  HAS_IMSG=$(sqlite3 "$PROJECT_ROOT/store/messages.db" "SELECT COUNT(*) FROM registered_groups WHERE jid LIKE 'imsg:%' OR jid LIKE 'imsg-group:%'" 2>/dev/null || echo "0")
  HAS_WA=$(sqlite3 "$PROJECT_ROOT/store/messages.db" "SELECT COUNT(*) FROM registered_groups WHERE jid LIKE '%@s.whatsapp.net' OR jid LIKE '%@g.us'" 2>/dev/null || echo "0")
  if [ "$HAS_IMSG" -gt 0 ] 2>/dev/null && [ "$HAS_WA" -gt 0 ] 2>/dev/null; then
    CONFIGURED_CHANNEL="both"
  elif [ "$HAS_IMSG" -gt 0 ] 2>/dev/null; then
    CONFIGURED_CHANNEL="imessage"
  elif [ "$HAS_WA" -gt 0 ] 2>/dev/null; then
    CONFIGURED_CHANNEL="whatsapp"
  fi
  log "Configured channel: $CONFIGURED_CHANNEL (imsg=$HAS_IMSG, wa=$HAS_WA)"
fi

log "Environment check complete"

# Output structured status block
cat <<EOF
=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: $PLATFORM
NODE_VERSION: $NODE_VERSION
NODE_OK: $NODE_OK
APPLE_CONTAINER: $APPLE_CONTAINER
DOCKER: $DOCKER
HAS_ENV: $HAS_ENV
HAS_AUTH: $HAS_AUTH
HAS_REGISTERED_GROUPS: $HAS_REGISTERED_GROUPS
IMESSAGE_AVAILABLE: $IMESSAGE_AVAILABLE
HAS_IMESSAGE_ACCESS: $HAS_IMESSAGE_ACCESS
CONFIGURED_CHANNEL: $CONFIGURED_CHANNEL
STATUS: success
LOG: logs/setup.log
=== END ===
EOF

# Exit 2 if Node is missing or too old
if [ "$NODE_OK" = "false" ]; then
  exit 2
fi
