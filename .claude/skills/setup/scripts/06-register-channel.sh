#!/bin/bash
set -euo pipefail

# 06-register-channel.sh — Write channel registration config, create group folders

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [register-channel] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Parse args
JID=""
NAME=""
TRIGGER=""
FOLDER=""
REQUIRES_TRIGGER="true"
ASSISTANT_NAME="Andy"

while [[ $# -gt 0 ]]; do
  case $1 in
    --jid)              JID="$2"; shift 2 ;;
    --name)             NAME="$2"; shift 2 ;;
    --trigger)          TRIGGER="$2"; shift 2 ;;
    --folder)           FOLDER="$2"; shift 2 ;;
    --no-trigger-required) REQUIRES_TRIGGER="false"; shift ;;
    --assistant-name)   ASSISTANT_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Validate required args
if [ -z "$JID" ] || [ -z "$NAME" ] || [ -z "$TRIGGER" ] || [ -z "$FOLDER" ]; then
  log "ERROR: Missing required args (--jid, --name, --trigger, --folder)"
  cat <<EOF
=== NANOCLAW SETUP: REGISTER_CHANNEL ===
STATUS: failed
ERROR: missing_required_args
LOG: logs/setup.log
=== END ===
EOF
  exit 4
fi

log "Registering channel: jid=$JID name=$NAME trigger=$TRIGGER folder=$FOLDER requiresTrigger=$REQUIRES_TRIGGER"

# Create data directory
mkdir -p "$PROJECT_ROOT/data"

# Write directly to SQLite (the DB and schema exist from the sync-groups step)
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
DB_PATH="$PROJECT_ROOT/store/messages.db"
REQUIRES_TRIGGER_INT=$( [ "$REQUIRES_TRIGGER" = "true" ] && echo 1 || echo 0 )

sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger) VALUES ('$JID', '$NAME', '$FOLDER', '$TRIGGER', '$TIMESTAMP', NULL, $REQUIRES_TRIGGER_INT);"

log "Wrote registration to SQLite"

# Create group folders
mkdir -p "$PROJECT_ROOT/groups/$FOLDER/logs"
log "Created groups/$FOLDER/logs/"

# Update assistant name in CLAUDE.md files if different from default
NAME_UPDATED="false"
if [ "$ASSISTANT_NAME" != "Andy" ]; then
  log "Updating assistant name from Andy to $ASSISTANT_NAME"

  for md_file in groups/global/CLAUDE.md groups/main/CLAUDE.md; do
    if [ -f "$PROJECT_ROOT/$md_file" ]; then
      sed -i '' "s/^# Andy$/# $ASSISTANT_NAME/" "$PROJECT_ROOT/$md_file"
      sed -i '' "s/You are Andy/You are $ASSISTANT_NAME/g" "$PROJECT_ROOT/$md_file"
      log "Updated $md_file"
    else
      log "WARNING: $md_file not found, skipping name update"
    fi
  done

  NAME_UPDATED="true"
fi

cat <<EOF
=== NANOCLAW SETUP: REGISTER_CHANNEL ===
JID: $JID
NAME: $NAME
FOLDER: $FOLDER
TRIGGER: $TRIGGER
REQUIRES_TRIGGER: $REQUIRES_TRIGGER
ASSISTANT_NAME: $ASSISTANT_NAME
NAME_UPDATED: $NAME_UPDATED
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
