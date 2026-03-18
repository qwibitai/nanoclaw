#!/bin/bash
# Tests for enforce-pr-review.sh — Level 3 PR review gate (Issue #46)
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../enforce-pr-review.sh"
setup_test_env

run_gate() {
  local command="$1"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

setup() { reset_state; }
teardown() { reset_state; }

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

OUTPUT=$(run_gate "node src/index.ts")
if is_denied "$OUTPUT"; then
  echo "  PASS: node blocked during active review"
  ((PASS++))
else
  echo "  FAIL: node NOT blocked during active review"
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

# git fetch — needed for merge-from-main during review (kaizen #85, Fix C)
OUTPUT=$(run_gate "git fetch origin main")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: git fetch allowed during review"
  ((PASS++))
else
  echo "  FAIL: git fetch blocked during review"
  ((FAIL++))
fi

echo ""
echo "=== Active review: read-only filesystem commands allowed (kaizen #85, Fix C) ==="

# INVARIANT: Read-only filesystem commands are allowed during review gate
# because they can't "do work" and are useful for debugging hooks and reviewing code
# SUT: enforce-pr-review.sh is_review_command allowlist

OUTPUT=$(run_gate "ls -la /tmp/.pr-review-state/")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: ls allowed during review (hook debugging)"
  ((PASS++))
else
  echo "  FAIL: ls blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "cat /tmp/.pr-review-state/some-file")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: cat allowed during review (hook debugging)"
  ((PASS++))
else
  echo "  FAIL: cat blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "stat /tmp/.pr-review-state/some-file")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stat allowed during review"
  ((PASS++))
else
  echo "  FAIL: stat blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "find /tmp/.pr-review-state/ -type f")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: find allowed during review"
  ((PASS++))
else
  echo "  FAIL: find blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "head -20 src/index.ts")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: head allowed during review"
  ((PASS++))
else
  echo "  FAIL: head blocked during review"
  ((FAIL++))
fi

OUTPUT=$(run_gate "wc -l src/index.ts")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: wc allowed during review"
  ((PASS++))
else
  echo "  FAIL: wc blocked during review"
  ((FAIL++))
fi

# Work commands should still be blocked
OUTPUT=$(run_gate "npm run build")
if is_denied "$OUTPUT"; then
  echo "  PASS: npm run build still blocked during review"
  ((PASS++))
else
  echo "  FAIL: npm run build NOT blocked during review"
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
OUTPUT=$(echo '{"tool_input":{}}' | PATH="$GATE_MOCK_DIR:$PATH" STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: empty command allowed through"
  ((PASS++))
else
  echo "  FAIL: empty command blocked"
  ((FAIL++))
fi

echo ""
echo "=== Multiple state files: only needs_review on current branch triggers gate ==="

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/40" "2" "passed" "$CURRENT_BRANCH"
create_state "https://github.com/Garsson-io/garsson-prints/pull/5" "1" "needs_review" "$CURRENT_BRANCH"

# INVARIANT: Gate activates if a state file on the current branch has needs_review
# SUT: enforce-pr-review.sh with mixed state files on same branch
OUTPUT=$(run_gate "npm test")
if is_denied "$OUTPUT"; then
  echo "  PASS: gate active when one of multiple PRs needs review (same branch)"
  ((PASS++))
else
  echo "  FAIL: gate NOT active despite needs_review state on current branch"
  ((FAIL++))
fi

REASON=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
assert_contains "deny references the correct PR" "garsson-prints/pull/5" "$REASON"

echo ""
echo "=== Cross-worktree isolation: other branch's review does not block ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/54" "1" "needs_review" "wt/other-worktree-branch"

# INVARIANT: A needs_review state from a different branch does NOT block the current branch
# SUT: enforce-pr-review.sh branch filtering
OUTPUT=$(run_gate "npm test")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: other branch's needs_review does not block current branch"
  ((PASS++))
else
  echo "  FAIL: other branch's needs_review is blocking current branch"
  ((FAIL++))
fi

# INVARIANT: Legacy state files without BRANCH= field are SKIPPED — they can't be
# safely attributed to any worktree, so blocking on them causes cross-worktree contamination.
# SUT: enforce-pr-review.sh via shared state-utils.sh is_state_for_current_worktree
setup
local_file="$STATE_DIR/Garsson-io_nanoclaw_99"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/99\nROUND=1\nSTATUS=needs_review\n' > "$local_file"

OUTPUT=$(run_gate "npm test")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: legacy state file (no BRANCH) does NOT block (cross-worktree safety)"
  ((PASS++))
else
  echo "  FAIL: legacy state file (no BRANCH) is blocking — cross-worktree contamination risk"
  ((FAIL++))
fi

echo ""
echo "=== Stale state files are ignored ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/50" "1" "needs_review"

# INVARIANT: State files older than MAX_STATE_AGE are treated as stale and ignored
# SUT: enforce-pr-review.sh staleness check
# Backdate the state file to 3 hours ago (10800 seconds)
STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_50"
backdate_file "$STATE_FILE" 3

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
cleanup_test_env

print_results
