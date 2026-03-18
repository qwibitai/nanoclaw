#!/bin/bash
# Tests for lib/state-utils.sh — shared worktree isolation logic
# This is the SINGLE enforcement point for cross-worktree safety.
# All hooks use these functions instead of iterating state files directly.
source "$(dirname "$0")/test-helpers.sh"

setup_test_env
MAX_STATE_AGE=7200
export MAX_STATE_AGE

source "$(dirname "$0")/../lib/state-utils.sh"

setup() { reset_state; }
teardown() { reset_state; }

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
backdate_file "$STATE_FILE" 3

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
backdate_file "$STATE_DIR/f5" 3

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

echo ""
echo "=== find_needs_review_state: returns first needs_review ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/10\nROUND=2\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_passed"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/11\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_needs"

# INVARIANT: find_needs_review_state returns the PR with needs_review, not passed
# SUT: find_needs_review_state
REVIEW_INFO=$(find_needs_review_state)
if [ $? -eq 0 ]; then
  echo "  PASS: find_needs_review_state found a review"
  ((PASS++))
else
  echo "  FAIL: find_needs_review_state returned failure"
  ((FAIL++))
fi

assert_contains "returns correct PR URL" "nanoclaw/pull/11" "$REVIEW_INFO"
assert_contains "returns round" "1" "$REVIEW_INFO"

echo ""
echo "=== find_needs_review_state: returns failure when none pending ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/10\nROUND=2\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_passed"

# INVARIANT: find_needs_review_state returns 1 when no needs_review exists
# SUT: find_needs_review_state with only passed state
REVIEW_INFO=$(find_needs_review_state)
if [ $? -ne 0 ]; then
  echo "  PASS: find_needs_review_state returns failure when none pending"
  ((PASS++))
else
  echo "  FAIL: find_needs_review_state returned success when none pending"
  ((FAIL++))
fi

echo ""
echo "=== find_needs_review_state: ignores other branch ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/20\nROUND=1\nSTATUS=needs_review\nBRANCH=wt/other\n' > "$STATE_DIR/f_other"

# INVARIANT: find_needs_review_state skips other branches
# SUT: find_needs_review_state with cross-worktree state
REVIEW_INFO=$(find_needs_review_state)
if [ $? -ne 0 ]; then
  echo "  PASS: find_needs_review_state ignores other branch"
  ((PASS++))
else
  echo "  FAIL: find_needs_review_state matched other branch (cross-worktree contamination!)"
  ((FAIL++))
fi

echo ""
echo "=== find_needs_review_state: auto-clears merged PR state (kaizen #85, Fix A) ==="

setup

# Override default mock: return MERGED for pull/99, OPEN for anything else
FIXA_MOCK_DIR=$(mktemp -d)
cat > "$FIXA_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pull/99"; then
  echo "MERGED"
  exit 0
fi
echo "OPEN"
exit 0
MOCK
chmod +x "$FIXA_MOCK_DIR/gh"

printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/99\nROUND=3\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_merged"

# INVARIANT: find_needs_review_state auto-clears state for merged PRs
# SUT: find_needs_review_state with gh returning MERGED
REVIEW_INFO=$(PATH="$FIXA_MOCK_DIR:$PATH" find_needs_review_state)
if [ $? -ne 0 ]; then
  echo "  PASS: find_needs_review_state returns failure for merged PR"
  ((PASS++))
else
  echo "  FAIL: find_needs_review_state returned success for merged PR"
  ((FAIL++))
fi

# INVARIANT: The state file should be deleted after detecting merge
if [ ! -f "$STATE_DIR/f_merged" ]; then
  echo "  PASS: state file deleted after merge detection"
  ((PASS++))
else
  echo "  FAIL: state file still exists after merge detection"
  ((FAIL++))
fi

echo ""
echo "=== find_needs_review_state: auto-clears CLOSED PR state ==="

setup
cat > "$FIXA_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
echo "CLOSED"
exit 0
MOCK
chmod +x "$FIXA_MOCK_DIR/gh"

printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/50\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_closed"

# INVARIANT: CLOSED PRs are also auto-cleared
REVIEW_INFO=$(PATH="$FIXA_MOCK_DIR:$PATH" find_needs_review_state)
if [ $? -ne 0 ] && [ ! -f "$STATE_DIR/f_closed" ]; then
  echo "  PASS: CLOSED PR state auto-cleared"
  ((PASS++))
else
  echo "  FAIL: CLOSED PR state not cleared"
  ((FAIL++))
fi

echo ""
echo "=== find_needs_review_state: keeps OPEN PR state ==="

setup
# Default mock already returns OPEN

printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/60\nROUND=2\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_open"

# INVARIANT: OPEN PRs are NOT cleared — review gate stays active
REVIEW_INFO=$(find_needs_review_state)
if [ $? -eq 0 ] && [ -f "$STATE_DIR/f_open" ]; then
  echo "  PASS: OPEN PR state preserved, review gate active"
  ((PASS++))
else
  echo "  FAIL: OPEN PR state was incorrectly cleared"
  ((FAIL++))
fi
assert_contains "returns correct PR URL for open PR" "nanoclaw/pull/60" "$REVIEW_INFO"

echo ""
echo "=== find_needs_review_state: clears merged, returns next open PR ==="

setup
cat > "$FIXA_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pull/70"; then
  echo "MERGED"
  exit 0
fi
echo "OPEN"
exit 0
MOCK
chmod +x "$FIXA_MOCK_DIR/gh"

printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/70\nROUND=3\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_merged2"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/71\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_open2"

# INVARIANT: Merged PRs are skipped, next open PR is returned
REVIEW_INFO=$(PATH="$FIXA_MOCK_DIR:$PATH" find_needs_review_state)
if [ $? -eq 0 ]; then
  echo "  PASS: found an open PR after skipping merged one"
  ((PASS++))
else
  echo "  FAIL: no PR found after merged one (should have found open PR)"
  ((FAIL++))
fi
assert_contains "returns open PR, not merged one" "nanoclaw/pull/71" "$REVIEW_INFO"

if [ ! -f "$STATE_DIR/f_merged2" ]; then
  echo "  PASS: merged PR state file was cleaned up"
  ((PASS++))
else
  echo "  FAIL: merged PR state file still exists"
  ((FAIL++))
fi

echo ""
echo "=== find_needs_review_state: handles gh failure gracefully ==="

setup
cat > "$FIXA_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
exit 1
MOCK
chmod +x "$FIXA_MOCK_DIR/gh"

printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/80\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/f_gh_fail"

# INVARIANT: If gh fails (network error, etc), treat PR as still open (don't clear)
REVIEW_INFO=$(PATH="$FIXA_MOCK_DIR:$PATH" find_needs_review_state)
if [ $? -eq 0 ] && [ -f "$STATE_DIR/f_gh_fail" ]; then
  echo "  PASS: gh failure treated as PR still open (safe default)"
  ((PASS++))
else
  echo "  FAIL: gh failure caused incorrect behavior"
  ((FAIL++))
fi

rm -rf "$FIXA_MOCK_DIR"

teardown
rm -rf "$DEFAULT_MOCK_DIR"

print_results
