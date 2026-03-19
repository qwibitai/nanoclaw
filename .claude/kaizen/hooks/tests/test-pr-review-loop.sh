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

echo ""
echo "=== gh pr diff outputs checklist and transitions state to passed ==="

# INVARIANT: When an agent runs `gh pr diff` while state is needs_review,
# the hook must output the review checklist AND transition status to passed.
# SUT: pr-review-loop.sh TRIGGER 3 (gh pr diff handler)
# VERIFICATION: Output contains checklist text; state file STATUS becomes passed.
teardown
setup

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

# Create state file simulating an active review (round 2, needs_review)
DIFF_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_55"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/55\nROUND=2\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$DIFF_STATE_FILE"

DIFF_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/55"},
  "tool_response": {
    "stdout": "diff --git a/src/foo.ts b/src/foo.ts\n...",
    "stderr": "",
    "exit_code": "0"
  }
}')

DIFF_OUTPUT=$(echo "$DIFF_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "diff output includes review round" "REVIEW ROUND 2/4" "$DIFF_OUTPUT"
assert_contains "diff output includes checklist" "/review-pr" "$DIFF_OUTPUT"
assert_contains "diff output includes REVIEW PASSED" "REVIEW PASSED" "$DIFF_OUTPUT"

# Verify state transitioned to passed
DIFF_STATUS=$(grep '^STATUS=' "$DIFF_STATE_FILE" | cut -d= -f2-)
DIFF_ROUND=$(grep '^ROUND=' "$DIFF_STATE_FILE" | cut -d= -f2-)
assert_eq "state STATUS set to passed after diff" "passed" "$DIFF_STATUS"
assert_eq "state ROUND unchanged after diff" "2" "$DIFF_ROUND"

echo ""
echo "=== gh pr diff with already-passed state exits silently ==="

# INVARIANT: If state is already passed, gh pr diff should not output anything.
# SUT: pr-review-loop.sh guard before TRIGGER 3
# VERIFICATION: No output produced.
teardown
setup

PASSED_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_56"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/56\nROUND=2\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$PASSED_STATE_FILE"

DIFF_PASSED_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/56"},
  "tool_response": {
    "stdout": "diff output...",
    "stderr": "",
    "exit_code": "0"
  }
}')

DIFF_PASSED_OUTPUT=$(echo "$DIFF_PASSED_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$DIFF_PASSED_OUTPUT" ]; then
  echo "  PASS: diff with passed state produces no output"
  ((PASS++))
else
  echo "  FAIL: diff with passed state produced output"
  ((FAIL++))
fi

echo ""
echo "=== Escalation: push exceeding MAX_ROUNDS emits escalation message ==="

# INVARIANT: When push count exceeds MAX_ROUNDS, the hook must emit an
# escalation message instructing the agent to notify a human, and set
# status to escalated.
# SUT: pr-review-loop.sh git push handler escalation path (lines 315-328)
# VERIFICATION: Output contains escalation text; state STATUS becomes escalated.
teardown
setup

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

# Create state at round 4 (MAX_ROUNDS), status=passed (agent just reviewed)
ESC_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_60"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/60\nROUND=4\nSTATUS=passed\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$ESC_STATE_FILE"

ESC_PUSH_INPUT=$(jq -n '{
  "tool_input": {"command": "git push"},
  "tool_response": {
    "stdout": "Everything up-to-date",
    "stderr": "",
    "exit_code": "0"
  }
}')

# Mock git to return single-parent commit (not merge-from-main)
ESC_MOCK_DIR=$(mktemp -d)
cat > "$ESC_MOCK_DIR/git" << MOCK
#!/bin/bash
if [ "\$1" = "log" ] && echo "\$@" | grep -q -- "--format=%P"; then
  echo "abc123"
  exit 0
fi
if [ "\$1" = "rev-parse" ] && [ "\$2" = "--abbrev-ref" ]; then
  echo "$CURRENT_BRANCH"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
chmod +x "$ESC_MOCK_DIR/git"

ESC_OUTPUT=$(echo "$ESC_PUSH_INPUT" | PATH="$ESC_MOCK_DIR:$PATH" STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "escalation output mentions round limit" "REVIEW ROUND 4/4" "$ESC_OUTPUT"
assert_contains "escalation output instructs to escalate" "escalate" "$ESC_OUTPUT"
assert_contains "escalation output mentions PR comment" "gh pr comment" "$ESC_OUTPUT"

# Verify state transitioned to escalated
ESC_STATUS=$(grep '^STATUS=' "$ESC_STATE_FILE" | cut -d= -f2-)
ESC_ROUND=$(grep '^ROUND=' "$ESC_STATE_FILE" | cut -d= -f2-)
assert_eq "state STATUS set to escalated" "escalated" "$ESC_STATUS"
assert_eq "state ROUND stays at MAX_ROUNDS" "4" "$ESC_ROUND"

echo ""
echo "=== Escalation: push after escalated state exits silently ==="

# INVARIANT: Once escalated, further pushes should not produce output.
# SUT: pr-review-loop.sh git push handler guard for escalated status
# VERIFICATION: No output produced.

ESC_SILENT_OUTPUT=$(echo "$ESC_PUSH_INPUT" | PATH="$ESC_MOCK_DIR:$PATH" STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$ESC_SILENT_OUTPUT" ]; then
  echo "  PASS: push after escalation produces no output"
  ((PASS++))
else
  echo "  FAIL: push after escalation produced output"
  ((FAIL++))
fi

rm -rf "$ESC_MOCK_DIR"

echo ""
echo "=== PR create records LAST_REVIEWED_SHA (kaizen #117) ==="

# INVARIANT: After PR create, state file contains LAST_REVIEWED_SHA
# for diff-size scaling on subsequent pushes.
# SUT: pr-review-loop.sh TRIGGER 1 (gh pr create)
teardown
setup

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "abc123")

PR_CREATE_SHA_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --title \"test SHA tracking\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/nanoclaw/pull/200",
    "stderr": "",
    "exit_code": "0"
  }
}')

echo "$PR_CREATE_SHA_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null >/dev/null

SHA_STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_200"
if [ -f "$SHA_STATE_FILE" ]; then
  STORED_SHA=$(grep '^LAST_REVIEWED_SHA=' "$SHA_STATE_FILE" | cut -d= -f2-)
  if [ -n "$STORED_SHA" ]; then
    echo "  PASS: LAST_REVIEWED_SHA recorded after PR create"
    ((PASS++))
  else
    echo "  FAIL: LAST_REVIEWED_SHA not found in state file"
    ((FAIL++))
  fi
else
  echo "  FAIL: state file not created"
  ((FAIL++))
fi

echo ""
echo "=== gh pr diff records LAST_REVIEWED_SHA (kaizen #117) ==="

# INVARIANT: After gh pr diff (review pass), LAST_REVIEWED_SHA is updated
# so diff-size scaling can compare against reviewed baseline.
# SUT: pr-review-loop.sh TRIGGER 3 (gh pr diff)
teardown
setup

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

DIFF_SHA_STATE="$STATE_DIR/Garsson-io_nanoclaw_201"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/201\nROUND=1\nSTATUS=needs_review\nBRANCH=%s\n' "$CURRENT_BRANCH" > "$DIFF_SHA_STATE"

DIFF_SHA_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/201"},
  "tool_response": {
    "stdout": "diff...",
    "stderr": "",
    "exit_code": "0"
  }
}')

echo "$DIFF_SHA_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null >/dev/null

STORED_SHA=$(grep '^LAST_REVIEWED_SHA=' "$DIFF_SHA_STATE" | cut -d= -f2-)
if [ -n "$STORED_SHA" ]; then
  echo "  PASS: LAST_REVIEWED_SHA recorded after diff review"
  ((PASS++))
else
  echo "  FAIL: LAST_REVIEWED_SHA not found after diff"
  ((FAIL++))
fi

echo ""
echo "=== Small push auto-passes review (kaizen #117) ==="

# INVARIANT: When push changes ≤15 lines since last reviewed SHA,
# the review auto-passes with abbreviated output instead of full ceremony.
# SUT: pr-review-loop.sh git push handler with diff-size scaling
teardown
setup

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "abc123")

# Create state with a LAST_REVIEWED_SHA that matches HEAD~1 (small diff)
SMALL_STATE="$STATE_DIR/Garsson-io_nanoclaw_210"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/210\nROUND=1\nSTATUS=passed\nBRANCH=%s\nLAST_REVIEWED_SHA=%s\n' \
  "$CURRENT_BRANCH" "$CURRENT_SHA" > "$SMALL_STATE"

# Mock git to simulate a small diff (5 lines changed)
# All rev-parse calls must use /usr/bin/git to avoid recursive mock calls
SMALL_MOCK_DIR=$(mktemp -d)
cat > "$SMALL_MOCK_DIR/git" << 'MOCK'
#!/bin/bash
if [ "$1" = "log" ] && echo "$@" | grep -q -- "--format=%P"; then
  echo "abc123"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then
  /usr/bin/git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  /usr/bin/git rev-parse HEAD
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "origin/main" ]; then
  /usr/bin/git rev-parse origin/main 2>/dev/null || echo "no-main"
  exit 0
fi
if [ "$1" = "diff" ] && echo "$@" | grep -q -- "--stat"; then
  echo " src/foo.ts | 3 +++"
  echo " src/bar.ts | 2 +-"
  echo " 2 files changed, 4 insertions(+), 1 deletion(-)"
  exit 0
fi
if [ "$1" = "diff" ]; then
  echo "+// small fix"
  echo "+const x = 1;"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$SMALL_MOCK_DIR/git"

SMALL_PUSH_INPUT=$(jq -n '{
  "tool_input": {"command": "git push"},
  "tool_response": {
    "stdout": "Everything up-to-date",
    "stderr": "",
    "exit_code": "0"
  }
}')

SMALL_PUSH_OUTPUT=$(echo "$SMALL_PUSH_INPUT" | PATH="$SMALL_MOCK_DIR:$PATH" STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "small push mentions abbreviated review" "abbreviated review" "$SMALL_PUSH_OUTPUT"
assert_contains "small push shows line count" "5 lines" "$SMALL_PUSH_OUTPUT"

# Verify state auto-passed (not needs_review)
SMALL_STATUS=$(grep '^STATUS=' "$SMALL_STATE" | cut -d= -f2-)
assert_eq "small push auto-passes review" "passed" "$SMALL_STATUS"

rm -rf "$SMALL_MOCK_DIR"

teardown

print_results
