#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/logs/runtime.log}"
WINDOW_MINUTES="${WINDOW_MINUTES:-30}"
TAIL_LINES="${TAIL_LINES:-2000}"
REQUIRE_DB=0
JSON_MODE=0
JSON_OUT=""

CHECKS_FILE="$(mktemp /tmp/jarvis-auth-health.XXXXXX)"
trap 'rm -f "$CHECKS_FILE"' EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-auth-health.sh [options]

Deterministic auth/quota health checks using local runtime evidence.

Options:
  --db <path>               SQLite DB path (default: store/messages.db)
  --env-file <path>         .env path (default: .env)
  --log-file <path>         Runtime log path (default: logs/runtime.log)
  --window-minutes <n>      Recency window for DB checks (default: 30)
  --tail-lines <n>          Lines from runtime log to inspect (default: 2000)
  --require-db              Fail when DB is missing/unreadable
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
    "script": "jarvis-auth-health",
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
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --window-minutes) WINDOW_MINUTES="$2"; shift 2 ;;
    --tail-lines) TAIL_LINES="$2"; shift 2 ;;
    --require-db) REQUIRE_DB=1; shift ;;
    --json) JSON_MODE=1; shift ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

for n in "$WINDOW_MINUTES" "$TAIL_LINES"; do
  if ! is_pos_int "$n"; then
    echo "Expected positive integer, got: $n"
    exit 1
  fi
done

echo "== Jarvis Auth Health =="
echo "env: $ENV_FILE"
echo "db: $DB_PATH"
echo "log: $LOG_FILE"
echo "window: ${WINDOW_MINUTES}m"

# 1) Environment token presence
if [ -f "$ENV_FILE" ]; then
  has_oauth=0
  has_api=0
  if grep -Eq '^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN=.+' "$ENV_FILE"; then
    has_oauth=1
  fi
  if grep -Eq '^[[:space:]]*ANTHROPIC_API_KEY=.+' "$ENV_FILE"; then
    has_api=1
  fi
  if [ "$has_oauth" -eq 1 ] || [ "$has_api" -eq 1 ]; then
    pass "env.auth" ".env contains required auth token(s)"
  else
    fail "env.auth" ".env missing CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY"
  fi
else
  fail "env.exists" "auth env file not found"
fi

# 2) Runtime log auth/quota errors
if [ -f "$LOG_FILE" ]; then
  log_hits="$(tail -n "$TAIL_LINES" "$LOG_FILE" | rg -i -n 'invalid api key|authentication fails|failed to authenticate|insufficient credits|oauth limit|\\b401\\b|\\b402\\b' || true)"
  if [ -n "$log_hits" ]; then
    first_hit="$(printf '%s\n' "$log_hits" | head -n 1 | cut -c1-220)"
    fail "runtime.auth_signals" "recent auth/quota error signals found in runtime log" "$first_hit"
  else
    pass "runtime.auth_signals" "no auth/quota error patterns found in recent runtime log"
  fi
else
  warn "runtime.log" "runtime log not found; skipping log-based auth signal check"
fi

# 3) DB auth/quota evidence
if [ ! -f "$DB_PATH" ]; then
  if [ "$REQUIRE_DB" -eq 1 ]; then
    fail "db.exists" "DB not found"
  else
    warn "db.exists" "DB not found; skipping DB auth signal checks"
  fi
else
  if ! command -v sqlite3 >/dev/null 2>&1; then
    if [ "$REQUIRE_DB" -eq 1 ]; then
      fail "db.sqlite3" "sqlite3 is required for DB auth signal checks"
    else
      warn "db.sqlite3" "sqlite3 missing; skipping DB auth signal checks"
    fi
  else
    if sqlite3 "$DB_PATH" ".tables" | grep -q "worker_runs"; then
      auth_hit_count="$(sqlite3 "$DB_PATH" "
SELECT COUNT(*)
FROM worker_runs
WHERE julianday(COALESCE(completed_at, started_at)) >= julianday('now', '-${WINDOW_MINUTES} minutes')
  AND (
    lower(COALESCE(error_details, '')) LIKE '%invalid api key%'
    OR lower(COALESCE(error_details, '')) LIKE '%authentication fails%'
    OR lower(COALESCE(error_details, '')) LIKE '%failed to authenticate%'
    OR lower(COALESCE(error_details, '')) LIKE '%insufficient credits%'
    OR lower(COALESCE(error_details, '')) LIKE '%oauth limit%'
    OR lower(COALESCE(result_summary, '')) LIKE '%invalid api key%'
    OR lower(COALESCE(result_summary, '')) LIKE '%authentication fails%'
    OR lower(COALESCE(result_summary, '')) LIKE '%failed to authenticate%'
    OR lower(COALESCE(result_summary, '')) LIKE '%insufficient credits%'
    OR lower(COALESCE(result_summary, '')) LIKE '%oauth limit%'
  );
")"
      if [ "${auth_hit_count:-0}" -gt 0 ]; then
        sample="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT run_id, status, substr(COALESCE(error_details, result_summary, ''), 1, 180)
FROM worker_runs
WHERE julianday(COALESCE(completed_at, started_at)) >= julianday('now', '-${WINDOW_MINUTES} minutes')
  AND (
    lower(COALESCE(error_details, '')) LIKE '%invalid api key%'
    OR lower(COALESCE(error_details, '')) LIKE '%authentication fails%'
    OR lower(COALESCE(error_details, '')) LIKE '%failed to authenticate%'
    OR lower(COALESCE(error_details, '')) LIKE '%insufficient credits%'
    OR lower(COALESCE(error_details, '')) LIKE '%oauth limit%'
    OR lower(COALESCE(result_summary, '')) LIKE '%invalid api key%'
    OR lower(COALESCE(result_summary, '')) LIKE '%authentication fails%'
    OR lower(COALESCE(result_summary, '')) LIKE '%failed to authenticate%'
    OR lower(COALESCE(result_summary, '')) LIKE '%insufficient credits%'
    OR lower(COALESCE(result_summary, '')) LIKE '%oauth limit%'
  )
ORDER BY datetime(COALESCE(completed_at, started_at)) DESC
LIMIT 1;
")"
        fail "db.auth_signals" "recent auth/quota error signals found in worker_runs (${auth_hit_count})" "${sample:-recent auth/quota evidence found}"
      else
        pass "db.auth_signals" "no auth/quota signals found in recent worker_runs window"
      fi
    else
      if [ "$REQUIRE_DB" -eq 1 ]; then
        fail "db.worker_runs" "worker_runs table missing"
      else
        warn "db.worker_runs" "worker_runs table missing; skipping DB auth signal checks"
      fi
    fi
  fi
fi

if emit_json; then
  exit 0
fi
exit 1
