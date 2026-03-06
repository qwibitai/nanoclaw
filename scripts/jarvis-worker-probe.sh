#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
TIMEOUT_SEC="${TIMEOUT_SEC:-420}"
POLL_SEC="${POLL_SEC:-2}"
INFLIGHT_WINDOW_MINUTES="${INFLIGHT_WINDOW_MINUTES:-180}"
WORKERS_FILTER="${WORKERS_FILTER:-}"
DISPATCH_FILE=""
SKIP_LINT=0
JSON_MODE=0
JSON_OUT=""

RESULTS_FILE="$(mktemp /tmp/jarvis-worker-probe.XXXXXX)"
trap 'rm -f "$RESULTS_FILE"' EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-worker-probe.sh [options]

Options:
  --workers <csv>         Probe only specific worker folders (jarvis-worker-1,jarvis-worker-2)
  --dispatch-file <path>  Use explicit dispatch JSON template file (run_id/branch auto-overridden)
  --skip-lint             Skip dispatch lint precheck
  --timeout <sec>         Timeout per worker lane (default: 180)
  --poll <sec>            Poll interval in seconds (default: 2)
  --inflight-window-minutes <n>
                           Block duplicate probes when a probe run is already active (queued/provisioning/running/stopping) within this window (default: 180)
  --db <path>             SQLite DB path (default: store/messages.db)
  --json                  Emit JSON summary to stdout
  --json-out <path>       Write JSON summary to file
  -h, --help              Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workers) WORKERS_FILTER="$2"; shift 2 ;;
    --dispatch-file) DISPATCH_FILE="$2"; shift 2 ;;
    --skip-lint) SKIP_LINT=1; shift ;;
    --timeout) TIMEOUT_SEC="$2"; shift 2 ;;
    --poll) POLL_SEC="$2"; shift 2 ;;
    --inflight-window-minutes) INFLIGHT_WINDOW_MINUTES="$2"; shift 2 ;;
    --db) DB_PATH="$2"; shift 2 ;;
    --json) JSON_MODE=1; shift ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

for value in "$TIMEOUT_SEC" "$POLL_SEC" "$INFLIGHT_WINDOW_MINUTES"; do
  if ! is_pos_int "$value"; then
    echo "Expected positive integer, got: $value"
    exit 1
  fi
done

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required"
  exit 1
fi
if [ ! -f "$DB_PATH" ]; then
  echo "DB not found: $DB_PATH"
  exit 1
fi
if [ -n "$DISPATCH_FILE" ] && [ ! -f "$DISPATCH_FILE" ]; then
  echo "Dispatch file not found: $DISPATCH_FILE"
  exit 1
fi

lane_rows=()
while IFS= read -r lane_row; do
  [ -n "$lane_row" ] || continue
  lane_rows+=("$lane_row")
done < <(
  sqlite3 -separator '|' "$DB_PATH" \
    "SELECT folder, jid FROM registered_groups WHERE folder LIKE 'jarvis-worker-%' ORDER BY folder;"
)

if [ "${#lane_rows[@]}" -eq 0 ]; then
  echo "No jarvis-worker lanes registered."
  exit 1
fi

if [ -n "$WORKERS_FILTER" ]; then
  IFS=',' read -r -a requested_lanes <<<"$WORKERS_FILTER"
  filtered=()
  for lane in "${requested_lanes[@]}"; do
    lane_trimmed="$(echo "$lane" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    for row in "${lane_rows[@]}"; do
      folder="${row%%|*}"
      if [ "$folder" = "$lane_trimmed" ]; then
        filtered+=("$row")
      fi
    done
  done
  lane_rows=("${filtered[@]}")
fi

if [ "${#lane_rows[@]}" -eq 0 ]; then
  echo "No matching worker lanes found for filter: $WORKERS_FILTER"
  exit 1
fi

mkdir -p data/ipc/andy-developer/messages

echo "== Jarvis Worker Probe =="
echo "db: $DB_PATH"
echo "timeout: ${TIMEOUT_SEC}s per lane"
echo "poll: ${POLL_SEC}s"
echo "inflight window: ${INFLIGHT_WINDOW_MINUTES}m"
[ -n "$DISPATCH_FILE" ] && echo "dispatch template: $DISPATCH_FILE"

overall_fail=0
total=0
passed=0

for row in "${lane_rows[@]}"; do
  folder="${row%%|*}"
  jid="${row#*|}"
  total=$((total + 1))

  existing_probe="$(sqlite3 -separator '|' "$DB_PATH" "
SELECT run_id, status, started_at
FROM worker_runs
WHERE group_folder='${folder}'
  AND run_id LIKE 'probe-${folder}-%'
  AND status IN ('queued', 'provisioning', 'running', 'stopping')
  AND julianday(started_at) >= julianday('now', '-${INFLIGHT_WINDOW_MINUTES} minutes')
ORDER BY started_at DESC
LIMIT 1;
")"
  if [ -n "$existing_probe" ]; then
    IFS='|' read -r existing_run_id existing_status existing_started_at <<<"$existing_probe"
    echo
    echo "[PROBE] $folder ($jid)"
    echo "  result: FAIL (existing probe in-flight)"
    echo "  in_flight_run: $existing_run_id ($existing_status @ $existing_started_at)"
    overall_fail=1
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$folder" "$jid" "$existing_run_id" "blocked_inflight_probe" "existing_inflight_probe" "" >>"$RESULTS_FILE"
    continue
  fi

  ts="$(date +%s)"
  run_id="probe-${folder}-${ts}-$RANDOM"
  request_id="req-${ts}-${folder}"
  branch="jarvis-probe-${folder}-${ts}"
  probe_file="work/${folder}-probe-${ts}.txt"
  msg_file="data/ipc/andy-developer/messages/${ts}-${folder}-probe.json"
  payload_file="$(mktemp /tmp/jarvis-probe-dispatch.XXXXXX)"

  if [ -n "$DISPATCH_FILE" ]; then
    python3 - "$DISPATCH_FILE" "$run_id" "$branch" "$request_id" <<'PY' >"$payload_file"
import json
import sys
path, run_id, branch, request_id = sys.argv[1:5]
with open(path, 'r', encoding='utf-8') as f:
    d = json.load(f)
d['run_id'] = run_id
d['branch'] = branch
if not d.get('request_id'):
    d['request_id'] = request_id
if 'context_intent' not in d:
    d['context_intent'] = 'fresh'
if 'base_branch' not in d:
    d['base_branch'] = 'main'
print(json.dumps(d, ensure_ascii=True))
PY
  else
    RUN_ID="$run_id" REQUEST_ID="$request_id" BRANCH="$branch" PROBE_FILE="$probe_file" python3 <<'PY' >"$payload_file"
import json
import os
run_id = os.environ['RUN_ID']
request_id = os.environ['REQUEST_ID']
branch = os.environ['BRANCH']
probe_file = os.environ['PROBE_FILE']
dispatch = {
    "run_id": run_id,
    "request_id": request_id,
    "task_type": "test",
    "context_intent": "fresh",
    "input": f"Create file {probe_file} with content 'probe-ok'. Run acceptance tests. Return exactly one <completion> JSON block.",
    "repo": "openclaw-gurusharan/nanoclaw",
    "base_branch": "main",
    "branch": branch,
    "acceptance_tests": [
      f"test -f {probe_file}",
      f"grep -q probe-ok {probe_file}"
    ],
    "output_contract": {
      "required_fields": [
        "run_id",
        "branch",
        "commit_sha",
        "files_changed",
        "test_result",
        "risk",
        "pr_skipped_reason"
      ]
    },
    "priority": "normal"
}
print(json.dumps(dispatch, ensure_ascii=True))
PY
  fi

  if [ "$SKIP_LINT" -eq 0 ]; then
    if [ -x "scripts/jarvis-pre-dispatch-gate.sh" ]; then
      # Probes generate the connectivity evidence that normal dispatches consume,
      # so requiring recent connectivity proof here deadlocks an empty window.
      if ! scripts/jarvis-pre-dispatch-gate.sh --file "$payload_file" --target-folder "$folder" --db "$DB_PATH" --skip-connectivity >/tmp/jarvis-probe-lint.out 2>&1; then
        echo
        echo "[PROBE] $folder ($jid)"
        echo "  run_id: $run_id"
        echo "  result: FAIL (pre-dispatch gate failed before send)"
        echo "  gate: $(tr '\n' ' ' </tmp/jarvis-probe-lint.out | sed 's/[[:space:]]\+/ /g')"
        overall_fail=1
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$folder" "$jid" "$run_id" "failed" "pre_dispatch_gate_failed" "" >>"$RESULTS_FILE"
        rm -f "$payload_file"
        continue
      fi
    elif [ -x "scripts/jarvis-dispatch-lint.sh" ]; then
      if ! scripts/jarvis-dispatch-lint.sh --file "$payload_file" --target-folder "$folder" >/tmp/jarvis-probe-lint.out 2>&1; then
        echo
        echo "[PROBE] $folder ($jid)"
        echo "  run_id: $run_id"
        echo "  result: FAIL (dispatch lint failed before send)"
        echo "  lint: $(tr '\n' ' ' </tmp/jarvis-probe-lint.out | sed 's/[[:space:]]\+/ /g')"
        overall_fail=1
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$folder" "$jid" "$run_id" "failed" "dispatch_lint_failed" "" >>"$RESULTS_FILE"
        rm -f "$payload_file"
        continue
      fi
    fi
  fi

  CHAT_JID="$jid" MSG_FILE="$msg_file" PAYLOAD_FILE="$payload_file" node <<'NODE'
const fs = require('fs');
const payload = fs.readFileSync(process.env.PAYLOAD_FILE, 'utf8');
const message = {
  type: 'message',
  chatJid: process.env.CHAT_JID,
  text: payload,
};
fs.writeFileSync(process.env.MSG_FILE, JSON.stringify(message));
NODE

  rm -f "$payload_file"

  echo
  echo "[PROBE] $folder ($jid)"
  echo "  run_id: $run_id"

  deadline=$((SECONDS + TIMEOUT_SEC))
  terminal=""
  result_line=""

  while [ "$SECONDS" -lt "$deadline" ]; do
    result_line="$(sqlite3 -separator '|' "$DB_PATH" "
      SELECT
        status,
        COALESCE(result_summary, ''),
        CASE
          WHEN json_valid(error_details) THEN
            COALESCE(NULLIF(json_extract(error_details, '$.reason'), ''), NULLIF(json_extract(error_details, '$.missing[0]'), ''))
          ELSE ''
        END,
        COALESCE(branch_name, ''),
        COALESCE(commit_sha, '')
      FROM worker_runs
      WHERE run_id='${run_id}'
      LIMIT 1;
    ")"

    if [ -n "$result_line" ]; then
      IFS='|' read -r status summary reason branch_name commit_sha <<<"$result_line"
      case "$status" in
        review_requested|done|failed_runtime|failed_timeout|failed_contract)
          terminal="$status"
          break
          ;;
      esac
    fi

    sleep "$POLL_SEC"
  done

  if [ -z "$terminal" ]; then
    echo "  result: FAIL (timeout waiting for terminal status)"
    overall_fail=1
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$folder" "$jid" "$run_id" "timeout" "timeout_waiting_terminal" "" >>"$RESULTS_FILE"
    continue
  fi

  if [ "$terminal" = "review_requested" ] || [ "$terminal" = "done" ]; then
    echo "  result: PASS ($terminal)"
    [ -n "${branch_name:-}" ] && echo "  branch: $branch_name"
    [ -n "${commit_sha:-}" ] && echo "  commit_sha: $commit_sha"
    passed=$((passed + 1))
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$folder" "$jid" "$run_id" "$terminal" "" "$commit_sha" >>"$RESULTS_FILE"
  else
    error_hint="${reason:-${summary:-unknown}}"
    echo "  result: FAIL ($terminal)"
    echo "  reason: $error_hint"
    overall_fail=1
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$folder" "$jid" "$run_id" "$terminal" "$error_hint" "$commit_sha" >>"$RESULTS_FILE"
  fi
done

echo
echo "Probe summary: pass=$passed total=$total"

if [ "$JSON_MODE" -eq 1 ] || [ -n "$JSON_OUT" ]; then
  json="$(python3 - "$RESULTS_FILE" "$passed" "$total" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, passed, total = sys.argv[1:4]
items = []
with open(path, 'r', encoding='utf-8') as f:
    for line in f:
        parts = line.rstrip('\n').split('\t')
        if len(parts) < 6:
            continue
        folder, jid, run_id, status, reason, commit_sha = parts[:6]
        items.append({
            "folder": folder,
            "jid": jid,
            "run_id": run_id,
            "status": status,
            "reason": reason,
            "commit_sha": commit_sha,
        })

payload = {
    "script": "jarvis-worker-probe",
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "summary": {
        "passed": int(passed),
        "total": int(total),
        "failed": int(total) - int(passed),
    },
    "results": items,
}
print(json.dumps(payload, ensure_ascii=True, indent=2))
PY
)"

  if [ "$JSON_MODE" -eq 1 ]; then
    echo
    echo "$json"
  fi
  if [ -n "$JSON_OUT" ]; then
    printf '%s\n' "$json" >"$JSON_OUT"
  fi
fi

if [ "$overall_fail" -ne 0 ]; then
  exit 1
fi
