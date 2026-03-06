#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
WINDOW_MINUTES="${WINDOW_MINUTES:-60}"
STALE_QUEUED_MINUTES="${STALE_QUEUED_MINUTES:-20}"
STALE_RUNNING_MINUTES="${STALE_RUNNING_MINUTES:-60}"
PROBE_TIMEOUT_SEC="${PROBE_TIMEOUT_SEC:-${VERIFY_WORKER_PROBE_TIMEOUT_SEC:-480}}"
PROBE_POLL_SEC="${PROBE_POLL_SEC:-2}"
PROBE_INFLIGHT_WINDOW_MINUTES="${PROBE_INFLIGHT_WINDOW_MINUTES:-180}"
PROBE_RUNNING_WATCHDOG_MS="${WORKER_PROBE_RUNNING_STALE_MS:-360000}"
PROBE_TIMEOUT_MARGIN_SEC="${PROBE_TIMEOUT_MARGIN_SEC:-10}"
SKIP_PRECHECKS=0
SKIP_PROBE=0

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-verify-worker-connectivity.sh [options]

Options:
  --db <path>                    SQLite DB path (default: store/messages.db)
  --window-minutes <n>           Probe-result freshness window (default: 60)
  --stale-queued-minutes <n>     Stale queued threshold (default: 20)
  --stale-running-minutes <n>    Stale running threshold (default: 60)
  --probe-timeout-sec <n>        Probe timeout per worker lane (default: VERIFY_WORKER_PROBE_TIMEOUT_SEC or 480)
  --probe-poll-sec <n>           Probe poll interval (default: 2)
  --probe-inflight-window-minutes <n>
                                 Block duplicate probes when a probe run is already queued/running in this window (default: 180)
  --skip-prechecks               Skip preflight command
  --skip-probe                   Skip worker probe command
  -h, --help                     Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    --window-minutes) WINDOW_MINUTES="$2"; shift 2 ;;
    --stale-queued-minutes) STALE_QUEUED_MINUTES="$2"; shift 2 ;;
    --stale-running-minutes) STALE_RUNNING_MINUTES="$2"; shift 2 ;;
    --probe-timeout-sec) PROBE_TIMEOUT_SEC="$2"; shift 2 ;;
    --probe-poll-sec) PROBE_POLL_SEC="$2"; shift 2 ;;
    --probe-inflight-window-minutes) PROBE_INFLIGHT_WINDOW_MINUTES="$2"; shift 2 ;;
    --skip-prechecks) SKIP_PRECHECKS=1; shift ;;
    --skip-probe) SKIP_PROBE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

for n in "$WINDOW_MINUTES" "$STALE_QUEUED_MINUTES" "$STALE_RUNNING_MINUTES" "$PROBE_TIMEOUT_SEC" "$PROBE_POLL_SEC" "$PROBE_INFLIGHT_WINDOW_MINUTES"; do
  if ! is_pos_int "$n"; then
    echo "Expected positive integer, got: $n"
    exit 1
  fi
done
for n in "$PROBE_RUNNING_WATCHDOG_MS" "$PROBE_TIMEOUT_MARGIN_SEC"; do
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

echo "== Jarvis Verify Worker Connectivity =="
echo "db: $DB_PATH"
echo "window: ${WINDOW_MINUTES}m"
echo "probe timeout: ${PROBE_TIMEOUT_SEC}s per lane"
echo "probe poll: ${PROBE_POLL_SEC}s"
echo "probe inflight window: ${PROBE_INFLIGHT_WINDOW_MINUTES}m"

required_probe_timeout_sec=$(( (PROBE_RUNNING_WATCHDOG_MS + 999) / 1000 + PROBE_TIMEOUT_MARGIN_SEC ))
if [ "$PROBE_TIMEOUT_SEC" -le "$required_probe_timeout_sec" ]; then
  echo "[FAIL] probe timeout guard"
  echo "  detail: --probe-timeout-sec (${PROBE_TIMEOUT_SEC}) must be greater than running probe watchdog (${PROBE_RUNNING_WATCHDOG_MS}ms) + margin (${PROBE_TIMEOUT_MARGIN_SEC}s)"
  echo "  required: > ${required_probe_timeout_sec}s"
  exit 1
fi

overall_fail=0
preflight_fail=0
probe_fail=0
lane_fail=0
stale_fail=0

if [ "$SKIP_PRECHECKS" -eq 0 ]; then
  preflight_ok=0
  for attempt in 1 2 3; do
    if bash scripts/jarvis-ops.sh preflight >/tmp/jarvis-verify-preflight.out 2>&1; then
      preflight_ok=1
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      sleep 2
    fi
  done

  if [ "$preflight_ok" -eq 1 ]; then
    echo "[PASS] preflight"
  else
    overall_fail=1
    preflight_fail=1
    echo "[FAIL] preflight"
    echo "  detail: $(tr '\n' ' ' </tmp/jarvis-verify-preflight.out | sed 's/[[:space:]]\+/ /g')"
    if grep -q "Operation not permitted" /tmp/jarvis-verify-preflight.out; then
      echo "  hint: container runtime checks are permission-blocked in this execution context; run outside restricted sandbox."
    fi
  fi
fi

if [ "$preflight_fail" -ne 0 ]; then
  echo
  echo "Result: FAIL"
  exit 1
fi

if [ "$SKIP_PROBE" -eq 0 ]; then
  probe_ok=0
  if bash scripts/jarvis-ops.sh probe \
    --timeout "$PROBE_TIMEOUT_SEC" \
    --poll "$PROBE_POLL_SEC" \
    --inflight-window-minutes "$PROBE_INFLIGHT_WINDOW_MINUTES" \
    >/tmp/jarvis-verify-probe.out 2>&1; then
    probe_ok=1
  fi

  if [ "$probe_ok" -eq 1 ]; then
    echo "[PASS] probe dispatch"
  else
    overall_fail=1
    probe_fail=1
    echo "[FAIL] probe dispatch"
    echo "  detail: $(tr '\n' ' ' </tmp/jarvis-verify-probe.out | sed 's/[[:space:]]\+/ /g')"
  fi
fi

lanes=()
while IFS= read -r lane; do
  [ -n "$lane" ] || continue
  lanes+=("$lane")
done < <(sqlite3 "$DB_PATH" "SELECT folder FROM registered_groups WHERE folder LIKE 'jarvis-worker-%' ORDER BY folder;")
if [ "${#lanes[@]}" -eq 0 ]; then
  echo "[FAIL] no registered jarvis-worker lanes found"
  exit 1
fi

echo
echo "Lane probe evidence:"
for lane in "${lanes[@]}"; do
  row="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT run_id, status, started_at, COALESCE(completed_at, '')
FROM worker_runs
WHERE group_folder='${lane}'
  AND run_id LIKE 'probe-${lane}-%'
  AND julianday(started_at) >= julianday('now', '-${WINDOW_MINUTES} minutes')
ORDER BY started_at DESC
LIMIT 1;
")"
  if [ -z "$row" ]; then
    overall_fail=1
    lane_fail=1
    echo "[FAIL] $lane has no recent probe run in last ${WINDOW_MINUTES}m"
    continue
  fi

  IFS='|' read -r run_id status started_at completed_at <<<"$row"
  if [ "$status" = "review_requested" ] || [ "$status" = "done" ]; then
    echo "[PASS] $lane -> $status ($run_id @ $started_at)"
  else
    overall_fail=1
    lane_fail=1
    echo "[FAIL] $lane -> $status ($run_id @ $started_at)"
  fi
done

stale_queued="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('queued','provisioning') AND julianday(started_at) < julianday('now', '-${STALE_QUEUED_MINUTES} minutes');")"
stale_running="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('running','stopping') AND julianday(started_at) < julianday('now', '-${STALE_RUNNING_MINUTES} minutes');")"

echo
echo "Stale-state gate:"
if [ "$stale_queued" -eq 0 ]; then
  echo "[PASS] stale queued ($STALE_QUEUED_MINUTES m): 0"
else
  overall_fail=1
  stale_fail=1
  echo "[FAIL] stale queued ($STALE_QUEUED_MINUTES m): $stale_queued"
fi

if [ "$stale_running" -eq 0 ]; then
  echo "[PASS] stale running ($STALE_RUNNING_MINUTES m): 0"
else
  overall_fail=1
  stale_fail=1
  echo "[FAIL] stale running ($STALE_RUNNING_MINUTES m): $stale_running"
fi

if [ "$overall_fail" -ne 0 ]; then
  echo
  echo "Result: FAIL"
  exit 1
fi

echo
echo "Result: PASS"
exit 0
