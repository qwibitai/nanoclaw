#!/bin/bash
# End-to-end integration tests for the PR review enforcement system.
#
# Tests the COMPLETE lifecycle: PostToolUse creates state → Stop blocks →
# PreToolUse funnels → PostToolUse updates state → Stop allows.
#
# This is the test harness that validates the system works as a whole,
# not just individual hooks in isolation.
source "$(dirname "$0")/test-helpers.sh"

HOOKS_DIR="$(dirname "$0")/.."
PR_REVIEW_LOOP="$HOOKS_DIR/pr-review-loop.sh"
ENFORCE_PR_REVIEW="$HOOKS_DIR/enforce-pr-review.sh"
ENFORCE_PR_REVIEW_STOP="$HOOKS_DIR/enforce-pr-review-stop.sh"
ENFORCE_PR_REVIEW_TOOLS="$HOOKS_DIR/enforce-pr-review-tools.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

sim_post_tool_use() {
  local command="$1"
  local stdout="$2"
  local exit_code="${3:-0}"
  jq -n \
    --arg cmd "$command" \
    --arg out "$stdout" \
    --arg ec "$exit_code" \
    '{
      tool_input: {command: $cmd},
      tool_response: {stdout: $out, stderr: "", exit_code: $ec}
    }' | bash "$PR_REVIEW_LOOP" 2>/dev/null
}

sim_pre_tool_use_bash() {
  local command="$1"
  jq -n --arg cmd "$command" '{tool_input: {command: $cmd}}' | bash "$ENFORCE_PR_REVIEW" 2>/dev/null
}

sim_pre_tool_use_tool() {
  local tool_name="$1"
  jq -n --arg tool "$tool_name" '{tool_name: $tool, tool_input: {}}' | bash "$ENFORCE_PR_REVIEW_TOOLS" 2>/dev/null
}

sim_stop() {
  local stop_hook_active="${1:-false}"
  jq -n --arg active "$stop_hook_active" '{
    session_id: "test",
    hook_event_name: "Stop",
    stop_hook_active: ($active == "true"),
    last_assistant_message: "test"
  }' | bash "$ENFORCE_PR_REVIEW_STOP" 2>/dev/null
}

# Aliases for shared decision extractors (readable names for e2e context)
is_stop_blocked() { is_blocked "$1"; }
is_tool_denied() { is_denied "$1"; }

echo "=== SCENARIO 1: Full lifecycle — create → stop blocked → review → stop allowed ==="
echo "  This is the exact scenario that was broken before the fix."

setup

# Step 1: gh pr create fires PostToolUse
OUTPUT=$(sim_post_tool_use "gh pr create --title 'test'" "https://github.com/Garsson-io/nanoclaw/pull/42")
assert_contains "S1.1: PostToolUse outputs review prompt" "MANDATORY SELF-REVIEW" "$OUTPUT"

# Step 2: Claude tries to stop — Stop hook blocks
OUTPUT=$(sim_stop "false")
if is_stop_blocked "$OUTPUT"; then
  echo "  PASS: S1.2: Stop blocked after PR create (the fix)"
  ((PASS++))
else
  echo "  FAIL: S1.2: Stop NOT blocked after PR create (THIS IS THE BUG)"
  ((FAIL++))
fi

# Step 3: Claude tries non-review Bash command — PreToolUse blocks
OUTPUT=$(sim_pre_tool_use_bash "npm test")
if is_tool_denied "$OUTPUT"; then
  echo "  PASS: S1.3: non-review Bash command blocked"
  ((PASS++))
else
  echo "  FAIL: S1.3: non-review Bash command NOT blocked"
  ((FAIL++))
fi

# Step 4: Claude tries Edit — PreToolUse blocks
OUTPUT=$(sim_pre_tool_use_tool "Edit")
if is_tool_denied "$OUTPUT"; then
  echo "  PASS: S1.4: Edit blocked during review"
  ((PASS++))
else
  echo "  FAIL: S1.4: Edit NOT blocked during review"
  ((FAIL++))
fi

# Step 5: Claude runs gh pr diff (allowed) — triggers PostToolUse → sets passed
OUTPUT=$(sim_pre_tool_use_bash "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/42")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S1.5a: gh pr diff allowed through PreToolUse gate"
  ((PASS++))
else
  echo "  FAIL: S1.5a: gh pr diff blocked by PreToolUse gate"
  ((FAIL++))
fi

OUTPUT=$(sim_post_tool_use "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/42" "(diff output)")
assert_contains "S1.5b: PostToolUse outputs review checklist" "REVIEW ROUND" "$OUTPUT"

# Step 6: Now Claude can stop — state is passed
OUTPUT=$(sim_stop "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S1.6: Stop allowed after review passed"
  ((PASS++))
else
  echo "  FAIL: S1.6: Stop still blocked after review passed"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

# Step 7: All tools now allowed too
OUTPUT=$(sim_pre_tool_use_bash "npm test")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S1.7a: Bash commands allowed after review passed"
  ((PASS++))
else
  echo "  FAIL: S1.7a: Bash commands still blocked after review passed"
  ((FAIL++))
fi

OUTPUT=$(sim_pre_tool_use_tool "Edit")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S1.7b: Edit allowed after review passed"
  ((PASS++))
else
  echo "  FAIL: S1.7b: Edit still blocked after review passed"
  ((FAIL++))
fi

echo ""
echo "=== SCENARIO 2: Push after review → re-engages gate ==="

# Step 8: Agent pushes fixes → round increments, gate re-engages
OUTPUT=$(sim_post_tool_use "git push" "Everything up-to-date")
assert_contains "S2.1: Push triggers new review round" "ROUND" "$OUTPUT"

# Step 9: Stop blocked again
OUTPUT=$(sim_stop "false")
if is_stop_blocked "$OUTPUT"; then
  echo "  PASS: S2.2: Stop blocked after push (new round)"
  ((PASS++))
else
  echo "  FAIL: S2.2: Stop NOT blocked after push"
  ((FAIL++))
fi

# Step 10: Non-review commands blocked again
OUTPUT=$(sim_pre_tool_use_bash "npm test")
if is_tool_denied "$OUTPUT"; then
  echo "  PASS: S2.3: Bash commands blocked during new round"
  ((PASS++))
else
  echo "  FAIL: S2.3: Bash commands NOT blocked during new round"
  ((FAIL++))
fi

# Step 11: Review again
sim_post_tool_use "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/42" "(diff output)" >/dev/null

# Step 12: Stop allowed again
OUTPUT=$(sim_stop "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S2.4: Stop allowed after second review"
  ((PASS++))
else
  echo "  FAIL: S2.4: Stop still blocked after second review"
  ((FAIL++))
fi

echo ""
echo "=== SCENARIO 3: Merge cleans up state ==="

setup

# Create review state
sim_post_tool_use "gh pr create --title 'test'" "https://github.com/Garsson-io/nanoclaw/pull/50" >/dev/null

# Verify blocked
OUTPUT=$(sim_stop "false")
if is_stop_blocked "$OUTPUT"; then
  echo "  PASS: S3.1: Stop blocked before merge"
  ((PASS++))
else
  echo "  FAIL: S3.1: Stop NOT blocked before merge"
  ((FAIL++))
fi

# Merge cleans up
sim_post_tool_use "gh pr merge 50 --squash" "Merged https://github.com/Garsson-io/nanoclaw/pull/50" >/dev/null

# Stop now allowed (state file deleted)
OUTPUT=$(sim_stop "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S3.2: Stop allowed after merge (state cleaned up)"
  ((PASS++))
else
  echo "  FAIL: S3.2: Stop still blocked after merge"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== SCENARIO 4: Failed command does not trigger review ==="

setup

# Failed gh pr create should NOT create state
OUTPUT=$(sim_post_tool_use "gh pr create --title 'test'" "error: something went wrong" "1")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S4.1: Failed PR create produces no output"
  ((PASS++))
else
  echo "  FAIL: S4.1: Failed PR create produced output"
  ((FAIL++))
fi

# No state file should exist
OUTPUT=$(sim_stop "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S4.2: Stop allowed (no state from failed command)"
  ((PASS++))
else
  echo "  FAIL: S4.2: Stop blocked despite failed PR create"
  ((FAIL++))
fi

echo ""
echo "=== SCENARIO 5: Cross-worktree isolation in full lifecycle ==="

setup

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

# Another worktree's PR state
OTHER_STATE="$STATE_DIR/Garsson-io_nanoclaw_77"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/77\nROUND=1\nSTATUS=needs_review\nBRANCH=wt/other-worktree\n' > "$OTHER_STATE"

# Our worktree should not be affected
OUTPUT=$(sim_stop "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S5.1: Other worktree's review does not block our stop"
  ((PASS++))
else
  echo "  FAIL: S5.1: Other worktree's review is blocking our stop"
  ((FAIL++))
fi

OUTPUT=$(sim_pre_tool_use_bash "npm test")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S5.2: Other worktree's review does not block our Bash"
  ((PASS++))
else
  echo "  FAIL: S5.2: Other worktree's review is blocking our Bash"
  ((FAIL++))
fi

OUTPUT=$(sim_pre_tool_use_tool "Edit")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S5.3: Other worktree's review does not block our Edit"
  ((PASS++))
else
  echo "  FAIL: S5.3: Other worktree's review is blocking our Edit"
  ((FAIL++))
fi

echo ""
echo "=== SCENARIO 6: Multiple enforcement layers block independently ==="

setup

# Simulate state as if PostToolUse had fired (create state manually)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_88"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/88\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_FILE"

# All three enforcement layers should block independently
OUTPUT=$(sim_stop "false")
if is_stop_blocked "$OUTPUT"; then
  echo "  PASS: S6.1: Stop hook blocks independently"
  ((PASS++))
else
  echo "  FAIL: S6.1: Stop hook does not block"
  ((FAIL++))
fi

# ls is now allowed during review (kaizen #85, Fix C — read-only commands)
# Use a work command (npm test) to verify Bash gate blocks
OUTPUT=$(sim_pre_tool_use_bash "npm test")
if is_tool_denied "$OUTPUT"; then
  echo "  PASS: S6.2: Bash gate blocks independently"
  ((PASS++))
else
  echo "  FAIL: S6.2: Bash gate does not block"
  ((FAIL++))
fi

OUTPUT=$(sim_pre_tool_use_tool "Write")
if is_tool_denied "$OUTPUT"; then
  echo "  PASS: S6.3: Tool gate blocks independently"
  ((PASS++))
else
  echo "  FAIL: S6.3: Tool gate does not block"
  ((FAIL++))
fi

# But review commands pass through
OUTPUT=$(sim_pre_tool_use_bash "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/88")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: S6.4: Review command passes through"
  ((PASS++))
else
  echo "  FAIL: S6.4: Review command blocked"
  ((FAIL++))
fi

teardown
rm -rf "$E2E_MOCK_DIR"

print_results
