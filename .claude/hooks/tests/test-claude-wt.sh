#!/bin/bash
# Tests for claude-wt.sh arg parsing
# Run: bash .claude/hooks/tests/test-claude-wt.sh
#
# INVARIANT: --dangerously-skip-permissions is prepended to claude args by default.
# INVARIANT: --safe suppresses --dangerously-skip-permissions.
# INVARIANT: --base, --keep, --safe are consumed and NOT passed to claude.
# INVARIANT: All other args are passed through to claude unchanged.
# INVARIANT: --help exits 0 with usage text.
# SUT: parse_claude_wt_args() in scripts/claude-wt.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
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
assert_eq "no args: keep false" "false" "$KEEP_WORKTREE"
assert_eq "no args: base empty" "" "$BASE_BRANCH"

echo ""
echo "=== --safe suppresses --dangerously-skip-permissions ==="

parse_claude_wt_args --safe
assert_eq "safe: no skip-permissions" "" "${CLAUDE_ARGS[*]:-}"
assert_eq "safe: skip flag false" "false" "$SKIP_PERMISSIONS"

parse_claude_wt_args --safe -p "fix bug"
assert_eq "safe with prompt: no skip-permissions" "-p fix bug" "${CLAUDE_ARGS[*]}"

echo ""
echo "=== --base is consumed, not passed through ==="

parse_claude_wt_args --base feat/foo
assert_eq "base consumed" "feat/foo" "$BASE_BRANCH"
assert_eq "base not in claude args" "--dangerously-skip-permissions" "${CLAUDE_ARGS[*]}"

parse_claude_wt_args --base main -p "do it"
assert_eq "base with prompt" "main" "$BASE_BRANCH"
assert_eq "base not leaked to claude args" "--dangerously-skip-permissions -p do it" "${CLAUDE_ARGS[*]}"

echo ""
echo "=== --keep is consumed, not passed through ==="

parse_claude_wt_args --keep
assert_eq "keep flag set" "true" "$KEEP_WORKTREE"
assert_eq "keep not in claude args" "--dangerously-skip-permissions" "${CLAUDE_ARGS[*]}"

echo ""
echo "=== Combined flags ==="

parse_claude_wt_args --base feat/x --keep --safe -p "task"
assert_eq "combined: base" "feat/x" "$BASE_BRANCH"
assert_eq "combined: keep" "true" "$KEEP_WORKTREE"
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
assert_contains "help mentions base option" "base <branch>" "$HELP_OUTPUT"
assert_contains "help mentions safe option" "safe" "$HELP_OUTPUT"
assert_contains "help mentions keep option" "keep" "$HELP_OUTPUT"

print_results
