#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.nanoclaw/platform-loop"
STATE_FILE="$STATE_DIR/manual-pickup-state.json"
START_SCRIPT="$ROOT_DIR/scripts/workflow/start-platform-loop.sh"
DRY_RUN=0

while (($#)); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$STATE_DIR"

SHELL_COMMAND="NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT=\"$ROOT_DIR\" NANOCLAW_PLATFORM_LOOP_WORKTREE=\"$WORKTREE_PATH\" NANOCLAW_PLATFORM_LOOP_BRANCH=\"$WORKTREE_BRANCH\" NANOCLAW_PLATFORM_LOOP_BASE_BRANCH=\"$BASE_BRANCH\" NANOCLAW_PLATFORM_LOOP_REMOTE=\"$REMOTE_NAME\" bash \"$SESSION_RUNNER\" --worktree \"$WORKTREE_PATH\" --gh-account \"$GH_ACCOUNT\" --permission-mode \"$CLAUDE_PERMISSION_MODE\" --prompt \"$PICKUP_COMMAND\""

json_escape() {
  python3 - <<'PY' "$1"
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

record_state() {
  cat >"$STATE_FILE" <<EOF
{
  "launched_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "source_root": $(json_escape "$ROOT_DIR"),
  "start_script": $(json_escape "$START_SCRIPT")
}
EOF
}

if [[ "$DRY_RUN" == "1" ]]; then
  record_state
  bash "$START_SCRIPT" --dry-run
  exit 0
fi

record_state
bash "$START_SCRIPT"
