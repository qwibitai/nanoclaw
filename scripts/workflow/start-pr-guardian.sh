#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.nanoclaw/pr-guardian"
RUNS_DIR="$STATE_DIR/runs"
STATE_FILE="$STATE_DIR/launch-state.json"
RUN_ID="$(date -u +"%Y%m%dT%H%M%SZ")"
PROMPT_FILE="$RUNS_DIR/prompt-${RUN_ID}.txt"
RUN_LOG_FILE="$RUNS_DIR/${RUN_ID}.json"
JSONL_FILE="$RUNS_DIR/${RUN_ID}.jsonl"
STDERR_FILE="$RUNS_DIR/${RUN_ID}.stderr.log"
LAST_MESSAGE_FILE="$RUNS_DIR/${RUN_ID}-last-message.json"
WORKTREE_PATH="${NANOCLAW_PR_GUARDIAN_WORKTREE:-$ROOT_DIR/.worktrees/pr-guardian}"
WORKTREE_BRANCH="${NANOCLAW_PR_GUARDIAN_BRANCH:-codex-pr-guardian}"
BASE_BRANCH="${NANOCLAW_PR_GUARDIAN_BASE_BRANCH:-main}"
REMOTE_NAME="${NANOCLAW_PR_GUARDIAN_REMOTE:-origin}"
PROFILE_NAME="${NANOCLAW_PR_GUARDIAN_PROFILE:-pr_guardian}"
GH_ACCOUNT="${NANOCLAW_PLATFORM_GH_ACCOUNT:-ingpoc}"
OUTPUT_SCHEMA_FILE="$ROOT_DIR/scripts/workflow/autonomy-pr-guardian-output-schema.json"
SYNC_HELPER="$ROOT_DIR/scripts/workflow/platform-loop-sync.sh"
AUTONOMY_HELPER="$ROOT_DIR/scripts/workflow/autonomy-lane.sh"
DRY_RUN=0

usage() {
  echo "Usage: scripts/workflow/start-pr-guardian.sh [--dry-run]"
}

json_escape() {
  python3 - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

resolve_codex_bin() {
  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return 0
  fi
  find "$HOME/.nvm/versions/node" -path '*/bin/codex' -type f 2>/dev/null | sort | tail -n 1
}

build_prompt() {
  cat >"$PROMPT_FILE" <<EOF
Run the NanoClaw autonomous Codex PR guardian lane.

Rules:
1. Only handle autonomy-managed PRs whose head branch starts with \`claude-platform-\` or \`claude-reliability-\`.
2. Work on at most one PR in this run.
3. You may patch the selected PR branch until required checks are green or the PR is explicitly blocked.
4. Never merge.
5. Never change roadmap readiness or reprioritize issues.

Execution:
1. Confirm the active GitHub account:
   - \`gh api user -q .login\`
   - if needed: \`gh auth switch --user $GH_ACCOUNT\`
2. List open PRs and filter to the autonomy branch prefixes.
3. Prefer the oldest open PR that is not already labeled \`ready-for-user-merge\` and not labeled \`autonomy-blocked\`.
4. If no eligible PR exists, return \`noop\`.
5. Review the selected PR's diff, issue linkage, and current checks.
6. If required checks or repo-fixable CI fail, check out the PR branch in this worktree, make the smallest bounded fix, run the relevant checks, commit, and push.
7. Repeat repair only while the next action is still concrete and repo-fixable inside this run.
8. If the PR is green and review-clean:
   - add or keep the \`ready-for-user-merge\` label
   - remove \`autonomy-blocked\` if present
   - leave a concise review comment with checks passed, residual risks, and explicit user merge recommendation
9. If blocked:
   - add the \`autonomy-blocked\` label
   - leave a comment naming the concrete blocker and next action
10. Return structured output matching the schema.
EOF
}

record_state() {
  local codex_bin="$1"
  local shell_command="$2"
  cat >"$STATE_FILE" <<EOF
{
  "label": "com.nanoclaw.pr-guardian",
  "profile": $(json_escape "$PROFILE_NAME"),
  "worktree_path": $(json_escape "$WORKTREE_PATH"),
  "worktree_branch": $(json_escape "$WORKTREE_BRANCH"),
  "base_branch": $(json_escape "$BASE_BRANCH"),
  "source_root": $(json_escape "$ROOT_DIR"),
  "launched_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "codex_bin": $(json_escape "$codex_bin"),
  "shell_command": $(json_escape "$shell_command")
}
EOF
}

write_run_log() {
  local status="$1"
  local notes="$2"
  cat >"$RUN_LOG_FILE" <<EOF
{
  "run_id": $(json_escape "$RUN_ID"),
  "lane": "pr-guardian",
  "status": $(json_escape "$status"),
  "profile": $(json_escape "$PROFILE_NAME"),
  "prompt_file": $(json_escape "$PROMPT_FILE"),
  "jsonl_file": $(json_escape "$JSONL_FILE"),
  "stderr_file": $(json_escape "$STDERR_FILE"),
  "summary_file": $(json_escape "$LAST_MESSAGE_FILE"),
  "ended_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "notes": $(json_escape "$notes")
}
EOF
}

cleanup_worktree() {
  local status_output=""
  if [[ ! -d "$WORKTREE_PATH" ]]; then
    return 0
  fi
  status_output="$(git -C "$WORKTREE_PATH" status --porcelain --untracked-files=normal 2>/dev/null || true)"
  if [[ -n "$status_output" ]]; then
    echo "pr-guardian: preserving dirty worktree at $WORKTREE_PATH" >&2
    printf '%s\n' "$status_output" >&2
    return 0
  fi
  git -C "$ROOT_DIR" worktree remove "$WORKTREE_PATH" >/dev/null 2>&1 || true
}

while (($#)); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$STATE_DIR" "$RUNS_DIR"
require_cmd git
require_cmd python3
require_cmd gh

if [[ ! -f "$OUTPUT_SCHEMA_FILE" ]]; then
  echo "Missing output schema: $OUTPUT_SCHEMA_FILE" >&2
  exit 1
fi

CODEX_BIN="$(resolve_codex_bin)"
if [[ -z "$CODEX_BIN" ]]; then
  echo "codex CLI is required but not found in PATH or under \$HOME/.nvm/versions/node" >&2
  exit 1
fi

build_prompt

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

SHELL_COMMAND="cd \"$WORKTREE_PATH\" && NANOCLAW_AUTONOMY_SOURCE_ROOT=\"$ROOT_DIR\" \"$CODEX_BIN\" exec --ephemeral --json -p \"$PROFILE_NAME\" -C \"$WORKTREE_PATH\" -s workspace-write -c 'approval_policy=\"never\"' -c 'sandbox_workspace_write.network_access=true' --output-schema \"$OUTPUT_SCHEMA_FILE\" -o \"$LAST_MESSAGE_FILE\" \"\$(cat \"$PROMPT_FILE\")\""
record_state "$CODEX_BIN" "$SHELL_COMMAND"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "$SHELL_COMMAND"
  exit 0
fi

set +e
LOCK_OUTPUT="$(NANOCLAW_AUTONOMY_SOURCE_ROOT="$ROOT_DIR" bash "$AUTONOMY_HELPER" run-start --lane pr-guardian 2>&1)"
LOCK_STATUS=$?
set -e
if [[ "$LOCK_STATUS" -eq 2 ]]; then
  write_run_log "noop" "guardian lane already running"
  echo "pr-guardian: already running"
  exit 0
fi
if [[ "$LOCK_STATUS" -ne 0 ]]; then
  printf '%s\n' "$LOCK_OUTPUT" >&2
  exit "$LOCK_STATUS"
fi
cleanup_lock() {
  NANOCLAW_AUTONOMY_SOURCE_ROOT="$ROOT_DIR" bash "$AUTONOMY_HELPER" run-end --lane pr-guardian >/dev/null 2>&1 || true
}
trap cleanup_lock EXIT

set +e
(
  cd "$WORKTREE_PATH" &&
    NANOCLAW_AUTONOMY_SOURCE_ROOT="$ROOT_DIR" \
      "$CODEX_BIN" exec \
      --ephemeral \
      --json \
      -p "$PROFILE_NAME" \
      -C "$WORKTREE_PATH" \
      -s workspace-write \
      -c 'approval_policy="never"' \
      -c 'sandbox_workspace_write.network_access=true' \
      --output-schema "$OUTPUT_SCHEMA_FILE" \
      -o "$LAST_MESSAGE_FILE" \
      "$(cat "$PROMPT_FILE")"
) >"$JSONL_FILE" 2>"$STDERR_FILE"
EXEC_STATUS=$?
set -e

cleanup_worktree

if [[ "$EXEC_STATUS" -ne 0 ]]; then
  write_run_log "failed" "codex exec exited $EXEC_STATUS"
  echo "pr-guardian: FAIL (codex exec exited $EXEC_STATUS)" >&2
  exit "$EXEC_STATUS"
fi

write_run_log "ok" "guardian run completed"
echo "pr-guardian: PASS"
echo "jsonl: $JSONL_FILE"
echo "summary: $LAST_MESSAGE_FILE"

