#!/bin/bash
# Tests for lib/state-utils.sh — shared worktree isolation logic
# This is the SINGLE enforcement point for cross-worktree safety.
# All hooks use these functions instead of iterating state files directly.
source "$(dirname "$0")/test-helpers.sh"

STATE_DIR="/tmp/.pr-review-state-test-$$"
MAX_STATE_AGE=7200
export STATE_DIR MAX_STATE_AGE

source "$(dirname "$0")/../lib/state-utils.sh"

setup() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
}

teardown() {
  rm -rf "$STATE_DIR"
}

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

echo "=== is_state_for_current_worktree: same branch, fresh file ==="

setup
STATE_FILE="$STATE_DIR/test_same_branch"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/1\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_FILE"

# INVARIANT: A fresh state file on the current branch passes the filter
# SUT: is_state_for_current_worktree
if is_state_for_current_worktree "$STATE_FILE"; then
  echo "  PASS: same branch, fresh file accepted"
  ((PASS++))
else
  echo "  FAIL: same branch, fresh file rejected"
  ((FAIL++))
fi

echo ""
echo "=== is_state_for_current_worktree: different branch ==="

setup
STATE_FILE="$STATE_DIR/test_diff_branch"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/2\nROUND=1\nSTATUS=needs_review\nBRANCH=wt/other-worktree\n' > "$STATE_FILE"

# INVARIANT: A state file from a different branch is rejected
# SUT: is_state_for_current_worktree branch filtering
if is_state_for_current_worktree "$STATE_FILE"; then
  echo "  FAIL: different branch file accepted (cross-worktree contamination!)"
  ((FAIL++))
else
  echo "  PASS: different branch file rejected"
  ((PASS++))
fi

echo ""
echo "=== is_state_for_current_worktree: no BRANCH field (legacy) ==="

setup
STATE_FILE="$STATE_DIR/test_no_branch"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/3\nROUND=1\nSTATUS=needs_review\n' > "$STATE_FILE"

# INVARIANT: Legacy state files without BRANCH are rejected (can't be attributed)
# SUT: is_state_for_current_worktree legacy handling
if is_state_for_current_worktree "$STATE_FILE"; then
  echo "  FAIL: legacy file (no BRANCH) accepted (contamination risk!)"
  ((FAIL++))
else
  echo "  PASS: legacy file (no BRANCH) rejected"
  ((PASS++))
fi

echo ""
echo "=== is_state_for_current_worktree: stale file ==="

setup
STATE_FILE="$STATE_DIR/test_stale"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/4\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_FILE"
touch -d "3 hours ago" "$STATE_FILE" 2>/dev/null || touch -t "$(date -d '3 hours ago' +%Y%m%d%H%M.%S 2>/dev/null || date -v-3H +%Y%m%d%H%M.%S)" "$STATE_FILE" 2>/dev/null

# INVARIANT: Stale files (>MAX_STATE_AGE) are rejected even if same branch
# SUT: is_state_for_current_worktree staleness check
if is_state_for_current_worktree "$STATE_FILE"; then
  echo "  FAIL: stale file accepted"
  ((FAIL++))
else
  echo "  PASS: stale file rejected"
  ((PASS++))
fi

echo ""
echo "=== is_state_for_current_worktree: nonexistent file ==="

# INVARIANT: Nonexistent files are rejected
# SUT: is_state_for_current_worktree with missing file
if is_state_for_current_worktree "$STATE_DIR/does_not_exist"; then
  echo "  FAIL: nonexistent file accepted"
  ((FAIL++))
else
  echo "  PASS: nonexistent file rejected"
  ((PASS++))
fi

echo ""
echo "=== list_state_files_for_current_worktree: mixed files ==="

setup

# Create files: 2 same-branch, 1 different-branch, 1 legacy, 1 stale
printf 'PR_URL=url1\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f1"
printf 'PR_URL=url2\nROUND=1\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f2"
printf 'PR_URL=url3\nROUND=1\nSTATUS=needs_review\nBRANCH=wt/other\n' > "$STATE_DIR/f3"
printf 'PR_URL=url4\nROUND=1\nSTATUS=needs_review\n' > "$STATE_DIR/f4"
printf 'PR_URL=url5\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f5"
touch -d "3 hours ago" "$STATE_DIR/f5" 2>/dev/null || touch -t "$(date -d '3 hours ago' +%Y%m%d%H%M.%S 2>/dev/null || date -v-3H +%Y%m%d%H%M.%S)" "$STATE_DIR/f5" 2>/dev/null

# INVARIANT: Only fresh, same-branch, BRANCH-tagged files are returned
# SUT: list_state_files_for_current_worktree
FILE_COUNT=$(list_state_files_for_current_worktree | wc -l)
FILE_COUNT=$(echo "$FILE_COUNT" | tr -d ' ')

assert_eq "only 2 of 5 files pass filter" "2" "$FILE_COUNT"

# Verify correct files are returned
LISTED=$(list_state_files_for_current_worktree)
assert_contains "f1 included" "f1" "$LISTED"
assert_contains "f2 included" "f2" "$LISTED"
assert_not_contains "f3 (other branch) excluded" "f3" "$LISTED"
assert_not_contains "f4 (no BRANCH) excluded" "f4" "$LISTED"
assert_not_contains "f5 (stale) excluded" "f5" "$LISTED"

teardown

print_results
