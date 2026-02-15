#!/bin/bash
set -euo pipefail

# 07-configure-mounts.sh — Write mount allowlist config file

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [configure-mounts] $*" >> "$LOG_FILE"; }

CONFIG_DIR="$HOME/.config/nanoclaw"
CONFIG_FILE="$CONFIG_DIR/mount-allowlist.json"

# Parse args
EMPTY_MODE="false"
while [[ $# -gt 0 ]]; do
  case $1 in
    --empty) EMPTY_MODE="true"; shift ;;
    *) shift ;;
  esac
done

# Create config directory
mkdir -p "$CONFIG_DIR"
log "Ensured config directory: $CONFIG_DIR"

if [ "$EMPTY_MODE" = "true" ]; then
  log "Writing empty mount allowlist"
  cat > "$CONFIG_FILE" <<'JSONEOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
JSONEOF
  ALLOWED_ROOTS=0
  NON_MAIN_READ_ONLY="true"
else
  # Read JSON from stdin
  log "Reading mount allowlist from stdin"
  INPUT=$(cat)

  # Validate JSON
  if ! echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d)}catch(e){process.exit(1)}})" 2>/dev/null; then
    log "ERROR: Invalid JSON input"
    cat <<EOF
=== NANOCLAW SETUP: CONFIGURE_MOUNTS ===
PATH: $CONFIG_FILE
ALLOWED_ROOTS: 0
NON_MAIN_READ_ONLY: unknown
STATUS: failed
ERROR: invalid_json
LOG: logs/setup.log
=== END ===
EOF
    exit 4
  fi

  echo "$INPUT" > "$CONFIG_FILE"
  log "Wrote mount allowlist from stdin"

  # Extract values
  ALLOWED_ROOTS=$(node -e "const d=require('$CONFIG_FILE');console.log((d.allowedRoots||[]).length)" 2>/dev/null || echo "0")
  NON_MAIN_READ_ONLY=$(node -e "const d=require('$CONFIG_FILE');console.log(d.nonMainReadOnly===false?'false':'true')" 2>/dev/null || echo "true")
fi

log "Allowlist configured: $ALLOWED_ROOTS roots, nonMainReadOnly=$NON_MAIN_READ_ONLY"

cat <<EOF
=== NANOCLAW SETUP: CONFIGURE_MOUNTS ===
PATH: $CONFIG_FILE
ALLOWED_ROOTS: $ALLOWED_ROOTS
NON_MAIN_READ_ONLY: $NON_MAIN_READ_ONLY
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
