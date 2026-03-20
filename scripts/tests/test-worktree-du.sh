#!/bin/bash
# Tests for worktree-du.sh
#
# INVARIANT: worktree-du.sh initialization resolves PROJECT_ROOT correctly
# from any location (main checkout, worktree, subdirectory), and the script
# can be sourced for testing without executing main logic.
#
# SUT: scripts/worktree-du.sh — resolve_project_root() and test guard
# VERIFICATION: Unit tests verify path resolution produces correct absolute
# paths; smoke tests verify the script runs end-to-end.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKTREE_DU="$SCRIPT_DIR/../worktree-du.sh"

PASS=0
FAIL=0

assert_eq() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected: '$expected'"
    echo "    actual:   '$actual'"
    ((FAIL++))
  fi
}

assert_contains() {
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected to contain: '$needle'"
    echo "    actual: '$haystack'"
    ((FAIL++))
  fi
}

# Run a command, capture stdout/stderr/exit, and fail on script errors in stderr.
# Usage: run_capturing COMMAND [ARGS...]
# Sets: RUN_OUTPUT, RUN_STDERR, RUN_EXIT
# Known-benign stderr (e.g., git warnings, cli-kaizen resolution) is allowed.
# Shell/script errors (syntax error, arithmetic, unbound variable, etc.) cause a test failure.
SCRIPT_ERROR_PATTERN='syntax error|bad substitution|unbound variable|command not found|arithmetic|not a valid identifier|unexpected token'
run_capturing() {
  local stderr_file
  stderr_file=$(mktemp)
  RUN_EXIT=0
  RUN_OUTPUT=$("$@" 2>"$stderr_file") || RUN_EXIT=$?
  RUN_STDERR=$(<"$stderr_file")
  rm -f "$stderr_file"
}

assert_no_script_errors() {
  local test_name="$1"
  if echo "$RUN_STDERR" | grep -qiE "$SCRIPT_ERROR_PATTERN"; then
    echo "  FAIL: $test_name — script errors on stderr"
    echo "    stderr: $RUN_STDERR"
    ((FAIL++))
  else
    echo "  PASS: $test_name"
    ((PASS++))
  fi
}

assert_true() {
  local test_name="$1"
  local condition="$2"
  if eval "$condition"; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    condition was false: $condition"
    ((FAIL++))
  fi
}

# Determine the real project root for reference
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== worktree-du.sh tests ==="
echo ""

# --- Test 1: Test guard allows sourcing without executing ---
echo "--- 1: WORKTREE_DU_TEST=1 allows sourcing without side effects ---"
# Source the script — it sets -euo pipefail, so restore our options after.
WORKTREE_DU_TEST=1 source "$WORKTREE_DU"
EXIT_CODE=$?
set +eo pipefail  # undo the sourced script's set -euo pipefail
assert_eq "sourcing with test guard succeeds" "0" "$EXIT_CODE"
assert_true "resolve_project_root is a function" "declare -f resolve_project_root >/dev/null 2>&1"

# --- Test 2: resolve_project_root returns absolute path ---
echo ""
echo "--- 2: resolve_project_root returns an absolute path ---"
RESULT=$(resolve_project_root "$SCRIPT_DIR")
assert_true "result is an absolute path" "[[ '$RESULT' = /* ]]"

# --- Test 3: resolve_project_root from scripts/ dir finds project root ---
echo ""
echo "--- 3: resolve_project_root from scripts/ dir finds project root ---"
RESULT=$(resolve_project_root "$SCRIPT_DIR/..")
assert_eq "finds project root" "$PROJECT_ROOT" "$RESULT"

# --- Test 4: resolve_project_root from project root ---
echo ""
echo "--- 4: resolve_project_root from project root ---"
RESULT=$(resolve_project_root "$PROJECT_ROOT")
assert_eq "finds project root from root" "$PROJECT_ROOT" "$RESULT"

# --- Test 5: resolve_project_root from a subdirectory ---
echo ""
echo "--- 5: resolve_project_root from a subdirectory ---"
RESULT=$(resolve_project_root "$PROJECT_ROOT/src")
assert_eq "finds project root from src/" "$PROJECT_ROOT" "$RESULT"

# --- Test 6: resolve_project_root output is a valid directory ---
echo ""
echo "--- 6: resolve_project_root output is a valid directory ---"
RESULT=$(resolve_project_root "$SCRIPT_DIR")
assert_true "result is a directory" "[ -d '$RESULT' ]"
assert_true "result contains package.json" "[ -f '$RESULT/package.json' ]"

# --- Test 7: resolve_project_root from a worktree (if we're in one) ---
echo ""
echo "--- 7: resolve_project_root works from worktree ---"
# Detect if we're in a worktree
GIT_COMMON="$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null)"
if [[ "$GIT_COMMON" == *"/.git/worktrees/"* ]]; then
  echo "  (running in a worktree — testing worktree path)"
  RESULT=$(resolve_project_root "$PROJECT_ROOT/scripts")
  assert_eq "finds worktree root (not main checkout)" "$PROJECT_ROOT" "$RESULT"
  assert_true "worktree root has package.json" "[ -f '$RESULT/package.json' ]"
else
  echo "  (not in a worktree — testing main checkout path)"
  RESULT=$(resolve_project_root "$PROJECT_ROOT/scripts")
  assert_eq "finds main checkout root" "$PROJECT_ROOT" "$RESULT"
fi

# --- Test 8: Smoke test — script runs analyze --fast without script errors ---
echo ""
echo "--- 8: Smoke test — analyze --fast produces expected output ---"
run_capturing "$WORKTREE_DU" analyze --fast
# Note: analyze may exit non-zero in worktrees without dist/ (cli-kaizen
# resolution fails for case info). We verify it starts, produces output,
# and does NOT emit script errors (syntax, arithmetic, etc.) on stderr.
assert_contains "output contains header" "NanoClaw Worktree DU" "$RUN_OUTPUT"
assert_contains "output contains Worktrees section" "Worktrees" "$RUN_OUTPUT"
assert_no_script_errors "analyze --fast no script errors on stderr"

# --- Test 9: Smoke test — script runs cleanup --dry-run without script errors ---
echo ""
echo "--- 9: Smoke test — cleanup --dry-run produces expected output ---"
run_capturing "$WORKTREE_DU" cleanup --dry-run
# Note: cleanup may exit non-zero in worktrees without dist/ (Phase 5 cli-kaizen
# resolution fails). We verify it starts, runs the cleanup phases correctly,
# and does NOT emit script errors on stderr.
assert_contains "output contains Cleanup" "Cleanup" "$RUN_OUTPUT"
assert_contains "output mentions dry run" "DRY RUN" "$RUN_OUTPUT"
assert_contains "output contains Phase 1" "Phase 1" "$RUN_OUTPUT"
assert_no_script_errors "cleanup --dry-run no script errors on stderr"

# --- Test 10: Smoke test — --help works ---
echo ""
echo "--- 10: Smoke test — --help prints usage ---"
OUTPUT=$("$WORKTREE_DU" --help 2>&1)
EXIT_CODE=$?
assert_eq "--help exits 0" "0" "$EXIT_CODE"
assert_contains "help mentions analyze" "analyze" "$OUTPUT"
assert_contains "help mentions cleanup" "cleanup" "$OUTPUT"

# --- Test 11: analyze_branches arithmetic is safe when grep -c returns 0 ---
echo ""
echo "--- 11: analyze_branches handles zero-match grep -c without arithmetic error ---"
# grep -cv exits 1 when count is 0, which causes `|| echo "0"` to append a
# second "0", producing "0\n0" — an invalid arithmetic operand.
# The fix uses `|| true` so grep's exit code is ignored and only one value is produced.
WORKTREE_DU_TEST=1 source "$WORKTREE_DU"
set +eo pipefail
run_capturing bash -c "source '$WORKTREE_DU' && analyze_branches"
assert_contains "analyze_branches produces output" "Total:" "$RUN_OUTPUT"
assert_no_script_errors "analyze_branches no arithmetic errors"

# --- Test 12: Regression — command substitutions used in arithmetic must produce single values ---
echo ""
echo "--- 12: Regression — no || echo fallbacks that double-output in arithmetic ---"
# Pattern: var=$(cmd | grep -cv PATTERN || echo "0") produces "0\n0" when grep
# returns count 0 (exit 1). The || echo fires AND grep's output is kept,
# resulting in two values. This breaks $((var + ...)).
# We scan the script source to ensure this anti-pattern is not reintroduced.
ANTIPATTERN_COUNT=$(grep -cE 'grep -c.*\|\| echo' "$WORKTREE_DU" || true)
if [ "$ANTIPATTERN_COUNT" -gt 0 ]; then
  echo "  FAIL: found $ANTIPATTERN_COUNT instance(s) of 'grep -c ... || echo' anti-pattern"
  grep -nE 'grep -c.*\|\| echo' "$WORKTREE_DU"
  ((FAIL++))
else
  echo "  PASS: no grep -c || echo anti-pattern found"
  ((PASS++))
fi

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All tests passed."
