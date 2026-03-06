#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
MAX_AGE_SECONDS="${MAX_AGE_SECONDS:-90}"
SAMPLE_LIMIT="${SAMPLE_LIMIT:-20}"
WARN_ONLY=0
JSON_MODE=0
JSON_OUT=""

CHECKS_FILE="$(mktemp /tmp/jarvis-linkage-audit.XXXXXX)"
trap 'rm -f "$CHECKS_FILE"' EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-linkage-audit.sh [options]

Detects request->worker linkage gaps in andy_requests/worker_runs.

Options:
  --db <path>               SQLite DB path (default: store/messages.db)
  --max-age-seconds <n>     Max allowed age for unlinked active requests (default: 90)
  --sample-limit <n>        Sample row limit in evidence output (default: 20)
  --warn-only               Downgrade blocking failures to warnings
  --json                    Emit JSON report to stdout
  --json-out <path>         Write JSON report to file
  -h, --help                Show help
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
mark_blocking() {
  local id="$1"
  local message="$2"
  local evidence="${3:-}"
  if [ "$WARN_ONLY" -eq 1 ]; then
    warn "$id" "$message" "$evidence"
  else
    fail "$id" "$message" "$evidence"
  fi
}

emit_json() {
  local fail_count warn_count overall json
  fail_count="$(awk -F'\t' '$1=="fail"{c++} END{print c+0}' "$CHECKS_FILE")"
  warn_count="$(awk -F'\t' '$1=="warn"{c++} END{print c+0}' "$CHECKS_FILE")"
  overall="pass"
  if [ "$fail_count" -gt 0 ]; then
    overall="fail"
  elif [ "$warn_count" -gt 0 ]; then
    overall="warn"
  fi

  json="$(python3 - "$CHECKS_FILE" "$overall" <<'PY'
import json
import sys
from datetime import datetime, timezone

checks_path, overall = sys.argv[1:3]
checks = []
with open(checks_path, 'r', encoding='utf-8') as f:
    for line in f:
        parts = line.rstrip('\n').split('\t')
        if len(parts) < 5:
            continue
        checks.append({
            "id": parts[2],
            "status": parts[0],
            "severity": parts[1],
            "message": parts[3],
            "evidence": {"raw": parts[4]} if parts[4] else {},
        })

print(json.dumps({
    "script": "jarvis-linkage-audit",
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "overall_status": overall,
    "checks": checks,
    "recommendations": [
        "bash scripts/jarvis-ops.sh status",
        "bash scripts/jarvis-ops.sh trace --lane andy-developer",
        "bash scripts/jarvis-ops.sh incident-bundle --incident-id <id>"
    ]
}, ensure_ascii=True, indent=2))
PY
)"

  if [ "$JSON_MODE" -eq 1 ]; then
    echo
    echo "$json"
  fi
  if [ -n "$JSON_OUT" ]; then
    printf '%s\n' "$json" >"$JSON_OUT"
  fi

  if [ "$overall" = "fail" ]; then
    return 1
  fi
  return 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    --max-age-seconds) MAX_AGE_SECONDS="$2"; shift 2 ;;
    --sample-limit) SAMPLE_LIMIT="$2"; shift 2 ;;
    --warn-only) WARN_ONLY=1; shift ;;
    --json) JSON_MODE=1; shift ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

for n in "$MAX_AGE_SECONDS" "$SAMPLE_LIMIT"; do
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

echo "== Jarvis Linkage Audit =="
echo "db: $DB_PATH"
echo "max-age: ${MAX_AGE_SECONDS}s"

if ! sqlite3 "$DB_PATH" ".tables" | grep -q "andy_requests"; then
  mark_blocking "db.andy_requests" "andy_requests table missing"
  emit_json || true
  if [ "$WARN_ONLY" -eq 1 ]; then
    exit 0
  fi
  exit 1
fi

if ! sqlite3 "$DB_PATH" ".tables" | grep -q "worker_runs"; then
  mark_blocking "db.worker_runs" "worker_runs table missing"
  emit_json || true
  if [ "$WARN_ONLY" -eq 1 ]; then
    exit 0
  fi
  exit 1
fi

stale_unlinked_count="$(sqlite3 "$DB_PATH" "
SELECT COUNT(*)
FROM andy_requests
WHERE (worker_run_id IS NULL OR TRIM(worker_run_id) = '')
  AND state NOT IN ('completed', 'failed', 'cancelled')
  AND julianday(COALESCE(updated_at, created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      < julianday('now', '-${MAX_AGE_SECONDS} seconds');
")"

if [ "${stale_unlinked_count:-0}" -gt 0 ]; then
  stale_sample="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT request_id, state, COALESCE(updated_at, created_at, '') AS ts
FROM andy_requests
WHERE (worker_run_id IS NULL OR TRIM(worker_run_id) = '')
  AND state NOT IN ('completed', 'failed', 'cancelled')
  AND julianday(COALESCE(updated_at, created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      < julianday('now', '-${MAX_AGE_SECONDS} seconds')
ORDER BY datetime(COALESCE(updated_at, created_at)) ASC
LIMIT ${SAMPLE_LIMIT};
")"
  first_line="$(printf '%s\n' "$stale_sample" | head -n 1)"
  mark_blocking "linkage.stale_unlinked" "stale unlinked active requests detected: ${stale_unlinked_count}" "${first_line:-stale unlinked requests present}"
else
  pass "linkage.stale_unlinked" "no stale unlinked active requests"
fi

orphan_link_count="$(sqlite3 "$DB_PATH" "
SELECT COUNT(*)
FROM andy_requests r
WHERE r.worker_run_id IS NOT NULL
  AND TRIM(r.worker_run_id) != ''
  AND r.state NOT IN ('completed', 'failed', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM worker_runs w WHERE w.run_id = r.worker_run_id
  );
")"

if [ "${orphan_link_count:-0}" -gt 0 ]; then
  orphan_sample="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT request_id, state, worker_run_id
FROM andy_requests r
WHERE r.worker_run_id IS NOT NULL
  AND TRIM(r.worker_run_id) != ''
  AND r.state NOT IN ('completed', 'failed', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM worker_runs w WHERE w.run_id = r.worker_run_id
  )
ORDER BY datetime(COALESCE(updated_at, created_at)) DESC
LIMIT ${SAMPLE_LIMIT};
")"
  first_line="$(printf '%s\n' "$orphan_sample" | head -n 1)"
  mark_blocking "linkage.orphan_worker_run" "andy_requests references missing worker_runs rows: ${orphan_link_count}" "${first_line:-orphan worker_run_id references present}"
else
  pass "linkage.orphan_worker_run" "all linked worker_run_id values resolve to worker_runs rows"
fi

active_count="$(sqlite3 "$DB_PATH" "
SELECT COUNT(*)
FROM andy_requests
WHERE state NOT IN ('completed', 'failed', 'cancelled');
")"
pass "linkage.active_requests" "active request count: ${active_count}"

if emit_json; then
  exit 0
fi
exit 1
