#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_BUILD=0
KEEP_LOG=0

usage() {
  cat <<'EOF'
Usage: scripts/jarvis-smoke.sh [options]

Options:
  --skip-build  Skip worker image rebuild.
  --keep-log    Keep smoke output log file.
  -h, --help    Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --keep-log)
      KEEP_LOG=1
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

log_file="$(mktemp /tmp/jarvis-smoke.XXXXXX.log)"
cleanup() {
  if [ "$KEEP_LOG" -eq 0 ]; then
    rm -f "$log_file"
  fi
}
trap cleanup EXIT

echo "== Jarvis Smoke =="
echo "log: $log_file"

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "[STEP] rebuild worker image"
  ./container/worker/build.sh
  echo "[PASS] rebuild worker image"
else
  echo "[INFO] skipping worker image rebuild"
fi

echo "[STEP] run worker e2e smoke"
set +e
npx tsx scripts/test-worker-e2e.ts 2>&1 | tee "$log_file"
smoke_rc=${PIPESTATUS[0]}
set -e

andy_image="$(grep -E '^andy_image:' "$log_file" | tail -n1 | sed 's/^andy_image:[[:space:]]*//')"
worker_image="$(grep -E '^worker_image:' "$log_file" | tail -n1 | sed 's/^worker_image:[[:space:]]*//')"
dispatch_status="$(grep -E '^dispatch_validation:' "$log_file" | tail -n1 | sed 's/^dispatch_validation:[[:space:]]*//')"
completion_issue="$(grep -E '^completion validation failed:' "$log_file" | tail -n1 | sed 's/^completion validation failed:[[:space:]]*//')"
worker_preview="$(grep -E '^worker_output_preview:' "$log_file" | tail -n1 | sed 's/^worker_output_preview:[[:space:]]*//')"

echo
echo "Smoke summary:"
[ -n "$andy_image" ] && echo "  andy image: $andy_image"
[ -n "$worker_image" ] && echo "  worker image: $worker_image"
[ -n "$dispatch_status" ] && echo "  dispatch validation: $dispatch_status"
[ -n "$worker_preview" ] && echo "  worker preview: $worker_preview"
[ -n "$completion_issue" ] && echo "  completion issue: $completion_issue"

if [ "$smoke_rc" -eq 0 ]; then
  echo "[PASS] smoke gate"
else
  KEEP_LOG=1
  echo "[FAIL] smoke gate (exit=$smoke_rc)"
  echo "[INFO] preserved log: $log_file"
  exit "$smoke_rc"
fi

