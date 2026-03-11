#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.nanoclaw/morning-codex-prep"
RUNS_DIR="$STATE_DIR/runs"
STATE_FILE="$STATE_DIR/launch-state.json"
RUN_ID="$(date -u +"%Y%m%dT%H%M%SZ")"
PROMPT_FILE="$STATE_DIR/prompt-${RUN_ID}.txt"
RUN_LOG_FILE="$RUNS_DIR/${RUN_ID}.json"
JSONL_FILE="$RUNS_DIR/${RUN_ID}.jsonl"
STDERR_FILE="$RUNS_DIR/${RUN_ID}.stderr.log"
LAST_MESSAGE_FILE="$RUNS_DIR/${RUN_ID}-last-message.txt"
BASELINE_STATUS_FILE="$RUNS_DIR/${RUN_ID}-git-status.before"
FINAL_STATUS_FILE="$RUNS_DIR/${RUN_ID}-git-status.after"
STATUS_DIFF_FILE="$RUNS_DIR/${RUN_ID}-git-status.diff"
OUTPUT_SCHEMA_FILE="$ROOT_DIR/scripts/workflow/morning-codex-prep-output-schema.json"
PROFILE_NAME="${NANOCLAW_MORNING_PREP_PROFILE:-morning_prep}"
GH_ACCOUNT="${NANOCLAW_PLATFORM_GH_ACCOUNT:-ingpoc}"
LAUNCH_LABEL="${NANOCLAW_MORNING_PREP_LABEL:-com.nanoclaw.morning-codex-prep}"
PLAN_PATH="${NANOCLAW_AUTONOMY_PLAN_PATH:-$ROOT_DIR/.nanoclaw/autonomy/feature-plan.md}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/workflow/start-morning-codex-prep.sh [--dry-run]

Runs the bounded morning Codex prep lane:
  1. headless `codex exec` using the `morning_prep` profile
  2. `session-start.sh --agent codex --no-background-sync`
  3. PR and review follow-up only when surfaced by the session-start sweep
  4. structured summary output with no repo-tracked edits
EOF
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
  if [[ -n "${NANOCLAW_MORNING_PREP_CODEX_BIN:-}" ]]; then
    printf '%s\n' "$NANOCLAW_MORNING_PREP_CODEX_BIN"
    return 0
  fi

  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return 0
  fi

  local fallback=""
  fallback="$(
    find "$HOME/.nvm/versions/node" -path '*/bin/codex' -type f 2>/dev/null \
      | sort \
      | tail -n 1
  )"

  if [[ -n "$fallback" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi

  echo "codex CLI is required but not found in PATH or under \$HOME/.nvm/versions/node" >&2
  exit 1
}

build_prompt() {
  cat >"$PROMPT_FILE" <<EOF
Run the NanoClaw morning Codex prep routine.

Requirements:
1. Confirm the active GitHub account with \`gh api user -q .login\`.
2. If it is not \`$GH_ACCOUNT\`, run \`gh auth switch --user $GH_ACCOUNT\`, re-check, and stop if the account is still wrong.
3. Run \`bash scripts/workflow/session-start.sh --agent codex --no-background-sync\`.
4. If session-start exits blocked on collaboration items, resolve only the surfaced Linear work by following:
   - \`docs/workflow/control-plane/session-work-sweep.md\`
   - \`docs/workflow/control-plane/collaboration-surface-contract.md\`
5. For nightly findings surfaced during that work, follow \`docs/workflow/strategy/nightly-evaluation-loop.md\`.
6. If \`$PLAN_PATH\` exists, read it and treat it as the user roadmap input for promotion and readiness decisions.
7. When evidence is needed, prefer the available MCP servers:
   - \`DeepWiki\` for repository documentation and architecture questions
   - \`Context7\` for primary library/API docs
   - \`token-efficient\` for verbose logs, JSON, CSV, or command output
8. For every candidate from the queue or roadmap, decide exactly one of: \`promote\`, \`ready-recommendation\`, \`defer\`, or \`reject\`.
9. Write rationale for all \`defer\` and \`reject\` decisions on the relevant Notion page or Linear issue.
10. Codex may normalize issue content and record a \`ready-recommendation\`, but \`andy-developer\` remains the only readiness authority.
11. Promote only concrete next actions into Issues. Do not broaden scope beyond the surfaced morning queue and roadmap.
12. After handling the surfaced morning work, rerun \`bash scripts/workflow/session-start.sh --agent codex --no-background-sync\` once.
13. Do not edit repo-tracked files, docs, or code. This lane may update Linear/Notion/GitHub state and runtime-local artifacts only.
14. End with JSON matching the supplied output schema.
EOF
}

record_state() {
  local codex_bin="$1"
  local shell_command="$2"
  cat >"$STATE_FILE" <<EOF
{
  "label": $(json_escape "$LAUNCH_LABEL"),
  "source_root": $(json_escape "$ROOT_DIR"),
  "profile": $(json_escape "$PROFILE_NAME"),
  "codex_bin": $(json_escape "$codex_bin"),
  "prompt_file": $(json_escape "$PROMPT_FILE"),
  "output_schema_file": $(json_escape "$OUTPUT_SCHEMA_FILE"),
  "run_log_file": $(json_escape "$RUN_LOG_FILE"),
  "jsonl_file": $(json_escape "$JSONL_FILE"),
  "stderr_file": $(json_escape "$STDERR_FILE"),
  "last_message_file": $(json_escape "$LAST_MESSAGE_FILE"),
  "launched_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "shell_command": $(json_escape "$shell_command")
}
EOF
}

write_run_log() {
  local status="$1"
  local started_at="$2"
  local ended_at="$3"
  local notes="${4:-}"

  cat >"$RUN_LOG_FILE" <<EOF
{
  "run_id": $(json_escape "$RUN_ID"),
  "label": $(json_escape "$LAUNCH_LABEL"),
  "profile": $(json_escape "$PROFILE_NAME"),
  "status": $(json_escape "$status"),
  "started_at": $(json_escape "$started_at"),
  "ended_at": $(json_escape "$ended_at"),
  "prompt_file": $(json_escape "$PROMPT_FILE"),
  "output_schema_file": $(json_escape "$OUTPUT_SCHEMA_FILE"),
  "jsonl_file": $(json_escape "$JSONL_FILE"),
  "stderr_file": $(json_escape "$STDERR_FILE"),
  "last_message_file": $(json_escape "$LAST_MESSAGE_FILE"),
  "baseline_git_status_file": $(json_escape "$BASELINE_STATUS_FILE"),
  "final_git_status_file": $(json_escape "$FINAL_STATUS_FILE"),
  "status_diff_file": $(json_escape "$STATUS_DIFF_FILE"),
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

require_cmd git
require_cmd python3
require_cmd gh

if [[ ! -f "$OUTPUT_SCHEMA_FILE" ]]; then
  echo "Missing output schema: $OUTPUT_SCHEMA_FILE" >&2
  exit 1
fi

CODEX_BIN="$(resolve_codex_bin)"
build_prompt

SHELL_COMMAND="cd \"$ROOT_DIR\" && \"$CODEX_BIN\" exec --ephemeral --json -p \"$PROFILE_NAME\" -C \"$ROOT_DIR\" -s workspace-write -c 'approval_policy=\"never\"' -c 'sandbox_workspace_write.network_access=true' --output-schema \"$OUTPUT_SCHEMA_FILE\" -o \"$LAST_MESSAGE_FILE\" \"\$(cat \"$PROMPT_FILE\")\""
record_state "$CODEX_BIN" "$SHELL_COMMAND"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "$SHELL_COMMAND"
  exit 0
fi

git -C "$ROOT_DIR" status --short --untracked-files=all >"$BASELINE_STATUS_FILE"

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
set +e
"$CODEX_BIN" exec \
  --ephemeral \
  --json \
  -p "$PROFILE_NAME" \
  -C "$ROOT_DIR" \
  -s workspace-write \
  -c 'approval_policy="never"' \
  -c 'sandbox_workspace_write.network_access=true' \
  --output-schema "$OUTPUT_SCHEMA_FILE" \
  -o "$LAST_MESSAGE_FILE" \
  "$(cat "$PROMPT_FILE")" \
  >"$JSONL_FILE" 2>"$STDERR_FILE"
EXEC_STATUS=$?
set -e
ENDED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

git -C "$ROOT_DIR" status --short --untracked-files=all >"$FINAL_STATUS_FILE"

if ! cmp -s "$BASELINE_STATUS_FILE" "$FINAL_STATUS_FILE"; then
  diff -u "$BASELINE_STATUS_FILE" "$FINAL_STATUS_FILE" >"$STATUS_DIFF_FILE" || true
  write_run_log "fail" "$STARTED_AT" "$ENDED_AT" "repo-tracked-state-mutated"
  echo "morning-codex-prep: FAIL (repo-tracked state changed; see $STATUS_DIFF_FILE)" >&2
  exit 1
fi

if [[ "$EXEC_STATUS" -ne 0 ]]; then
  write_run_log "fail" "$STARTED_AT" "$ENDED_AT" "codex-exec-exit-$EXEC_STATUS"
  echo "morning-codex-prep: FAIL (codex exec exited $EXEC_STATUS)" >&2
  echo "stderr: $STDERR_FILE" >&2
  exit "$EXEC_STATUS"
fi

write_run_log "ok" "$STARTED_AT" "$ENDED_AT"
echo "morning-codex-prep: PASS"
echo "jsonl: $JSONL_FILE"
echo "summary: $LAST_MESSAGE_FILE"
