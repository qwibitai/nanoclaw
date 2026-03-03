#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
LOG_PATH="${LOG_PATH:-$ROOT_DIR/logs/nanoclaw.log}"
WINDOW_MINUTES="${WINDOW_MINUTES:-180}"
STALE_QUEUED_MINUTES="${STALE_QUEUED_MINUTES:-20}"
STALE_RUNNING_MINUTES="${STALE_RUNNING_MINUTES:-60}"
STALE_INPUT_MINUTES="${STALE_INPUT_MINUTES:-10}"
TAIL_LINES="${TAIL_LINES:-2200}"

pass_count=0
warn_count=0
fail_count=0

usage() {
  cat <<'EOF'
Usage: scripts/jarvis-reliability.sh [options]

Fast reliability triage for NanoClaw/Jarvis runtime.

Options:
  --db <path>                  SQLite DB path (default: store/messages.db)
  --log <path>                 Runtime log path (default: logs/nanoclaw.log)
  --window-minutes <n>         Window for run freshness checks (default: 180)
  --stale-queued-minutes <n>   Threshold for stale queued runs (default: 20)
  --stale-running-minutes <n>  Threshold for stale running runs (default: 60)
  --stale-input-minutes <n>    Threshold for stale IPC input files (default: 10)
  --tail-lines <n>             Log tail lines for heuristics (default: 2200)
  -h, --help                   Show this help
EOF
}

pass() {
  echo "[PASS] $1"
  pass_count=$((pass_count + 1))
}

warn() {
  echo "[WARN] $1"
  warn_count=$((warn_count + 1))
}

fail() {
  echo "[FAIL] $1"
  fail_count=$((fail_count + 1))
}

info() {
  echo "[INFO] $1"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

RETRY_LAST_ERR=""
run_with_retry() {
  local attempts="$1"
  local sleep_sec="$2"
  shift 2
  local try
  local out=""
  for ((try=1; try<=attempts; try++)); do
    if out="$("$@" 2>&1)"; then
      RETRY_LAST_ERR=""
      return 0
    fi
    RETRY_LAST_ERR="$out"
    if [ "$try" -lt "$attempts" ]; then
      sleep "$sleep_sec"
    fi
  done
  return 1
}

compact_error() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-240
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db)
      DB_PATH="$2"
      shift 2
      ;;
    --log)
      LOG_PATH="$2"
      shift 2
      ;;
    --window-minutes)
      WINDOW_MINUTES="$2"
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
    --stale-input-minutes)
      STALE_INPUT_MINUTES="$2"
      shift 2
      ;;
    --tail-lines)
      TAIL_LINES="$2"
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

for value in \
  "$WINDOW_MINUTES" \
  "$STALE_QUEUED_MINUTES" \
  "$STALE_RUNNING_MINUTES" \
  "$STALE_INPUT_MINUTES" \
  "$TAIL_LINES"
do
  if ! is_pos_int "$value"; then
    echo "Expected positive integer, got: $value"
    exit 1
  fi
done

echo "== Jarvis Reliability Check =="
echo "repo: $ROOT_DIR"
echo "window: ${WINDOW_MINUTES}m"
echo

if have_cmd launchctl; then
  uid_val="$(id -u)"
  launch_dump="$(launchctl print "gui/$uid_val/com.nanoclaw" 2>/dev/null || true)"
  if echo "$launch_dump" | grep -q "state = running"; then
    pid="$(echo "$launch_dump" | awk -F'= ' '/^[[:space:]]*pid =/{print $2; exit}' | tr -d ' ')"
    pass "launchd service com.nanoclaw is running${pid:+ (pid=$pid)}"
  else
    fail "launchd service com.nanoclaw not running"
  fi
else
  warn "launchctl not available; skipped service check"
fi

if have_cmd container; then
  if run_with_retry 3 1 container system status; then
    pass "container system status OK"
  else
    fail "container system status failed (stderr: $(printf '%s' "$RETRY_LAST_ERR" | compact_error))"
  fi
  if run_with_retry 3 1 container builder status; then
    pass "container builder status OK"
  else
    fail "container builder status failed (stderr: $(printf '%s' "$RETRY_LAST_ERR" | compact_error))"
  fi

  running_nanoclaw="$(container ls -a 2>/dev/null | awk 'NR>1 && $1 ~ /^nanoclaw-/ && $5=="running" {print $1}')"
  running_count="$(printf "%s\n" "$running_nanoclaw" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$running_count" -eq 0 ]; then
    pass "no running nanoclaw-* containers"
  else
    warn "running nanoclaw containers detected ($running_count)"
    while IFS= read -r c; do
      [ -n "$c" ] && info "running container: $c"
    done <<<"$running_nanoclaw"
  fi
else
  fail "container CLI not found"
fi

if [ -f "$DB_PATH" ]; then
  pass "sqlite DB exists ($DB_PATH)"
else
  fail "sqlite DB missing ($DB_PATH)"
fi

if [ -f "$DB_PATH" ] && have_cmd sqlite3; then
  required_cols=(
    dispatch_repo
    dispatch_branch
    context_intent
    dispatch_session_id
    selected_session_id
    effective_session_id
    session_resume_status
    last_progress_summary
    last_progress_at
    steer_count
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
    pass "worker_runs schema includes session/dispatch/steering columns"
  else
    fail "worker_runs missing columns: ${missing_cols[*]}"
  fi

  if sqlite3 "$DB_PATH" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_steering_events';" 2>/dev/null | grep -q 1; then
    pass "worker_steering_events table exists"
  else
    fail "worker_steering_events table missing"
  fi

  queued_stale="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('queued','provisioning') AND julianday(started_at) < julianday('now', '-${STALE_QUEUED_MINUTES} minutes');" 2>/dev/null || echo 0)"
  running_stale="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('running','stopping') AND julianday(started_at) < julianday('now', '-${STALE_RUNNING_MINUTES} minutes');" 2>/dev/null || echo 0)"
  if [ "$queued_stale" -eq 0 ]; then
    pass "no queued worker runs older than ${STALE_QUEUED_MINUTES}m"
  else
    warn "stale queued worker runs: $queued_stale"
  fi
  if [ "$running_stale" -eq 0 ]; then
    pass "no running worker runs older than ${STALE_RUNNING_MINUTES}m"
  else
    fail "stale running worker runs: $running_stale"
  fi

  lane_rows="$(sqlite3 -separator '|' "$DB_PATH" "
WITH window_runs AS (
  SELECT * FROM worker_runs
  WHERE julianday(started_at) >= julianday('now', '-${WINDOW_MINUTES} minutes')
)
SELECT group_folder, status, COUNT(*)
FROM window_runs
WHERE group_folder LIKE 'jarvis-worker-%'
GROUP BY group_folder, status
ORDER BY group_folder, status;
")"
  if [ -n "$lane_rows" ]; then
    info "worker lane status counts (last ${WINDOW_MINUTES}m):"
    while IFS='|' read -r lane status cnt; do
      [ -n "$lane" ] && echo "  - $lane | $status | $cnt"
    done <<<"$lane_rows"
  else
    warn "no worker runs in the last ${WINDOW_MINUTES}m"
  fi

  reg_rows="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT
  r.folder,
  r.name,
  COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.chat_jid = r.jid), 'never')
FROM registered_groups r
ORDER BY r.folder;
")"
  if [ -n "$reg_rows" ]; then
    info "registered group last message timestamps:"
    while IFS='|' read -r folder name last_ts; do
      echo "  - $folder ($name): $last_ts"
    done <<<"$reg_rows"
  fi
else
  warn "sqlite3 not available; skipped schema/run checks"
fi

dispatch_block_count=0
recent_dispatch_block_count=0
if [ -d "$ROOT_DIR/data/ipc/errors" ]; then
  while IFS= read -r _; do
    dispatch_block_count=$((dispatch_block_count + 1))
  done < <(find "$ROOT_DIR/data/ipc/errors" -type f -name 'dispatch-block-*.json' 2>/dev/null)
  while IFS= read -r _; do
    recent_dispatch_block_count=$((recent_dispatch_block_count + 1))
  done < <(find "$ROOT_DIR/data/ipc/errors" -type f -name 'dispatch-block-*.json' -mmin "-${WINDOW_MINUTES}" 2>/dev/null)
fi
info "all-time dispatch-block artifacts: $dispatch_block_count"
if [ "$recent_dispatch_block_count" -eq 0 ]; then
  pass "no dispatch-block artifacts in last ${WINDOW_MINUTES}m"
else
  warn "dispatch-block artifacts in last ${WINDOW_MINUTES}m: $recent_dispatch_block_count"
  recent_block_reasons="$(rg -n '"reason_text"' "$ROOT_DIR/data/ipc/errors"/dispatch-block-*.json 2>/dev/null | tail -n 3 || true)"
  if [ -n "$recent_block_reasons" ]; then
    info "recent dispatch block reasons:"
    while IFS= read -r row; do
      [ -n "$row" ] && echo "  - $row"
    done <<<"$recent_block_reasons"
  fi
fi

ipc_json_count=0
stale_ipc_json_count=0
if [ -d "$ROOT_DIR/data/ipc" ]; then
  ipc_json_count="$(find "$ROOT_DIR/data/ipc" -type f -path '*/input/*.json' 2>/dev/null | wc -l | tr -d ' ')"
  stale_ipc_json_count="$(find "$ROOT_DIR/data/ipc" -type f -path '*/input/*.json' -mmin +"$STALE_INPUT_MINUTES" 2>/dev/null | wc -l | tr -d ' ')"
fi
if [ "$ipc_json_count" -eq 0 ]; then
  pass "no pending IPC input files"
else
  warn "pending IPC input files: $ipc_json_count"
fi
if [ "$stale_ipc_json_count" -eq 0 ]; then
  pass "no stale IPC input files older than ${STALE_INPUT_MINUTES}m"
else
  fail "stale IPC input files older than ${STALE_INPUT_MINUTES}m: $stale_ipc_json_count"
fi

if [ -f "$LOG_PATH" ]; then
  pass "runtime log exists ($LOG_PATH)"
  log_tail="$(tail -n "$TAIL_LINES" "$LOG_PATH" 2>/dev/null || true)"
  conflict_count="$(printf "%s" "$log_tail" | rg -c 'type": "replaced"|Stream Errored \(conflict\)' || true)"
  container_err_count="$(printf "%s" "$log_tail" | rg -c 'Container exited with error|Container agent error' || true)"
  schema_err_count="$(printf "%s" "$log_tail" | rg -c 'SqliteError|no such column: dispatch_repo' || true)"
  reconnect_count="$(printf "%s" "$log_tail" | rg -c 'Connection closed|Reconnecting\.\.\.' || true)"

  if [ "${schema_err_count:-0}" -gt 0 ]; then
    fail "schema/runtime errors found in recent logs (count=${schema_err_count})"
  else
    pass "no recent schema/runtime column errors in logs"
  fi

  if [ "${conflict_count:-0}" -gt 4 ]; then
    warn "high WhatsApp conflict frequency in recent logs (count=${conflict_count})"
  else
    pass "WhatsApp conflict frequency is low"
  fi

  if [ "${container_err_count:-0}" -gt 0 ]; then
    warn "container errors seen in recent logs (count=${container_err_count})"
  else
    pass "no recent container error lines in log tail"
  fi

  if [ "${reconnect_count:-0}" -gt 20 ]; then
    warn "heavy reconnect churn in recent logs (count=${reconnect_count})"
  else
    pass "reconnect churn looks normal"
  fi
else
  warn "runtime log not found ($LOG_PATH)"
fi

echo
echo "Summary: pass=$pass_count warn=$warn_count fail=$fail_count"
if [ "$fail_count" -gt 0 ]; then
  echo "Recommended next steps:"
  echo "  1) scripts/jarvis-recover.sh"
  echo "  2) scripts/jarvis-status.sh --window-minutes $WINDOW_MINUTES"
  echo "  3) scripts/jarvis-watch.sh"
  exit 1
fi

exit 0
