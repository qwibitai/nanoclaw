#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
STALE_MINUTES="${STALE_MINUTES:-180}"
REQUEST_ID=""
CHAT_JID=""
APPLY=0
BACKUP_DIR="$ROOT_DIR/data/diagnostics/db-backups"
LIMIT="${LIMIT:-50}"
CLOSE_STATE="cancelled"
REASON="stale Andy request archived by admin cleanup"
STATE_FILTERS=()

DEFAULT_ACTIVE_STATES=(
  queued_for_coordinator
  coordinator_active
  worker_queued
  worker_running
  worker_review_requested
  review_in_progress
  andy_patch_in_progress
)

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-reconcile-stale-andy-requests.sh [options]

Archive or close stale non-terminal Andy requests.
Defaults to dry-run; pass --apply to persist updates.

Options:
  --db <path>                 SQLite DB path (default: store/messages.db)
  --request-id <id>           Close a single request_id regardless of age
  --chat-jid <jid>            Restrict cleanup to one source chat
  --state <state>             Restrict to one non-terminal request state (repeatable)
  --stale-minutes <n>         Threshold for stale requests in batch mode (default: 180)
  --limit <n>                 Max requests to affect in batch mode (default: 50)
  --close-state <state>       Terminal state to write: cancelled|failed|completed (default: cancelled)
  --reason <text>             last_status_text to persist on closed requests
  --apply                     Apply updates (default is dry-run)
  --backup-dir <path>         Backup directory (default: data/diagnostics/db-backups)
  -h, --help                  Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

validate_safe_request_id() {
  [[ "$1" =~ ^[A-Za-z0-9._:-]+$ ]]
}

validate_safe_chat_jid() {
  [[ "$1" =~ ^[A-Za-z0-9._:@+-]+$ ]]
}

is_allowed_active_state() {
  local candidate="$1"
  local state
  for state in "${DEFAULT_ACTIVE_STATES[@]}"; do
    if [ "$state" = "$candidate" ]; then
      return 0
    fi
  done
  return 1
}

sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db)
      DB_PATH="$2"
      shift 2
      ;;
    --request-id)
      REQUEST_ID="$2"
      shift 2
      ;;
    --chat-jid)
      CHAT_JID="$2"
      shift 2
      ;;
    --state)
      STATE_FILTERS+=("$2")
      shift 2
      ;;
    --stale-minutes)
      STALE_MINUTES="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    --close-state)
      CLOSE_STATE="$2"
      shift 2
      ;;
    --reason)
      REASON="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required"
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "DB not found: $DB_PATH"
  exit 1
fi

if ! is_pos_int "$STALE_MINUTES"; then
  echo "Expected positive integer for --stale-minutes, got: $STALE_MINUTES"
  exit 1
fi

if ! is_pos_int "$LIMIT"; then
  echo "Expected positive integer for --limit, got: $LIMIT"
  exit 1
fi

if [ -n "$REQUEST_ID" ] && ! validate_safe_request_id "$REQUEST_ID"; then
  echo "Unsafe request-id (allowed: A-Za-z0-9._:-): $REQUEST_ID"
  exit 1
fi

if [ -n "$CHAT_JID" ] && ! validate_safe_chat_jid "$CHAT_JID"; then
  echo "Unsafe chat-jid (allowed: A-Za-z0-9._:@+-): $CHAT_JID"
  exit 1
fi

case "$CLOSE_STATE" in
  cancelled|failed|completed)
    ;;
  *)
    echo "Expected --close-state to be cancelled, failed, or completed; got: $CLOSE_STATE"
    exit 1
    ;;
esac

if [ "${#STATE_FILTERS[@]}" -eq 0 ]; then
  STATE_FILTERS=("${DEFAULT_ACTIVE_STATES[@]}")
fi

for state in "${STATE_FILTERS[@]}"; do
  if ! is_allowed_active_state "$state"; then
    echo "Unsupported --state for active cleanup: $state"
    exit 1
  fi
done

if ! sqlite3 "$DB_PATH" ".tables" | grep -q "andy_requests"; then
  echo "andy_requests table missing in DB: $DB_PATH"
  exit 1
fi

state_sql=""
for state in "${STATE_FILTERS[@]}"; do
  if [ -n "$state_sql" ]; then
    state_sql="$state_sql, "
  fi
  state_sql="$state_sql'$(sql_quote "$state")'"
done

where_clauses=("state IN ($state_sql)")
mode="batch"
if [ -n "$REQUEST_ID" ]; then
  where_clauses+=("request_id = '$(sql_quote "$REQUEST_ID")'")
  mode="targeted"
else
  where_clauses+=(
    "julianday(COALESCE(updated_at, created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) < julianday('now', '-${STALE_MINUTES} minutes')"
  )
fi

if [ -n "$CHAT_JID" ]; then
  where_clauses+=("chat_jid = '$(sql_quote "$CHAT_JID")'")
fi

where_sql="${where_clauses[0]}"
if [ "${#where_clauses[@]}" -gt 1 ]; then
  idx=1
  while [ "$idx" -lt "${#where_clauses[@]}" ]; do
    where_sql="$where_sql AND ${where_clauses[$idx]}"
    idx=$((idx + 1))
  done
fi

echo "== Jarvis Reconcile Stale Andy Requests =="
echo "db: $DB_PATH"
echo "mode: $mode"
if [ -n "$REQUEST_ID" ]; then
  echo "request-id: $REQUEST_ID"
else
  echo "stale threshold: ${STALE_MINUTES}m"
  echo "limit: $LIMIT"
fi
if [ -n "$CHAT_JID" ]; then
  echo "chat-jid: $CHAT_JID"
fi
echo "state filter: ${STATE_FILTERS[*]}"
echo "close-state: $CLOSE_STATE"
echo "reason: $REASON"
echo "apply mode: $([ "$APPLY" -eq 1 ] && echo yes || echo no)"

target_rows="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT request_id, chat_jid, state, COALESCE(worker_run_id, ''), COALESCE(worker_group_folder, ''), COALESCE(updated_at, created_at, ''), substr(COALESCE(user_prompt, ''), 1, 80)
FROM andy_requests
WHERE $where_sql
ORDER BY datetime(COALESCE(updated_at, created_at)) ASC
LIMIT $LIMIT;
")"

if [ -z "$target_rows" ]; then
  echo
  echo "No matching stale Andy requests found."
  exit 0
fi

declare -a target_ids=()
echo
echo "Target rows:"
while IFS='|' read -r request_id chat_jid state worker_run_id worker_group_folder updated_at prompt_excerpt; do
  [ -z "$request_id" ] && continue
  if ! validate_safe_request_id "$request_id"; then
    echo "Unsafe request_id from DB: $request_id"
    exit 1
  fi
  target_ids+=("$request_id")
  echo "  - $request_id | chat=$chat_jid | $state | run=${worker_run_id:-null} | worker=${worker_group_folder:-null} | updated=$updated_at | prompt=${prompt_excerpt:-}"
done <<<"$target_rows"

if [ "${#target_ids[@]}" -eq 0 ]; then
  echo "No valid request IDs found after parsing."
  exit 1
fi

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Dry-run only. Re-run with --apply to persist updates."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
backup_path="$BACKUP_DIR/messages.db.pre-andy-request-reconcile-$(date +%Y%m%dT%H%M%S).bak"
cp "$DB_PATH" "$backup_path"
echo
echo "Backup created: $backup_path"

reason_sql="$(sql_quote "$REASON")"

sqlite3 "$DB_PATH" "
BEGIN IMMEDIATE;
CREATE TEMP TABLE _andy_request_targets AS
SELECT request_id
FROM andy_requests
WHERE $where_sql
ORDER BY datetime(COALESCE(updated_at, created_at)) ASC
LIMIT $LIMIT;

UPDATE andy_requests
SET state = '$(sql_quote "$CLOSE_STATE")',
    last_status_text = '$reason_sql',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    closed_at = COALESCE(closed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
WHERE request_id IN (SELECT request_id FROM _andy_request_targets);

COMMIT;
"

request_in_clause=""
for id in "${target_ids[@]}"; do
  if [ -n "$request_in_clause" ]; then
    request_in_clause="$request_in_clause, "
  fi
  request_in_clause="$request_in_clause'$(sql_quote "$id")'"
done

echo
echo "Updated andy_requests:"
sqlite3 -separator '|' "$DB_PATH" "
SELECT request_id, state, COALESCE(worker_run_id, ''), updated_at, COALESCE(closed_at, ''), COALESCE(last_status_text, '')
FROM andy_requests
WHERE request_id IN ($request_in_clause)
ORDER BY datetime(updated_at) DESC;
" | while IFS='|' read -r request_id state worker_run_id updated_at closed_at last_status_text; do
  [ -z "$request_id" ] && continue
  echo "  - $request_id | $state | run=${worker_run_id:-null} | updated=$updated_at | closed=${closed_at:-null} | status=${last_status_text:-}"
done
