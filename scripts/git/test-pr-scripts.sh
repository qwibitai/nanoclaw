#!/bin/bash
# test-pr-scripts.sh — Smoke tests for git PR helper scripts.
#
# Tests argument parsing, validation, and error messages without requiring
# actual git/GitHub operations. Uses a temp git repo with mocked gh CLI.
#
# Usage: bash scripts/git/test-pr-scripts.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
ERRORS=""

# ---------- test helpers ----------
pass() {
  PASS=$((PASS + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  ERRORS="${ERRORS}\n  FAIL: $1"
  echo "  FAIL: $1" >&2
}

assert_exit() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label (expected exit $expected, got $actual)"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qiF -- "$needle"; then
    pass "$label"
  else
    fail "$label (output missing: '$needle')"
  fi
}

# ---------- setup temp git repo ----------
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Create a minimal git repo for validation tests.
git init -q "$TMPDIR/repo"
cd "$TMPDIR/repo"
git commit -q --allow-empty -m "initial"
git branch -M main

# Create a test branch with a commit.
git checkout -q -b test-branch
git commit -q --allow-empty -m "test commit"
git checkout -q main

# Create a mock gh CLI that returns predictable output.
MOCK_DIR="$TMPDIR/mock-bin"
mkdir -p "$MOCK_DIR"
cat > "$MOCK_DIR/gh" <<'MOCK_GH'
#!/bin/bash
# Mock gh CLI for testing — simulates common responses.
# When --jq is used, gh returns the extracted value (not raw JSON).
ARGS="$*"
case "$ARGS" in
  *"pr list"*"--state open"*)
    echo ""
    exit 0
    ;;
  *"pr list"*"--state merged"*)
    echo ""
    exit 0
    ;;
  *"pr create"*)
    echo "https://github.com/test/repo/pull/42"
    exit 0
    ;;
  *"pr view"*"--jq"*".state"*)
    echo "OPEN"
    exit 0
    ;;
  *"pr view"*"--jq"*".headRefName"*)
    echo "test-branch"
    exit 0
    ;;
  *"pr view"*"--jq"*".baseRefName"*)
    echo "main"
    exit 0
    ;;
  *"pr view"*"--jq"*".url"*)
    echo "https://github.com/test/repo/pull/42"
    exit 0
    ;;
  *"pr view"*"--json state"*)
    echo '{"state":"OPEN"}'
    exit 0
    ;;
  *"pr checks"*)
    echo "build	pass	1m	https://github.com"
    exit 0
    ;;
  *"pr merge"*)
    echo "Merged"
    exit 0
    ;;
  *"auth status"*)
    echo "Logged in to github.com"
    exit 0
    ;;
  *"repo view"*)
    echo '{"nameWithOwner":"test/repo"}'
    exit 0
    ;;
  *)
    echo "mock-gh: unhandled: $ARGS" >&2
    exit 1
    ;;
esac
MOCK_GH
chmod +x "$MOCK_DIR/gh"

# Put mock gh first in PATH.
export PATH="$MOCK_DIR:$PATH"

echo "=== create-pr tests ==="

# Test: missing branch name
echo "--- Test: create-pr with no args ---"
OUTPUT=$("$SCRIPT_DIR/create-pr" 2>&1 || true)
EXIT=$?
# The script should fail (but due to set -e, we capture with || true)
assert_contains "$OUTPUT" "branch name is required" "create-pr: no args gives usage hint"

# Test: invalid branch name with spaces
echo "--- Test: create-pr with spaces in branch name ---"
OUTPUT=$("$SCRIPT_DIR/create-pr" "branch with spaces" 2>&1 || true)
assert_contains "$OUTPUT" "whitespace" "create-pr: rejects branch with spaces"

# Test: invalid branch name with special chars
echo "--- Test: create-pr with invalid ref chars ---"
OUTPUT=$("$SCRIPT_DIR/create-pr" "branch~bad" 2>&1 || true)
assert_contains "$OUTPUT" "invalid git ref" "create-pr: rejects branch with tilde"

# Test: branch name ending in .lock
echo "--- Test: create-pr with .lock suffix ---"
OUTPUT=$("$SCRIPT_DIR/create-pr" "branch.lock" 2>&1 || true)
assert_contains "$OUTPUT" "invalid git ref" "create-pr: rejects .lock suffix"

# Test: branch that doesn't exist
echo "--- Test: create-pr with nonexistent branch ---"
OUTPUT=$("$SCRIPT_DIR/create-pr" "nonexistent-branch-xyz" 2>&1 || true)
assert_contains "$OUTPUT" "does not exist" "create-pr: nonexistent branch error"

# Test: --help flag
echo "--- Test: create-pr --help ---"
OUTPUT=$("$SCRIPT_DIR/create-pr" --help 2>&1 || true)
assert_contains "$OUTPUT" "Usage:" "create-pr: --help shows usage"
assert_contains "$OUTPUT" "--auto-merge" "create-pr: --help shows auto-merge option"

# Test: unknown option
echo "--- Test: create-pr with unknown option ---"
OUTPUT=$("$SCRIPT_DIR/create-pr" --bogus 2>&1 || true)
assert_contains "$OUTPUT" "Unknown option" "create-pr: rejects unknown option"

# Test: no commits (branch at same point as base)
echo "--- Test: create-pr with no commits ahead ---"
git checkout -q main
git checkout -q -b no-commits-branch
git checkout -q main
OUTPUT=$("$SCRIPT_DIR/create-pr" "no-commits-branch" 2>&1 || true)
assert_contains "$OUTPUT" "no commits ahead" "create-pr: detects no commits"
assert_contains "$OUTPUT" "git log" "create-pr: shows git log command in error"

# Test: valid branch with commits (full flow with mock gh)
echo "--- Test: create-pr with valid branch ---"
OUTPUT=$("$SCRIPT_DIR/create-pr" "test-branch" 2>&1 || true)
assert_contains "$OUTPUT" "commit(s) ahead" "create-pr: shows commit count"
assert_contains "$OUTPUT" "Commits to be included" "create-pr: shows commit summary"

echo ""
echo "=== merge-pr tests ==="

# Test: missing PR number
echo "--- Test: merge-pr with no args ---"
OUTPUT=$("$SCRIPT_DIR/merge-pr" 2>&1 || true)
assert_contains "$OUTPUT" "PR number is required" "merge-pr: no args gives usage hint"

# Test: non-numeric PR number
echo "--- Test: merge-pr with non-numeric PR ---"
OUTPUT=$("$SCRIPT_DIR/merge-pr" "abc" 2>&1 || true)
assert_contains "$OUTPUT" "must be numeric" "merge-pr: rejects non-numeric PR"

# Test: --help flag
echo "--- Test: merge-pr --help ---"
OUTPUT=$("$SCRIPT_DIR/merge-pr" --help 2>&1 || true)
assert_contains "$OUTPUT" "Usage:" "merge-pr: --help shows usage"
assert_contains "$OUTPUT" "--ci-timeout" "merge-pr: --help shows ci-timeout option"

# Test: unknown option
echo "--- Test: merge-pr with unknown option ---"
OUTPUT=$("$SCRIPT_DIR/merge-pr" --bogus 2>&1 || true)
assert_contains "$OUTPUT" "Unknown option" "merge-pr: rejects unknown option"

# Test: merge with mock (should succeed with mocked gh)
echo "--- Test: merge-pr with mock gh ---"
OUTPUT=$("$SCRIPT_DIR/merge-pr" 42 2>&1 || true)
assert_contains "$OUTPUT" "merged successfully" "merge-pr: completes with mock gh"

# Test: merge already-merged PR
echo "--- Test: merge-pr with already-merged PR ---"
# Override mock to return MERGED state.
cat > "$MOCK_DIR/gh" <<'MOCK_GH'
#!/bin/bash
case "$*" in
  *"pr view"*"--jq"*".state"*)
    echo "MERGED"
    exit 0
    ;;
  *"pr view"*"--jq"*".url"*)
    echo "https://github.com/test/repo/pull/99"
    exit 0
    ;;
  *)
    echo "mock-gh: $*" >&2
    exit 0
    ;;
esac
MOCK_GH
chmod +x "$MOCK_DIR/gh"
OUTPUT=$("$SCRIPT_DIR/merge-pr" 99 2>&1 || true)
assert_contains "$OUTPUT" "already merged" "merge-pr: detects already merged PR"

# Test: merge closed PR
echo "--- Test: merge-pr with closed PR ---"
cat > "$MOCK_DIR/gh" <<'MOCK_GH'
#!/bin/bash
case "$*" in
  *"pr view"*"--jq"*".state"*)
    echo "CLOSED"
    exit 0
    ;;
  *)
    echo "mock-gh: $*" >&2
    exit 0
    ;;
esac
MOCK_GH
chmod +x "$MOCK_DIR/gh"
OUTPUT=$("$SCRIPT_DIR/merge-pr" 99 2>&1 || true)
assert_contains "$OUTPUT" "closed" "merge-pr: detects closed PR"
assert_contains "$OUTPUT" "gh pr reopen" "merge-pr: suggests reopening closed PR"

echo ""
echo "=== create-and-merge tests ==="

# Test: missing branch name
echo "--- Test: create-and-merge with no args ---"
OUTPUT=$("$SCRIPT_DIR/create-and-merge" 2>&1 || true)
assert_contains "$OUTPUT" "branch name is required" "create-and-merge: no args gives usage hint"

# Test: --help flag
echo "--- Test: create-and-merge --help ---"
OUTPUT=$("$SCRIPT_DIR/create-and-merge" --help 2>&1 || true)
assert_contains "$OUTPUT" "Usage:" "create-and-merge: --help shows usage"

# Test: unknown option
echo "--- Test: create-and-merge with unknown option ---"
OUTPUT=$("$SCRIPT_DIR/create-and-merge" --bogus 2>&1 || true)
assert_contains "$OUTPUT" "Unknown option" "create-and-merge: rejects unknown option"

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  echo -e "\nFailures:$ERRORS"
  exit 1
fi
echo "All tests passed."
