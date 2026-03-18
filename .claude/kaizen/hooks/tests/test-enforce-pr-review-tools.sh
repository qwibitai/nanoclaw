#!/bin/bash
# Tests for enforce-pr-review-tools.sh — PreToolUse gate for non-Bash tools
# (Edit, Write, Agent) during PR review.
#
# INVARIANT UNDER TEST: During an active PR review, non-Bash write/spawn tools
# are blocked. Read-only tools (Read, Glob, Grep) are NOT covered by this hook
# (they are useful for reviewing code).
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../enforce-pr-review-tools.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

run_tool_gate() {
  local tool_name="$1"
  local input
  input=$(jq -n --arg tool "$tool_name" '{
    tool_name: $tool,
    tool_input: {
      file_path: "/some/file.ts",
      old_string: "foo",
      new_string: "bar"
    }
  }')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

echo "=== No active review: all tools allowed ==="

setup

# INVARIANT: When no state files exist, all tools pass through
# SUT: enforce-pr-review-tools.sh with empty STATE_DIR
for tool in Edit Write Agent; do
  OUTPUT=$(run_tool_gate "$tool")
  if [ -z "$OUTPUT" ]; then
    echo "  PASS: $tool allowed with no active review"
    ((PASS++))
  else
    echo "  FAIL: $tool blocked with no active review"
    ((FAIL++))
  fi
done

echo ""
echo "=== Active review: write/spawn tools blocked ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# INVARIANT: When STATUS=needs_review, Edit/Write/Agent are denied
# SUT: enforce-pr-review-tools.sh deny logic
for tool in Edit Write Agent; do
  OUTPUT=$(run_tool_gate "$tool")
  if is_denied "$OUTPUT"; then
    echo "  PASS: $tool blocked during active review"
    ((PASS++))
  else
    echo "  FAIL: $tool NOT blocked during active review"
    echo "    output: $OUTPUT"
    ((FAIL++))
  fi
done

echo ""
echo "=== Deny message includes tool name and PR info ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/99" "3" "needs_review"

# INVARIANT: Deny message includes actionable information
# SUT: enforce-pr-review-tools.sh deny reason text
OUTPUT=$(run_tool_gate "Edit")
REASON=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')

assert_contains "deny reason includes tool name" "Edit" "$REASON"
assert_contains "deny reason includes PR URL" "nanoclaw/pull/99" "$REASON"
assert_contains "deny reason includes round" "round 3" "$REASON"
assert_contains "deny reason includes gh pr diff" "gh pr diff" "$REASON"

echo ""
echo "=== Passed review: tools allowed ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "passed"

# INVARIANT: When STATUS=passed, all tools are allowed
# SUT: enforce-pr-review-tools.sh with passed state
for tool in Edit Write Agent; do
  OUTPUT=$(run_tool_gate "$tool")
  if [ -z "$OUTPUT" ]; then
    echo "  PASS: $tool allowed after review passed"
    ((PASS++))
  else
    echo "  FAIL: $tool blocked after review passed"
    ((FAIL++))
  fi
done

echo ""
echo "=== Escalated review: tools allowed ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "4" "escalated"

# INVARIANT: When STATUS=escalated, all tools are allowed
# SUT: enforce-pr-review-tools.sh with escalated state
OUTPUT=$(run_tool_gate "Edit")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: Edit allowed after review escalated"
  ((PASS++))
else
  echo "  FAIL: Edit blocked after review escalated"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: other branch's review does not block ==="

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/55" "1" "needs_review" "wt/other-worktree-branch"

# INVARIANT: A needs_review state from another branch does NOT block tools
# SUT: enforce-pr-review-tools.sh branch filtering
OUTPUT=$(run_tool_gate "Edit")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: other branch's needs_review does not block Edit"
  ((PASS++))
else
  echo "  FAIL: other branch's needs_review is blocking Edit"
  ((FAIL++))
fi

echo ""
echo "=== Empty tool name: allowed through ==="

# INVARIANT: Empty/missing tool names are not blocked
# SUT: enforce-pr-review-tools.sh edge case handling
setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

OUTPUT=$(echo '{"tool_name":""}' | PATH="$TOOLS_MOCK_DIR:$PATH" STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: empty tool name allowed through"
  ((PASS++))
else
  echo "  FAIL: empty tool name blocked"
  ((FAIL++))
fi

echo ""
echo "=== Legacy state files (no BRANCH) do not block ==="

setup
local_file="$STATE_DIR/Garsson-io_nanoclaw_99"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/99\nROUND=1\nSTATUS=needs_review\n' > "$local_file"

# INVARIANT: Legacy state files are skipped
# SUT: enforce-pr-review-tools.sh via state-utils.sh
OUTPUT=$(run_tool_gate "Edit")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: legacy state file does not block Edit"
  ((PASS++))
else
  echo "  FAIL: legacy state file is blocking Edit"
  ((FAIL++))
fi

echo ""
echo "=== Stale state files do not block ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/60" "1" "needs_review"
STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_60"
backdate_file "$STATE_FILE" 3

# INVARIANT: Stale state files do not block tools
# SUT: enforce-pr-review-tools.sh via state-utils.sh staleness check
OUTPUT=$(MAX_STATE_AGE=7200 run_tool_gate "Edit")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stale state file does not block Edit"
  ((PASS++))
else
  echo "  FAIL: stale state file is blocking Edit"
  ((FAIL++))
fi

teardown
rm -rf "$TOOLS_MOCK_DIR"

print_results
