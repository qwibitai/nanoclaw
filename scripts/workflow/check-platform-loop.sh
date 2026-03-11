#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START_SCRIPT="$ROOT_DIR/scripts/workflow/start-platform-loop.sh"

if ! start_output="$(bash "$START_SCRIPT" 2>&1)"; then
  printf '%s\n' "$start_output" >&2
  echo "platform-loop-health: failed to run the headless pickup lane" >&2
  exit 1
fi

if [[ -n "$start_output" ]]; then
  printf '%s\n' "$start_output"
fi

echo "checked"
