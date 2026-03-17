#!/bin/bash
# Tests for enforce-case-worktree.sh hook
# Run: bash .claude/hooks/tests/test-enforce-case-worktree.sh
#
# INVARIANT: git commit/push on allowed branch prefixes (case/, skill/, feat/, wt/, YYMMDD-) are ALLOWED.
# INVARIANT: git commit/push on main or unrecognized branches are DENIED.
# INVARIANT: Non-git-commit/push commands are always ALLOWED regardless of branch.
# SUT: enforce-case-worktree.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
HOOK="$HOOKS_DIR/enforce-case-worktree.sh"
source "$SCRIPT_DIR/test-helpers.sh"

setup_mock_dir
trap 'rm -rf "$MOCK_DIR"' EXIT

# Helper: create a mock git that reports a specific branch name
setup_branch_mock() {
  local branch="$1"
  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "rev-parse --abbrev-ref HEAD"; then
  echo "$branch"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

echo "=== Non-git-commit/push commands are always allowed ==="

setup_branch_mock "main"

OUTPUT=$(run_hook "$HOOK" "npm run build")
assert_eq "npm command allowed on main" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git status")
assert_eq "git status allowed on main" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git add .")
assert_eq "git add allowed on main" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git diff HEAD")
assert_eq "git diff allowed on main" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git log --oneline")
assert_eq "git log allowed on main" "" "$OUTPUT"

echo ""
echo "=== Allowed branch prefixes can commit and push ==="

setup_branch_mock "case/260317-fix-bug"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'fix'")
assert_eq "case/ branch can commit" "" "$OUTPUT"
OUTPUT=$(run_hook "$HOOK" "git push origin case/260317-fix-bug")
assert_eq "case/ branch can push" "" "$OUTPUT"

setup_branch_mock "skill/browser-tool"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'add skill'")
assert_eq "skill/ branch can commit" "" "$OUTPUT"

setup_branch_mock "feat/new-feature"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'feat'")
assert_eq "feat/ branch can commit" "" "$OUTPUT"
OUTPUT=$(run_hook "$HOOK" "git push -u origin feat/new-feature")
assert_eq "feat/ branch can push" "" "$OUTPUT"

setup_branch_mock "wt/260317-1430-a1b2c3"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'wt commit'")
assert_eq "wt/ nonce branch can commit" "" "$OUTPUT"
OUTPUT=$(run_hook "$HOOK" "git push origin wt/260317-1430-a1b2c3")
assert_eq "wt/ nonce branch can push" "" "$OUTPUT"

setup_branch_mock "260317-1430-manual"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'dated'")
assert_eq "YYMMDD- branch can commit" "" "$OUTPUT"

setup_branch_mock "HEAD"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'rebase'")
assert_eq "detached HEAD can commit" "" "$OUTPUT"

echo ""
echo "=== main and unrecognized branches are DENIED ==="

setup_branch_mock "main"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'bad'")
assert_contains "main branch commit denied" "deny" "$OUTPUT"
assert_contains "main branch deny mentions worktree" "worktree" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git push origin main")
assert_contains "main branch push denied" "deny" "$OUTPUT"

setup_branch_mock "develop"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'wrong branch'")
assert_contains "develop branch denied" "deny" "$OUTPUT"

setup_branch_mock "my-random-branch"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'unrecognized'")
assert_contains "unrecognized branch denied" "deny" "$OUTPUT"

setup_branch_mock "feature/missing-slash-prefix"
OUTPUT=$(run_hook "$HOOK" "git commit -m 'wrong prefix'")
assert_contains "feature/ (not feat/) denied" "deny" "$OUTPUT"

print_results
