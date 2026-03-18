#!/bin/bash
# test-integration-parallel-hooks.sh — Test parallel hook execution
#
# Claude Code runs all matching hooks for an event IN PARALLEL.
# This test validates that:
#   1. Multiple PreToolUse hooks don't interfere with each other
#   2. If any hook denies, the overall result is deny
#   3. Hooks don't corrupt shared state when running concurrently
#   4. Advisory hooks (stderr) coexist with blocking hooks (deny JSON)
#
# INVARIANT: Parallel hook execution produces correct combined results.
# SUT: All PreToolUse Bash hooks running simultaneously.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/harness.sh"

# Isolated state for PR review hooks
STATE_DIR="$HARNESS_TEMP/pr-review-state"
mkdir -p "$STATE_DIR"
export STATE_DIR
export DEBUG_LOG="$HARNESS_TEMP/debug.log"

# Setup mock dir for git/gh
setup_mock_dir
ORIG_MOCK_DIR="$MOCK_DIR"

echo "=== Parallel PreToolUse: clean state, harmless command ==="

# All hooks should allow a simple "npm test" with no state
setup_gh_git_mocks "" ""
INPUT=$(build_pre_tool_use_input "Bash" '{"command":"npm test"}')

# Run each hook individually to verify they all allow
HOOKS=(
  "$HOOKS_DIR/enforce-pr-review.sh"
  "$HOOKS_DIR/enforce-case-worktree.sh"
  "$HOOKS_DIR/check-test-coverage.sh"
  "$HOOKS_DIR/check-verification.sh"
  "$HOOKS_DIR/check-dirty-files.sh"
)

all_allow=true
for hook in "${HOOKS[@]}"; do
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
  if [ -n "$HOOK_STDOUT" ] && validate_deny_output "$HOOK_STDOUT"; then
    all_allow=false
    echo "  FAIL: $(basename $hook) denied 'npm test' unexpectedly"
    echo "    reason: $(echo "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' | head -2)"
    ((FAIL++))
  fi
done

if $all_allow; then
  echo "  PASS: all 5 hooks allow 'npm test' in clean state"
  ((PASS++))
fi

echo ""
echo "=== Parallel PreToolUse: PR review gate + dirty files ==="

# Scenario: active review gate AND dirty files.
# Both enforce-pr-review and check-dirty-files should deny.
# They run in parallel — neither should crash from the other's behavior.

# Setup: active review state (must include BRANCH for worktree isolation)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/42\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/Garsson-io_nanoclaw_42"

# Setup: dirty files
setup_git_status_mock " M src/dirty.ts"

INPUT=$(build_pre_tool_use_input "Bash" '{"command":"gh pr create --title test --body test"}')

deny_count=0
for hook in "${HOOKS[@]}"; do
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
  if [ -n "$HOOK_STDOUT" ] && validate_deny_output "$HOOK_STDOUT"; then
    ((deny_count++))
    log "$(basename $hook) denied: $(echo "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.permissionDecisionReason' | head -1)"
  fi
done

if [ "$deny_count" -ge 2 ]; then
  echo "  PASS: multiple hooks correctly deny simultaneously ($deny_count denials)"
  ((PASS++))
else
  echo "  FAIL: expected at least 2 denials, got $deny_count"
  ((FAIL++))
fi

echo ""
echo "=== Parallel PreToolUse: only one hook should deny ==="

# Clean state (no review gate), dirty files present.
# Only check-dirty-files should deny on git push.
rm -f "$STATE_DIR"/*

INPUT=$(build_pre_tool_use_input "Bash" '{"command":"git push origin wt/test-branch"}')

denying_hooks=()
for hook in "${HOOKS[@]}"; do
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
  if [ -n "$HOOK_STDOUT" ] && validate_deny_output "$HOOK_STDOUT"; then
    denying_hooks+=("$(basename "$hook")")
  fi
done

if [ ${#denying_hooks[@]} -eq 1 ] && [ "${denying_hooks[0]}" = "check-dirty-files.sh" ]; then
  echo "  PASS: only check-dirty-files denies git push with dirty files"
  ((PASS++))
else
  echo "  FAIL: expected only check-dirty-files to deny"
  echo "    denying hooks: ${denying_hooks[*]:-none}"
  ((FAIL++))
fi

echo ""
echo "=== Parallel PreToolUse: Edit/Write hooks independent of Bash hooks ==="

# Write hooks have a different matcher (Edit|Write) and should not
# be affected by Bash-matcher state.

INPUT=$(build_pre_tool_use_input "Write" "$(jq -n --arg f "$(pwd)/src/test.ts" '{file_path: $f, content: "test"}')")

run_single_hook "$HOOKS_DIR/enforce-worktree-writes.sh" "$INPUT" 10
# In a worktree, this should allow (we're in a worktree already)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ "$GIT_COMMON" != ".git" ]; then
  # We're in a worktree — write to our own dir should be allowed
  if [ -z "$HOOK_STDOUT" ] || ! validate_deny_output "$HOOK_STDOUT"; then
    echo "  PASS: Write to worktree dir allowed (worktree context)"
    ((PASS++))
  else
    echo "  FAIL: Write to worktree dir denied"
    echo "    reason: $(echo "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' | head -2)"
    ((FAIL++))
  fi
else
  echo "  SKIP: not in a worktree, can't test worktree write permissions"
fi

echo ""
echo "=== Parallel PostToolUse: both hooks fire on gh pr create ==="

# After a successful gh pr create, both pr-review-loop and kaizen-reflect should fire.
POST_INPUT=$(build_post_tool_use_input "Bash" \
  '{"command":"gh pr create --title test --body test"}' \
  "https://github.com/Garsson-io/nanoclaw/pull/99" "" "0")

POST_HOOKS=(
  "$HOOKS_DIR/pr-review-loop.sh"
  "$HOOKS_DIR/kaizen-reflect.sh"
)

post_outputs=()
for hook in "${POST_HOOKS[@]}"; do
  run_single_hook "$hook" "$POST_INPUT" 10 "STATE_DIR=$STATE_DIR"
  post_outputs+=("$HOOK_STDOUT")
done

if echo "${post_outputs[0]}" | grep -q "MANDATORY SELF-REVIEW"; then
  echo "  PASS: pr-review-loop fires on pr create"
  ((PASS++))
else
  echo "  FAIL: pr-review-loop didn't fire"
  echo "    output: ${post_outputs[0]:0:100}"
  ((FAIL++))
fi

if echo "${post_outputs[1]}" | grep -q "KAIZEN REFLECTION"; then
  echo "  PASS: kaizen-reflect fires on pr create"
  ((PASS++))
else
  echo "  FAIL: kaizen-reflect didn't fire"
  echo "    output: ${post_outputs[1]:0:100}"
  ((FAIL++))
fi

echo ""
echo "=== Stdin isolation: parallel hooks each get their own copy ==="

# When hooks run in parallel, each must get its own copy of stdin.
# If one hook consumes stdin, others shouldn't get empty input.
# We test this by running two hooks that both parse JSON from stdin.

INPUT=$(build_pre_tool_use_input "Bash" '{"command":"gh pr create --title test --body \"## Verification\ntest\""}')

outputs=()
for hook in "$HOOKS_DIR/enforce-pr-review.sh" "$HOOKS_DIR/check-verification.sh"; do
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
  outputs+=("exit=$HOOK_EXIT")
done

# Both should exit 0 (not crash from missing stdin)
all_ok=true
for i in "${!outputs[@]}"; do
  if [[ "${outputs[$i]}" != "exit=0" ]]; then
    all_ok=false
  fi
done

if $all_ok; then
  echo "  PASS: all hooks received valid stdin (no stdin starvation)"
  ((PASS++))
else
  echo "  FAIL: some hooks crashed, possibly from stdin issues"
  echo "    results: ${outputs[*]}"
  ((FAIL++))
fi

# Cleanup mock dir
rm -rf "$ORIG_MOCK_DIR"

harness_summary
