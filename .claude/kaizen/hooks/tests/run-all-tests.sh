#!/bin/bash
# run-all-tests.sh — Run all hook tests (unit + integration + harness)
#
# Usage:
#   bash .claude/kaizen/hooks/tests/run-all-tests.sh           # Run all
#   bash .claude/kaizen/hooks/tests/run-all-tests.sh --unit     # Unit tests only
#   bash .claude/kaizen/hooks/tests/run-all-tests.sh --harness  # Harness tests only
#   bash .claude/kaizen/hooks/tests/run-all-tests.sh --quick    # Fast subset
#
# Exit 0 = all passed, 1 = failures

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-all}"

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_TESTS=0
FAILED_FILES=()

run_test_file() {
  local file="$1"
  local name
  name=$(basename "$file" .sh)

  echo ""
  echo "━━━ $name ━━━"

  local output exit_code
  output=$(bash "$file" 2>&1)
  exit_code=$?

  # Extract pass/fail counts from output
  local pass fail
  pass=$(echo "$output" | grep -oP '(\d+) passed' | grep -oP '\d+' | tail -1)
  fail=$(echo "$output" | grep -oP '(\d+) failed' | grep -oP '\d+' | tail -1)
  pass=${pass:-0}
  fail=${fail:-0}

  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  TOTAL_TESTS=$((TOTAL_TESTS + pass + fail))

  if [ "$exit_code" -ne 0 ] || [ "$fail" -gt 0 ]; then
    echo "$output" | grep -E '(FAIL|PASS):' | head -20
    echo "  RESULT: $pass passed, $fail failed"
    FAILED_FILES+=("$name")
  else
    echo "  RESULT: $pass passed, $fail failed"
  fi
}

# Unit tests (existing)
UNIT_TESTS=(
  "$SCRIPT_DIR/test-parse-command.sh"
  "$SCRIPT_DIR/test-state-utils.sh"
  "$SCRIPT_DIR/test-allowlist.sh"
  "$SCRIPT_DIR/test-check-dirty-files.sh"
  "$SCRIPT_DIR/test-check-test-coverage.sh"
  "$SCRIPT_DIR/test-check-verification.sh"
  "$SCRIPT_DIR/test-enforce-case-worktree.sh"
  "$SCRIPT_DIR/test-enforce-case-exists.sh"
  "$SCRIPT_DIR/test-enforce-worktree-writes.sh"
  "$SCRIPT_DIR/test-enforce-pr-review.sh"
  "$SCRIPT_DIR/test-enforce-pr-review-stop.sh"
  "$SCRIPT_DIR/test-enforce-pr-review-tools.sh"
  "$SCRIPT_DIR/test-pr-review-loop.sh"
  "$SCRIPT_DIR/test-kaizen-merge-notify.sh"
  "$SCRIPT_DIR/test-kaizen-merge-gate.sh"
  "$SCRIPT_DIR/test-send-telegram-ipc.sh"
  "$SCRIPT_DIR/test-enforce-post-merge-stop.sh"
  "$SCRIPT_DIR/test-post-merge-clear.sh"
  "$SCRIPT_DIR/test-enforce-pr-kaizen.sh"
  "$SCRIPT_DIR/test-pr-kaizen-clear.sh"
  "$SCRIPT_DIR/test-kaizen-reflect.sh"
  "$SCRIPT_DIR/test-warn-code-quality.sh"
  "$SCRIPT_DIR/test-worktree-du-cleanup.sh"
  "$SCRIPT_DIR/test-check-practices.sh"
  "$SCRIPT_DIR/test-resolve-main-checkout.sh"
  "$SCRIPT_DIR/test-verify-before-stop.sh"
  "$SCRIPT_DIR/test-check-cleanup-on-stop.sh"
  "$SCRIPT_DIR/test-check-wip.sh"
  "$SCRIPT_DIR/test-waiver-quality.sh"
)

# Bash harness tests (integration + interaction tests)
BASH_HARNESS_TESTS=(
  "$SCRIPT_DIR/test-schema-validation.sh"
  "$SCRIPT_DIR/test-real-world-commands.sh"
  "$SCRIPT_DIR/test-integration-parallel-hooks.sh"
  "$SCRIPT_DIR/test-review-enforcement-e2e.sh"
  "$SCRIPT_DIR/test-hook-interaction-matrix.sh"
  "$SCRIPT_DIR/test-integration-pr-lifecycle.sh"
  "$SCRIPT_DIR/test-claude-wt.sh"
  "$SCRIPT_DIR/../../../../scripts/tests/test-resolve-cli-kaizen.sh"
)

# Python harness test (preferred — cleaner, faster, better assertions)
PYTHON_TEST="$SCRIPT_DIR/test_hooks.py"

echo "Hook Test Suite"
echo "==============="

# Category prevention: detect orphaned test files not registered in any test array.
# This catches the exact bug that let test-kaizen-merge-gate.sh failures go unnoticed (kaizen #176).
check_orphaned_tests() {
  local orphaned=()
  for f in "$SCRIPT_DIR"/test-*.sh; do
    [ -f "$f" ] || continue
    local base
    base=$(basename "$f")
    # Skip test-helpers.sh (shared library, not a test)
    [ "$base" = "test-helpers.sh" ] && continue
    local found=false
    for t in "${UNIT_TESTS[@]}" "${BASH_HARNESS_TESTS[@]}"; do
      if [ "$(basename "$t")" = "$base" ]; then
        found=true
        break
      fi
    done
    if ! $found; then
      orphaned+=("$base")
    fi
  done
  if [ ${#orphaned[@]} -gt 0 ]; then
    echo ""
    echo "ORPHANED TEST FILES (not registered in run-all-tests.sh):"
    for f in "${orphaned[@]}"; do
      echo "  - $f"
    done
    echo ""
    echo "Add these to UNIT_TESTS or BASH_HARNESS_TESTS array."
    TOTAL_FAIL=$((TOTAL_FAIL + ${#orphaned[@]}))
    FAILED_FILES+=("orphan-check")
    return 1
  fi
  return 0
}

check_orphaned_tests

run_python_tests() {
  echo ""
  echo "━━━ test_hooks.py (pytest) ━━━"
  if ! command -v python3 &>/dev/null; then
    echo "  SKIP: python3 not available"
    return
  fi
  if ! python3 -c "import pytest" 2>/dev/null; then
    echo "  SKIP: pytest not installed (pip3 install pytest)"
    return
  fi

  local output exit_code
  output=$(python3 -m pytest "$PYTHON_TEST" -v --tb=short 2>&1)
  exit_code=$?

  local pass fail
  pass=$(echo "$output" | grep -oP '(\d+) passed' | grep -oP '\d+' | tail -1)
  fail=$(echo "$output" | grep -oP '(\d+) failed' | grep -oP '\d+' | tail -1)
  pass=${pass:-0}
  fail=${fail:-0}

  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  TOTAL_TESTS=$((TOTAL_TESTS + pass + fail))

  if [ "$exit_code" -ne 0 ] || [ "$fail" -gt 0 ]; then
    echo "$output" | grep -E '(PASSED|FAILED)' | head -20
    echo "  RESULT: $pass passed, $fail failed"
    FAILED_FILES+=("test_hooks.py")
  else
    echo "  RESULT: $pass passed, $fail failed"
  fi
}

case "$MODE" in
  --unit)
    echo "Running unit tests only..."
    for t in "${UNIT_TESTS[@]}"; do
      [ -f "$t" ] && run_test_file "$t"
    done
    ;;
  --harness)
    echo "Running harness tests only..."
    for t in "${BASH_HARNESS_TESTS[@]}"; do
      [ -f "$t" ] && run_test_file "$t"
    done
    run_python_tests
    ;;
  --python)
    echo "Running Python tests only..."
    run_python_tests
    ;;
  --quick)
    echo "Running quick subset..."
    run_python_tests
    ;;
  all|*)
    echo "Running all tests..."
    for t in "${UNIT_TESTS[@]}"; do
      [ -f "$t" ] && run_test_file "$t"
    done
    for t in "${BASH_HARNESS_TESTS[@]}"; do
      [ -f "$t" ] && run_test_file "$t"
    done
    run_python_tests
    ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "TOTAL: $TOTAL_TESTS tests, $TOTAL_PASS passed, $TOTAL_FAIL failed"

if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  echo ""
  echo "FAILED FILES:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
  echo ""
  exit 1
fi

echo "All tests passed."
exit 0
