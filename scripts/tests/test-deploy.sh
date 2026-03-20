#!/bin/bash
# Tests for deploy.sh
#
# INVARIANT: deploy.sh correctly detects change types, guards against
# running in worktrees, handles build failures gracefully, and notifies.
#
# SUT: scripts/deploy.sh
# VERIFICATION: Unit tests verify each function's behavior in isolation;
# integration tests verify the full deploy flow with mocked commands.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/../deploy.sh"

source "$SCRIPT_DIR/lib/test-utils.sh"

# Create temp environment for each test
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo "=== deploy.sh tests ==="
echo ""

# --- Test 1: --dry-run flag is parsed ---
echo "--- 1: --dry-run shows plan without executing ---"
run_capturing "$DEPLOY_SCRIPT" --dry-run
# Should not fail (exits 0 because guard_main_checkout returns 0 to skip)
assert_no_script_errors "--dry-run no script errors"

# --- Test 2: --build-only flag is parsed ---
echo ""
echo "--- 2: --build-only flag is recognized ---"
run_capturing "$DEPLOY_SCRIPT" --build-only --dry-run
assert_no_script_errors "--build-only no script errors"

# --- Test 3: Script is sourceable with DEPLOY_TEST=1 ---
echo ""
echo "--- 3: DEPLOY_TEST=1 allows sourcing without executing ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
EXIT_CODE=$?
assert_eq "sourcing with test guard succeeds" "0" "$EXIT_CODE"
assert_true "guard_main_checkout is a function" "declare -f guard_main_checkout >/dev/null 2>&1"
assert_true "detect_changes is a function" "declare -f detect_changes >/dev/null 2>&1"
assert_true "step_build is a function" "declare -f step_build >/dev/null 2>&1"
assert_true "step_restart is a function" "declare -f step_restart >/dev/null 2>&1"
assert_true "notify is a function" "declare -f notify >/dev/null 2>&1"

# --- Test 4: guard_main_checkout rejects worktrees ---
echo ""
echo "--- 4: guard_main_checkout rejects worktrees ---"
# We're running in a worktree — guard should reject
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if guard_main_checkout 2>/dev/null; then
  echo "  FAIL: guard_main_checkout should reject worktree"
  ((FAIL++))
else
  echo "  PASS: guard_main_checkout correctly rejects worktree"
  ((PASS++))
fi

# --- Test 5: detect_changes identifies src/ changes ---
echo ""
echo "--- 5: detect_changes identifies src/ changes ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
PROJECT_ROOT="$TMPDIR_BASE/test5"
mkdir -p "$PROJECT_ROOT/.git"
# Mock git diff to return src/ files
mkdir -p "$TMPDIR_BASE/test5-bin"
cat > "$TMPDIR_BASE/test5-bin/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "diff --name-only"; then
  echo "src/index.ts"
  echo "src/config.ts"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-dir"; then
  echo ".git"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-common-dir"; then
  echo ".git"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --abbrev-ref"; then
  echo "main"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$TMPDIR_BASE/test5-bin/git"
PATH="$TMPDIR_BASE/test5-bin:$PATH" detect_changes 2>/dev/null
assert_eq "src/ changes need build" "true" "$NEEDS_BUILD"
assert_eq "src/ changes need restart" "true" "$NEEDS_RESTART"
assert_eq "src/ changes don't need npm install" "false" "$NEEDS_NPM_INSTALL"
assert_eq "src/ changes don't need container build" "false" "$NEEDS_CONTAINER_BUILD"

# --- Test 6: detect_changes identifies package.json changes ---
echo ""
echo "--- 6: detect_changes identifies package.json changes ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
PROJECT_ROOT="$TMPDIR_BASE/test6"
mkdir -p "$PROJECT_ROOT/.git"
mkdir -p "$TMPDIR_BASE/test6-bin"
cat > "$TMPDIR_BASE/test6-bin/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "diff --name-only"; then
  echo "package.json"
  echo "package-lock.json"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$TMPDIR_BASE/test6-bin/git"
PATH="$TMPDIR_BASE/test6-bin:$PATH" detect_changes 2>/dev/null
assert_eq "package.json needs npm install" "true" "$NEEDS_NPM_INSTALL"
assert_eq "package.json needs build" "true" "$NEEDS_BUILD"
assert_eq "package.json needs restart" "true" "$NEEDS_RESTART"

# --- Test 7: detect_changes identifies Dockerfile changes ---
echo ""
echo "--- 7: detect_changes identifies Dockerfile changes ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
PROJECT_ROOT="$TMPDIR_BASE/test7"
mkdir -p "$PROJECT_ROOT/.git"
mkdir -p "$TMPDIR_BASE/test7-bin"
cat > "$TMPDIR_BASE/test7-bin/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "diff --name-only"; then
  echo "container/Dockerfile"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$TMPDIR_BASE/test7-bin/git"
PATH="$TMPDIR_BASE/test7-bin:$PATH" detect_changes 2>/dev/null
assert_eq "Dockerfile needs container build" "true" "$NEEDS_CONTAINER_BUILD"
assert_eq "Dockerfile needs restart" "true" "$NEEDS_RESTART"

# --- Test 8: detect_changes skips for docs-only ---
echo ""
echo "--- 8: detect_changes skips for docs-only changes ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
PROJECT_ROOT="$TMPDIR_BASE/test8"
mkdir -p "$PROJECT_ROOT/.git"
mkdir -p "$TMPDIR_BASE/test8-bin"
cat > "$TMPDIR_BASE/test8-bin/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "diff --name-only"; then
  echo "docs/README.md"
  echo "CLAUDE.md"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$TMPDIR_BASE/test8-bin/git"
PATH="$TMPDIR_BASE/test8-bin:$PATH" detect_changes 2>/dev/null
assert_eq "docs-only: no build" "false" "$NEEDS_BUILD"
assert_eq "docs-only: no restart" "false" "$NEEDS_RESTART"
assert_eq "docs-only: no npm install" "false" "$NEEDS_NPM_INSTALL"
assert_eq "docs-only: no container build" "false" "$NEEDS_CONTAINER_BUILD"

# --- Test 9: notify skips when DEPLOY_SKIP_NOTIFY=1 ---
echo ""
echo "--- 9: notify skips when DEPLOY_SKIP_NOTIFY=1 ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
DEPLOY_LOG="/dev/null"
DEPLOY_SKIP_NOTIFY=1
notify "test message" 2>/dev/null
EXIT_CODE=$?
assert_eq "notify succeeds when skipped" "0" "$EXIT_CODE"
unset DEPLOY_SKIP_NOTIFY

# --- Test 10: step_build skips when NEEDS_BUILD=false ---
echo ""
echo "--- 10: step_build skips when not needed ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
DEPLOY_LOG="/dev/null"
NEEDS_BUILD=false
OUTPUT=$(step_build 2>/dev/null)
assert_contains "build skipped" "skipped" "$OUTPUT"

# --- Test 11: step_restart skips with DEPLOY_SKIP_RESTART ---
echo ""
echo "--- 11: step_restart skips with DEPLOY_SKIP_RESTART=1 ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
DEPLOY_LOG="/dev/null"
NEEDS_RESTART=true
DEPLOY_SKIP_RESTART=1
BUILD_ONLY=false
DRY_RUN=false
OUTPUT=$(step_restart 2>/dev/null)
assert_contains "restart skipped" "skipped" "$OUTPUT"
unset DEPLOY_SKIP_RESTART

# --- Test 12: step_restart skips with --build-only ---
echo ""
echo "--- 12: step_restart skips with --build-only ---"
DEPLOY_TEST=1 source "$DEPLOY_SCRIPT"
DEPLOY_LOG="/dev/null"
NEEDS_RESTART=true
BUILD_ONLY=true
DRY_RUN=false
OUTPUT=$(step_restart 2>/dev/null)
assert_contains "restart skipped build-only" "skipped" "$OUTPUT"

# --- Test 13: Post-merge hook exists and is executable ---
echo ""
echo "--- 13: Post-merge hook exists and is executable ---"
HOOK_FILE="$SCRIPT_DIR/../../.husky/post-merge"
assert_true "post-merge hook exists" "[ -f '$HOOK_FILE' ]"
assert_true "post-merge hook is executable" "[ -x '$HOOK_FILE' ]"
assert_contains "hook references deploy.sh" "deploy.sh" "$(cat "$HOOK_FILE")"

print_results
