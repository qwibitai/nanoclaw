#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START_SCRIPT="$ROOT_DIR/scripts/workflow/start-platform-loop.sh"
PROCESS_MATCH="${NANOCLAW_PLATFORM_LOOP_PROCESS_MATCH:-claude.*platform-pickup}"

start_loop() {
  local start_output
  if ! start_output="$(bash "$START_SCRIPT" 2>&1)"; then
    printf '%s\n' "$start_output" >&2
    echo "platform-loop-health: failed to run the headless pickup lane" >&2
    exit 1
  fi

  if [[ -n "$start_output" ]]; then
    printf '%s\n' "$start_output"
  fi
}

if pgrep -f "$PROCESS_MATCH" >/dev/null 2>&1; then
  echo "pickup already running"
  exit 0
fi

start_loop
echo "started"
