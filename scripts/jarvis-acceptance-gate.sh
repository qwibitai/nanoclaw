#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Prevent pyenv shim rehash failures from polluting gate command exits in restricted environments.
export PYENV_REHASH_DISABLE="${PYENV_REHASH_DISABLE:-1}"

RUN_BUILD=1
RUN_TESTS=1
RUN_CONNECTIVITY=1
RUN_LINKAGE_AUDIT=1
INCLUDE_HAPPINESS=0
HAPPINESS_USER_CONFIRMATION=""
OUT_FILE=""
LINKAGE_DB_PATH=""
LINKAGE_AUDIT_WARN_ONLY="${LINKAGE_AUDIT_WARN_ONLY:-1}"

VERIFY_ARGS=()

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-acceptance-gate.sh [options]

Deterministic acceptance gate for NanoClaw Jarvis workflows.
Runs selected checks and writes a machine-readable evidence manifest.

Options:
  --skip-build                      Skip `npm run build`
  --skip-tests                      Skip `npm test`
  --skip-connectivity               Skip `verify-worker-connectivity`
  --skip-linkage-audit              Skip `linkage-audit`
  --include-happiness               Also run user-facing happiness gate
  --happiness-user-confirmation <t> Required when --include-happiness is used
  --out <path>                      Manifest output path

verify-worker-connectivity passthrough options:
  --db <path>
  --window-minutes <n>
  --stale-queued-minutes <n>
  --stale-running-minutes <n>
  --probe-timeout-sec <n>
  --probe-poll-sec <n>
  --probe-inflight-window-minutes <n>
  --skip-prechecks

  -h, --help                        Show help
USAGE
}

is_pos_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build)
      RUN_BUILD=0
      shift
      ;;
    --skip-tests)
      RUN_TESTS=0
      shift
      ;;
    --skip-connectivity)
      RUN_CONNECTIVITY=0
      shift
      ;;
    --skip-linkage-audit)
      RUN_LINKAGE_AUDIT=0
      shift
      ;;
    --include-happiness)
      INCLUDE_HAPPINESS=1
      shift
      ;;
    --happiness-user-confirmation)
      HAPPINESS_USER_CONFIRMATION="$2"
      shift 2
      ;;
    --out)
      OUT_FILE="$2"
      shift 2
      ;;
    --db|--window-minutes|--stale-queued-minutes|--stale-running-minutes|--probe-timeout-sec|--probe-poll-sec|--probe-inflight-window-minutes)
      VERIFY_ARGS+=("$1" "$2")
      if [ "$1" = "--db" ]; then
        LINKAGE_DB_PATH="$2"
      fi
      shift 2
      ;;
    --skip-prechecks)
      VERIFY_ARGS+=("$1")
      shift
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

if [ "$RUN_BUILD" -eq 0 ] && [ "$RUN_TESTS" -eq 0 ] && [ "$RUN_CONNECTIVITY" -eq 0 ] && [ "$RUN_LINKAGE_AUDIT" -eq 0 ] && [ "$INCLUDE_HAPPINESS" -eq 0 ]; then
  echo "At least one gate check must be enabled."
  exit 1
fi

if [ "$INCLUDE_HAPPINESS" -eq 1 ]; then
  if [ "${#HAPPINESS_USER_CONFIRMATION}" -lt 3 ]; then
    echo "--happiness-user-confirmation is required (and must be explicit) when --include-happiness is used"
    exit 1
  fi
fi

RESULTS_FILE="$(mktemp /tmp/jarvis-acceptance-gate.XXXXXX.tsv)"
trap 'rm -f "$RESULTS_FILE"' EXIT

overall_fail=0
checks_total=0
checks_passed=0
checks_failed=0

run_check() {
  local check_id="$1"
  local command_str="$2"
  local start_iso end_iso start_epoch end_epoch duration_sec status log_file exit_code detail_line

  start_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  start_epoch="$(date +%s)"
  log_file="$(mktemp "/tmp/jarvis-acceptance-${check_id}.XXXXXX")"

  set +e
  if [ "$check_id" = "tests" ]; then
    # Streaming test output avoids intermittent tsx IPC EPERM failures seen when stdout/stderr are redirected in non-interactive runs.
    PYENV_REHASH_DISABLE="${PYENV_REHASH_DISABLE:-1}" bash -c "$command_str"
    exit_code=$?
    printf '%s\n' "test output streamed to console (redirection disabled for tsx IPC stability)" >"$log_file"
  else
    PYENV_REHASH_DISABLE="${PYENV_REHASH_DISABLE:-1}" bash -c "$command_str" >"$log_file" 2>&1
    exit_code=$?
  fi
  set -e

  end_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  end_epoch="$(date +%s)"
  duration_sec=$((end_epoch - start_epoch))

  checks_total=$((checks_total + 1))

  if [ "$exit_code" -eq 0 ]; then
    status="pass"
    checks_passed=$((checks_passed + 1))
    echo "[PASS] ${check_id} (${duration_sec}s)"
  else
    status="fail"
    checks_failed=$((checks_failed + 1))
    overall_fail=1
    detail_line="$(tr '\n' ' ' <"$log_file" | sed 's/[[:space:]]\+/ /g' | cut -c1-220)"
    echo "[FAIL] ${check_id} (${duration_sec}s)"
    [ -n "$detail_line" ] && echo "  detail: $detail_line"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$check_id" "$status" "$exit_code" "$start_iso" "$end_iso" "$duration_sec" "$command_str" "$log_file" >>"$RESULTS_FILE"
}

echo "== Jarvis Acceptance Gate =="
echo "repo: $ROOT_DIR"

auto_ts="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -z "$OUT_FILE" ]; then
  OUT_FILE="data/diagnostics/acceptance/acceptance-${auto_ts}.json"
fi
mkdir -p "$(dirname "$OUT_FILE")"

if [ "$RUN_BUILD" -eq 1 ]; then
  run_check "build" "npm run build"
fi

if [ "$RUN_TESTS" -eq 1 ]; then
  # Run tests with one worker to avoid intermittent tsx IPC socket EPERM failures in redirected/non-interactive gate runs.
  run_check "tests" "npm test -- --maxWorkers=1"
fi

if [ "$RUN_CONNECTIVITY" -eq 1 ]; then
  verify_cmd="bash scripts/jarvis-ops.sh verify-worker-connectivity"
  for arg in "${VERIFY_ARGS[@]}"; do
    verify_cmd+=" $(printf '%q' "$arg")"
  done
  run_check "worker_connectivity" "$verify_cmd"
fi

if [ "$RUN_LINKAGE_AUDIT" -eq 1 ]; then
  linkage_cmd="bash scripts/jarvis-ops.sh linkage-audit"
  if [ -n "$LINKAGE_DB_PATH" ]; then
    linkage_cmd+=" --db $(printf '%q' "$LINKAGE_DB_PATH")"
  fi
  if [ "$LINKAGE_AUDIT_WARN_ONLY" = "1" ]; then
    linkage_cmd+=" --warn-only"
  fi
  run_check "linkage_audit" "$linkage_cmd"
fi

if [ "$INCLUDE_HAPPINESS" -eq 1 ]; then
  escaped_confirmation="$(printf '%q' "$HAPPINESS_USER_CONFIRMATION")"
  run_check "happiness_gate" "bash scripts/jarvis-ops.sh happiness-gate --user-confirmation ${escaped_confirmation}"
fi

generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
python3 - "$RESULTS_FILE" "$OUT_FILE" "$generated_at" "$checks_total" "$checks_passed" "$checks_failed" "$overall_fail" <<'PY'
import json
import sys

results_path, out_path, generated_at, checks_total, checks_passed, checks_failed, overall_fail = sys.argv[1:8]
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
    "script": "jarvis-acceptance-gate",
    "generated_at": generated_at,
    "summary": {
        "total": int(checks_total),
        "passed": int(checks_passed),
        "failed": int(checks_failed),
        "status": "fail" if int(overall_fail) else "pass",
    },
    "checks": checks,
}

with open(out_path, "w", encoding="utf-8") as out:
    json.dump(payload, out, ensure_ascii=True, indent=2)
    out.write("\n")
PY

echo
echo "Acceptance evidence: $OUT_FILE"

if [ "$overall_fail" -ne 0 ]; then
  echo "Result: FAIL"
  exit 1
fi

echo "Result: PASS"
exit 0
