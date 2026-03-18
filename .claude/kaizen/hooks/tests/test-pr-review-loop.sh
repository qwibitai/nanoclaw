#!/bin/bash
# Tests for pr-review-loop.sh — state file keying by PR URL
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../pr-review-loop.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

# Source the hook's functions for direct testing
source "$(dirname "$0")/../lib/parse-command.sh"

# Override STATE_DIR in the hook by testing the functions directly
echo "=== pr_url_to_state_file ==="

# INVARIANT: PR URLs from different repos produce different state file names
# SUT: pr_url_to_state_file
source_with_state_dir() {
  local STATE_DIR="$1"
  # Inline the function since we can't easily source just part of the hook
  local url="$2"
  echo "$STATE_DIR/$(echo "$url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
}

NANOCLAW_STATE=$(source_with_state_dir "$STATE_DIR" "https://github.com/Garsson-io/nanoclaw/pull/33")
PRINTS_STATE=$(source_with_state_dir "$STATE_DIR" "https://github.com/Garsson-io/garsson-prints/pull/2")

assert_contains "nanoclaw PR state file includes repo name" "Garsson-io_nanoclaw_33" "$NANOCLAW_STATE"
assert_contains "prints PR state file includes repo name" "Garsson-io_garsson-prints_2" "$PRINTS_STATE"
assert_not_contains "nanoclaw state != prints state" "$PRINTS_STATE" "$NANOCLAW_STATE"

echo ""
echo "=== Full hook integration: PR create ==="

setup

# Simulate gh pr create for garsson-prints
PR_CREATE_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/garsson-prints --title \"test\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/garsson-prints/pull/2",
    "stderr": "",
    "exit_code": "0"
  }
}')

# Run the hook with overridden STATE_DIR
OUTPUT=$(echo "$PR_CREATE_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "PR create outputs review prompt" "MANDATORY SELF-REVIEW" "$OUTPUT"
assert_contains "PR create mentions the PR URL" "garsson-prints/pull/2" "$OUTPUT"

# Check state file was created with repo-specific name
STATE_FILE="$STATE_DIR/Garsson-io_garsson-prints_2"
if [ -f "$STATE_FILE" ]; then
  echo "  PASS: state file created with PR-URL-based name"
  ((PASS++))

  STORED_URL=$(grep '^PR_URL=' "$STATE_FILE" | cut -d= -f2-)
  assert_eq "state file contains correct PR URL" "https://github.com/Garsson-io/garsson-prints/pull/2" "$STORED_URL"

  STORED_ROUND=$(grep '^ROUND=' "$STATE_FILE" | cut -d= -f2-)
  assert_eq "state file starts at round 1" "1" "$STORED_ROUND"
else
  echo "  FAIL: state file not created at $STATE_FILE"
  ((FAIL++))
  ls -la "$STATE_DIR/" 2>/dev/null
fi

echo ""
echo "=== Two PRs from different repos don't conflict ==="

# Create another PR for nanoclaw
PR_CREATE_NANOCLAW=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/nanoclaw --title \"test2\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/nanoclaw/pull/40",
    "stderr": "",
    "exit_code": "0"
  }
}')

echo "$PR_CREATE_NANOCLAW" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null

PRINTS_FILE="$STATE_DIR/Garsson-io_garsson-prints_2"
NANOCLAW_FILE="$STATE_DIR/Garsson-io_nanoclaw_40"

if [ -f "$PRINTS_FILE" ] && [ -f "$NANOCLAW_FILE" ]; then
  echo "  PASS: both state files exist independently"
  ((PASS++))
else
  echo "  FAIL: expected two independent state files"
  ((FAIL++))
  ls -la "$STATE_DIR/"
fi

echo ""
echo "=== Push finds most recent active state on CURRENT branch ==="

# Both PRs above (garsson-prints/2 and nanoclaw/40) were created from this branch.
# Simulate git push (no PR URL in output)
PUSH_INPUT=$(jq -n '{
  "tool_input": {"command": "git push"},
  "tool_response": {
    "stdout": "Everything up-to-date",
    "stderr": "",
    "exit_code": "0"
  }
}')

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "push triggers next review round (same branch)" "ROUND" "$PUSH_OUTPUT"

echo ""
echo "=== Merge cleans up state file ==="

# Simulate gh pr merge (PR URL in stdout)
MERGE_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr merge 2 --repo Garsson-io/garsson-prints --squash"},
  "tool_response": {
    "stdout": "✓ Merged https://github.com/Garsson-io/garsson-prints/pull/2",
    "stderr": "",
    "exit_code": "0"
  }
}')

echo "$MERGE_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null
PRINTS_FILE="$STATE_DIR/Garsson-io_garsson-prints_2"
if [ ! -f "$PRINTS_FILE" ]; then
  echo "  PASS: merge cleans up state file for correct PR"
  ((PASS++))
else
  echo "  FAIL: state file still exists after merge"
  ((FAIL++))
fi

echo ""
echo "=== Merge output includes post-merge completion checklist (kaizen #86) ==="

# INVARIANT: Merge handler output must include kaizen reflection, issue update,
# and spec update reminders — not just deploy classification.
# SUT: pr-review-loop.sh merge handler output
# VERIFICATION: Output contains all 6 checklist items including the 3 new ones.

teardown
setup

# Re-create state file for a fresh merge test
echo "STATUS=needs_review" > "$STATE_DIR/Garsson-io_garsson-prints_2"
echo "PR_URL=https://github.com/Garsson-io/garsson-prints/pull/2" >> "$STATE_DIR/Garsson-io_garsson-prints_2"
echo "ROUND=1" >> "$STATE_DIR/Garsson-io_garsson-prints_2"

MERGE_OUTPUT=$(echo "$MERGE_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "merge output includes kaizen reflection item" "Kaizen reflection" "$MERGE_OUTPUT"
assert_contains "merge output includes issue update item" "Update linked issue" "$MERGE_OUTPUT"
assert_contains "merge output includes spec update item" "Spec update" "$MERGE_OUTPUT"
assert_contains "merge output includes deploy classification" "Post-merge action needed" "$MERGE_OUTPUT"
assert_contains "merge output includes sync main" "Sync main" "$MERGE_OUTPUT"

echo ""
echo "=== Push with no active state exits silently ==="

teardown
setup

PUSH_EMPTY=$(echo "$PUSH_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$PUSH_EMPTY" ]; then
  echo "  PASS: push with no state produces no output"
  ((PASS++))
else
  echo "  FAIL: push with no state produced output: $PUSH_EMPTY"
  ((FAIL++))
fi

echo ""
echo "=== PR create with no URL in output exits silently ==="

NO_URL_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --title test"},
  "tool_response": {
    "stdout": "some error or unexpected output",
    "stderr": "",
    "exit_code": "0"
  }
}')

NO_URL_OUTPUT=$(echo "$NO_URL_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$NO_URL_OUTPUT" ]; then
  echo "  PASS: PR create with no URL exits silently"
  ((PASS++))
else
  echo "  FAIL: PR create with no URL produced output"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: push does NOT update other branch's state ==="

# INVARIANT: A git push in worktree A must NEVER modify state for worktree B's PR.
# This is the exact bug that caused cross-worktree contamination (kaizen).
# SUT: find_state_by_status via shared state-utils.sh branch filtering
teardown
setup

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

# Create a state file for a DIFFERENT branch's PR (simulating another worktree's work)
OTHER_BRANCH="wt/other-worktree-branch"
OTHER_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_71"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/71\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$OTHER_BRANCH" > "$OTHER_STATE_FILE"

# Push from current worktree — should NOT touch the other branch's state
PUSH_OUTPUT=$(echo "$PUSH_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$PUSH_OUTPUT" ]; then
  echo "  PASS: push in current worktree ignores other branch's state"
  ((PASS++))
else
  echo "  FAIL: push in current worktree modified other branch's state (cross-worktree contamination!)"
  ((FAIL++))
fi

# Verify the other branch's state file was NOT modified
OTHER_STATUS=$(grep '^STATUS=' "$OTHER_STATE_FILE" | cut -d= -f2-)
OTHER_ROUND=$(grep '^ROUND=' "$OTHER_STATE_FILE" | cut -d= -f2-)
OTHER_STORED_BRANCH=$(grep '^BRANCH=' "$OTHER_STATE_FILE" | cut -d= -f2-)

assert_eq "other branch state STATUS unchanged" "needs_review" "$OTHER_STATUS"
assert_eq "other branch state ROUND unchanged" "1" "$OTHER_ROUND"
assert_eq "other branch state BRANCH unchanged" "$OTHER_BRANCH" "$OTHER_STORED_BRANCH"

echo ""
echo "=== Cross-worktree isolation: push DOES update same branch's state ==="

# INVARIANT: A git push should update state files for the CURRENT branch.
# SUT: find_state_by_status with matching branch
teardown
setup

# Create a state file for the CURRENT branch's PR
SAME_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_80"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/80\nROUND=1\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$SAME_STATE_FILE"

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "push updates same branch's state" "ROUND" "$PUSH_OUTPUT"

SAME_STATUS=$(grep '^STATUS=' "$SAME_STATE_FILE" | cut -d= -f2-)
SAME_ROUND=$(grep '^ROUND=' "$SAME_STATE_FILE" | cut -d= -f2-)
assert_eq "same branch state STATUS set to needs_review" "needs_review" "$SAME_STATUS"
assert_eq "same branch state ROUND incremented" "2" "$SAME_ROUND"

echo ""
echo "=== Cross-worktree isolation: legacy state files (no BRANCH) are skipped ==="

# INVARIANT: State files without BRANCH field cannot be attributed to any worktree
# and must be skipped to prevent cross-worktree contamination.
# SUT: find_state_by_status via shared state-utils.sh
teardown
setup

LEGACY_STATE="$STATE_DIR/Garsson-io_nanoclaw_50"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/50\nROUND=1\nSTATUS=needs_review\n' > "$LEGACY_STATE"

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$PUSH_OUTPUT" ]; then
  echo "  PASS: push ignores legacy state file without BRANCH"
  ((PASS++))
else
  echo "  FAIL: push matched legacy state file without BRANCH (contamination risk)"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: stale state files are skipped ==="

# INVARIANT: State files older than MAX_STATE_AGE are ignored even if on same branch.
# SUT: find_state_by_status via shared state-utils.sh staleness check
teardown
setup

STALE_STATE="$STATE_DIR/Garsson-io_nanoclaw_90"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/90\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$STALE_STATE"
# Backdate to 3 hours ago
backdate_file "$STALE_STATE" 3

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | MAX_STATE_AGE=7200 STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$PUSH_OUTPUT" ]; then
  echo "  PASS: push ignores stale state file"
  ((PASS++))
else
  echo "  FAIL: push matched stale state file"
  ((FAIL++))
fi

echo ""
echo "=== Merge-from-main push does NOT increment review round (kaizen #85, Fix B) ==="

# INVARIANT: When HEAD is a merge commit with origin/main as a parent,
# git push should NOT increment the review round — it's a branch protection
# sync, not a code change.
# SUT: pr-review-loop.sh merge-from-main detection in git push handler
teardown
setup

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
MAIN_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "abc123")

# Create state file for current branch (passed review, now syncing with main)
SAME_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_100"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/100\nROUND=2\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$SAME_STATE_FILE"

# Create a mock git that simulates a merge commit from origin/main
MOCK_DIR=$(mktemp -d)
SECOND_PARENT="def456"
cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if [ "\$1" = "log" ] && echo "\$@" | grep -q -- "--format=%P"; then
  # Return two parents — merge commit with origin/main as second parent
  echo "abc123 $MAIN_HEAD"
  exit 0
fi
if [ "\$1" = "rev-parse" ] && [ "\$2" = "origin/main" ]; then
  echo "$MAIN_HEAD"
  exit 0
fi
if [ "\$1" = "rev-parse" ] && [ "\$2" = "--abbrev-ref" ]; then
  echo "$CURRENT_BRANCH"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
chmod +x "$MOCK_DIR/git"

PUSH_INPUT=$(jq -n '{
  "tool_input": {"command": "git push"},
  "tool_response": {
    "stdout": "Everything up-to-date",
    "stderr": "",
    "exit_code": "0"
  }
}')

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | PATH="$MOCK_DIR:$PATH" STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$PUSH_OUTPUT" ]; then
  echo "  PASS: merge-from-main push produces no output (round not incremented)"
  ((PASS++))
else
  echo "  FAIL: merge-from-main push triggered a new review round"
  echo "    output: $(echo "$PUSH_OUTPUT" | head -3)"
  ((FAIL++))
fi

# Verify state was NOT modified
SAME_STATUS=$(grep '^STATUS=' "$SAME_STATE_FILE" | cut -d= -f2-)
SAME_ROUND=$(grep '^ROUND=' "$SAME_STATE_FILE" | cut -d= -f2-)
assert_eq "state STATUS unchanged after merge-from-main" "passed" "$SAME_STATUS"
assert_eq "state ROUND unchanged after merge-from-main" "2" "$SAME_ROUND"

echo ""
echo "=== Regular push (non-merge) DOES increment review round ==="

# INVARIANT: A normal push (non-merge commit) should still increment the round
# SUT: pr-review-loop.sh git push handler with normal commit
teardown
setup

SAME_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_101"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/101\nROUND=1\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$SAME_STATE_FILE"

# Mock git that simulates a regular (non-merge) commit
cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if [ "\$1" = "log" ] && echo "\$@" | grep -q -- "--format=%P"; then
  # Single parent — not a merge commit
  echo "abc123"
  exit 0
fi
if [ "\$1" = "rev-parse" ] && [ "\$2" = "--abbrev-ref" ]; then
  echo "$CURRENT_BRANCH"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
chmod +x "$MOCK_DIR/git"

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | PATH="$MOCK_DIR:$PATH" STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "regular push triggers next review round" "ROUND" "$PUSH_OUTPUT"

SAME_STATUS=$(grep '^STATUS=' "$SAME_STATE_FILE" | cut -d= -f2-)
SAME_ROUND=$(grep '^ROUND=' "$SAME_STATE_FILE" | cut -d= -f2-)
assert_eq "state STATUS set to needs_review after regular push" "needs_review" "$SAME_STATUS"
assert_eq "state ROUND incremented after regular push" "2" "$SAME_ROUND"

echo ""
echo "=== Merge from non-main branch DOES increment review round ==="

# INVARIANT: A merge commit that doesn't include origin/main as a parent
# (e.g., merging a feature branch) should still increment the round
# SUT: pr-review-loop.sh merge-from-main detection specificity
teardown
setup

SAME_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_102"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/102\nROUND=1\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$SAME_STATE_FILE"

# Mock git with merge commit from a non-main branch
cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if [ "\$1" = "log" ] && echo "\$@" | grep -q -- "--format=%P"; then
  # Two parents, but neither is origin/main
  echo "abc123 xyz789"
  exit 0
fi
if [ "\$1" = "rev-parse" ] && [ "\$2" = "origin/main" ]; then
  echo "$MAIN_HEAD"
  exit 0
fi
if [ "\$1" = "rev-parse" ] && [ "\$2" = "--abbrev-ref" ]; then
  echo "$CURRENT_BRANCH"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
chmod +x "$MOCK_DIR/git"

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | PATH="$MOCK_DIR:$PATH" STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "merge from non-main branch triggers review round" "ROUND" "$PUSH_OUTPUT"

rm -rf "$MOCK_DIR"

teardown

print_results
