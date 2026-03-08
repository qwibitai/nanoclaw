#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.claude/progress"
STATE_FILE="$STATE_DIR/platform-loop-state.json"
WORKTREE_PATH="${NANOCLAW_PLATFORM_LOOP_WORKTREE:-$ROOT_DIR/.worktrees/platform-loop}"
WORKTREE_BRANCH="${NANOCLAW_PLATFORM_LOOP_BRANCH:-claude-platform-loop}"
BASE_BRANCH="${NANOCLAW_PLATFORM_LOOP_BASE_BRANCH:-main}"
LOOP_INTERVAL="${NANOCLAW_PLATFORM_LOOP_INTERVAL:-1h}"
LOOP_COMMAND="${NANOCLAW_PLATFORM_LOOP_COMMAND:-/platform-pickup}"
LAUNCH_LABEL="${NANOCLAW_PLATFORM_LOOP_LABEL:-com.nanoclaw.platform-loop}"
GH_ACCOUNT="${NANOCLAW_PLATFORM_GH_ACCOUNT:-ingpoc}"
CLAUDE_PERMISSION_MODE="${NANOCLAW_PLATFORM_CLAUDE_PERMISSION_MODE:-bypassPermissions}"
SESSION_RUNNER="$ROOT_DIR/scripts/workflow/run-platform-claude-session.sh"
LOG_DIR="$ROOT_DIR/logs"
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

mkdir -p "$STATE_DIR" "$LOG_DIR"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is required but not found in PATH" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not found in PATH" >&2
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  gh auth switch --user "$GH_ACCOUNT" >/dev/null
fi

if [[ ! -d "$WORKTREE_PATH" ]]; then
  mkdir -p "$(dirname "$WORKTREE_PATH")"
  git -C "$ROOT_DIR" worktree add -B "$WORKTREE_BRANCH" "$WORKTREE_PATH" "$BASE_BRANCH"
fi

mkdir -p "$WORKTREE_PATH/.claude/commands" "$WORKTREE_PATH/scripts/workflow"
cp "$ROOT_DIR/.claude/commands/platform-pickup.md" "$WORKTREE_PATH/.claude/commands/platform-pickup.md"
cp "$ROOT_DIR/scripts/workflow/platform-loop.js" "$WORKTREE_PATH/scripts/workflow/platform-loop.js"

WORKTREE_EXCLUDE_FILE="$(git -C "$WORKTREE_PATH" rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$WORKTREE_EXCLUDE_FILE")"
for pattern in \
  ".claude/commands/platform-pickup.md" \
  ".claude/scheduled_tasks.lock" \
  "scripts/workflow/platform-loop.js"
do
  if ! grep -Fqx "$pattern" "$WORKTREE_EXCLUDE_FILE" 2>/dev/null; then
    echo "$pattern" >>"$WORKTREE_EXCLUDE_FILE"
  fi
done

LOOP_PROMPT="/loop ${LOOP_INTERVAL} ${LOOP_COMMAND}"
SHELL_COMMAND="bash \"$SESSION_RUNNER\" --worktree \"$WORKTREE_PATH\" --gh-account \"$GH_ACCOUNT\" --permission-mode \"$CLAUDE_PERMISSION_MODE\" --prompt \"$LOOP_PROMPT\""

json_escape() {
  python3 - <<'PY' "$1"
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

record_state() {
  cat >"$STATE_FILE" <<EOF
{
  "label": $(json_escape "$LAUNCH_LABEL"),
  "worktree_path": $(json_escape "$WORKTREE_PATH"),
  "worktree_branch": $(json_escape "$WORKTREE_BRANCH"),
  "base_branch": $(json_escape "$BASE_BRANCH"),
  "loop_interval": $(json_escape "$LOOP_INTERVAL"),
  "loop_command": $(json_escape "$LOOP_COMMAND"),
  "github_account": $(json_escape "$GH_ACCOUNT"),
  "permission_mode": $(json_escape "$CLAUDE_PERMISSION_MODE"),
  "launched_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "shell_command": $(json_escape "$SHELL_COMMAND")
}
EOF
}

if [[ "$DRY_RUN" == "1" ]]; then
  record_state
  echo "$SHELL_COMMAND"
  exit 0
fi

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript is required to bootstrap the dedicated Claude session" >&2
  exit 1
fi

ESCAPED_COMMAND="${SHELL_COMMAND//\\/\\\\}"
ESCAPED_COMMAND="${ESCAPED_COMMAND//\"/\\\"}"

osascript -e "tell application \"Terminal\" to do script \"$ESCAPED_COMMAND\"" >/dev/null
record_state
echo "Started NanoClaw platform loop session via Terminal"
