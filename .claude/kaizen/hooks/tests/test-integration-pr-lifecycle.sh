#!/bin/bash
# test-integration-pr-lifecycle.sh — End-to-end PR lifecycle integration test
#
# Tests the full flow across multiple hooks interacting via shared state:
#   1. gh pr create → pr-review-loop writes state → enforce-pr-review gates
#   2. gh pr diff → pr-review-loop marks passed → enforce-pr-review opens gate
#   3. git push → pr-review-loop increments round → enforce-pr-review re-gates
#   4. gh pr merge → pr-review-loop cleans up → enforce-pr-review allows all
#
# INVARIANT: The PR review lifecycle transitions correctly across hooks.
# SUT: enforce-pr-review.sh + pr-review-loop.sh interacting via state files.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/harness.sh"

# Isolated state directory for this test
STATE_DIR="$HARNESS_TEMP/pr-review-state"
mkdir -p "$STATE_DIR"
export STATE_DIR
export DEBUG_LOG="$HARNESS_TEMP/debug.log"

ENFORCE="$HOOKS_DIR/enforce-pr-review.sh"
LOOP="$HOOKS_DIR/pr-review-loop.sh"

INTEG_MOCK_DIR="$HARNESS_TEMP/mock-bin"
setup_default_gh_mock "$INTEG_MOCK_DIR"

HOOK_ENV_VARS=$(printf 'STATE_DIR=%s\nPATH=%s\n' "$STATE_DIR" "$INTEG_MOCK_DIR:$PATH")

# Helpers that use the harness input builders
run_pre_hook() {
  local command="$1"
  local input
  input=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$command" '{command: $c}')")
  run_single_hook "$ENFORCE" "$input" 10 "$HOOK_ENV_VARS"
}

run_post_hook() {
  local command="$1"
  local stdout="${2:-}"
  local stderr="${3:-}"
  local exit_code="${4:-0}"
  local input
  input=$(build_post_tool_use_input "Bash" \
    "$(jq -n --arg c "$command" '{command: $c}')" \
    "$stdout" "$stderr" "$exit_code")
  run_single_hook "$LOOP" "$input" 10 "$HOOK_ENV_VARS"
}

echo "=== Phase 1: Before PR create — no gate ==="

run_pre_hook "npm test"
assert_eq "npm test allowed before any PR" "" "$HOOK_STDOUT"

run_pre_hook "git commit -m 'fix bug'"
assert_eq "git commit allowed before any PR" "" "$HOOK_STDOUT"

echo ""
echo "=== Phase 2: gh pr create → gate activates ==="

# PostToolUse: pr-review-loop.sh creates state
run_post_hook \
  "gh pr create --title 'test PR' --body 'test body'" \
  "https://github.com/Garsson-io/nanoclaw/pull/55" \
  "" "0"
assert_contains "pr-review-loop outputs review prompt" "MANDATORY SELF-REVIEW" "$HOOK_STDOUT"

# Verify state file exists
STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_55"
if [ -f "$STATE_FILE" ]; then
  echo "  PASS: state file created"
  ((PASS++))
else
  echo "  FAIL: state file not created at $STATE_FILE"
  ((FAIL++))
  ls -la "$STATE_DIR/" 2>&1
fi

# PreToolUse: enforce-pr-review.sh should now block non-review commands
run_pre_hook "npm test"
if validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: npm test blocked after PR create (gate active)"
  ((PASS++))
else
  echo "  FAIL: npm test NOT blocked after PR create"
  echo "    stdout: $HOOK_STDOUT"
  ((FAIL++))
fi

run_pre_hook "git commit -m 'fix'"
if validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: git commit blocked after PR create"
  ((PASS++))
else
  echo "  FAIL: git commit NOT blocked after PR create"
  ((FAIL++))
fi

# But review commands should be allowed
run_pre_hook "gh pr diff 55"
assert_eq "gh pr diff allowed during gate" "" "$HOOK_STDOUT"

run_pre_hook "git diff HEAD~1"
assert_eq "git diff allowed during gate" "" "$HOOK_STDOUT"

echo ""
echo "=== Phase 3: gh pr diff → gate opens (review passed) ==="

# PostToolUse: pr-review-loop marks state as passed
run_post_hook "gh pr diff 55" "diff output here..." "" "0"
assert_contains "review checklist shown" "checklist" "$HOOK_STDOUT"

# State should now be "passed"
STATUS=$(grep '^STATUS=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
assert_eq "state is 'passed' after diff" "passed" "$STATUS"

# PreToolUse: gate should be open now
run_pre_hook "npm test"
assert_eq "npm test allowed after review passed" "" "$HOOK_STDOUT"

run_pre_hook "git commit -m 'fix review issues'"
assert_eq "git commit allowed after review passed" "" "$HOOK_STDOUT"

echo ""
echo "=== Phase 4: git push → gate re-engages (next round) ==="

# PostToolUse: pr-review-loop increments round
run_post_hook "git push" "Everything up-to-date" "" "0"
assert_contains "push starts next round" "ROUND" "$HOOK_STDOUT"

# State should be needs_review with round 2
STATUS=$(grep '^STATUS=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
ROUND=$(grep '^ROUND=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
assert_eq "state is 'needs_review' after push" "needs_review" "$STATUS"
assert_eq "round is 2 after push" "2" "$ROUND"

# PreToolUse: gate should be active again
run_pre_hook "npm test"
if validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: npm test blocked again after push (round 2)"
  ((PASS++))
else
  echo "  FAIL: npm test NOT blocked after push"
  ((FAIL++))
fi

echo ""
echo "=== Phase 5: Review again → passed → push → round 3 ==="

run_post_hook "gh pr diff 55" "diff..." "" "0"
STATUS=$(grep '^STATUS=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
assert_eq "passed after 2nd review" "passed" "$STATUS"

run_post_hook "git push" "ok" "" "0"
ROUND=$(grep '^ROUND=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
assert_eq "round 3 after 2nd push" "3" "$ROUND"

echo ""
echo "=== Phase 6: gh pr merge → cleanup ==="

run_post_hook \
  "gh pr merge 55 --squash" \
  "✓ Merged https://github.com/Garsson-io/nanoclaw/pull/55" \
  "" "0"

if [ ! -f "$STATE_FILE" ]; then
  echo "  PASS: state file cleaned up after merge"
  ((PASS++))
else
  echo "  FAIL: state file still exists after merge"
  ((FAIL++))
fi

# PreToolUse: everything should be allowed now
run_pre_hook "npm test"
assert_eq "npm test allowed after merge cleanup" "" "$HOOK_STDOUT"

run_pre_hook "git commit -m 'next work'"
assert_eq "git commit allowed after merge cleanup" "" "$HOOK_STDOUT"

echo ""
echo "=== Phase 7: Failed commands don't trigger PostToolUse hooks ==="

run_post_hook "gh pr create --title test" "" "error: failed" "1"
assert_eq "failed pr create produces no output" "" "$HOOK_STDOUT"

# No state should exist
STATE_COUNT=$(ls "$STATE_DIR"/ 2>/dev/null | wc -l | tr -d ' ')
assert_eq "no state files from failed command" "0" "$STATE_COUNT"

echo ""
echo "=== Phase 8: Multi-repo isolation ==="

# Create PR for repo A
run_post_hook \
  "gh pr create --repo Garsson-io/nanoclaw --title 'A'" \
  "https://github.com/Garsson-io/nanoclaw/pull/60" "" "0"

# Create PR for repo B
run_post_hook \
  "gh pr create --repo Garsson-io/garsson-prints --title 'B'" \
  "https://github.com/Garsson-io/garsson-prints/pull/10" "" "0"

STATE_A="$STATE_DIR/Garsson-io_nanoclaw_60"
STATE_B="$STATE_DIR/Garsson-io_garsson-prints_10"

if [ -f "$STATE_A" ] && [ -f "$STATE_B" ]; then
  echo "  PASS: both repos have independent state files"
  ((PASS++))
else
  echo "  FAIL: multi-repo state files missing"
  echo "    A: $([ -f "$STATE_A" ] && echo exists || echo missing)"
  echo "    B: $([ -f "$STATE_B" ] && echo exists || echo missing)"
  ((FAIL++))
fi

# Merge A shouldn't affect B
run_post_hook \
  "gh pr merge 60 --squash" \
  "✓ Merged https://github.com/Garsson-io/nanoclaw/pull/60" "" "0"

if [ ! -f "$STATE_A" ] && [ -f "$STATE_B" ]; then
  echo "  PASS: merging A cleans only A, B untouched"
  ((PASS++))
else
  echo "  FAIL: merge affected wrong state files"
  echo "    A: $([ -f "$STATE_A" ] && echo still-exists || echo cleaned)"
  echo "    B: $([ -f "$STATE_B" ] && echo exists || echo missing)"
  ((FAIL++))
fi

harness_summary
