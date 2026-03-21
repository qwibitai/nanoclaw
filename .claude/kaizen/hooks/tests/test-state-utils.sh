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

echo ""
echo "=== find_state_with_status: finds matching status ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/90\nSTATUS=needs_post_merge\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/post-merge-test"

# INVARIANT: find_state_with_status returns the first file with the given status
# SUT: find_state_with_status general-purpose lookup
STATE_INFO=$(find_state_with_status "needs_post_merge")
if [ $? -eq 0 ]; then
  echo "  PASS: find_state_with_status found needs_post_merge"
  ((PASS++))
else
  echo "  FAIL: find_state_with_status did not find needs_post_merge"
  ((FAIL++))
fi
assert_contains "returns correct PR URL" "nanoclaw/pull/90" "$STATE_INFO"

echo ""
echo "=== find_state_with_status: ignores non-matching status ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/91\nSTATUS=awaiting_merge\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/post-merge-test2"

# INVARIANT: find_state_with_status returns failure when no matching status exists
STATE_INFO=$(find_state_with_status "needs_post_merge")
if [ $? -ne 0 ]; then
  echo "  PASS: find_state_with_status correctly ignores non-matching status"
  ((PASS++))
else
  echo "  FAIL: find_state_with_status returned success for wrong status"
  ((FAIL++))
fi

echo ""
echo "=== find_state_with_status: respects cross-worktree isolation ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/92\nSTATUS=needs_post_merge\nBRANCH=wt/other-branch\n' > "$STATE_DIR/post-merge-other"

# INVARIANT: find_state_with_status ignores state from other branches
STATE_INFO=$(find_state_with_status "needs_post_merge")
if [ $? -ne 0 ]; then
  echo "  PASS: find_state_with_status ignores other branch's state"
  ((PASS++))
else
  echo "  FAIL: find_state_with_status matched other branch's state"
  ((FAIL++))
fi

echo ""
echo "=== clear_state_with_status: removes matching state file ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/93\nSTATUS=needs_post_merge\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/post-merge-clear-test"

# INVARIANT: clear_state_with_status removes the first matching file
clear_state_with_status "needs_post_merge"
if [ $? -eq 0 ] && [ ! -f "$STATE_DIR/post-merge-clear-test" ]; then
  echo "  PASS: clear_state_with_status removed matching state file"
  ((PASS++))
else
  echo "  FAIL: clear_state_with_status did not remove the file"
  ((FAIL++))
fi

echo ""
echo "=== clear_state_with_status: returns failure when no match ==="

setup

# INVARIANT: clear_state_with_status returns 1 when no matching state exists
clear_state_with_status "needs_post_merge"
if [ $? -ne 0 ]; then
  echo "  PASS: clear_state_with_status returns failure when no match"
  ((PASS++))
else
  echo "  FAIL: clear_state_with_status returned success with no matching files"
  ((FAIL++))
fi

echo ""
echo "=== clear_state_with_status: only clears own branch ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/94\nSTATUS=needs_post_merge\nBRANCH=wt/other-branch\n' > "$STATE_DIR/post-merge-other2"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/95\nSTATUS=needs_post_merge\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/post-merge-own"

# INVARIANT: clear_state_with_status only removes state for the current branch
clear_state_with_status "needs_post_merge"
if [ -f "$STATE_DIR/post-merge-other2" ] && [ ! -f "$STATE_DIR/post-merge-own" ]; then
  echo "  PASS: clear_state_with_status only cleared own branch's state"
  ((PASS++))
else
  echo "  FAIL: clear_state_with_status did not respect branch isolation"
  if [ ! -f "$STATE_DIR/post-merge-other2" ]; then echo "    other branch's file was deleted"; fi
  if [ -f "$STATE_DIR/post-merge-own" ]; then echo "    own branch's file was NOT deleted"; fi
  ((FAIL++))
fi

# ================================================================
# Cross-branch state functions (kaizen #239, #125)
# ================================================================

echo ""
echo "=== list_state_files_any_branch: returns files from all branches ==="

setup
# Same branch
printf 'PR_URL=url1\nSTATUS=needs_pr_kaizen\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/cb1"
# Different branch
printf 'PR_URL=url2\nSTATUS=needs_pr_kaizen\nBRANCH=wt/other-branch\n' > "$STATE_DIR/cb2"
# Legacy (no BRANCH) — still rejected
printf 'PR_URL=url3\nSTATUS=needs_pr_kaizen\n' > "$STATE_DIR/cb3"
# Stale — rejected
printf 'PR_URL=url4\nSTATUS=needs_pr_kaizen\nBRANCH=wt/stale\n' > "$STATE_DIR/cb4"
backdate_file "$STATE_DIR/cb4" 3

# INVARIANT: list_state_files_any_branch returns fresh files regardless of branch,
# but still rejects stale and legacy files
FILE_COUNT=$(list_state_files_any_branch | wc -l)
FILE_COUNT=$(echo "$FILE_COUNT" | tr -d ' ')

assert_eq "any_branch: returns 2 of 4 files (both branches, not stale/legacy)" "2" "$FILE_COUNT"

LISTED=$(list_state_files_any_branch)
assert_contains "any_branch: includes same-branch file" "cb1" "$LISTED"
assert_contains "any_branch: includes other-branch file" "cb2" "$LISTED"
assert_not_contains "any_branch: excludes legacy file" "cb3" "$LISTED"
assert_not_contains "any_branch: excludes stale file" "cb4" "$LISTED"

echo ""
echo "=== find_state_with_status_any_branch: finds state on other branch ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/100\nSTATUS=needs_pr_kaizen\nBRANCH=wt/other-worktree\n' > "$STATE_DIR/pr-kaizen-cross1"

# INVARIANT: find_state_with_status_any_branch finds state regardless of branch
# This is the core fix for kaizen #239
STATE_INFO=$(find_state_with_status_any_branch "needs_pr_kaizen")
if [ $? -eq 0 ]; then
  echo "  PASS: find_state_with_status_any_branch found cross-branch state"
  ((PASS++))
else
  echo "  FAIL: find_state_with_status_any_branch missed cross-branch state"
  ((FAIL++))
fi
assert_contains "returns correct PR URL from other branch" "nanoclaw/pull/100" "$STATE_INFO"

echo ""
echo "=== find_state_with_status_any_branch: still rejects stale ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/101\nSTATUS=needs_pr_kaizen\nBRANCH=wt/other\n' > "$STATE_DIR/pr-kaizen-stale1"
backdate_file "$STATE_DIR/pr-kaizen-stale1" 3

# INVARIANT: Even cross-branch lookup rejects stale files
STATE_INFO=$(find_state_with_status_any_branch "needs_pr_kaizen")
if [ $? -ne 0 ]; then
  echo "  PASS: find_state_with_status_any_branch rejects stale cross-branch state"
  ((PASS++))
else
  echo "  FAIL: find_state_with_status_any_branch accepted stale state"
  ((FAIL++))
fi

echo ""
echo "=== clear_state_with_status_any_branch: clears state on other branch ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/102\nSTATUS=needs_pr_kaizen\nBRANCH=wt/other-worktree\n' > "$STATE_DIR/pr-kaizen-cross2"

# INVARIANT: clear_state_with_status_any_branch removes state regardless of branch
clear_state_with_status_any_branch "needs_pr_kaizen"
if [ $? -eq 0 ] && [ ! -f "$STATE_DIR/pr-kaizen-cross2" ]; then
  echo "  PASS: clear_state_with_status_any_branch removed cross-branch state"
  ((PASS++))
else
  echo "  FAIL: clear_state_with_status_any_branch did not remove cross-branch state"
  ((FAIL++))
fi

echo ""
echo "=== clear_state_with_status_any_branch: preserves non-matching status ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/103\nSTATUS=needs_review\nBRANCH=wt/other\n' > "$STATE_DIR/review-keep"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/104\nSTATUS=needs_pr_kaizen\nBRANCH=wt/other\n' > "$STATE_DIR/kaizen-clear"

# INVARIANT: Only the matching status is cleared, other state preserved
clear_state_with_status_any_branch "needs_pr_kaizen"
if [ -f "$STATE_DIR/review-keep" ] && [ ! -f "$STATE_DIR/kaizen-clear" ]; then
  echo "  PASS: only cleared matching status, preserved other"
  ((PASS++))
else
  echo "  FAIL: did not correctly target status"
  ((FAIL++))
fi

echo ""
echo "=== Contrast: branch-scoped vs cross-branch lookup ==="

setup
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/105\nSTATUS=needs_pr_kaizen\nBRANCH=wt/different\n' > "$STATE_DIR/pr-kaizen-contrast"

# INVARIANT: find_state_with_status MISSES cross-branch state (by design)
STATE_INFO=$(find_state_with_status "needs_pr_kaizen")
if [ $? -ne 0 ]; then
  echo "  PASS: branch-scoped lookup correctly misses cross-branch state"
  ((PASS++))
else
  echo "  FAIL: branch-scoped lookup should NOT find cross-branch state"
  ((FAIL++))
fi

# INVARIANT: find_state_with_status_any_branch FINDS the same state
STATE_INFO=$(find_state_with_status_any_branch "needs_pr_kaizen")
if [ $? -eq 0 ]; then
  echo "  PASS: cross-branch lookup finds the same state"
  ((PASS++))
else
  echo "  FAIL: cross-branch lookup should find cross-branch state"
  ((FAIL++))
fi

teardown
rm -rf "$DEFAULT_MOCK_DIR"

print_results

echo ""
echo "=== find_all_states_with_status: finds all matching (kaizen #279) ==="

reset_state
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/10" "needs_post_merge" "$CURRENT_BRANCH"
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/11" "needs_post_merge" "$CURRENT_BRANCH"
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/12" "awaiting_merge" "$CURRENT_BRANCH"

ALL=$(find_all_states_with_status "needs_post_merge")
COUNT=$(echo "$ALL" | wc -l | tr -d ' ')
assert_eq "find_all finds 2 needs_post_merge states" "2" "$COUNT"
assert_contains "find_all includes PR 10" "pull/10" "$ALL"
assert_contains "find_all includes PR 11" "pull/11" "$ALL"
assert_not_contains "find_all excludes awaiting_merge" "pull/12" "$ALL"

echo ""
echo "=== find_all_states_with_status: returns failure when none ==="

reset_state
find_all_states_with_status "needs_post_merge" > /dev/null 2>&1 && RESULT="found" || RESULT="not found"
assert_eq "find_all returns failure when empty" "not found" "$RESULT"

echo ""
echo "=== find_all_states_with_status: respects cross-worktree isolation ==="

reset_state
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/20" "needs_post_merge" "$CURRENT_BRANCH"
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/21" "needs_post_merge" "other-branch"

ALL=$(find_all_states_with_status "needs_post_merge")
COUNT=$(echo "$ALL" | wc -l | tr -d ' ')
assert_eq "find_all only finds own branch" "1" "$COUNT"
assert_contains "find_all includes own branch PR" "pull/20" "$ALL"

echo ""
echo "=== clear_all_states_with_status: clears all matching (kaizen #279) ==="

reset_state
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/30" "needs_post_merge" "$CURRENT_BRANCH"
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/31" "needs_post_merge" "$CURRENT_BRANCH"
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/32" "awaiting_merge" "$CURRENT_BRANCH"

clear_all_states_with_status "needs_post_merge"
REMAINING=$(find_all_states_with_status "needs_post_merge" 2>/dev/null)
assert_eq "clear_all removed all needs_post_merge" "" "$REMAINING"

# awaiting_merge should still exist
AWAITING=$(find_state_with_status "awaiting_merge")
assert_contains "clear_all preserved awaiting_merge" "pull/32" "$AWAITING"

echo ""
echo "=== clear_all_states_with_status: only clears own branch ==="

reset_state
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/40" "needs_post_merge" "$CURRENT_BRANCH"
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/41" "needs_post_merge" "other-branch"

clear_all_states_with_status "needs_post_merge"
# The other branch's state should still exist (as a file, even though find won't return it)
OTHER_FILE="$STATE_DIR/post-merge-Garsson-io_nanoclaw_41"
if [ -f "$OTHER_FILE" ]; then
  echo "  PASS: other branch's state preserved"
  ((PASS++))
else
  echo "  FAIL: other branch's state was deleted"
  ((FAIL++))
fi

echo ""
echo "=== find_newest_state_with_status_any_branch: returns newest when multiple match (kaizen #327) ==="

reset_state
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

# Create two state files with different timestamps
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/50\nSTATUS=needs_pr_kaizen\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/pr-kaizen-Garsson-io_nanoclaw_50"
sleep 1
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/51\nSTATUS=needs_pr_kaizen\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/pr-kaizen-Garsson-io_nanoclaw_51"

# INVARIANT: find_newest returns the most recently modified state file
STATE_INFO=$(find_newest_state_with_status_any_branch "needs_pr_kaizen")
if [ $? -eq 0 ]; then
  echo "  PASS: find_newest found a state"
  ((PASS++))
else
  echo "  FAIL: find_newest returned failure"
  ((FAIL++))
fi
assert_contains "find_newest returns newer PR (51)" "pull/51" "$STATE_INFO"
assert_not_contains "find_newest does NOT return older PR (50)" "pull/50" "$STATE_INFO"

echo ""
echo "=== find_newest_state_with_status_any_branch: works with single match ==="

reset_state
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/60\nSTATUS=needs_pr_kaizen\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/pr-kaizen-single"

STATE_INFO=$(find_newest_state_with_status_any_branch "needs_pr_kaizen")
if [ $? -eq 0 ]; then
  echo "  PASS: find_newest works with single state"
  ((PASS++))
else
  echo "  FAIL: find_newest failed with single state"
  ((FAIL++))
fi
assert_contains "find_newest returns single PR" "pull/60" "$STATE_INFO"

echo ""
echo "=== find_newest_state_with_status_any_branch: returns failure when none ==="

reset_state
STATE_INFO=$(find_newest_state_with_status_any_branch "needs_pr_kaizen")
if [ $? -ne 0 ]; then
  echo "  PASS: find_newest returns failure when no match"
  ((PASS++))
else
  echo "  FAIL: find_newest returned success with no states"
  ((FAIL++))
fi

echo ""
echo "=== find_newest_state_with_status_any_branch: crosses branches ==="

reset_state
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/70\nSTATUS=needs_pr_kaizen\nBRANCH=wt/other-branch\n' > "$STATE_DIR/pr-kaizen-cross"
sleep 1
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/71\nSTATUS=needs_pr_kaizen\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STATE_DIR/pr-kaizen-current"

STATE_INFO=$(find_newest_state_with_status_any_branch "needs_pr_kaizen")
assert_contains "find_newest crosses branches, returns newest" "pull/71" "$STATE_INFO"

cleanup_test_env

echo ""
echo "================================"
echo "Extended results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All extended tests passed."
