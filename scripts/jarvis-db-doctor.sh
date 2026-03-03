#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
STALE_QUEUED_MINUTES="${STALE_QUEUED_MINUTES:-20}"
STALE_RUNNING_MINUTES="${STALE_RUNNING_MINUTES:-60}"
JSON_MODE=0
JSON_OUT=""

CHECKS_FILE="$(mktemp /tmp/jarvis-db-doctor.XXXXXX)"
trap 'rm -f "$CHECKS_FILE"' EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-db-doctor.sh [options]

Read-only DB diagnostics for NanoClaw worker/session schema drift.

Options:
  --db <path>                  SQLite DB path (default: store/messages.db)
  --stale-queued-minutes <n>   Stale queued threshold (default: 20)
  --stale-running-minutes <n>  Stale running threshold (default: 60)
  --json                       Emit JSON report to stdout
  --json-out <path>            Write JSON report to file
  -h, --help                   Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

record_check() {
  local status="$1"
  local severity="$2"
  local id="$3"
  local message="$4"
  local evidence="${5:-}"
  printf '%s\t%s\t%s\t%s\t%s\n' "$status" "$severity" "$id" "$message" "$evidence" >>"$CHECKS_FILE"
}

pass() { echo "[PASS] $2"; record_check "pass" "info" "$1" "$2" "${3:-}"; }
warn() { echo "[WARN] $2"; record_check "warn" "warn" "$1" "$2" "${3:-}"; }
fail() { echo "[FAIL] $2"; record_check "fail" "critical" "$1" "$2" "${3:-}"; }

emit_json() {
  local overall fail_count warn_count
  fail_count="$(awk -F'\t' '$1=="fail"{c++} END{print c+0}' "$CHECKS_FILE")"
  warn_count="$(awk -F'\t' '$1=="warn"{c++} END{print c+0}' "$CHECKS_FILE")"
  overall="pass"
  if [ "$fail_count" -gt 0 ]; then
    overall="fail"
  elif [ "$warn_count" -gt 0 ]; then
    overall="warn"
  fi

  local json
  json=$(python3 - "$CHECKS_FILE" "$overall" <<'PY'
import json
import sys
from datetime import datetime, timezone

checks_path, overall = sys.argv[1:3]
checks = []
with open(checks_path, 'r', encoding='utf-8') as f:
    for line in f:
      s = line.rstrip('\n').split('\t')
      if len(s) < 5:
        continue
      checks.append({
        "id": s[2], "status": s[0], "severity": s[1], "message": s[3],
        "evidence": {"raw": s[4]} if s[4] else {}
      })
print(json.dumps({
  "script": "jarvis-db-doctor",
  "timestamp": datetime.now(timezone.utc).isoformat(),
  "overall_status": overall,
  "checks": checks,
  "recommendations": [
    "bash scripts/jarvis-ops.sh preflight",
    "bash scripts/jarvis-ops.sh status",
    "bash scripts/jarvis-ops.sh trace --lane andy-developer"
  ]
}, ensure_ascii=True, indent=2))
PY
)

  if [ "$JSON_MODE" -eq 1 ]; then
    echo
    echo "$json"
  fi
  if [ -n "$JSON_OUT" ]; then
    printf '%s\n' "$json" >"$JSON_OUT"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    --stale-queued-minutes) STALE_QUEUED_MINUTES="$2"; shift 2 ;;
    --stale-running-minutes) STALE_RUNNING_MINUTES="$2"; shift 2 ;;
    --json) JSON_MODE=1; shift ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

for n in "$STALE_QUEUED_MINUTES" "$STALE_RUNNING_MINUTES"; do
  if ! is_pos_int "$n"; then
    echo "Expected positive integer, got: $n"
    exit 1
  fi
done

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required"
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "DB not found: $DB_PATH"
  exit 1
fi

echo "== Jarvis DB Doctor =="
echo "db: $DB_PATH"

if sqlite3 "$DB_PATH" ".tables" | grep -q "worker_runs"; then
  pass "db.table.worker_runs" "worker_runs table exists"
else
  fail "db.table.worker_runs" "worker_runs table missing"
fi

if sqlite3 "$DB_PATH" ".tables" | grep -q "registered_groups"; then
  pass "db.table.registered_groups" "registered_groups table exists"
else
  fail "db.table.registered_groups" "registered_groups table missing"
fi

required_cols=(
  run_id group_folder status started_at completed_at result_summary error_details
  dispatch_repo dispatch_branch context_intent parent_run_id dispatch_session_id
  selected_session_id effective_session_id session_selection_source session_resume_status
)
missing=()
for col in "${required_cols[@]}"; do
  if ! sqlite3 "$DB_PATH" "PRAGMA table_info(worker_runs);" | awk -F'|' '{print $2}' | grep -qx "$col"; then
    missing+=("$col")
  fi
done
if [ "${#missing[@]}" -eq 0 ]; then
  pass "db.schema.required_columns" "required worker_runs columns are present"
else
  fail "db.schema.required_columns" "missing worker_runs columns: ${missing[*]}"
fi

required_indexes=(idx_worker_runs_folder idx_worker_runs_context_lookup idx_worker_runs_effective_session)
missing_idx=()
for idx in "${required_indexes[@]}"; do
  exists="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='${idx}';")"
  if [ "$exists" -eq 0 ]; then
    missing_idx+=("$idx")
  fi
done
if [ "${#missing_idx[@]}" -eq 0 ]; then
  pass "db.schema.required_indexes" "required worker_runs indexes are present"
else
  fail "db.schema.required_indexes" "missing indexes: ${missing_idx[*]}"
fi

rows_total="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs;")"
if [ "$rows_total" -gt 0 ]; then
  pass "db.data.worker_runs_nonempty" "worker_runs has rows ($rows_total)"
else
  warn "db.data.worker_runs_nonempty" "worker_runs has no rows"
fi

active_with_completed="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('queued','provisioning','running','stopping') AND completed_at IS NOT NULL;")"
if [ "$active_with_completed" -eq 0 ]; then
  pass "db.consistency.active_completed" "no active worker runs with completed_at"
else
  warn "db.consistency.active_completed" "active rows with completed_at found: $active_with_completed"
fi

stale_queued="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('queued','provisioning') AND julianday(started_at) < julianday('now', '-${STALE_QUEUED_MINUTES} minutes');")"
stale_running="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('running','stopping') AND julianday(started_at) < julianday('now', '-${STALE_RUNNING_MINUTES} minutes');")"

if [ "$stale_queued" -eq 0 ]; then
  pass "db.consistency.stale_queued" "no stale queued rows"
else
  warn "db.consistency.stale_queued" "stale queued rows: $stale_queued"
fi

if [ "$stale_running" -eq 0 ]; then
  pass "db.consistency.stale_running" "no stale running rows"
else
  fail "db.consistency.stale_running" "stale running rows: $stale_running"
fi

invalid_json_error_details="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE error_details IS NOT NULL AND TRIM(error_details) != '' AND json_valid(error_details)=0;")"
if [ "$invalid_json_error_details" -eq 0 ]; then
  pass "db.consistency.error_details_json" "error_details JSON validity looks good"
else
  warn "db.consistency.error_details_json" "rows with invalid error_details JSON: $invalid_json_error_details"
fi

session_cross_worker="$(sqlite3 "$DB_PATH" "
SELECT COUNT(*)
FROM (
  SELECT effective_session_id
  FROM worker_runs
  WHERE effective_session_id IS NOT NULL
    AND TRIM(effective_session_id) != ''
  GROUP BY effective_session_id
  HAVING COUNT(DISTINCT group_folder) > 1
) t;
")"
if [ "$session_cross_worker" -eq 0 ]; then
  pass "db.consistency.session_cross_worker" "no cross-worker reused effective_session_id detected"
else
  warn "db.consistency.session_cross_worker" "effective_session_id reused across workers: $session_cross_worker"
fi

echo
echo "Snapshot metrics:"
echo "  - worker_runs total: $rows_total"
echo "  - stale queued: $stale_queued"
echo "  - stale running: $stale_running"
echo "  - invalid error_details json: $invalid_json_error_details"
echo "  - cross-worker effective_session_id collisions: $session_cross_worker"

emit_json

fail_count="$(awk -F'\t' '$1=="fail"{c++} END{print c+0}' "$CHECKS_FILE")"
if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
