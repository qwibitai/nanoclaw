#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
INPUT_FILE=""
USE_STDIN=0
TARGET_FOLDER=""
WINDOW_MINUTES="${WINDOW_MINUTES:-120}"
STALE_QUEUED_MINUTES="${STALE_QUEUED_MINUTES:-20}"
STALE_RUNNING_MINUTES="${STALE_RUNNING_MINUTES:-60}"
SKIP_AUTH_HEALTH=0
SKIP_CONNECTIVITY=0
JSON_MODE=0
JSON_OUT=""
payload_file=""
stale_check_file=""

RESULTS_FILE="$(mktemp /tmp/jarvis-pre-dispatch-gate.XXXXXX.tsv)"
cleanup() {
  rm -f "$RESULTS_FILE"
  rm -f /tmp/jarvis-pre-dispatch-gate.json
  if [ "$USE_STDIN" -eq 1 ] && [ -n "$payload_file" ]; then
    rm -f "$payload_file"
  fi
  if [ -n "$stale_check_file" ]; then
    rm -f "$stale_check_file"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-pre-dispatch-gate.sh [options]

Hard gate before dispatching work to worker lanes.

Options:
  --file <path>               Dispatch JSON file to validate
  --stdin                     Read dispatch JSON from stdin
  --target-folder <folder>    Worker folder (required)
  --db <path>                 SQLite DB path (default: store/messages.db)
  --window-minutes <n>        Connectivity evidence window (default: 120)
  --stale-queued-minutes <n>  Stale queued threshold (default: 20)
  --stale-running-minutes <n> Stale running threshold (default: 60)
  --skip-auth-health          Skip auth health check
  --skip-connectivity         Skip connectivity check
  --json                      Emit JSON report to stdout
  --json-out <path>           Write JSON report to file
  -h, --help                  Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

run_check() {
  local check_id="$1"
  local command_str="$2"
  local start_iso end_iso start_epoch end_epoch duration_sec status log_file exit_code detail_line

  start_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  start_epoch="$(date +%s)"
  log_file="$(mktemp "/tmp/jarvis-pre-dispatch-${check_id}.XXXXXX")"

  set +e
  PYENV_REHASH_DISABLE="${PYENV_REHASH_DISABLE:-1}" bash -c "$command_str" >"$log_file" 2>&1
  exit_code=$?
  set -e

  end_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  end_epoch="$(date +%s)"
  duration_sec=$((end_epoch - start_epoch))

  if [ "$exit_code" -eq 0 ]; then
    status="pass"
    echo "[PASS] ${check_id} (${duration_sec}s)"
  else
    status="fail"
    detail_line="$(tr '\n' ' ' <"$log_file" | sed 's/[[:space:]]\+/ /g' | cut -c1-260)"
    echo "[FAIL] ${check_id} (${duration_sec}s)"
    [ -n "$detail_line" ] && echo "  detail: $detail_line"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$check_id" "$status" "$exit_code" "$start_iso" "$end_iso" "$duration_sec" "$command_str" "$log_file" >>"$RESULTS_FILE"
}

emit_json() {
  local generated_at summary_status
  generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  summary_status="pass"
  if awk -F'\t' 'BEGIN { found=0 } $2=="fail" { found=1 } END { exit(found ? 0 : 1) }' "$RESULTS_FILE"; then
    summary_status="fail"
  fi

  python3 - "$RESULTS_FILE" "$generated_at" "$summary_status" <<'PY' >"/tmp/jarvis-pre-dispatch-gate.json"
import json
import sys

results_path, generated_at, summary_status = sys.argv[1:4]
checks = []
with open(results_path, "r", encoding="utf-8") as f:
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) != 8:
            continue
        check_id, status, exit_code, start_at, end_at, duration_sec, command, log_path = parts
        checks.append(
            {
                "id": check_id,
                "status": status,
                "exit_code": int(exit_code),
                "start_at": start_at,
                "end_at": end_at,
                "duration_sec": int(duration_sec),
                "command": command,
                "log_path": log_path,
            }
        )

payload = {
    "script": "jarvis-pre-dispatch-gate",
    "generated_at": generated_at,
    "summary": {
        "status": summary_status,
        "total": len(checks),
        "passed": sum(1 for c in checks if c["status"] == "pass"),
        "failed": sum(1 for c in checks if c["status"] == "fail"),
    },
    "checks": checks,
}
print(json.dumps(payload, ensure_ascii=True, indent=2))
PY

  if [ "$JSON_MODE" -eq 1 ]; then
    echo
    cat /tmp/jarvis-pre-dispatch-gate.json
  fi
  if [ -n "$JSON_OUT" ]; then
    cp /tmp/jarvis-pre-dispatch-gate.json "$JSON_OUT"
  fi

  if [ "$summary_status" = "pass" ]; then
    return 0
  fi
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) INPUT_FILE="$2"; shift 2 ;;
    --stdin) USE_STDIN=1; shift ;;
    --target-folder) TARGET_FOLDER="$2"; shift 2 ;;
    --db) DB_PATH="$2"; shift 2 ;;
    --window-minutes) WINDOW_MINUTES="$2"; shift 2 ;;
    --stale-queued-minutes) STALE_QUEUED_MINUTES="$2"; shift 2 ;;
    --stale-running-minutes) STALE_RUNNING_MINUTES="$2"; shift 2 ;;
    --skip-auth-health) SKIP_AUTH_HEALTH=1; shift ;;
    --skip-connectivity) SKIP_CONNECTIVITY=1; shift ;;
    --json) JSON_MODE=1; shift ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if [ "$USE_STDIN" -eq 0 ] && [ -z "$INPUT_FILE" ]; then
  echo "One of --file or --stdin is required"
  exit 1
fi

if [ "$USE_STDIN" -eq 1 ] && [ -n "$INPUT_FILE" ]; then
  echo "Use either --file or --stdin, not both"
  exit 1
fi

if [ -z "$TARGET_FOLDER" ]; then
  echo "--target-folder is required"
  exit 1
fi

if [ "$USE_STDIN" -eq 0 ] && [ ! -f "$INPUT_FILE" ]; then
  echo "Dispatch file not found: $INPUT_FILE"
  exit 1
fi

for n in "$WINDOW_MINUTES" "$STALE_QUEUED_MINUTES" "$STALE_RUNNING_MINUTES"; do
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

if [ "$USE_STDIN" -eq 1 ]; then
  payload_file="$(mktemp /tmp/jarvis-pre-dispatch-input.XXXXXX)"
  cat >"$payload_file"
else
  payload_file="$INPUT_FILE"
fi

echo "== Jarvis Pre-Dispatch Gate =="
echo "target folder: $TARGET_FOLDER"
echo "db: $DB_PATH"

run_check "dispatch_lint" "bash scripts/jarvis-dispatch-lint.sh --file $(printf '%q' "$payload_file") --target-folder $(printf '%q' "$TARGET_FOLDER") --strict-session-check --db $(printf '%q' "$DB_PATH")"

if [ "$SKIP_AUTH_HEALTH" -eq 0 ]; then
  run_check "auth_health" "bash scripts/jarvis-auth-health.sh --db $(printf '%q' "$DB_PATH") --require-db"
fi

if [ "$SKIP_CONNECTIVITY" -eq 0 ]; then
  run_check "worker_connectivity_fast" "bash scripts/jarvis-verify-worker-connectivity.sh --db $(printf '%q' "$DB_PATH") --skip-prechecks --skip-probe --window-minutes $(printf '%q' "$WINDOW_MINUTES") --stale-queued-minutes $(printf '%q' "$STALE_QUEUED_MINUTES") --stale-running-minutes $(printf '%q' "$STALE_RUNNING_MINUTES")"
fi

stale_check_file="$(mktemp /tmp/jarvis-pre-dispatch-stale.XXXXXX.sh)"
cat >"$stale_check_file" <<EOF
#!/usr/bin/env bash
set -euo pipefail
sq="\$(sqlite3 "$(printf '%q' "$DB_PATH")" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('queued','provisioning') AND run_id NOT LIKE 'probe-%' AND julianday(started_at) < julianday('now', '-${STALE_QUEUED_MINUTES} minutes');")"
sr="\$(sqlite3 "$(printf '%q' "$DB_PATH")" "SELECT COUNT(*) FROM worker_runs WHERE status IN ('running','stopping') AND run_id NOT LIKE 'probe-%' AND julianday(started_at) < julianday('now', '-${STALE_RUNNING_MINUTES} minutes');")"
if [ "\${sq:-0}" -gt 0 ] || [ "\${sr:-0}" -gt 0 ]; then
  echo "stale_non_probe_runs queued=\$sq running=\$sr"
  exit 1
fi
echo "stale_non_probe_runs queued=\$sq running=\$sr"
EOF
chmod +x "$stale_check_file"
run_check "stale_state_gate" "bash $(printf '%q' "$stale_check_file")"

if emit_json; then
  echo "Result: PASS"
  exit 0
fi

echo "Result: BLOCKED"
exit 2
