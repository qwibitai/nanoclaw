#!/bin/bash
# Tests for enforce-case-exists.sh — Level 2 case existence enforcement
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/enforce-case-exists.sh"

echo "Testing enforce-case-exists.sh"
echo ""

# Helper: run the hook with an Edit/Write tool input for a specific file path
run_edit_hook() {
  local file_path="$1"
  local input
  input=$(jq -n --arg fp "$file_path" '{"tool_input":{"file_path":$fp}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Test 1: Empty file_path → allow
echo "Test 1: empty file_path allows"
OUTPUT=$(echo '{"tool_input":{}}' | bash "$HOOK" 2>/dev/null)
assert_eq "empty file_path allows" "" "$OUTPUT"

# Test 2: Non-source files are always allowed (even without a case)
echo ""
echo "Test 2: non-source paths are allowed"
for path in ".claude/memory/test.md" "groups/test/config.json" "data/ipc/test.json" "store/test.db" "logs/test.log"; do
  WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  ABS_PATH="$WORKTREE_ROOT/$path"
  OUTPUT=$(run_edit_hook "$ABS_PATH")
  assert_eq "allows $path" "" "$OUTPUT"
done

# Test 3: Source file edit in main checkout → allow (not our job)
echo ""
echo "Test 3: main checkout is not enforced (handled by enforce-worktree-writes)"
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  echo "  SKIP: running in main checkout, can't test worktree behavior"
  ((PASS++))
else
  # We ARE in a worktree — test that source files trigger enforcement
  WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  # Check if a case exists for our branch
  MAIN_ROOT=$(dirname "$GIT_COMMON")
  DB_PATH="$MAIN_ROOT/store/messages.db"

  if [ -f "$DB_PATH" ]; then
    CASE_COUNT=$(node "$MAIN_ROOT/dist/cli-kaizen.js" case-by-branch "$BRANCH" 2>/dev/null | node -e "const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(r ? 1 : 0)" 2>/dev/null)

    if [ "$CASE_COUNT" -gt 0 ] 2>/dev/null; then
      # Case exists — source edits should be allowed
      OUTPUT=$(run_edit_hook "$WORKTREE_ROOT/src/test.ts")
      assert_eq "source edit allowed when case exists" "" "$OUTPUT"
    else
      # No case — source edits should be blocked
      OUTPUT=$(run_edit_hook "$WORKTREE_ROOT/src/test.ts")
      if is_denied "$OUTPUT"; then
        echo "  PASS: source edit blocked when no case exists"
        ((PASS++))
      else
        echo "  FAIL: source edit should be blocked when no case exists"
        echo "    output: $OUTPUT"
        ((FAIL++))
      fi

      # Verify the deny message mentions the branch
      assert_contains "deny message mentions branch" "$BRANCH" "$OUTPUT"
      assert_contains "deny message mentions cli-kaizen.js case-create" "case-create" "$OUTPUT"
    fi
  else
    echo "  SKIP: no database at $DB_PATH"
    ((PASS++))
  fi
fi

# Test 4: Various source file patterns should trigger enforcement
echo ""
echo "Test 4: source file patterns are checked"
WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)

if [ "$GIT_DIR" != "$GIT_COMMON" ]; then
  MAIN_ROOT=$(dirname "$GIT_COMMON")
  DB_PATH="$MAIN_ROOT/store/messages.db"
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  if [ -f "$DB_PATH" ]; then
    CASE_COUNT=$(node "$MAIN_ROOT/dist/cli-kaizen.js" case-by-branch "$BRANCH" 2>/dev/null | node -e "const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(r ? 1 : 0)" 2>/dev/null)

    if [ "$CASE_COUNT" -eq 0 ] 2>/dev/null; then
      for path in "src/index.ts" "container/Dockerfile" "package.json" "docs/README.md" "tsconfig.json"; do
        OUTPUT=$(run_edit_hook "$WORKTREE_ROOT/$path")
        if is_denied "$OUTPUT"; then
          echo "  PASS: blocks $path without case"
          ((PASS++))
        else
          echo "  FAIL: should block $path without case"
          ((FAIL++))
        fi
      done
    else
      echo "  SKIP: case exists for branch $BRANCH (can't test blocking)"
      ((PASS++))
    fi
  else
    echo "  SKIP: no database"
    ((PASS++))
  fi
else
  echo "  SKIP: not in worktree"
  ((PASS++))
fi

# Test 5: Files outside worktree are allowed
echo ""
echo "Test 5: files outside worktree are allowed"
OUTPUT=$(run_edit_hook "/tmp/some-random-file.ts")
assert_eq "file outside worktree allowed" "" "$OUTPUT"

print_results
