#!/bin/bash
# Tests for check-test-coverage.sh hook
# Run: bash .claude/kaizen/hooks/tests/test-check-test-coverage.sh
#
# INVARIANT: For gh pr merge, the hook checks the ACTUAL PR diff (via gh pr diff),
#   not the local worktree diff (git diff). Unrelated dirty files in the worktree
#   must NOT cause false positive denials.
# INVARIANT: For gh pr create, the hook uses git diff (local branch vs base).
# INVARIANT: When no source files are changed, the hook allows the command (exit 0).
# INVARIANT: When source files are changed without tests, merge is denied with JSON.
# SUT: check-test-coverage.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
HOOK="$HOOKS_DIR/check-test-coverage.sh"
source "$SCRIPT_DIR/test-helpers.sh"

setup_mock_dir
trap 'rm -rf "$MOCK_DIR"' EXIT

echo "=== Non-PR commands are ignored ==="

OUTPUT=$(echo '{"tool_input":{"command":"npm run build"}}' | bash "$HOOK" 2>&1)
assert_eq "npm command exits silently" "" "$OUTPUT"

OUTPUT=$(echo '{"tool_input":{"command":"git push origin main"}}' | bash "$HOOK" 2>&1)
assert_eq "git push exits silently" "" "$OUTPUT"

echo ""
echo "=== Merge: PR with no source files → allow ==="

setup_gh_git_mocks ".claude/kaizen/hooks/check-test-coverage.sh" "src/index.ts
src/unrelated.ts"

OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
assert_eq "no src in PR diff → no output (allow)" "" "$OUTPUT"

echo ""
echo "=== Merge: PR with source + tests → allow ==="

setup_gh_git_mocks "src/index.ts
src/index.test.ts" "src/index.ts
src/unrelated-dirty.ts"

assert_contains "src with matching test → allow message" "Test coverage check" "$(run_hook_stderr "$HOOK" "gh pr merge 42")"

echo ""
echo "=== CRITICAL: Merge uses PR diff, not worktree diff ==="

# gh pr diff returns ONLY .claude/ files (no src)
# git diff returns src/index.ts (dirty worktree)
# Merge should use gh pr diff → no src files → allow
setup_gh_git_mocks ".claude/kaizen/hooks/some-hook.sh" "src/index.ts
src/config.ts"

OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
assert_eq "merge with clean PR but dirty worktree → allow" "" "$OUTPUT"
assert_not_contains "merge should not see worktree src files" "deny" "$OUTPUT"

echo ""
echo "=== Merge: PR with untested source → deny ==="

setup_gh_git_mocks "src/index.ts
src/config.ts" ""

OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
assert_contains "untested source in PR → deny" "deny" "$OUTPUT"
assert_contains "deny message lists files" "Test coverage policy" "$OUTPUT"

echo ""
echo "=== Create: uses git diff (local) ==="

setup_gh_git_mocks "" "src/new-feature.ts"

OUTPUT=$(run_hook_stderr "$HOOK" "gh pr create --title test --body 'test'")
assert_contains "create sees local git diff files" "Test coverage policy" "$OUTPUT"

echo ""
echo "=== Prefixed test files match source (e.g., ipc-github-issues.test.ts covers ipc.ts) ==="

setup_gh_git_mocks "src/ipc.ts
src/github-issues.ts
src/ipc-github-issues.test.ts
src/github-issues.test.ts" ""

assert_contains "prefixed test matches source → allow" "Test coverage check" "$(run_hook_stderr "$HOOK" "gh pr merge 42")"

echo ""
echo "=== container/agent-runner/ files are excluded from coverage checks ==="

setup_gh_git_mocks "container/agent-runner/src/ipc-mcp-stdio.ts
src/github-issues.ts
src/github-issues.test.ts" ""

assert_contains "agent-runner excluded → allow" "Test coverage check" "$(run_hook_stderr "$HOOK" "gh pr merge 42")"

echo ""
echo "=== .test-util.ts files are excluded from source coverage checks ==="

setup_gh_git_mocks "src/test-helpers.test-util.ts
src/github-issues.ts
src/github-issues.test.ts" ""

assert_contains "test-util excluded → allow" "Test coverage check" "$(run_hook_stderr "$HOOK" "gh pr merge 42")"

echo ""
echo "=== Prefixed test does NOT match unrelated source ==="

# ipc-github-issues.test.ts should NOT count as coverage for config.ts
setup_gh_git_mocks "src/config.ts
src/ipc-github-issues.test.ts" ""

OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
assert_contains "unrelated prefixed test → deny" "deny" "$OUTPUT"

print_results
