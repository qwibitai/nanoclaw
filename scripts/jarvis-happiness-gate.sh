#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run_status=true
forward_args=()

usage() {
  cat <<'USAGE'
Usage: scripts/jarvis-happiness-gate.sh [options] [-- <probe-args>]

Runs the Andy user-facing reliability gate:
1) runtime lane status snapshot
2) user-point-of-view probe (scripts/test-andy-user-e2e.ts)

Options:
  --skip-status   Skip jarvis status snapshot
  -h, --help      Show this help

Any remaining args are forwarded to test-andy-user-e2e.ts.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-status)
      run_status=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        forward_args+=("$1")
        shift
      done
      ;;
    *)
      forward_args+=("$1")
      shift
      ;;
  esac
done

echo "== Andy Happiness Gate =="
echo "repo: $ROOT_DIR"
echo

if [ "$run_status" = true ]; then
  bash scripts/jarvis-ops.sh status
  echo
fi

NODE_NO_WARNINGS=1 node --experimental-transform-types scripts/test-andy-user-e2e.ts "${forward_args[@]}"
echo
echo "Manual user POV check required:"
echo "  docs/workflow/nanoclaw-andy-user-happiness-gate.md (User POV Runbook)"
