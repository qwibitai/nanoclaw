#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.nanoclaw/platform-loop"
STATE_FILE="$STATE_DIR/launch-state.json"
RUNS_DIR="$STATE_DIR/runs"
WORKTREE_PATH="${NANOCLAW_PLATFORM_LOOP_WORKTREE:-$ROOT_DIR/.worktrees/platform-loop}"
WORKTREE_BRANCH="${NANOCLAW_PLATFORM_LOOP_BRANCH:-claude-platform-loop}"
BASE_BRANCH="${NANOCLAW_PLATFORM_LOOP_BASE_BRANCH:-main}"
REMOTE_NAME="${NANOCLAW_PLATFORM_LOOP_REMOTE:-origin}"
LAUNCH_LABEL="${NANOCLAW_PLATFORM_LOOP_LABEL:-com.nanoclaw.platform-loop}"
GH_ACCOUNT="${NANOCLAW_PLATFORM_GH_ACCOUNT:-ingpoc}"
CLAUDE_PERMISSION_MODE="${NANOCLAW_PLATFORM_CLAUDE_PERMISSION_MODE:-bypassPermissions}"
PLAN_PATH="${NANOCLAW_AUTONOMY_PLAN_PATH:-$ROOT_DIR/.nanoclaw/autonomy/feature-plan.md}"
CLAUDE_ALLOWED_TOOLS="${NANOCLAW_PLATFORM_ALLOWED_TOOLS:-Read,Grep,Glob,Bash(bash scripts/workflow/autonomy-lane.sh:*),Bash(bash scripts/workflow/platform-loop-sync.sh:*),Bash(node scripts/workflow/platform-loop.js:*),Bash(gh auth:*),Bash(gh api:*),Bash(gh issue:*),Bash(gh pr:*),Bash(git status),Bash(git switch:*),Bash(git checkout:*),Bash(git add:*),Bash(git commit:*),Bash(git push:*),Bash(npm run build),Bash(npm test)}"
SESSION_RUNNER="$ROOT_DIR/scripts/workflow/run-platform-claude-session.sh"
SYNC_HELPER="$ROOT_DIR/scripts/workflow/platform-loop-sync.sh"
AUTONOMY_HELPER="$ROOT_DIR/scripts/workflow/autonomy-lane.sh"
LOG_DIR="$ROOT_DIR/logs"
DRY_RUN=0
RUN_ID="$(date -u +"%Y%m%dT%H%M%SZ")"
PROMPT_FILE="$RUNS_DIR/prompt-${RUN_ID}.txt"
RUN_LOG_FILE="$RUNS_DIR/${RUN_ID}.json"

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

mkdir -p "$STATE_DIR" "$RUNS_DIR" "$LOG_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not found in PATH" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is required but not found in PATH" >&2
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  gh auth switch --user "$GH_ACCOUNT" >/dev/null 2>&1 || true
fi

if [[ ! -x "$SYNC_HELPER" || ! -x "$SESSION_RUNNER" || ! -x "$AUTONOMY_HELPER" ]]; then
  echo "required workflow helper missing or not executable" >&2
  exit 1
fi

build_prompt() {
  cat >"$PROMPT_FILE" <<EOF
Run the NanoClaw autonomous Claude implementation pickup lane.

Rules:
1. Never reprioritize work. Only implement issues that Codex already marked \`Ready\`.
2. Never continue if \`bash scripts/workflow/autonomy-lane.sh pause-status\` reports \`"paused": true\`.
3. Never continue if \`node scripts/workflow/platform-loop.js next\` returns \`noop\`.
4. Never merge.
5. Work on exactly one issue in this run.

Execution:
1. Confirm the active GitHub account:
   - run \`gh api user -q .login\`
   - if needed run \`gh auth switch --user $GH_ACCOUNT\`
2. If \`$PLAN_PATH\` exists, read it for product intent only. Codex remains the sole authority for what is \`Ready\`.
3. Run \`node scripts/workflow/platform-loop.js next\`.
4. If the helper returns \`noop\`, summarize the reason and stop.
5. Read the selected issue completely and obey its scope, required checks, required evidence, and blocked conditions.
6. Generate \`request_id\`, \`run_id\`, and branch with \`node scripts/workflow/platform-loop.js ids --issue <issue-number> --title "<issue-title>"\`.
7. Move the issue to \`In Progress\` with \`Agent=claude\` and \`Review Lane=codex\`.
8. Leave an issue comment proving ownership with request/run ids and branch.
9. Implement only the scoped change on the generated branch.
10. Run the issue's required checks. If scope is incomplete or checks fail, set \`Blocked\`, write the blocker and next decision, and stop.
11. Open or update the linked PR with summary, evidence, risks, and rollback notes.
12. Move the issue to \`Review\` with next decision \`Codex PR guardian to repair/review until ready for user merge\`.
13. Leave a review handoff comment with PR URL, checks run, request/run ids, and known risks.
14. End with a concise summary naming the issue, branch, PR URL, checks run, and any known blockers.
EOF
}

write_run_log() {
  local status="$1"
  local notes="$2"
  cat >"$RUN_LOG_FILE" <<EOF
{
  "run_id": $(json_escape "$RUN_ID"),
  "lane": "platform-pickup",
  "status": $(json_escape "$status"),
  "prompt_file": $(json_escape "$PROMPT_FILE"),
  "worktree_path": $(json_escape "$WORKTREE_PATH"),
  "plan_path": $(json_escape "$PLAN_PATH"),
  "ended_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "notes": $(json_escape "$notes")
}
EOF
}

if [[ ! -x "$SYNC_HELPER" ]]; then
  echo "platform pickup sync helper is missing or not executable: $SYNC_HELPER" >&2
  exit 1
fi

sync_args=()
if [[ "$DRY_RUN" == "1" ]]; then
  sync_args+=(--dry-run)
fi
NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT="$ROOT_DIR" \
NANOCLAW_PLATFORM_LOOP_WORKTREE="$WORKTREE_PATH" \
NANOCLAW_PLATFORM_LOOP_BRANCH="$WORKTREE_BRANCH" \
NANOCLAW_PLATFORM_LOOP_BASE_BRANCH="$BASE_BRANCH" \
NANOCLAW_PLATFORM_LOOP_REMOTE="$REMOTE_NAME" \
bash "$SYNC_HELPER" "${sync_args[@]}"

build_prompt
SHELL_COMMAND="NANOCLAW_AUTONOMY_SOURCE_ROOT=\"$ROOT_DIR\" bash \"$SESSION_RUNNER\" --worktree \"$WORKTREE_PATH\" --source-root \"$ROOT_DIR\" --gh-account \"$GH_ACCOUNT\" --permission-mode \"$CLAUDE_PERMISSION_MODE\" --allowed-tools \"$CLAUDE_ALLOWED_TOOLS\" --prompt \"\$(cat \"$PROMPT_FILE\")\""

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
  "remote_name": $(json_escape "$REMOTE_NAME"),
  "source_root": $(json_escape "$ROOT_DIR"),
  "prompt_file": $(json_escape "$PROMPT_FILE"),
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

if NANOCLAW_AUTONOMY_SOURCE_ROOT="$ROOT_DIR" bash "$AUTONOMY_HELPER" pause-status | grep -q '"paused": true'; then
  record_state
  write_run_log "noop" "global pause sentinel active"
  echo "platform-loop: paused"
  exit 0
fi

set +e
LOCK_OUTPUT="$(NANOCLAW_AUTONOMY_SOURCE_ROOT="$ROOT_DIR" bash "$AUTONOMY_HELPER" run-start --lane platform-pickup 2>&1)"
LOCK_STATUS=$?
set -e

if [[ "$LOCK_STATUS" -eq 2 ]]; then
  record_state
  write_run_log "noop" "pickup lane already running"
  echo "platform-loop: already running"
  exit 0
fi

if [[ "$LOCK_STATUS" -ne 0 ]]; then
  printf '%s\n' "$LOCK_OUTPUT" >&2
  exit "$LOCK_STATUS"
fi

cleanup_lock() {
  NANOCLAW_AUTONOMY_SOURCE_ROOT="$ROOT_DIR" bash "$AUTONOMY_HELPER" run-end --lane platform-pickup >/dev/null 2>&1 || true
}
trap cleanup_lock EXIT

record_state
set +e
bash "$SESSION_RUNNER" \
  --worktree "$WORKTREE_PATH" \
  --source-root "$ROOT_DIR" \
  --gh-account "$GH_ACCOUNT" \
  --permission-mode "$CLAUDE_PERMISSION_MODE" \
  --allowed-tools "$CLAUDE_ALLOWED_TOOLS" \
  --prompt "$(cat "$PROMPT_FILE")"
RUN_STATUS=$?
set -e

if [[ "$RUN_STATUS" -eq 0 ]]; then
  write_run_log "ok" "headless pickup completed"
else
  write_run_log "failed" "headless pickup exited $RUN_STATUS"
fi

exit "$RUN_STATUS"
