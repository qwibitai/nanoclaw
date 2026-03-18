#!/bin/bash
# harness.sh — Hook test harness for integration and regression testing
#
# Simulates Claude Code's hook runner: constructs real-format event JSON,
# runs hooks (individually or in parallel), validates output schemas,
# and supports full session lifecycle replay.
#
# Usage:
#   source "$(dirname "$0")/harness.sh"
#   simulate_pre_tool_use "Bash" "gh pr create --title test" check_result
#   run_all_hooks_for_event "PreToolUse" "Bash" '{"command":"npm test"}'
#
# The harness solves 8 gaps identified in the existing test suite:
#   1. Integration tests (multi-hook interaction)
#   2. Schema-compliant event JSON
#   3. Real-world command patterns
#   4. Parallel execution simulation
#   5. Output schema validation
#   6. Worktree context simulation
#   7. Error and timeout handling
#   8. Full lifecycle testing

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/test-helpers.sh"

# Configurable paths
HARNESS_SETTINGS="${HARNESS_SETTINGS:-$HOOKS_DIR/../settings.json}"
HARNESS_TEMP=$(mktemp -d)
HARNESS_LOG="$HARNESS_TEMP/harness.log"
HARNESS_REGRESSION_DIR="$SCRIPT_DIR/regressions"

# Test counters (augment test-helpers.sh)
HARNESS_TESTS_RUN=0
HARNESS_TESTS_FAILED=0

harness_cleanup() {
  rm -rf "$HARNESS_TEMP"
}
trap harness_cleanup EXIT

log() {
  echo "[$(date -Iseconds)] $*" >> "$HARNESS_LOG"
}

# Build schema-compliant event JSON for each event type.
# Claude Code sends these fields; our tests should too.

build_pre_tool_use_input() {
  local tool_name="$1"
  local tool_input_json="$2"  # raw JSON object for tool_input
  local session_id="${3:-test-session-$$}"
  local cwd="${4:-$(pwd)}"

  jq -n \
    --arg session_id "$session_id" \
    --arg cwd "$cwd" \
    --arg tool_name "$tool_name" \
    --argjson tool_input "$tool_input_json" \
    '{
      session_id: $session_id,
      transcript_path: "/tmp/test-transcript.txt",
      cwd: $cwd,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: $tool_name,
      tool_input: $tool_input
    }'
}

build_post_tool_use_input() {
  local tool_name="$1"
  local tool_input_json="$2"
  local stdout="${3:-}"
  local stderr="${4:-}"
  local exit_code="${5:-0}"
  local session_id="${6:-test-session-$$}"
  local cwd="${7:-$(pwd)}"

  jq -n \
    --arg session_id "$session_id" \
    --arg cwd "$cwd" \
    --arg tool_name "$tool_name" \
    --argjson tool_input "$tool_input_json" \
    --arg stdout "$stdout" \
    --arg stderr "$stderr" \
    --arg exit_code "$exit_code" \
    '{
      session_id: $session_id,
      transcript_path: "/tmp/test-transcript.txt",
      cwd: $cwd,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: $tool_name,
      tool_input: $tool_input,
      tool_response: {
        stdout: $stdout,
        stderr: $stderr,
        exit_code: $exit_code
      }
    }'
}

build_stop_input() {
  local reason="${1:-task_complete}"
  local session_id="${2:-test-session-$$}"
  local cwd="${3:-$(pwd)}"

  jq -n \
    --arg session_id "$session_id" \
    --arg cwd "$cwd" \
    --arg reason "$reason" \
    '{
      session_id: $session_id,
      transcript_path: "/tmp/test-transcript.txt",
      cwd: $cwd,
      permission_mode: "default",
      hook_event_name: "Stop",
      reason: $reason
    }'
}

build_session_start_input() {
  local session_id="${1:-test-session-$$}"
  local cwd="${2:-$(pwd)}"

  jq -n \
    --arg session_id "$session_id" \
    --arg cwd "$cwd" \
    '{
      session_id: $session_id,
      transcript_path: "/tmp/test-transcript.txt",
      cwd: $cwd,
      permission_mode: "default",
      hook_event_name: "SessionStart"
    }'
}

# Run a single hook with given input JSON. Captures stdout, stderr, exit code.
# Returns results in global vars: HOOK_STDOUT, HOOK_STDERR, HOOK_EXIT
#
# env_vars is a newline-separated list of KEY=value pairs (to handle spaces in values).
# Use: run_single_hook "$hook" "$input" 10 "$(printf 'STATE_DIR=%s\nPATH=%s\n' "$dir" "$MOCK_DIR:$PATH")"
# Or the simpler form for vars without spaces: run_single_hook "$hook" "$input" 10 "STATE_DIR=$dir"
run_single_hook() {
  local hook_script="$1"
  local input_json="$2"
  local timeout_val="${3:-10}"
  local env_vars="${4:-}"

  local stdout_file="$HARNESS_TEMP/hook-stdout-$$"
  local stderr_file="$HARNESS_TEMP/hook-stderr-$$"

  log "run_single_hook: $hook_script (timeout=${timeout_val}s)"

  # Write a wrapper script that exports env vars properly, avoiding word-splitting issues
  local wrapper="$HARNESS_TEMP/hook-wrapper-$$.sh"
  {
    echo '#!/bin/bash'
    if [ -n "$env_vars" ]; then
      # Each line is a KEY=value assignment — export them
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        local key="${line%%=*}"
        local val="${line#*=}"
        printf 'export %s=%q\n' "$key" "$val"
      done <<< "$env_vars"
    fi
    printf 'exec bash %q\n' "$hook_script"
  } > "$wrapper"
  chmod +x "$wrapper"

  local exit_code
  echo "$input_json" | timeout "$timeout_val" bash "$wrapper" \
    >"$stdout_file" 2>"$stderr_file"
  exit_code=$?

  HOOK_STDOUT=$(cat "$stdout_file" 2>/dev/null || echo "")
  HOOK_STDERR=$(cat "$stderr_file" 2>/dev/null || echo "")
  HOOK_EXIT=$exit_code

  log "  exit=$exit_code stdout_len=${#HOOK_STDOUT} stderr_len=${#HOOK_STDERR}"
  rm -f "$stdout_file" "$stderr_file" "$wrapper"
}

# Validate hook output matches expected schema for PreToolUse deny.
# Returns 0 if valid deny, 1 otherwise.
validate_deny_output() {
  local output="$1"

  if [ -z "$output" ]; then
    return 1
  fi

  # Must be valid JSON
  if ! echo "$output" | jq empty 2>/dev/null; then
    log "validate_deny_output: INVALID JSON"
    return 1
  fi

  # Must have hookSpecificOutput.permissionDecision = "deny"
  local decision
  decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')
  if [ "$decision" != "deny" ]; then
    log "validate_deny_output: decision='$decision' (expected 'deny')"
    return 1
  fi

  # Must have a non-empty reason
  local reason
  reason=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
  if [ -z "$reason" ]; then
    log "validate_deny_output: missing permissionDecisionReason"
    return 1
  fi

  return 0
}

# Validate hook output is a clean allow (empty stdout, exit 0).
validate_allow_output() {
  local stdout="$1"
  local exit_code="$2"

  if [ "$exit_code" -ne 0 ]; then
    return 1
  fi

  # For an allow, stdout should either be empty or NOT contain a deny decision
  if [ -n "$stdout" ]; then
    if echo "$stdout" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then
      return 1
    fi
  fi

  return 0
}

# Parse settings.json to get hook definitions for an event+matcher.
# Returns hook commands as newline-separated list.
get_hooks_for_event() {
  local event="$1"
  local tool_name="$2"
  local settings="$HARNESS_SETTINGS"

  if [ ! -f "$settings" ]; then
    echo ""
    return 1
  fi

  # Extract all hook entries for the event, filter by matcher
  jq -r --arg event "$event" --arg tool "$tool_name" '
    .hooks[$event] // [] | .[] |
    select(
      (.matcher // "*") as $m |
      ($tool | test("^(" + ($m | gsub("\\*"; ".*")) + ")$"))
    ) |
    .hooks[] | .command
  ' "$settings" 2>/dev/null || echo ""
}

# Run ALL hooks configured for an event+tool, simulating Claude Code's parallel execution.
# Captures combined results. Returns 0 if all allow, 1 if any deny.
run_all_hooks_for_event() {
  local event="$1"
  local tool_name="$2"
  local input_json="$3"
  local env_vars="${4:-}"

  local hooks
  hooks=$(get_hooks_for_event "$event" "$tool_name")

  if [ -z "$hooks" ]; then
    log "run_all_hooks_for_event: no hooks for $event/$tool_name"
    ALL_HOOK_RESULTS=()
    return 0
  fi

  log "run_all_hooks_for_event: $event/$tool_name"

  # Run hooks in parallel (like Claude Code does)
  local pids=()
  local result_files=()
  local i=0

  while IFS= read -r hook_cmd; do
    [ -z "$hook_cmd" ] && continue

    # Resolve relative paths
    local hook_path="$hook_cmd"
    if [[ "$hook_cmd" == ./* ]]; then
      hook_path="$HOOKS_DIR/../../${hook_cmd#./}"
    fi

    local result_file="$HARNESS_TEMP/parallel-$i"
    result_files+=("$result_file")

    (
      local stdout_file="${result_file}.stdout"
      local stderr_file="${result_file}.stderr"

      # Build wrapper to handle env vars with spaces safely
      local wrapper="${result_file}.wrapper.sh"
      {
        echo '#!/bin/bash'
        if [ -n "$env_vars" ]; then
          while IFS= read -r line; do
            [ -z "$line" ] && continue
            local key="${line%%=*}"
            local val="${line#*=}"
            printf 'export %s=%q\n' "$key" "$val"
          done <<< "$env_vars"
        fi
        printf 'exec bash %q\n' "$hook_path"
      } > "$wrapper"
      chmod +x "$wrapper"

      echo "$input_json" | bash "$wrapper" >"$stdout_file" 2>"$stderr_file"
      echo $? > "${result_file}.exit"
      rm -f "$wrapper"
    ) &
    pids+=($!)
    ((i++))
  done <<< "$hooks"

  # Wait for all hooks
  local any_deny=false
  ALL_HOOK_RESULTS=()

  for j in "${!pids[@]}"; do
    wait "${pids[$j]}" 2>/dev/null
    local rf="${result_files[$j]}"
    local exit_code=$(cat "${rf}.exit" 2>/dev/null || echo "1")
    local stdout=$(cat "${rf}.stdout" 2>/dev/null || echo "")
    local stderr=$(cat "${rf}.stderr" 2>/dev/null || echo "")

    ALL_HOOK_RESULTS+=("$(jq -n \
      --arg hook "$hook_cmd" \
      --arg stdout "$stdout" \
      --arg stderr "$stderr" \
      --arg exit_code "$exit_code" \
      '{hook: $hook, stdout: $stdout, stderr: $stderr, exit_code: $exit_code}'
    )")

    if validate_deny_output "$stdout"; then
      any_deny=true
    fi

    rm -f "${rf}.stdout" "${rf}.stderr" "${rf}.exit"
  done

  if $any_deny; then
    return 1
  fi
  return 0
}

# High-level simulation functions for common scenarios

# Simulate a PreToolUse Bash event with a command string.
# Usage: simulate_bash_pre "gh pr create --title test" [env_vars]
simulate_bash_pre() {
  local command="$1"
  local env_vars="${2:-}"
  local input
  input=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$command" '{command: $c}')")
  run_all_hooks_for_event "PreToolUse" "Bash" "$input" "$env_vars"
}

# Simulate a PostToolUse Bash event.
# Usage: simulate_bash_post "gh pr create ..." "https://github.com/..." "" "0" [env_vars]
simulate_bash_post() {
  local command="$1"
  local stdout="${2:-}"
  local stderr="${3:-}"
  local exit_code="${4:-0}"
  local env_vars="${5:-}"
  local input
  input=$(build_post_tool_use_input "Bash" \
    "$(jq -n --arg c "$command" '{command: $c}')" \
    "$stdout" "$stderr" "$exit_code")
  run_all_hooks_for_event "PostToolUse" "Bash" "$input" "$env_vars"
}

# Simulate an Edit/Write PreToolUse event.
# Usage: simulate_write_pre "/path/to/file.ts" '{"file_path":"/path","content":"..."}'
simulate_write_pre() {
  local file_path="$1"
  local env_vars="${2:-}"
  local input
  input=$(build_pre_tool_use_input "Write" \
    "$(jq -n --arg f "$file_path" '{file_path: $f, content: "test content"}')")
  run_all_hooks_for_event "PreToolUse" "Write" "$input" "$env_vars"
}

# Assertion helpers for harness tests

assert_event_allows() {
  local test_name="$1"
  # $? from the last run_all_hooks_for_event
  local result="$2"  # 0=allow, 1=deny

  ((HARNESS_TESTS_RUN++))
  if [ "$result" -eq 0 ]; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name (expected allow, got deny)"
    ((FAIL++))
    ((HARNESS_TESTS_FAILED++))
    # Show which hook denied
    for r in "${ALL_HOOK_RESULTS[@]:-}"; do
      local stdout
      stdout=$(echo "$r" | jq -r '.stdout // empty')
      if validate_deny_output "$stdout"; then
        local hook
        hook=$(echo "$r" | jq -r '.hook // "unknown"')
        echo "    denied by: $hook"
        echo "    reason: $(echo "$stdout" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' | head -3)"
      fi
    done
  fi
}

assert_event_denies() {
  local test_name="$1"
  local result="$2"

  ((HARNESS_TESTS_RUN++))
  if [ "$result" -eq 1 ]; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name (expected deny, got allow)"
    ((FAIL++))
    ((HARNESS_TESTS_FAILED++))
  fi
}

# Check that a specific hook produced output containing a pattern
assert_hook_output_contains() {
  local test_name="$1"
  local pattern="$2"

  ((HARNESS_TESTS_RUN++))
  local found=false
  for r in "${ALL_HOOK_RESULTS[@]:-}"; do
    local stdout stderr
    stdout=$(echo "$r" | jq -r '.stdout // empty')
    stderr=$(echo "$r" | jq -r '.stderr // empty')
    if echo "$stdout" | grep -q "$pattern" || echo "$stderr" | grep -q "$pattern"; then
      found=true
      break
    fi
  done

  if $found; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name (pattern '$pattern' not found in any hook output)"
    ((FAIL++))
    ((HARNESS_TESTS_FAILED++))
  fi
}

# Save a failing test input as a regression test fixture
save_regression() {
  local name="$1"
  local event="$2"
  local input_json="$3"
  local expected="$4"  # "allow" or "deny"
  local actual="$5"    # "allow" or "deny"

  mkdir -p "$HARNESS_REGRESSION_DIR"
  local file="$HARNESS_REGRESSION_DIR/$(date +%y%m%d)-${name}.json"

  jq -n \
    --arg name "$name" \
    --arg event "$event" \
    --argjson input "$input_json" \
    --arg expected "$expected" \
    --arg actual "$actual" \
    --arg date "$(date -Iseconds)" \
    '{
      name: $name,
      date: $date,
      event: $event,
      input: $input,
      expected: $expected,
      actual_at_capture: $actual,
      notes: ""
    }' > "$file"

  echo "  Regression saved: $file"
}

# Real-world command patterns that have caused failures.
# Use these in integration tests instead of simplified commands.
REAL_PR_CREATE_CMD='gh pr create --title "fix: address review findings" --body "$(cat <<'\''EOF'\''
## Summary
- Fixed prompt formatting
- Added missing imports

## Test plan
- [x] Unit tests pass
- [x] Integration tests pass

## Verification
- [ ] Run `npm run build` — should complete
- [ ] Send test message in Telegram

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"'

REAL_PR_CREATE_OUTPUT='https://github.com/Garsson-io/nanoclaw/pull/47'

REAL_GIT_PUSH_CMD='git push -u origin wt/260315-1430-fix-auth'
REAL_GIT_PUSH_OUTPUT='To github.com:Garsson-io/nanoclaw.git
   abc1234..def5678  wt/260315-1430-fix-auth -> wt/260315-1430-fix-auth
branch '\''wt/260315-1430-fix-auth'\'' set up to track '\''origin/wt/260315-1430-fix-auth'\''.'

REAL_PR_MERGE_CMD='gh pr merge 47 --repo Garsson-io/nanoclaw --squash --delete-branch'
REAL_PR_MERGE_OUTPUT='✓ Squashed and merged pull request #47 (fix: address review findings)
✓ Deleted branch wt/260315-1430-fix-auth and switched to branch main'

REAL_PR_DIFF_CMD='gh pr diff 47 --repo Garsson-io/nanoclaw'

REAL_HEREDOC_CMD='cat > /tmp/test.json << '\''EOF'\''
{"type": "message", "chatJid": "tg:-5128317012", "text": "test"}
EOF'

# Complex multi-line command with pipes and heredoc
REAL_COMPLEX_CMD='gh pr create --title "feat: add voice transcription" --body "$(cat <<'\''EOF'\''
## Summary
- Added whisper integration
- Voice messages auto-transcribed

## Test plan
- npm test
- Manual: send voice note

## Verification
- [ ] Build succeeds
- [ ] Voice message triggers transcription
EOF
)" && echo "PR created" | tee /tmp/pr-output.log'

# Print harness summary
harness_summary() {
  echo ""
  echo "================================"
  echo "Harness: $HARNESS_TESTS_RUN tests, $HARNESS_TESTS_FAILED failed"
  print_results
}
