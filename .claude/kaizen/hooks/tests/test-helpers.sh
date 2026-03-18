#!/bin/bash
# Shared test helpers for hook tests.
# Source from test files: source "$(dirname "$0")/test-helpers.sh"

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

assert_not_contains() {
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  if ! echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected NOT to contain: '$needle'"
    ((FAIL++))
  fi
}

# Assert a function returns success (exit 0)
assert_ok() {
  local test_name="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected success, got failure"
    ((FAIL++))
  fi
}

# Assert a function returns failure (non-zero exit)
assert_fails() {
  local test_name="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "  FAIL: $test_name"
    echo "    expected failure, got success"
    ((FAIL++))
  else
    echo "  PASS: $test_name"
    ((PASS++))
  fi
}

# Create a temp directory for mock commands. Sets MOCK_DIR.
# Caller must set trap: trap 'rm -rf "$MOCK_DIR"' EXIT
setup_mock_dir() {
  MOCK_DIR=$(mktemp -d)
}

# Run a hook script with a simulated PreToolUse JSON input.
# Usage: OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
# Captures stdout only (stderr suppressed). Use run_hook_stderr for stderr.
run_hook() {
  local hook="$1"
  local command="$2"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | PATH="$MOCK_DIR:$PATH" bash "$hook" 2>/dev/null
}

# Run a hook and capture stderr only (stdout suppressed).
run_hook_stderr() {
  local hook="$1"
  local command="$2"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | PATH="$MOCK_DIR:$PATH" bash "$hook" 2>&1 1>/dev/null
}

# Create mock gh and git commands in MOCK_DIR.
# Usage: setup_gh_git_mocks "file1.ts\nfile2.ts" "file3.ts\nfile4.ts"
#   $1 = files returned by gh pr diff --name-only
#   $2 = files returned by git diff --name-only
setup_gh_git_mocks() {
  local gh_files="$1"
  local git_files="$2"

  cat > "$MOCK_DIR/gh" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "pr diff"; then
  echo "$gh_files"
  exit 0
fi
if echo "\$@" | grep -q "pr view"; then
  # Return empty body by default
  echo ""
  exit 0
fi
exit 1
MOCK
  chmod +x "$MOCK_DIR/gh"

  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/nanoclaw.git"
  exit 0
fi
if echo "\$@" | grep -q "diff --name-only"; then
  echo "$git_files"
  exit 0
fi
if echo "\$@" | grep -q "status --porcelain"; then
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

# Create a mock git that returns specific status --porcelain output.
# Usage: setup_git_status_mock " M src/dirty.ts"
setup_git_status_mock() {
  local status_output="$1"
  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "status --porcelain"; then
  printf '%s' "$status_output"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

# Print final results and exit with appropriate code
print_results() {
  echo ""
  echo "================================"
  echo "Results: $PASS passed, $FAIL failed"
  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
  echo "All tests passed."
}
