#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
STALE_RUNNING_MINUTES="${STALE_RUNNING_MINUTES:-60}"
RUN_ID=""
APPLY=0
UPDATE_ANDY=1
BACKUP_DIR="$ROOT_DIR/data/diagnostics/db-backups"

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-reconcile-stale-runs.sh [options]

Reconcile stale worker_runs stuck in running/stopping state.
Defaults to dry-run; pass --apply to mutate DB rows.

Options:
  --db <path>                   SQLite DB path (default: store/messages.db)
  --run-id <id>                 Reconcile only a single run_id (targeted mode)
  --stale-running-minutes <n>   Threshold for stale runs in batch mode (default: 60)
  --apply                       Apply updates (default is dry-run)
  --no-update-andy              Do not update linked andy_requests state
  --backup-dir <path>           Backup directory (default: data/diagnostics/db-backups)
  -h, --help                    Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

validate_safe_id() {
  [[ "$1" =~ ^[A-Za-z0-9._:-]+$ ]]
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db)
      DB_PATH="$2"
      shift 2
      ;;
    --run-id)
      RUN_ID="$2"
      shift 2
      ;;
    --stale-running-minutes)
      STALE_RUNNING_MINUTES="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --no-update-andy)
      UPDATE_ANDY=0
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

if ! is_pos_int "$STALE_RUNNING_MINUTES"; then
  echo "Expected positive integer for --stale-running-minutes, got: $STALE_RUNNING_MINUTES"
  exit 1
fi

if [ -n "$RUN_ID" ] && ! validate_safe_id "$RUN_ID"; then
  echo "Unsafe run-id (allowed: A-Za-z0-9._:-): $RUN_ID"
  exit 1
fi

if [ -n "$RUN_ID" ]; then
  where_clause="run_id = '$RUN_ID' AND status IN ('running','stopping')"
  mode="targeted"
else
  where_clause="status IN ('running','stopping') AND julianday(started_at) < julianday('now', '-${STALE_RUNNING_MINUTES} minutes')"
  mode="batch"
fi

echo "== Jarvis Reconcile Stale Runs =="
echo "db: $DB_PATH"
echo "mode: $mode"
if [ -n "$RUN_ID" ]; then
  echo "run-id: $RUN_ID"
else
  echo "stale threshold: ${STALE_RUNNING_MINUTES}m"
fi
echo "update andy_requests: $([ "$UPDATE_ANDY" -eq 1 ] && echo yes || echo no)"
echo "apply mode: $([ "$APPLY" -eq 1 ] && echo yes || echo no)"

target_rows="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT run_id, group_folder, status, phase, started_at, request_id
FROM worker_runs
WHERE $where_clause
ORDER BY datetime(started_at) ASC;
")"

if [ -z "$target_rows" ]; then
  echo
  echo "No matching stale runs found."
  exit 0
fi

declare -a target_ids=()
echo
echo "Target rows:"
while IFS='|' read -r run_id group_folder status phase started_at request_id; do
  [ -z "$run_id" ] && continue
  if ! validate_safe_id "$run_id"; then
    echo "Unsafe run_id from DB: $run_id"
    exit 1
  fi
  target_ids+=("$run_id")
  echo "  - $run_id | $group_folder | $status | ${phase:-null} | $started_at | request_id=${request_id:-null}"
done <<<"$target_rows"

if [ "${#target_ids[@]}" -eq 0 ]; then
  echo "No valid target IDs found after parsing."
  exit 1
fi

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Dry-run only. Re-run with --apply to persist updates."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
backup_path="$BACKUP_DIR/messages.db.pre-stale-reconcile-$(date +%Y%m%dT%H%M%S).bak"
cp "$DB_PATH" "$backup_path"
echo
echo "Backup created: $backup_path"

andy_sql=""
if [ "$UPDATE_ANDY" -eq 1 ]; then
  andy_sql="
UPDATE andy_requests
SET state = 'failed',
    last_status_text = 'Worker run auto-closed after stale running reconciliation',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    closed_at = COALESCE(closed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
WHERE worker_run_id IN (SELECT run_id FROM _stale_targets)
  AND state NOT IN ('completed','failed','cancelled');
"
fi

sqlite3 "$DB_PATH" "
BEGIN IMMEDIATE;
CREATE TEMP TABLE _stale_targets AS
SELECT run_id FROM worker_runs WHERE $where_clause;

UPDATE worker_runs
SET status = 'failed_runtime',
    completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    result_summary = COALESCE(result_summary, 'stale running run auto-reconciled'),
    error_details = CASE
      WHEN error_details IS NULL OR TRIM(error_details) = '' OR json_valid(error_details) = 0
        THEN json_object('reason', 'stale_worker_run_watchdog', 'detail', 'auto stale run reconciliation')
      ELSE error_details
    END,
    phase = 'terminal',
    active_container_name = NULL,
    no_container_since = NULL,
    expects_followup_container = 0,
    lease_expires_at = NULL,
    stop_reason = COALESCE(stop_reason, 'auto_stale_run_reconcile')
WHERE run_id IN (SELECT run_id FROM _stale_targets);

$andy_sql
COMMIT;
"

in_clause=""
for id in "${target_ids[@]}"; do
  if [ -n "$in_clause" ]; then
    in_clause="$in_clause, "
  fi
  in_clause="$in_clause'$id'"
done

echo
echo "Reconciled worker runs:"
sqlite3 -separator '|' "$DB_PATH" "
SELECT run_id, group_folder, status, phase, completed_at, stop_reason
FROM worker_runs
WHERE run_id IN ($in_clause)
ORDER BY datetime(started_at) ASC;
" | while IFS='|' read -r run_id group_folder status phase completed_at stop_reason; do
  [ -z "$run_id" ] && continue
  echo "  - $run_id | $group_folder | $status | ${phase:-null} | ${completed_at:-null} | ${stop_reason:-null}"
done

if [ "$UPDATE_ANDY" -eq 1 ]; then
  echo
  echo "Linked andy_requests:"
  linked_rows="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT request_id, state, worker_run_id, updated_at, closed_at
FROM andy_requests
WHERE worker_run_id IN ($in_clause)
ORDER BY updated_at DESC;
")"
  if [ -z "$linked_rows" ]; then
    echo "  (none)"
  else
    while IFS='|' read -r request_id state worker_run_id updated_at closed_at; do
      [ -z "$request_id" ] && continue
      echo "  - $request_id | $state | run=$worker_run_id | updated=$updated_at | closed=${closed_at:-null}"
    done <<<"$linked_rows"
  fi
fi
