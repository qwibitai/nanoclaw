#!/bin/bash
#
# Prune stale v2 session artifacts.
# Safe to run while NanoClaw is live: active sessions are read from data/v2.db
# and are always kept.
#
# Usage:  ./scripts/cleanup-sessions.sh [--dry-run]
#
# Retention:
#   Closed/ended session folders:  7 days
#   Claude debug logs:            3 days
#   Claude todo files:            3 days
#   Claude telemetry:             7 days
#   Group logs:                   7 days

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

CENTRAL_DB="$PROJECT_ROOT/data/v2.db"
SESSIONS_DIR="$PROJECT_ROOT/data/v2-sessions"
GROUPS_DIR="$PROJECT_ROOT/groups"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

TOTAL_FREED=0

log() { echo "[cleanup] $*"; }

remove() {
  local target="$1"
  local size
  size=$(du -sk "$target" 2>/dev/null | awk '{print $1}')
  size=${size:-0}

  TOTAL_FREED=$((TOTAL_FREED + size))
  if $DRY_RUN; then
    log "would remove: $target (${size}K)"
  else
    rm -rf "$target"
  fi
}

is_older_than() {
  local target="$1"
  local days="$2"
  [ -n "$(find "$target" -prune -mtime +"$days" -print 2>/dev/null)" ]
}

prune_files() {
  local dir="$1"
  local days="$2"
  [ -d "$dir" ] || return 0

  while IFS= read -r -d '' f; do
    remove "$f"
  done < <(find "$dir" -type f -mtime +"$days" -print0 2>/dev/null)
}

if [ ! -f "$CENTRAL_DB" ]; then
  log "ERROR: central database not found at $CENTRAL_DB"
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  log "ERROR: sqlite3 CLI is required for session cleanup"
  exit 1
fi

ACTIVE_SESSION_KEYS=$(
  sqlite3 "$CENTRAL_DB" \
    "SELECT agent_group_id || '/' || id FROM sessions WHERE status = 'active';" \
    2>/dev/null || true
)

is_active_session() {
  printf '%s\n' "$ACTIVE_SESSION_KEYS" | grep -Fxq "$1"
}

# --- Prune inactive session folders ---

if [ -d "$SESSIONS_DIR" ]; then
  for agent_dir in "$SESSIONS_DIR"/*; do
    [ -d "$agent_dir" ] || continue
    agent_group_id="$(basename "$agent_dir")"

    for session_dir in "$agent_dir"/sess-*; do
      [ -d "$session_dir" ] || continue
      session_id="$(basename "$session_dir")"
      key="$agent_group_id/$session_id"

      if is_active_session "$key"; then
        continue
      fi

      if is_older_than "$session_dir" 7; then
        remove "$session_dir"
      fi
    done
  done
fi

# --- Prune Claude's shared per-agent diagnostic files ---

if [ -d "$SESSIONS_DIR" ]; then
  for shared_dir in "$SESSIONS_DIR"/*/.claude-shared; do
    [ -d "$shared_dir" ] || continue
    prune_files "$shared_dir/debug" 3
    prune_files "$shared_dir/todos" 3
    prune_files "$shared_dir/telemetry" 7
  done
fi

# --- Prune group logs (>7 days) ---

for logs_dir in "$GROUPS_DIR"/*/logs; do
  [ -d "$logs_dir" ] || continue
  prune_files "$logs_dir" 7
done

# --- Summary ---

if $DRY_RUN; then
  log "DRY RUN complete - would free ~${TOTAL_FREED}K"
else
  log "Done - freed ~${TOTAL_FREED}K"
fi
