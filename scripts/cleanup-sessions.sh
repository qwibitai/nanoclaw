#!/bin/bash
#
# Prune stale session artifacts (JSONLs, debug logs, todos, telemetry, group logs).
# Safe to run while NanoClaw is live — active sessions are read from the DB.
#
# Usage:  ./scripts/cleanup-sessions.sh [--dry-run]
#
# Retention:
#   Session JSONLs + tool-results:  7 days  (active session always kept)
#   Debug logs:                     3 days
#   Todo files:                     3 days
#   Telemetry:                      7 days
#   Group logs:                     7 days

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

STORE_DB="$PROJECT_ROOT/store/messages.db"
SESSIONS_DIR="$PROJECT_ROOT/data/sessions"
GROUPS_DIR="$PROJECT_ROOT/groups"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

TOTAL_FREED=0

log() { echo "[cleanup] $*"; }

remove() {
  local target="$1"
  if $DRY_RUN; then
    if [ -d "$target" ]; then
      size=$(du -sk "$target" 2>/dev/null | cut -f1)
    else
      size=$(stat -f%z "$target" 2>/dev/null || echo 0)
      size=$((size / 1024))
    fi
    TOTAL_FREED=$((TOTAL_FREED + size))
    log "would remove: $target (${size}K)"
  else
    if [ -d "$target" ]; then
      size=$(du -sk "$target" 2>/dev/null | cut -f1)
      rm -rf "$target"
    else
      size=$(stat -f%z "$target" 2>/dev/null || echo 0)
      size=$((size / 1024))
      rm -f "$target"
    fi
    TOTAL_FREED=$((TOTAL_FREED + size))
  fi
}

# --- Collect active session IDs from the database ---

if [ ! -f "$STORE_DB" ]; then
  log "ERROR: database not found at $STORE_DB"
  exit 1
fi

ACTIVE_IDS=$(sqlite3 "$STORE_DB" "SELECT session_id FROM sessions;" 2>/dev/null || true)

is_active() {
  echo "$ACTIVE_IDS" | grep -qF "$1"
}

# --- Prune session JSONLs and tool-results dirs ---

for group_dir in "$SESSIONS_DIR"/*/; do
  [ -d "$group_dir" ] || continue
  jsonl_dir="$group_dir/.claude/projects/-workspace-group"
  [ -d "$jsonl_dir" ] || continue

  for jsonl in "$jsonl_dir"/*.jsonl; do
    [ -f "$jsonl" ] || continue
    id=$(basename "$jsonl" .jsonl)

    # Never delete the active session
    if is_active "$id"; then
      continue
    fi

    # Only delete if older than 7 days
    if [ -n "$(find "$jsonl" -mtime +7 2>/dev/null)" ]; then
      remove "$jsonl"
      # Remove matching tool-results directory
      [ -d "$jsonl_dir/$id" ] && remove "$jsonl_dir/$id"
    fi
  done
done

# --- Prune debug logs (>3 days, skip files named after active sessions) ---

for group_dir in "$SESSIONS_DIR"/*/; do
  debug_dir="$group_dir/.claude/debug"
  [ -d "$debug_dir" ] || continue
  find "$debug_dir" -type f -mtime +3 ! -name "latest" -print0 2>/dev/null | while IFS= read -r -d '' f; do
    fname=$(basename "$f" .txt)
    is_active "$fname" && continue
    remove "$f"
  done
done

# --- Prune todo files (>3 days, skip files named after active sessions) ---

for group_dir in "$SESSIONS_DIR"/*/; do
  todos_dir="$group_dir/.claude/todos"
  [ -d "$todos_dir" ] || continue
  find "$todos_dir" -type f -mtime +3 -print0 2>/dev/null | while IFS= read -r -d '' f; do
    fname=$(basename "$f" .json)
    # Todo filenames are like {session_id}-agent-{session_id}.json
    for aid in $ACTIVE_IDS; do
      if [[ "$fname" == *"$aid"* ]]; then
        continue 2
      fi
    done
    remove "$f"
  done
done

# --- Prune telemetry (>7 days, skip files named after active sessions) ---

for group_dir in "$SESSIONS_DIR"/*/; do
  telem_dir="$group_dir/.claude/telemetry"
  [ -d "$telem_dir" ] || continue
  find "$telem_dir" -type f -mtime +7 -print0 2>/dev/null | while IFS= read -r -d '' f; do
    fname=$(basename "$f")
    for aid in $ACTIVE_IDS; do
      if [[ "$fname" == *"$aid"* ]]; then
        continue 2
      fi
    done
    remove "$f"
  done
done

# --- Prune group logs (>7 days) ---

find "$GROUPS_DIR"/*/logs -type f -mtime +7 -print0 2>/dev/null | while IFS= read -r -d '' f; do
  remove "$f"
done

# --- Summary ---

if $DRY_RUN; then
  log "DRY RUN complete — would free ~${TOTAL_FREED}K"
else
  log "Done — freed ~${TOTAL_FREED}K"
fi
