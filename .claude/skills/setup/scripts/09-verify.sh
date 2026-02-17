#!/bin/bash
set -euo pipefail

# 09-verify.sh — End-to-end health check of the full installation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [verify] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

log "Starting verification"

# Detect platform
case "$(uname -s)" in
  Darwin*) PLATFORM="macos" ;;
  Linux*)  PLATFORM="linux" ;;
  *)       PLATFORM="unknown" ;;
esac

# 1. Check service status
SERVICE="not_found"
if [ "$PLATFORM" = "macos" ]; then
  if launchctl list 2>/dev/null | grep -q "com.nanoclaw"; then
    # Check if it has a PID (actually running)
    LAUNCHCTL_LINE=$(launchctl list 2>/dev/null | grep "com.nanoclaw" || true)
    PID_FIELD=$(echo "$LAUNCHCTL_LINE" | awk '{print $1}')
    if [ "$PID_FIELD" != "-" ] && [ -n "$PID_FIELD" ]; then
      SERVICE="running"
    else
      SERVICE="stopped"
    fi
  fi
elif [ "$PLATFORM" = "linux" ]; then
  if systemctl --user is-active nanoclaw >/dev/null 2>&1; then
    SERVICE="running"
  elif systemctl --user list-unit-files 2>/dev/null | grep -q "nanoclaw"; then
    SERVICE="stopped"
  fi
fi
log "Service: $SERVICE"

# 2. Check container runtime
CONTAINER_RUNTIME="none"
if command -v container >/dev/null 2>&1; then
  CONTAINER_RUNTIME="apple-container"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER_RUNTIME="docker"
fi
log "Container runtime: $CONTAINER_RUNTIME"

# 3. Check credentials
CREDENTIALS="missing"
if [ -f "$PROJECT_ROOT/.env" ]; then
  if grep -qE "^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=" "$PROJECT_ROOT/.env" 2>/dev/null; then
    CREDENTIALS="configured"
  fi
fi
log "Credentials: $CREDENTIALS"

# 4. Check WhatsApp auth
WHATSAPP_AUTH="not_found"
if [ -d "$PROJECT_ROOT/store/auth" ] && [ "$(ls -A "$PROJECT_ROOT/store/auth" 2>/dev/null)" ]; then
  WHATSAPP_AUTH="authenticated"
fi
log "WhatsApp auth: $WHATSAPP_AUTH"

# 5. Check registered groups (in SQLite — the JSON file gets migrated away on startup)
REGISTERED_GROUPS=0
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  REGISTERED_GROUPS=$(sqlite3 "$PROJECT_ROOT/store/messages.db" "SELECT COUNT(*) FROM registered_groups" 2>/dev/null || echo "0")
fi
log "Registered groups: $REGISTERED_GROUPS"

# 6. Check mount allowlist
MOUNT_ALLOWLIST="missing"
if [ -f "$HOME/.config/nanoclaw/mount-allowlist.json" ]; then
  MOUNT_ALLOWLIST="configured"
fi
log "Mount allowlist: $MOUNT_ALLOWLIST"

# Determine overall status
STATUS="success"
if [ "$SERVICE" != "running" ] || [ "$CREDENTIALS" = "missing" ] || [ "$WHATSAPP_AUTH" = "not_found" ] || [ "$REGISTERED_GROUPS" -eq 0 ] 2>/dev/null; then
  STATUS="failed"
fi

log "Verification complete: $STATUS"

cat <<EOF
=== NANOCLAW SETUP: VERIFY ===
SERVICE: $SERVICE
CONTAINER_RUNTIME: $CONTAINER_RUNTIME
CREDENTIALS: $CREDENTIALS
WHATSAPP_AUTH: $WHATSAPP_AUTH
REGISTERED_GROUPS: $REGISTERED_GROUPS
MOUNT_ALLOWLIST: $MOUNT_ALLOWLIST
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
