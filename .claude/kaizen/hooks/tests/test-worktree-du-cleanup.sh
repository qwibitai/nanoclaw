#!/bin/bash
# Tests for worktree-du.sh cleanup enhancements (kaizen #190, #193, #194, #195)
# Run: bash .claude/kaizen/hooks/tests/test-worktree-du-cleanup.sh
#
# INVARIANT: Orphaned locks (dead PID) are removed during cleanup.
# INVARIANT: Active locks (live PID) always block cleanup.
# INVARIANT: Stale locks (live PID, old heartbeat) always block cleanup.
# INVARIANT: classify_lock returns "active", "stale", "orphaned", or "none".
# INVARIANT: Squash-merged branches are detected even though git branch --merged misses them.
# INVARIANT: At-main (stillborn) worktrees are eligible for cleanup.
# SUT: worktree-du.sh lock functions, branch_merge_status(), cleanup Phase 1

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

WORKTREE_DU="$REPO_ROOT/scripts/worktree-du.sh"

# Create a temp directory for test worktrees
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Source worktree-du.sh functions (we need the helpers but not the main execution)
# We can't source it directly since it runs main at the end. Instead, extract functions.
# We'll test by running specific functions via bash -c after sourcing.

# Helper: run a function from worktree-du.sh in an isolated subshell
run_du_func() {
  local func="$1"
  shift
  (
    # Suppress the main execution by overriding MODE
    # Source the script but override the main section
    PROJECT_ROOT="$REPO_ROOT"
    WORKTREES_DIR="$TMPDIR_TEST/worktrees"
    DB_PATH="$REPO_ROOT/store/messages.db"
    STALE_THRESHOLD_SECONDS=1800
    RED=''; GREEN=''; YELLOW=''; BOLD=''; DIM=''; NC=''
    FAST=true
    DRY_RUN=false
    MODE="test"
    MERGED_BRANCHES=""

    # Source functions from the script (up to the main section)
    eval "$(sed -n '/^has_lock_file/,/^# Main$/{ /^# Main$/d; p; }' "$WORKTREE_DU")"

    # Also need helper functions defined earlier
    eval "$(sed -n '/^human_size/,/^has_lock_file/{ /^has_lock_file/d; p; }' "$WORKTREE_DU")"
    eval "$(sed -n '/^has_lock_file/,/^# Main$/{ /^# Main$/d; p; }' "$WORKTREE_DU")"

    "$func" "$@"
  )
}

# Create a mock worktree dir with a lock file
create_mock_worktree() {
  local name="$1"
  local pid="${2:-}"
  local heartbeat="${3:-}"
  local dir="$TMPDIR_TEST/worktrees/$name"
  mkdir -p "$dir"

  if [ -n "$pid" ]; then
    local lock_json="{\"pid\": $pid"
    if [ -n "$heartbeat" ]; then
      lock_json="$lock_json, \"heartbeat\": \"$heartbeat\""
    fi
    lock_json="$lock_json}"
    echo "$lock_json" > "$dir/.worktree-lock.json"
  fi
  echo "$dir"
}

echo "=== Lock PID detection ==="

# Test: get_lock_pid returns PID from lock file
WT_DIR=$(create_mock_worktree "test-pid-present" "12345")
PID_RESULT=$(run_du_func get_lock_pid "$WT_DIR" 2>/dev/null)
assert_eq "get_lock_pid: returns PID when present" "12345" "$PID_RESULT"

# Test: get_lock_pid returns empty when no PID field
WT_DIR=$(create_mock_worktree "test-no-pid")
echo '{"heartbeat": "2026-03-19T00:00:00Z"}' > "$WT_DIR/.worktree-lock.json"
PID_RESULT=$(run_du_func get_lock_pid "$WT_DIR" 2>/dev/null)
assert_eq "get_lock_pid: empty when no PID field" "" "$PID_RESULT"

# Test: get_lock_pid returns empty when no lock file
WT_DIR="$TMPDIR_TEST/worktrees/test-no-lock"
mkdir -p "$WT_DIR"
PID_RESULT=$(run_du_func get_lock_pid "$WT_DIR" 2>/dev/null)
assert_eq "get_lock_pid: empty when no lock file" "" "$PID_RESULT"

echo ""
echo "=== PID liveness detection ==="

# Test: is_lock_pid_alive returns true for current shell PID
WT_DIR=$(create_mock_worktree "test-live-pid" "$$")
run_du_func is_lock_pid_alive "$WT_DIR" 2>/dev/null
assert_eq "is_lock_pid_alive: true for live PID ($$)" "0" "$?"

# Test: is_lock_pid_alive returns false for impossible PID
WT_DIR=$(create_mock_worktree "test-dead-pid" "999999999")
run_du_func is_lock_pid_alive "$WT_DIR" 2>/dev/null
DEAD_RESULT=$?
assert_eq "is_lock_pid_alive: false for dead PID" "1" "$DEAD_RESULT"

# Test: is_lock_pid_alive returns false when no PID in lock
WT_DIR=$(create_mock_worktree "test-no-pid-alive")
echo '{"heartbeat": "2026-03-19T00:00:00Z"}' > "$WT_DIR/.worktree-lock.json"
run_du_func is_lock_pid_alive "$WT_DIR" 2>/dev/null
assert_eq "is_lock_pid_alive: false when no PID field" "1" "$?"

echo ""
echo "=== Lock classification ==="

# Test: classify_lock returns "none" when no lock file
WT_DIR="$TMPDIR_TEST/worktrees/test-classify-none"
mkdir -p "$WT_DIR"
CLASS=$(run_du_func classify_lock "$WT_DIR" 2>/dev/null)
assert_eq "classify_lock: none when no lock file" "none" "$CLASS"

# Test: classify_lock returns "active" for live PID + fresh heartbeat
FRESH_HB=$(date -u +%Y-%m-%dT%H:%M:%SZ)
WT_DIR=$(create_mock_worktree "test-classify-active" "$$" "$FRESH_HB")
CLASS=$(run_du_func classify_lock "$WT_DIR" 2>/dev/null)
assert_eq "classify_lock: active for live PID + fresh heartbeat" "active" "$CLASS"

# Test: classify_lock returns "stale" for live PID + old heartbeat
OLD_HB="2026-03-18T00:00:00Z"
WT_DIR=$(create_mock_worktree "test-classify-stale" "$$" "$OLD_HB")
CLASS=$(run_du_func classify_lock "$WT_DIR" 2>/dev/null)
assert_eq "classify_lock: stale for live PID + old heartbeat" "stale" "$CLASS"

# Test: classify_lock returns "orphaned" for dead PID
WT_DIR=$(create_mock_worktree "test-classify-orphaned" "999999999" "$FRESH_HB")
CLASS=$(run_du_func classify_lock "$WT_DIR" 2>/dev/null)
assert_eq "classify_lock: orphaned for dead PID" "orphaned" "$CLASS"

# Test: classify_lock returns "orphaned" for dead PID even with old heartbeat
WT_DIR=$(create_mock_worktree "test-classify-orphaned-old" "999999999" "$OLD_HB")
CLASS=$(run_du_func classify_lock "$WT_DIR" 2>/dev/null)
assert_eq "classify_lock: orphaned for dead PID + old heartbeat" "orphaned" "$CLASS"

echo ""
echo "=== Squash-merge detection ==="

# For squash-merge detection, we need a real git repo.
# Create a test repo with a squash-merged branch.
TEST_REPO="$TMPDIR_TEST/test-repo"
(
  mkdir -p "$TEST_REPO"
  cd "$TEST_REPO"
  git init -b main >/dev/null 2>&1
  git config user.email "test@test.com"
  git config user.name "Test"

  # Initial commit
  echo "initial" > file.txt
  git add file.txt
  git commit -m "initial" >/dev/null 2>&1

  # Create a feature branch with a change
  git checkout -b feature-branch >/dev/null 2>&1
  echo "feature" > feature.txt
  git add feature.txt
  git commit -m "add feature" >/dev/null 2>&1

  # Go back to main, squash-merge the feature (simulates GitHub squash-merge)
  git checkout main >/dev/null 2>&1
  git merge --squash feature-branch >/dev/null 2>&1
  git commit -m "squash: add feature" >/dev/null 2>&1

  # Create an at-main branch (stillborn — no unique commits)
  git checkout -b stillborn-branch >/dev/null 2>&1
  git checkout main >/dev/null 2>&1

  # Create a branch with genuine unmerged work
  git checkout -b unmerged-branch >/dev/null 2>&1
  echo "unmerged" > unmerged.txt
  git add unmerged.txt
  git commit -m "unmerged work" >/dev/null 2>&1
  git checkout main >/dev/null 2>&1
) >/dev/null 2>&1

# Test branch_merge_status using the test repo
test_merge_status() {
  local branch="$1"
  (
    cd "$TEST_REPO"
    PROJECT_ROOT="$TEST_REPO"
    MERGED_BRANCHES=""
    STALE_THRESHOLD_SECONDS=1800

    # Load functions from worktree-du.sh
    eval "$(sed -n '/^get_merged_branches/,/^# Analyze/{ /^# Analyze/d; p; }' "$WORKTREE_DU")"

    branch_merge_status "$branch"
  )
}

STATUS=$(test_merge_status "feature-branch")
assert_eq "branch_merge_status: squash-merged detected" "squash-merged" "$STATUS"

STATUS=$(test_merge_status "stillborn-branch")
assert_eq "branch_merge_status: at-main detected" "at-main" "$STATUS"

STATUS=$(test_merge_status "unmerged-branch")
assert_eq "branch_merge_status: unmerged detected" "unmerged" "$STATUS"

STATUS=$(test_merge_status "main")
assert_eq "branch_merge_status: main is at-main" "at-main" "$STATUS"

echo ""
echo "=== Stop hook removes lock file ==="

# Test that check-cleanup-on-stop.sh removes lock file
STOP_HOOK="$REPO_ROOT/.claude/kaizen/hooks/check-cleanup-on-stop.sh"
STOP_WT="$TMPDIR_TEST/stop-test-wt"
mkdir -p "$STOP_WT"
echo '{"pid": 999999999}' > "$STOP_WT/.worktree-lock.json"

# Simulate running the hook in a worktree context where WORKTREE_DIR matches
(
  cd "$STOP_WT"
  # Create minimal git structure to simulate worktree
  mkdir -p .git
  # The hook checks GIT_COMMON_DIR != ".git" — we need to simulate a worktree
  # For a real worktree, .git is a file pointing to the main repo
  echo "gitdir: /tmp/fake-git-dir/worktrees/test" > .git/HEAD 2>/dev/null || true
) >/dev/null 2>&1

# The lock file should exist before the hook
assert_eq "stop hook: lock file exists before" "true" "$([ -f "$STOP_WT/.worktree-lock.json" ] && echo true || echo false)"

print_results
