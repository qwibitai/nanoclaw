#!/bin/bash
# Tests for claude-wt.sh arg parsing
# Run: bash .claude/kaizen/hooks/tests/test-claude-wt.sh
#
# INVARIANT: --dangerously-skip-permissions is prepended to claude args by default.
# INVARIANT: --safe suppresses --dangerously-skip-permissions.
# INVARIANT: --safe is consumed and NOT passed to claude.
# INVARIANT: All other args are passed through to claude unchanged.
# INVARIANT: --help exits 0 with usage text.
# SUT: parse_claude_wt_args() in scripts/claude-wt.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
CLAUDE_WT="$REPO_ROOT/scripts/claude-wt.sh"
source "$SCRIPT_DIR/test-helpers.sh"

# Source claude-wt.sh in test mode (only loads functions, doesn't execute)
CLAUDE_WT_TEST=1 source "$CLAUDE_WT"

echo "=== Default: --dangerously-skip-permissions is prepended ==="

parse_claude_wt_args
assert_eq "no args: skip-permissions added" "--dangerously-skip-permissions" "${CLAUDE_ARGS[*]}"

parse_claude_wt_args -p "fix bug"
assert_eq "with prompt: skip-permissions first" "--dangerously-skip-permissions -p fix bug" "${CLAUDE_ARGS[*]}"
assert_eq "no args: skip flag true" "true" "$SKIP_PERMISSIONS"

echo ""
echo "=== --safe suppresses --dangerously-skip-permissions ==="

parse_claude_wt_args --safe
assert_eq "safe: no skip-permissions" "" "${CLAUDE_ARGS[*]:-}"
assert_eq "safe: skip flag false" "false" "$SKIP_PERMISSIONS"

parse_claude_wt_args --safe -p "fix bug"
assert_eq "safe with prompt: no skip-permissions" "-p fix bug" "${CLAUDE_ARGS[*]}"

echo ""
echo "=== Combined flags ==="

parse_claude_wt_args --safe -p "task"
assert_eq "combined: safe" "false" "$SKIP_PERMISSIONS"
assert_eq "combined: only claude args remain" "-p task" "${CLAUDE_ARGS[*]}"

echo ""
echo "=== Unknown flags pass through to claude ==="

parse_claude_wt_args --verbose --model opus -p "test"
assert_eq "unknown flags passed through" "--dangerously-skip-permissions --verbose --model opus -p test" "${CLAUDE_ARGS[*]}"

echo ""
echo "=== --help exits 0 with usage text ==="

# Run --help in a subshell since it calls exit 0
HELP_OUTPUT=$(CLAUDE_WT_TEST=1 bash -c 'source "'"$CLAUDE_WT"'"; parse_claude_wt_args --help' 2>&1) || true
assert_contains "help shows usage" "Usage:" "$HELP_OUTPUT"
assert_contains "help mentions safe option" "safe" "$HELP_OUTPUT"

echo ""
echo "=== Advisory mode: worktree-du.sh called with analyze --fast (not cleanup) ==="

# Create a temp dir with mock worktree-du.sh and mock claude
MOCK_SCRIPTS_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_SCRIPTS_DIR"' EXIT

# Copy the real claude-wt.sh to the mock dir so CLAUDE_WT_DIR resolves there
cp "$CLAUDE_WT" "$MOCK_SCRIPTS_DIR/claude-wt.sh"
chmod +x "$MOCK_SCRIPTS_DIR/claude-wt.sh"

# Mock worktree-du.sh — records args to a file
MOCK_ARGS_FILE="$MOCK_SCRIPTS_DIR/worktree-du-args.log"
cat > "$MOCK_SCRIPTS_DIR/worktree-du.sh" << 'MOCK'
#!/bin/bash
echo "$@" > "$(dirname "$0")/worktree-du-args.log"
echo "MOCK_DU_OUTPUT: advisory report here"
MOCK
chmod +x "$MOCK_SCRIPTS_DIR/worktree-du.sh"

# Mock claude — just exit successfully
cat > "$MOCK_SCRIPTS_DIR/claude" << 'MOCK'
#!/bin/bash
exit 0
MOCK
chmod +x "$MOCK_SCRIPTS_DIR/claude"

# Run claude-wt.sh with mock claude on PATH (unset CLAUDE_WT_TEST so main runs)
SCRIPT_OUTPUT=$(PATH="$MOCK_SCRIPTS_DIR:$PATH" CLAUDE_WT_TEST="" bash "$MOCK_SCRIPTS_DIR/claude-wt.sh" 2>&1)

# Test 1: worktree-du.sh was called with "analyze --fast"
if [ -f "$MOCK_ARGS_FILE" ]; then
  MOCK_ARGS=$(cat "$MOCK_ARGS_FILE")
  assert_eq "worktree-du called with analyze --fast" "analyze --fast" "$MOCK_ARGS"
else
  echo "  FAIL: worktree-du.sh was never called"
  ((FAIL++))
fi

# Test 2: worktree-du.sh output is visible (not suppressed by /dev/null)
assert_contains "worktree-du output visible to user" "MOCK_DU_OUTPUT" "$SCRIPT_OUTPUT"

# Test 3: no cleanup arg anywhere
assert_not_contains "no cleanup arg passed" "cleanup" "${MOCK_ARGS:-}"

# Test 4: runs synchronously (output appears before "Starting Claude" line)
# If backgrounded, the mock output might not appear at all or appear after
assert_contains "Starting Claude message present" "Starting Claude" "$SCRIPT_OUTPUT"

# Verify ordering: advisory output comes before "Starting Claude"
DU_LINE=$(echo "$SCRIPT_OUTPUT" | grep -n "MOCK_DU_OUTPUT" | head -1 | cut -d: -f1)
START_LINE=$(echo "$SCRIPT_OUTPUT" | grep -n "Starting Claude" | head -1 | cut -d: -f1)
if [ -n "$DU_LINE" ] && [ -n "$START_LINE" ] && [ "$DU_LINE" -lt "$START_LINE" ]; then
  echo "  PASS: advisory output appears before Claude starts"
  ((PASS++))
else
  echo "  FAIL: advisory output should appear before Claude starts"
  echo "    du line: ${DU_LINE:-missing}, start line: ${START_LINE:-missing}"
  ((FAIL++))
fi

print_results
