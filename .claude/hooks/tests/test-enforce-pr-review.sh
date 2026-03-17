#!/bin/bash
# Tests for enforce-pr-review.sh — Level 3 PR review gate (Issue #46)
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../enforce-pr-review.sh"
STATE_DIR="/tmp/.pr-review-state-test-$$"
export STATE_DIR
export DEBUG_LOG="/dev/null"

setup() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
}

teardown() {
  rm -rf "$STATE_DIR"
}

# Helper: create a state file with given status
create_state() {
  local pr_url="$1"
  local round="$2"
  local status="$3"
  local filename
  filename=$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')
  printf 'PR_URL=%s\nROUND=%s\nSTATUS=%s\n' "$pr_url" "$round" "$status" > "$STATE_DIR/$filename"
}

# Helper: run the PreToolUse hook with a command
run_gate() {
  local command="$1"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: check if output contains a deny decision
is_denied() {
  local output="$1"
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1
}

echo "=== No active review: all commands allowed ==="

setup

# INVARIANT: When no state files exist, all commands pass through
# SUT: enforce-pr-review.sh with empty STATE_DIR
OUTPUT=$(run_gate "npm test")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: npm test allowed with no active review"
  ((PASS++))
else
  echo "  FAIL: npm test blocked with no active review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git push")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: git push allowed with no active review"
  ((PASS++))
else
  echo "  FAIL: git push blocked with no active review"
  ((FAIL++))
fi

echo ""
echo "=== Active review: non-review commands blocked ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# INVARIANT: When STATUS=needs_review, non-review Bash commands are denied
# SUT: enforce-pr-review.sh deny logic
OUTPUT=$(run_gate "npm test")
if is_denied "$OUTPUT"; then
  echo "  PASS: npm test blocked during active review"
  ((PASS++))
else
  echo "  FAIL: npm test NOT blocked during active review"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git push")
if is_denied "$OUTPUT"; then
  echo "  PASS: git push blocked during active review"
  ((PASS++))
else
  echo "  FAIL: git push NOT blocked during active review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git commit -m 'fix stuff'")
if is_denied "$OUTPUT"; then
  echo "  PASS: git commit blocked during active review"
  ((PASS++))
else
  echo "  FAIL: git commit NOT blocked during active review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "ls -la")
if is_denied "$OUTPUT"; then
  echo "  PASS: ls blocked during active review"
  ((PASS++))
else
  echo "  FAIL: ls NOT blocked during active review"
  ((FAIL++))
fi

echo ""
echo "=== Active review: review commands allowed ==="

# INVARIANT: Review-related commands are always allowed, even during gate
# SUT: enforce-pr-review.sh allow list
OUTPUT=$(run_gate "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/42")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: gh pr diff allowed during review"
  ((PASS++))
else
  echo "  FAIL: gh pr diff blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "gh pr view 42")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: gh pr view allowed during review"
  ((PASS++))
else
  echo "  FAIL: gh pr view blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "gh pr comment 42 --body 'review notes'")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: gh pr comment allowed during review"
  ((PASS++))
else
  echo "  FAIL: gh pr comment blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "gh pr edit 42 --title 'updated'")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: gh pr edit allowed during review"
  ((PASS++))
else
  echo "  FAIL: gh pr edit blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git diff HEAD~1")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: git diff allowed during review"
  ((PASS++))
else
  echo "  FAIL: git diff blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git log --oneline -5")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: git log allowed during review"
  ((PASS++))
else
  echo "  FAIL: git log blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git show HEAD")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: git show allowed during review"
  ((PASS++))
else
  echo "  FAIL: git show blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git status")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: git status allowed during review"
  ((PASS++))
else
  echo "  FAIL: git status blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git branch -a")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: git branch allowed during review"
  ((PASS++))
else
  echo "  FAIL: git branch blocked during review"
  ((FAIL++))
fi

echo ""
echo "=== Passed review: gate opens ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "passed"

# INVARIANT: When STATUS=passed, all commands are allowed
# SUT: enforce-pr-review.sh with passed state
OUTPUT=$(run_gate "npm test")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: npm test allowed after review passed"
  ((PASS++))
else
  echo "  FAIL: npm test blocked after review passed"
  ((FAIL++))
fi

OUTPUT=$(run_gate "git commit -m 'fix issues'")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: git commit allowed after review passed"
  ((PASS++))
else
  echo "  FAIL: git commit blocked after review passed"
  ((FAIL++))
fi

echo ""
echo "=== Escalated review: gate opens ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "4" "escalated"

# INVARIANT: When STATUS=escalated, all commands are allowed
# SUT: enforce-pr-review.sh with escalated state
OUTPUT=$(run_gate "npm test")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: npm test allowed after review escalated"
  ((PASS++))
else
  echo "  FAIL: npm test blocked after review escalated"
  ((FAIL++))
fi

echo ""
echo "=== Deny message includes PR URL and round ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/99" "3" "needs_review"

# INVARIANT: Deny message includes actionable information (PR URL, round number)
# SUT: enforce-pr-review.sh deny reason text
OUTPUT=$(run_gate "npm test")
REASON=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')

assert_contains "deny reason includes PR URL" "nanoclaw/pull/99" "$REASON"
assert_contains "deny reason includes round number" "round 3" "$REASON"
assert_contains "deny reason includes gh pr diff instruction" "gh pr diff" "$REASON"

echo ""
echo "=== Empty command: allowed through ==="

# INVARIANT: Empty/missing commands are not blocked
# SUT: enforce-pr-review.sh edge case handling
OUTPUT=$(echo '{"tool_input":{}}' | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: empty command allowed through"
  ((PASS++))
else
  echo "  FAIL: empty command blocked"
  ((FAIL++))
fi

echo ""
echo "=== Multiple state files: only needs_review triggers gate ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/40" "2" "passed"
create_state "https://github.com/Garsson-io/garsson-prints/pull/5" "1" "needs_review"

# INVARIANT: Gate activates if ANY state file has needs_review
# SUT: enforce-pr-review.sh with mixed state files
OUTPUT=$(run_gate "npm test")
if is_denied "$OUTPUT"; then
  echo "  PASS: gate active when one of multiple PRs needs review"
  ((PASS++))
else
  echo "  FAIL: gate NOT active despite needs_review state"
  ((FAIL++))
fi

REASON=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
assert_contains "deny references the correct PR" "garsson-prints/pull/5" "$REASON"

echo ""
echo "=== Stale state files are ignored ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/50" "1" "needs_review"

# INVARIANT: State files older than MAX_STATE_AGE are treated as stale and ignored
# SUT: enforce-pr-review.sh staleness check
# Backdate the state file to 3 hours ago (10800 seconds)
STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_50"
touch -d "3 hours ago" "$STATE_FILE" 2>/dev/null || touch -t "$(date -d '3 hours ago' +%Y%m%d%H%M.%S 2>/dev/null || date -v-3H +%Y%m%d%H%M.%S)" "$STATE_FILE" 2>/dev/null

OUTPUT=$(MAX_STATE_AGE=7200 run_gate "npm test")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stale needs_review state file ignored"
  ((PASS++))
else
  echo "  FAIL: stale state file still blocking"
  ((FAIL++))
fi

# INVARIANT: Fresh state files (within MAX_STATE_AGE) still block
# SUT: enforce-pr-review.sh with fresh state
setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/51" "1" "needs_review"
# File was just created — should be fresh
OUTPUT=$(MAX_STATE_AGE=7200 run_gate "npm test")
if is_denied "$OUTPUT"; then
  echo "  PASS: fresh needs_review state file still blocks"
  ((PASS++))
else
  echo "  FAIL: fresh state file did NOT block"
  ((FAIL++))
fi

echo ""
echo "=== Piped review commands allowed ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# INVARIANT: gh pr diff piped to other commands is still allowed
# SUT: enforce-pr-review.sh command parsing with pipes
OUTPUT=$(run_gate "gh pr diff 42 | head -50")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: piped gh pr diff allowed"
  ((PASS++))
else
  echo "  FAIL: piped gh pr diff blocked"
  ((FAIL++))
fi

teardown

print_results
