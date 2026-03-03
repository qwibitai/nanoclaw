#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/logs/nanoclaw.log}"
STALE_QUEUED_MINUTES="${STALE_QUEUED_MINUTES:-20}"
STALE_RUNNING_MINUTES="${STALE_RUNNING_MINUTES:-60}"
LANE_INACTIVE_MINUTES="${LANE_INACTIVE_MINUTES:-180}"
JSON_MODE=0
JSON_OUT=""

pass_count=0
warn_count=0
fail_count=0

CHECKS_FILE="$(mktemp /tmp/jarvis-preflight-checks.XXXXXX)"
TMP_OUT="$(mktemp /tmp/jarvis-preflight-cmd.XXXXXX)"
trap 'rm -f "$CHECKS_FILE" "$TMP_OUT"' EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-preflight.sh [options]

Options:
  --db <path>                    SQLite DB path (default: store/messages.db)
  --env <path>                   .env path (default: .env)
  --log <path>                   Runtime log path (default: logs/nanoclaw.log)
  --stale-queued-minutes <n>     Stale queued threshold (default: 20)
  --stale-running-minutes <n>    Stale running threshold (default: 60)
  --lane-inactive-minutes <n>    Lane inactivity warning threshold (default: 180)
  --json                         Emit JSON report to stdout (in addition to human output)
  --json-out <path>              Write JSON report to file
  -h, --help                     Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//"/\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

record_check() {
  local status="$1"
  local severity="$2"
  local id="$3"
  local message="$4"
  local evidence="${5:-}"
  printf '%s\t%s\t%s\t%s\t%s\n' "$status" "$severity" "$id" "$message" "$evidence" >>"$CHECKS_FILE"
}

pass() {
  local id="$1"
  local msg="$2"
  local evidence="${3:-}"
  echo "[PASS] $msg"
  pass_count=$((pass_count + 1))
  record_check "pass" "info" "$id" "$msg" "$evidence"
}

warn() {
  local id="$1"
  local msg="$2"
  local evidence="${3:-}"
  echo "[WARN] $msg"
  warn_count=$((warn_count + 1))
  record_check "warn" "warn" "$id" "$msg" "$evidence"
}

fail() {
  local id="$1"
  local msg="$2"
  local evidence="${3:-}"
  echo "[FAIL] $msg"
  if [ -n "$evidence" ]; then
    echo "  detail: $evidence"
  fi
  fail_count=$((fail_count + 1))
  record_check "fail" "critical" "$id" "$msg" "$evidence"
}

run_check() {
  local id="$1"
  local label="$2"
  local attempts="$3"
  local sleep_sec="$4"
  shift 4
  local try err
  for ((try=1; try<=attempts; try++)); do
    if "$@" >"$TMP_OUT" 2>&1; then
      pass "$id" "$label"
      return 0
    fi
    if [ "$try" -lt "$attempts" ]; then
      sleep "$sleep_sec"
    fi
  done
  err="$(tr '\n' ' ' <"$TMP_OUT" | sed 's/[[:space:]]\+/ /g' | cut -c1-240)"
  fail "$id" "$label" "$err"
  return 1
}

emit_json() {
  local overall="pass"
  if [ "$fail_count" -gt 0 ]; then
    overall="fail"
  elif [ "$warn_count" -gt 0 ]; then
    overall="warn"
  fi

  local json
  json=$(
    python3 - "$CHECKS_FILE" "$overall" "$pass_count" "$warn_count" "$fail_count" <<'PY'
import json
import sys
from datetime import datetime, timezone

checks_path, overall, p, w, f = sys.argv[1:6]
checks = []
with open(checks_path, 'r', encoding='utf-8') as fh:
    for line in fh:
        parts = line.rstrip('\n').split('\t')
        if len(parts) < 5:
            continue
        status, severity, cid, msg, evidence = parts[:5]
        checks.append({
            "id": cid,
            "status": status,
            "severity": severity,
            "message": msg,
            "evidence": {"raw": evidence} if evidence else {}
        })

payload = {
    "script": "jarvis-preflight",
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "overall_status": overall,
    "counts": {"pass": int(p), "warn": int(w), "fail": int(f)},
    "checks": checks,
    "recommendations": [
        "bash scripts/jarvis-ops.sh status",
        "bash scripts/jarvis-ops.sh reliability",
        "bash scripts/jarvis-ops.sh recover"
    ]
}
print(json.dumps(payload, ensure_ascii=True, indent=2))
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
    --db)
      DB_PATH="$2"
      shift 2
      ;;
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --log)
      LOG_FILE="$2"
      shift 2
      ;;
    --stale-queued-minutes)
      STALE_QUEUED_MINUTES="$2"
      shift 2
      ;;
    --stale-running-minutes)
      STALE_RUNNING_MINUTES="$2"
      shift 2
      ;;
    --lane-inactive-minutes)
      LANE_INACTIVE_MINUTES="$2"
      shift 2
      ;;
    --json)
      JSON_MODE=1
      shift
      ;;
    --json-out)
      JSON_OUT="$2"
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

for n in "$STALE_QUEUED_MINUTES" "$STALE_RUNNING_MINUTES" "$LANE_INACTIVE_MINUTES"; do
  if ! is_pos_int "$n"; then
    echo "Expected positive integer, got: $n"
    exit 1
  fi
done

echo "== Jarvis Preflight =="
echo "repo: $ROOT_DIR"

auth_ok=0
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
    auth_ok=1
    pass "env.auth" ".env contains auth token(s)"
  else
    fail "env.auth" ".env missing CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY"
  fi

  if grep -Eq '^[[:space:]]*OAUTH_API_FALLBACK_ENABLED=(true|TRUE|1)$' "$ENV_FILE"; then
    if grep -Eq '^[[:space:]]*ANTHROPIC_BASE_URL=.+' "$ENV_FILE"; then
      pass "env.fallback_base_url" "fallback enabled with ANTHROPIC_BASE_URL configured"
    else
      fail "env.fallback_base_url" "fallback enabled but ANTHROPIC_BASE_URL is missing"
    fi
  fi
else
  fail "env.exists" ".env not found ($ENV_FILE)"
fi

if have_cmd launchctl; then
  uid_val="$(id -u)"
  launch_dump="$(launchctl print "gui/$uid_val/com.nanoclaw" 2>/dev/null || true)"
  if [ -z "$launch_dump" ]; then
    fail "service.launchd.registered" "launchd service com.nanoclaw not registered"
  elif echo "$launch_dump" | grep -q "state = running"; then
    service_pid="$(echo "$launch_dump" | awk -F'= ' '/^[[:space:]]*pid =/{print $2; exit}' | tr -d ' ')"
    if [[ "$service_pid" =~ ^[0-9]+$ ]] && [ "$service_pid" -gt 0 ]; then
      pass "service.launchd.running" "launchd service com.nanoclaw running (pid=$service_pid)"
    else
      pass "service.launchd.running" "launchd service com.nanoclaw running"
    fi
  else
    service_state="$(echo "$launch_dump" | awk -F'= ' '/^[[:space:]]*state =/{print $2; exit}' | tr -d ' ')"
    fail "service.launchd.running" "launchd service com.nanoclaw not running (state=${service_state:-unknown})"
  fi
else
  warn "service.launchd.available" "launchctl not available; skipping service check"
fi

if have_cmd container; then
  if ! run_check "runtime.system" "container system status" 5 2 container system status; then
    :
  fi
  if ! run_check "runtime.builder" "container builder status" 5 2 container builder status; then
    :
  fi
else
  fail "runtime.cli" "container CLI not found"
fi

if [ -f "$LOG_FILE" ]; then
  pass "log.exists" "runtime log exists ($LOG_FILE)"
  if grep -Eq 'Connected to WhatsApp|Connection closed|connection.*close' "$LOG_FILE"; then
    pass "log.wa_events" "WhatsApp connection events found in log history"
  else
    warn "log.wa_events" "No WhatsApp connection events found in runtime log"
  fi
else
  warn "log.exists" "runtime log not found ($LOG_FILE)"
fi

if [ -f "$DB_PATH" ]; then
  pass "db.exists" "sqlite DB exists ($DB_PATH)"
else
  fail "db.exists" "sqlite DB missing ($DB_PATH)"
fi

if [ -f "$DB_PATH" ] && have_cmd sqlite3; then
  if sqlite3 "$DB_PATH" ".schema worker_runs" | grep -q "CREATE TABLE"; then
    pass "db.worker_runs.table" "worker_runs table present"
  else
    fail "db.worker_runs.table" "worker_runs table missing"
  fi

  required_cols=(
    dispatch_repo
    dispatch_branch
    context_intent
    dispatch_session_id
    selected_session_id
    effective_session_id
    session_resume_status
    run_generation
    stop_reason
  )
  missing_cols=()
  for col in "${required_cols[@]}"; do
    if ! sqlite3 "$DB_PATH" "PRAGMA table_info(worker_runs);" | awk -F'|' '{print $2}' | grep -qx "$col"; then
      missing_cols+=("$col")
    fi
  done
  if [ "${#missing_cols[@]}" -eq 0 ]; then
    pass "db.worker_runs.columns" "worker_runs includes required dispatch/session columns"
  else
    fail "db.worker_runs.columns" "worker_runs missing columns: ${missing_cols[*]}"
  fi

  status_counts="$(sqlite3 "$DB_PATH" "SELECT status || ':' || COUNT(*) FROM worker_runs GROUP BY status ORDER BY status;" 2>/dev/null || true)"
  if [ -n "$status_counts" ]; then
    echo "[INFO] worker_runs status counts:"
    while IFS= read -r row; do
      [ -n "$row" ] && echo "  - $row"
    done <<<"$status_counts"
  else
    warn "db.worker_runs.rows" "worker_runs table has no rows"
  fi

  stale_queued_non_probe="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('queued','provisioning') AND run_id NOT LIKE 'probe-%' AND julianday(started_at) < julianday('now', '-${STALE_QUEUED_MINUTES} minutes');" 2>/dev/null || echo 0)"
  stale_queued_probe="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('queued','provisioning') AND run_id LIKE 'probe-%' AND julianday(started_at) < julianday('now', '-${STALE_QUEUED_MINUTES} minutes');" 2>/dev/null || echo 0)"
  stale_running="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('running','stopping') AND julianday(started_at) < julianday('now', '-${STALE_RUNNING_MINUTES} minutes');" 2>/dev/null || echo 0)"

  if [[ "$stale_queued_non_probe" =~ ^[0-9]+$ ]] && [ "$stale_queued_non_probe" -eq 0 ]; then
    pass "db.worker_runs.stale_queued" "no stale queued non-probe worker runs older than ${STALE_QUEUED_MINUTES}m"
  else
    fail "db.worker_runs.stale_queued" "stale queued non-probe worker runs detected: $stale_queued_non_probe"
  fi

  if [[ "$stale_queued_probe" =~ ^[0-9]+$ ]] && [ "$stale_queued_probe" -gt 0 ]; then
    warn "db.worker_runs.stale_queued_probe" "stale queued probe runs detected: $stale_queued_probe"
  fi

  if [[ "$stale_running" =~ ^[0-9]+$ ]] && [ "$stale_running" -eq 0 ]; then
    pass "db.worker_runs.stale_running" "no stale running worker runs older than ${STALE_RUNNING_MINUTES}m"
  else
    warn "db.worker_runs.stale_running" "long-running worker runs older than ${STALE_RUNNING_MINUTES}m: $stale_running"
  fi

  lane_rows="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT r.folder, r.name,
  COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.chat_jid = r.jid), '') AS last_ts,
  CAST((julianday('now') - julianday(COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.chat_jid = r.jid), '1970-01-01T00:00:00Z'))) * 24 * 60 AS INTEGER) AS age_minutes
FROM registered_groups r
ORDER BY r.folder;
" 2>/dev/null || true)"

  if [ -n "$lane_rows" ]; then
    echo "[INFO] lane heartbeat (last message):"
    while IFS='|' read -r folder name last_ts age_minutes; do
      [ -z "$folder" ] && continue
      echo "  - $folder ($name): ${last_ts:-never}"
      if [[ "$age_minutes" =~ ^-?[0-9]+$ ]] && [ "$age_minutes" -gt "$LANE_INACTIVE_MINUTES" ]; then
        warn "db.lane_inactive.$folder" "lane $folder inactive for ${age_minutes}m (threshold ${LANE_INACTIVE_MINUTES}m)"
      fi
    done <<<"$lane_rows"
  fi
else
  warn "db.sqlite3" "sqlite3 command not found; skipped DB checks"
fi

echo
echo "Summary: pass=$pass_count warn=$warn_count fail=$fail_count"
emit_json
if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
