#!/bin/bash
# Tests for resolve-cli-kaizen.sh
#
# INVARIANT: resolve_cli_kaizen() finds the best way to run cli-kaizen,
# preferring tsx from source over compiled dist/, and handling missing
# files gracefully.
#
# SUT: scripts/lib/resolve-cli-kaizen.sh
# VERIFICATION: Each test creates a mock filesystem and verifies the
# resolved command matches the expected strategy.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOLVER="$SCRIPT_DIR/../lib/resolve-cli-kaizen.sh"

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

# Create a temp dir for each test
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

source "$RESOLVER"

echo "=== resolve_cli_kaizen() tests ==="
echo ""

# --- Test 1: tsx + source available → uses tsx ---
echo "--- 1: tsx + source available → uses tsx ---"
MOCK_ROOT="$TMPDIR_BASE/test1"
mkdir -p "$MOCK_ROOT/node_modules/.bin" "$MOCK_ROOT/src"
cat > "$MOCK_ROOT/node_modules/.bin/tsx" << 'EOF'
#!/bin/bash
echo "tsx"
EOF
chmod +x "$MOCK_ROOT/node_modules/.bin/tsx"
touch "$MOCK_ROOT/src/cli-kaizen.ts"

RESULT=$(resolve_cli_kaizen "$MOCK_ROOT")
EXIT_CODE=$?
assert_eq "returns success" "0" "$EXIT_CODE"
assert_contains "uses tsx binary" "node_modules/.bin/tsx" "$RESULT"
assert_contains "points to source .ts" "src/cli-kaizen.ts" "$RESULT"

# --- Test 2: tsx available but source missing → falls back to dist ---
echo ""
echo "--- 2: tsx but no source → falls back to dist ---"
MOCK_ROOT="$TMPDIR_BASE/test2"
mkdir -p "$MOCK_ROOT/node_modules/.bin" "$MOCK_ROOT/dist"
cat > "$MOCK_ROOT/node_modules/.bin/tsx" << 'EOF'
#!/bin/bash
echo "tsx"
EOF
chmod +x "$MOCK_ROOT/node_modules/.bin/tsx"
touch "$MOCK_ROOT/dist/cli-kaizen.js"

RESULT=$(resolve_cli_kaizen "$MOCK_ROOT")
EXIT_CODE=$?
assert_eq "returns success" "0" "$EXIT_CODE"
assert_contains "uses node" "node " "$RESULT"
assert_contains "points to dist .js" "dist/cli-kaizen.js" "$RESULT"

# --- Test 3: no tsx, dist available → uses dist ---
echo ""
echo "--- 3: no tsx, dist available → uses dist ---"
MOCK_ROOT="$TMPDIR_BASE/test3"
mkdir -p "$MOCK_ROOT/dist" "$MOCK_ROOT/src"
touch "$MOCK_ROOT/dist/cli-kaizen.js"
touch "$MOCK_ROOT/src/cli-kaizen.ts"

RESULT=$(resolve_cli_kaizen "$MOCK_ROOT")
EXIT_CODE=$?
assert_eq "returns success" "0" "$EXIT_CODE"
assert_contains "uses node" "node " "$RESULT"
assert_contains "points to dist .js" "dist/cli-kaizen.js" "$RESULT"

# --- Test 4: nothing available → returns failure ---
echo ""
echo "--- 4: nothing available → returns failure ---"
MOCK_ROOT="$TMPDIR_BASE/test4"
mkdir -p "$MOCK_ROOT"

RESULT=$(resolve_cli_kaizen "$MOCK_ROOT")
EXIT_CODE=$?
assert_eq "returns failure" "1" "$EXIT_CODE"
assert_eq "empty output" "" "$RESULT"

# --- Test 5: tsx not executable → falls back to dist ---
echo ""
echo "--- 5: tsx exists but not executable → falls back to dist ---"
MOCK_ROOT="$TMPDIR_BASE/test5"
mkdir -p "$MOCK_ROOT/node_modules/.bin" "$MOCK_ROOT/src" "$MOCK_ROOT/dist"
touch "$MOCK_ROOT/node_modules/.bin/tsx"  # not executable
touch "$MOCK_ROOT/src/cli-kaizen.ts"
touch "$MOCK_ROOT/dist/cli-kaizen.js"

RESULT=$(resolve_cli_kaizen "$MOCK_ROOT")
EXIT_CODE=$?
assert_eq "returns success" "0" "$EXIT_CODE"
assert_contains "falls back to dist" "dist/cli-kaizen.js" "$RESULT"

# --- Test 6: tsx + source, no dist → uses tsx ---
echo ""
echo "--- 6: tsx + source, no dist → uses tsx (the fresh worktree case) ---"
MOCK_ROOT="$TMPDIR_BASE/test6"
mkdir -p "$MOCK_ROOT/node_modules/.bin" "$MOCK_ROOT/src"
cat > "$MOCK_ROOT/node_modules/.bin/tsx" << 'EOF'
#!/bin/bash
echo "tsx"
EOF
chmod +x "$MOCK_ROOT/node_modules/.bin/tsx"
touch "$MOCK_ROOT/src/cli-kaizen.ts"
# NO dist/ directory — this is the #197 scenario

RESULT=$(resolve_cli_kaizen "$MOCK_ROOT")
EXIT_CODE=$?
assert_eq "returns success" "0" "$EXIT_CODE"
assert_contains "uses tsx" "tsx" "$RESULT"
assert_contains "uses source" "cli-kaizen.ts" "$RESULT"

# --- Test 7: Resolved command is actually executable ---
echo ""
echo "--- 7: Resolved command is actually executable from real project ---"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MAIN_ROOT=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null | xargs dirname 2>/dev/null || echo "$PROJECT_ROOT")

RESULT=$(resolve_cli_kaizen "$MAIN_ROOT")
EXIT_CODE=$?
assert_eq "resolves for main checkout" "0" "$EXIT_CODE"

# Actually run it to verify — capture stderr separately to catch script errors
# RESULT contains a multi-word command (e.g., "tsx path/cli-kaizen.ts"), use eval
STDERR_FILE=$(mktemp)
HELP_OUTPUT=$(eval "$RESULT" 2>"$STDERR_FILE") || true
HELP_STDERR=$(<"$STDERR_FILE")
rm -f "$STDERR_FILE"
# cli-kaizen with no args prints usage (may go to stdout or stderr)
HELP_COMBINED="$HELP_OUTPUT $HELP_STDERR"
assert_contains "produces output" "cli-kaizen" "$HELP_COMBINED"
# Fail on script-level errors in stderr
SCRIPT_ERROR_PATTERN='syntax error|bad substitution|unbound variable|command not found|arithmetic|not a valid identifier|unexpected token'
if echo "$HELP_STDERR" | grep -qiE "$SCRIPT_ERROR_PATTERN"; then
  echo "  FAIL: cli-kaizen produced script errors on stderr"
  echo "    stderr: $HELP_STDERR"
  ((FAIL++))
else
  echo "  PASS: cli-kaizen no script errors on stderr"
  ((PASS++))
fi

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All tests passed."
