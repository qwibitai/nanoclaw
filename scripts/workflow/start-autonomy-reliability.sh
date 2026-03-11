#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.nanoclaw/reliability-loop"
RUNS_DIR="$STATE_DIR/runs"
STATE_FILE="$STATE_DIR/launch-state.json"
RUN_ID="$(date -u +"%Y%m%dT%H%M%SZ")"
PROMPT_FILE="$RUNS_DIR/prompt-${RUN_ID}.txt"
RUN_LOG_FILE="$RUNS_DIR/${RUN_ID}.json"
WORKTREE_PATH="${NANOCLAW_RELIABILITY_WORKTREE:-$ROOT_DIR/.worktrees/reliability-loop}"
WORKTREE_BRANCH="${NANOCLAW_RELIABILITY_BRANCH:-claude-reliability-loop}"
BASE_BRANCH="${NANOCLAW_RELIABILITY_BASE_BRANCH:-main}"
REMOTE_NAME="${NANOCLAW_RELIABILITY_REMOTE:-origin}"
GH_ACCOUNT="${NANOCLAW_PLATFORM_GH_ACCOUNT:-ingpoc}"
CLAUDE_PERMISSION_MODE="${NANOCLAW_RELIABILITY_CLAUDE_PERMISSION_MODE:-bypassPermissions}"
CLAUDE_ALLOWED_TOOLS="${NANOCLAW_RELIABILITY_ALLOWED_TOOLS:-Read,Grep,Glob,Bash(bash scripts/workflow/autonomy-lane.sh:*),Bash(bash scripts/workflow/platform-loop-sync.sh:*),Bash(bash scripts/jarvis-ops.sh:*),Bash(node scripts/workflow/platform-loop.js:*),Bash(gh auth:*),Bash(gh api:*),Bash(gh issue:*),Bash(gh pr:*),Bash(git status),Bash(git switch:*),Bash(git checkout:*),Bash(git add:*),Bash(git commit:*),Bash(git push:*),Bash(npm run build),Bash(npm test),Bash(node --experimental-transform-types scripts/test-andy-user-e2e.ts),Bash(node --experimental-transform-types scripts/test-main-lane-status-e2e.ts),Bash(node --experimental-transform-types scripts/test-andy-full-user-journey-e2e.ts)}"
SESSION_RUNNER="$ROOT_DIR/scripts/workflow/run-platform-claude-session.sh"
SYNC_HELPER="$ROOT_DIR/scripts/workflow/platform-loop-sync.sh"
AUTONOMY_HELPER="$ROOT_DIR/scripts/workflow/autonomy-lane.sh"
DRY_RUN=0

json_escape() {
  python3 - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

usage() {
  echo "Usage: scripts/workflow/start-autonomy-reliability.sh [--dry-run]"
}

build_prompt() {
  cat >"$PROMPT_FILE" <<EOF
Run the NanoClaw autonomous reliability lane.

Rules:
1. Always inspect fresh evidence before making a diagnosis.
2. Ignore stale historical failures from older runtimes.
3. If a concrete regression exists, set the autonomy pause sentinel and work that regression first.
4. If no concrete regression exists, run one bounded real-world soak scenario against the highest-priority autonomy PR that still lacks runtime/user-flow evidence.
5. Never mark issues \`Ready\`.
6. Never merge.

Execution:
1. Confirm the active GitHub account:
   - \`gh api user -q .login\`
   - if needed: \`gh auth switch --user $GH_ACCOUNT\`
2. Gather fresh evidence:
   - \`bash scripts/jarvis-ops.sh trace --lane andy-developer\`
   - \`bash scripts/jarvis-ops.sh incident-bundle --window-minutes 180 --lane andy-developer\`
   - inspect \`bash scripts/workflow/autonomy-lane.sh pause-status\`
3. If you find a fresh actionable regression:
   - create or update the incident record
   - set pause with \`bash scripts/workflow/autonomy-lane.sh pause-set --source reliability --reason "<short reason>" [--incident-id "<id>"]\`
   - fix it in this worktree, raise or update a PR, and summarize the blocker or evidence
4. If no fresh regression exists:
   - inspect open PRs whose branches start with \`claude-platform-\` or \`claude-reliability-\`
   - pick at most one PR that lacks runtime/user-flow coverage
   - run one real-world soak scenario through main, andy-developer, and jarvis-worker paths as applicable
   - if runtime or user-facing flow is in scope, run the relevant deterministic checks:
     - \`bash scripts/jarvis-ops.sh verify-worker-connectivity\`
     - \`bash scripts/jarvis-ops.sh linkage-audit\`
     - \`node --experimental-transform-types scripts/test-andy-user-e2e.ts\`
     - \`node --experimental-transform-types scripts/test-main-lane-status-e2e.ts\`
     - \`node --experimental-transform-types scripts/test-andy-full-user-journey-e2e.ts\` when dispatch or linkage is touched
5. If the system is healthy and the active blocker is gone, clear pause with \`bash scripts/workflow/autonomy-lane.sh pause-clear --source reliability\`.
6. Return a concise summary naming whether the run triaged a regression, patched a PR, or completed a soak scenario.
EOF
}

record_state() {
  cat >"$STATE_FILE" <<EOF
{
  "label": "com.nanoclaw.reliability-loop",
  "worktree_path": $(json_escape "$WORKTREE_PATH"),
  "worktree_branch": $(json_escape "$WORKTREE_BRANCH"),
  "base_branch": $(json_escape "$BASE_BRANCH"),
  "source_root": $(json_escape "$ROOT_DIR"),
  "launched_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")")
}
EOF
}

write_run_log() {
  local status="$1"
  local notes="$2"
  cat >"$RUN_LOG_FILE" <<EOF
{
  "run_id": $(json_escape "$RUN_ID"),
  "lane": "reliability-loop",
  "status": $(json_escape "$status"),
  "prompt_file": $(json_escape "$PROMPT_FILE"),
  "worktree_path": $(json_escape "$WORKTREE_PATH"),
  "ended_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "notes": $(json_escape "$notes")
}
EOF
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

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is required but not found in PATH" >&2
  exit 1
fi
if [[ ! -x "$SYNC_HELPER" || ! -x "$AUTONOMY_HELPER" || ! -x "$SESSION_RUNNER" ]]; then
  echo "required workflow helper missing or not executable" >&2
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

record_state
if [[ "$DRY_RUN" == "1" ]]; then
  echo "NANOCLAW_AUTONOMY_SOURCE_ROOT=\"$ROOT_DIR\" bash \"$SESSION_RUNNER\" --worktree \"$WORKTREE_PATH\" --source-root \"$ROOT_DIR\" --gh-account \"$GH_ACCOUNT\" --permission-mode \"$CLAUDE_PERMISSION_MODE\" --allowed-tools \"$CLAUDE_ALLOWED_TOOLS\" --prompt \"\$(cat \"$PROMPT_FILE\")\""
  exit 0
fi

set +e
LOCK_OUTPUT="$(NANOCLAW_AUTONOMY_SOURCE_ROOT="$ROOT_DIR" bash "$AUTONOMY_HELPER" run-start --lane reliability-loop 2>&1)"
LOCK_STATUS=$?
set -e
if [[ "$LOCK_STATUS" -eq 2 ]]; then
  write_run_log "noop" "reliability lane already running"
  echo "reliability-loop: already running"
  exit 0
fi
if [[ "$LOCK_STATUS" -ne 0 ]]; then
  printf '%s\n' "$LOCK_OUTPUT" >&2
  exit "$LOCK_STATUS"
fi
cleanup_lock() {
  NANOCLAW_AUTONOMY_SOURCE_ROOT="$ROOT_DIR" bash "$AUTONOMY_HELPER" run-end --lane reliability-loop >/dev/null 2>&1 || true
}
trap cleanup_lock EXIT

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
  write_run_log "ok" "reliability run completed"
else
  write_run_log "failed" "reliability run exited $RUN_STATUS"
fi

exit "$RUN_STATUS"
