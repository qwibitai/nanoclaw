#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_FILE="$ROOT_DIR/.claude/progress/platform-loop-state.json"
MAX_AGE_HOURS="${NANOCLAW_PLATFORM_LOOP_MAX_AGE_HOURS:-60}"
START_SCRIPT="$ROOT_DIR/scripts/workflow/start-platform-loop.sh"
PROCESS_MATCH="${NANOCLAW_PLATFORM_LOOP_PROCESS_MATCH:-claude.*platform-pickup}"

age_hours() {
  python3 - <<'PY' "$1"
from datetime import datetime, timezone
import sys
timestamp = sys.argv[1]
dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
delta = datetime.now(timezone.utc) - dt
print(int(delta.total_seconds() // 3600))
PY
}

launched_at=""
if [[ -f "$STATE_FILE" ]]; then
  launched_at="$(python3 - <<'PY' "$STATE_FILE"
import json,sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    print(json.load(handle).get("launched_at", ""))
PY
)"
fi

if pgrep -f "$PROCESS_MATCH" >/dev/null 2>&1; then
  if [[ -n "$launched_at" ]]; then
    age="$(age_hours "$launched_at")"
    if (( age >= MAX_AGE_HOURS )); then
      pkill -f "$PROCESS_MATCH" || true
      sleep 2
      bash "$START_SCRIPT"
      echo "rearmed"
      exit 0
    fi
  fi

  echo "healthy"
  exit 0
fi

bash "$START_SCRIPT"
echo "started"
