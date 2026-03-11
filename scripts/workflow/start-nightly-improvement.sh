#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ROOT="${NANOCLAW_NIGHTLY_SOURCE_ROOT:-$ROOT_DIR}"
STATE_DIR="$SOURCE_ROOT/.nanoclaw/nightly-improvement"
STATE_FILE="$STATE_DIR/launch-state.json"
CURSOR_STATE_FILE="$STATE_DIR/state.json"
RUNS_DIR="$STATE_DIR/runs"
WORKTREE_PATH="${NANOCLAW_NIGHTLY_WORKTREE:-$ROOT_DIR/.worktrees/nightly-improvement}"
WORKTREE_BRANCH="${NANOCLAW_NIGHTLY_WORKTREE_BRANCH:-claude-nightly-improvement}"
BASE_BRANCH="${NANOCLAW_NIGHTLY_BASE_BRANCH:-main}"
REMOTE_NAME="${NANOCLAW_NIGHTLY_REMOTE:-origin}"
CLAUDE_AGENT="${NANOCLAW_NIGHTLY_CLAUDE_AGENT:-nightly-improvement-researcher}"
CLAUDE_MODEL="${NANOCLAW_NIGHTLY_CLAUDE_MODEL:-sonnet}"
GH_ACCOUNT="${NANOCLAW_PLATFORM_GH_ACCOUNT:-ingpoc}"
CLAUDE_PERMISSION_MODE="${NANOCLAW_NIGHTLY_CLAUDE_PERMISSION_MODE:-bypassPermissions}"
CLAUDE_ALLOWED_TOOLS="${NANOCLAW_NIGHTLY_ALLOWED_TOOLS:-Read,Grep,Glob,Bash(node scripts/workflow/nightly-improvement.js:*),Bash(git fetch:*),Bash(git log:*),Bash(git rev-list:*),Bash(git rev-parse:*),Bash(git diff-tree:*),Bash(git status)}"
SYNC_HELPER="$ROOT_DIR/scripts/workflow/platform-loop-sync.sh"
DRY_RUN=0
RUN_ID="$(date -u +"%Y%m%dT%H%M%SZ")"
SCAN_FILE="$STATE_DIR/scan-${RUN_ID}.json"
PROMPT_FILE="$STATE_DIR/prompt-${RUN_ID}.txt"
CLAUDE_OUTPUT_FILE="$RUNS_DIR/${RUN_ID}-claude-output.txt"
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

mkdir -p "$STATE_DIR"
mkdir -p "$RUNS_DIR"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is required but not found in PATH" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not found in PATH" >&2
  exit 1
fi

if [[ ! -x "$SYNC_HELPER" ]]; then
  echo "nightly improvement sync helper is missing or not executable: $SYNC_HELPER" >&2
  exit 1
fi

json_escape() {
  python3 - <<'PY' "$1"
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

json_from_file() {
  local file_path="$1"
  local expression="$2"
  python3 - <<'PY' "$file_path" "$expression"
import json, pathlib, sys

file_path = pathlib.Path(sys.argv[1])
expr = sys.argv[2]

if not file_path.exists():
    print("null" if expr != "exists" else "false")
    sys.exit(0)

if expr == "exists":
    print("true")
    sys.exit(0)

data = json.loads(file_path.read_text(encoding="utf-8"))
value = data
for key in expr.split('.'):
    if not key:
        continue
    if isinstance(value, dict):
        value = value.get(key)
    else:
        value = None
        break
print(json.dumps(value))
PY
}

build_prompt() {
  cat >"$PROMPT_FILE" <<EOF
Run the NanoClaw nightly improvement evaluation.

Hard constraints:
- This is research-only. Never edit repo-tracked files, docs, or code.
- Never create Linear issues, move execution state, or open PRs.
- Update at most one upstream shared-context page and one tooling shared-context page.
- Use the worktree-local helper at \`node scripts/workflow/nightly-improvement.js\`.
- Use explicit state path: \`$CURSOR_STATE_FILE\`.
- Treat \`$SCAN_FILE\` as the primary source of truth for what changed.

Execution steps:
1. Read \`$SCAN_FILE\`.
2. If \`.upstream.pending\` is true:
   - use the scan output as the default evidence set
   - fetch extra upstream docs only when one commit still looks promising
   - pipe a concise update beginning with \`<!-- nightly-improvement:upstream -->\` into:
     \`node scripts/workflow/nightly-improvement.js upsert-context --state-path "$CURSOR_STATE_FILE" --kind upstream --body-stdin\`
   - then add one decision update with:
     \`node scripts/workflow/nightly-improvement.js append-decision --state-path "$CURSOR_STATE_FILE" --kind upstream --decision <pilot|defer|reject> --summary "<one-line summary>"\`
3. If tooling candidates are present:
   - evaluate only the listed changed tools from the scan output
   - fetch extra implementation docs only for candidates that still look relevant
   - pipe a concise update beginning with \`<!-- nightly-improvement:tooling -->\` into:
     \`node scripts/workflow/nightly-improvement.js upsert-context --state-path "$CURSOR_STATE_FILE" --kind tooling --body-stdin\`
   - then add one decision update with:
     \`node scripts/workflow/nightly-improvement.js append-decision --state-path "$CURSOR_STATE_FILE" --kind tooling --decision <pilot|defer|reject> --summary "<one-line summary>"\`
4. After the relevant context updates succeed, record state with:
   - \`node scripts/workflow/nightly-improvement.js record --state-path "$CURSOR_STATE_FILE" --scan-file "$SCAN_FILE"\`
5. End with a concise summary of:
   - whether upstream changed
   - which tools changed
   - which shared-context pages were created or updated
   - anything intentionally skipped for token efficiency

Do not broaden scope beyond the scan file.
EOF
}

record_launch_state() {
  local shell_command="$1"
  cat >"$STATE_FILE" <<EOF
{
  "runtime_mode": "headless",
  "source_root": $(json_escape "$SOURCE_ROOT"),
  "worktree_path": $(json_escape "$WORKTREE_PATH"),
  "worktree_branch": $(json_escape "$WORKTREE_BRANCH"),
  "base_branch": $(json_escape "$BASE_BRANCH"),
  "remote_name": $(json_escape "$REMOTE_NAME"),
  "agent": $(json_escape "$CLAUDE_AGENT"),
  "model": $(json_escape "$CLAUDE_MODEL"),
  "permission_mode": $(json_escape "$CLAUDE_PERMISSION_MODE"),
  "state_file": $(json_escape "$CURSOR_STATE_FILE"),
  "scan_file": $(json_escape "$SCAN_FILE"),
  "prompt_file": $(json_escape "$PROMPT_FILE"),
  "run_log_file": $(json_escape "$RUN_LOG_FILE"),
  "github_account": $(json_escape "$GH_ACCOUNT"),
  "launched_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "shell_command": $(json_escape "$shell_command")
}
EOF
}

write_run_log() {
  local status="$1"
  local started_at="$2"
  local ended_at="$3"
  local scan_action="$4"
  local notes="${5:-}"
  local context_refs_json
  context_refs_json="$(json_from_file "$CURSOR_STATE_FILE" "context_refs")"
  [[ "$context_refs_json" == "null" ]] && context_refs_json="{}"

  cat >"$RUN_LOG_FILE" <<EOF
{
  "run_id": $(json_escape "$RUN_ID"),
  "runtime_mode": "headless",
  "agent": $(json_escape "$CLAUDE_AGENT"),
  "model": $(json_escape "$CLAUDE_MODEL"),
  "status": $(json_escape "$status"),
  "started_at": $(json_escape "$started_at"),
  "ended_at": $(json_escape "$ended_at"),
  "scan_action": $(json_escape "$scan_action"),
  "scan_file": $(json_escape "$SCAN_FILE"),
  "prompt_file": $(json_escape "$PROMPT_FILE"),
  "claude_output_file": $(json_escape "$CLAUDE_OUTPUT_FILE"),
  "context_refs": $context_refs_json,
  "notes": $(json_escape "$notes")
}
EOF
}

sync_args=()
if [[ "$DRY_RUN" == "1" ]]; then
  sync_args+=(--dry-run)
fi
NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT="$SOURCE_ROOT" \
NANOCLAW_PLATFORM_LOOP_WORKTREE="$WORKTREE_PATH" \
NANOCLAW_PLATFORM_LOOP_BRANCH="$WORKTREE_BRANCH" \
NANOCLAW_PLATFORM_LOOP_BASE_BRANCH="$BASE_BRANCH" \
NANOCLAW_PLATFORM_LOOP_REMOTE="$REMOTE_NAME" \
bash "$SYNC_HELPER" "${sync_args[@]}"

build_prompt
SHELL_COMMAND="cd \"$WORKTREE_PATH\" && claude -p --agent \"$CLAUDE_AGENT\" --model \"$CLAUDE_MODEL\" --permission-mode \"$CLAUDE_PERMISSION_MODE\" --allowedTools \"$CLAUDE_ALLOWED_TOOLS\" --add-dir \"$SOURCE_ROOT\" \"\$(cat \"$PROMPT_FILE\")\""
record_launch_state "$SHELL_COMMAND"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "$SHELL_COMMAND"
  exit 0
fi

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
node "$SOURCE_ROOT/scripts/workflow/nightly-improvement.js" \
  scan \
  --state-path "$CURSOR_STATE_FILE" \
  --output "$SCAN_FILE"

SCAN_ACTION="$(
  python3 - <<'PY' "$(json_from_file "$SCAN_FILE" "action")"
import json, sys
print(json.loads(sys.argv[1]) or "")
PY
)"

if [[ "$SCAN_ACTION" == "noop" ]]; then
  node "$SOURCE_ROOT/scripts/workflow/nightly-improvement.js" \
    record \
    --state-path "$CURSOR_STATE_FILE" \
    --scan-file "$SCAN_FILE" >/dev/null
  ENDED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_run_log "noop" "$STARTED_AT" "$ENDED_AT" "$SCAN_ACTION" "scan returned noop; headless Claude was not invoked"
  echo "Nightly improvement: noop"
  exit 0
fi

if [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "Nightly improvement worktree path does not exist after sync: $WORKTREE_PATH" >&2
  exit 1
fi

if ! (
  cd "$WORKTREE_PATH" &&
    claude -p \
      --agent "$CLAUDE_AGENT" \
      --model "$CLAUDE_MODEL" \
      --permission-mode "$CLAUDE_PERMISSION_MODE" \
      --allowedTools "$CLAUDE_ALLOWED_TOOLS" \
      --add-dir "$SOURCE_ROOT" \
      "$(cat "$PROMPT_FILE")"
) >"$CLAUDE_OUTPUT_FILE" 2>&1; then
  ENDED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_run_log "failed" "$STARTED_AT" "$ENDED_AT" "$SCAN_ACTION" "headless Claude execution failed"
  cat "$CLAUDE_OUTPUT_FILE" >&2
  exit 1
fi

ENDED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
write_run_log "succeeded" "$STARTED_AT" "$ENDED_AT" "$SCAN_ACTION" "headless Claude execution completed"
cat "$CLAUDE_OUTPUT_FILE"
echo "Nightly improvement: completed"
