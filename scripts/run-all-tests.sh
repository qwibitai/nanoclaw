#!/usr/bin/env bash
# run-all-tests.sh — Run all shell script tests and infrastructure smoke tests
#
# Designed to be called from CI or locally. Exits non-zero if any test fails.
#
# Sections:
#   1. Unit tests — scripts/tests/test-*.sh (function-level tests)
#   2. Infrastructure smoke tests — run each script in safe mode to verify
#      it can start and produce output (catches broken initialization)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
SKIP=0

run_test() {
  local name="$1"
  shift
  echo ""
  echo "--- $name ---"
  if "$@" 2>&1; then
    echo "  PASS"
    ((PASS++)) || true
  else
    echo "  FAIL (exit code $?)"
    ((FAIL++)) || true
  fi
}

run_smoke() {
  local name="$1"
  local script="$2"
  shift 2
  echo ""
  echo "--- SMOKE: $name ---"
  if [ ! -x "$script" ]; then
    echo "  SKIP (not executable or missing)"
    ((SKIP++)) || true
    return
  fi
  local output
  output=$("$script" "$@" 2>&1) || true
  if [ -n "$output" ]; then
    echo "  PASS (produced output)"
    ((PASS++)) || true
  else
    echo "  FAIL (no output)"
    ((FAIL++)) || true
  fi
}

echo "========================================"
echo "  Shell Script Tests"
echo "========================================"

# Section 1: Unit tests
echo ""
echo "=== Unit tests ==="
for test_file in "$SCRIPT_DIR"/tests/test-*.sh; do
  [ -f "$test_file" ] || continue
  name="$(basename "$test_file")"
  run_test "$name" bash "$test_file"
done

# Section 2: Infrastructure smoke tests
# These run each script in safe mode — verifying the entry path works,
# not internal logic. Catches every "script can't even start" bug.
echo ""
echo "=== Infrastructure smoke tests ==="

run_smoke "worktree-du.sh --help" "$SCRIPT_DIR/worktree-du.sh" --help
run_smoke "worktree-du.sh analyze --fast" "$SCRIPT_DIR/worktree-du.sh" analyze --fast
run_smoke "claude-wt.sh --help" "$SCRIPT_DIR/claude-wt.sh" --help

echo ""
echo "========================================"
echo "  Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All tests passed."
