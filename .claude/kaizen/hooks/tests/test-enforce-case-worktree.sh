#!/bin/bash
# Tests for enforce-case-worktree.sh hook
# Run: bash .claude/kaizen/hooks/tests/test-enforce-case-worktree.sh
#
# INVARIANT: git commit/push inside a git worktree are ALLOWED.
# INVARIANT: git commit/push outside a worktree (main checkout) are DENIED.
# INVARIANT: Non-git-commit/push commands are always ALLOWED regardless of location.
# SUT: enforce-case-worktree.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
HOOK="$HOOKS_DIR/enforce-case-worktree.sh"
source "$SCRIPT_DIR/test-helpers.sh"

setup_mock_dir
trap 'rm -rf "$MOCK_DIR"' EXIT

# Helper: mock git to simulate being inside a worktree
# In a worktree, --git-dir and --git-common-dir return different paths
setup_worktree_mock() {
  cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "rev-parse --git-dir"; then
  echo "/repo/.git/worktrees/my-worktree"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-common-dir"; then
  echo "/repo/.git"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --abbrev-ref HEAD"; then
  echo "some-branch"
  exit 0
fi
/usr/bin/git "$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

# Helper: mock git to simulate being in the main checkout (not a worktree)
# In main checkout, --git-dir and --git-common-dir return the same path
setup_main_checkout_mock() {
  cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "rev-parse --git-dir"; then
  echo ".git"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-common-dir"; then
  echo ".git"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --abbrev-ref HEAD"; then
  echo "main"
  exit 0
fi
/usr/bin/git "$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

echo "=== Non-git-commit/push commands are always allowed ==="

setup_main_checkout_mock

OUTPUT=$(run_hook "$HOOK" "npm run build")
assert_eq "npm command allowed in main checkout" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git status")
assert_eq "git status allowed in main checkout" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git add .")
assert_eq "git add allowed in main checkout" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git diff HEAD")
assert_eq "git diff allowed in main checkout" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git log --oneline")
assert_eq "git log allowed in main checkout" "" "$OUTPUT"

echo ""
echo "=== Inside a worktree: commit and push are ALLOWED ==="

setup_worktree_mock

OUTPUT=$(run_hook "$HOOK" "git commit -m 'fix something'")
assert_eq "commit allowed in worktree" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git push origin my-branch")
assert_eq "push allowed in worktree" "" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git push -u origin my-branch")
assert_eq "push -u allowed in worktree" "" "$OUTPUT"

echo ""
echo "=== Outside a worktree (main checkout): commit and push are DENIED ==="

setup_main_checkout_mock

OUTPUT=$(run_hook "$HOOK" "git commit -m 'bad'")
assert_contains "commit denied in main checkout" "deny" "$OUTPUT"
assert_contains "commit deny mentions worktree" "worktree" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git push origin main")
assert_contains "push denied in main checkout" "deny" "$OUTPUT"

OUTPUT=$(run_hook "$HOOK" "git push -u origin some-branch")
assert_contains "push -u denied in main checkout" "deny" "$OUTPUT"

echo ""
echo "=== Branch name doesn't matter — only worktree context ==="

# Even with a branch name that looks like a case/feature branch,
# if we're not in a worktree, it should be denied
setup_main_checkout_mock

OUTPUT=$(run_hook "$HOOK" "git commit -m 'sneaky'")
assert_contains "main checkout denied regardless of branch name" "deny" "$OUTPUT"

# Even with a random branch name, if we're in a worktree, it should be allowed
setup_worktree_mock

OUTPUT=$(run_hook "$HOOK" "git commit -m 'any branch is fine'")
assert_eq "worktree allowed regardless of branch name" "" "$OUTPUT"

print_results
