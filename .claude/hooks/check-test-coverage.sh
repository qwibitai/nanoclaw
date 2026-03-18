#!/bin/bash
# check-test-coverage.sh — Advisory early warning (Issue #8)
# Warns when changed source files lack corresponding test coverage changes.
# Real enforcement is in CI (pr-policy job in .github/workflows/ci.yml).
#
# Runs as PreToolUse hook on Bash tool calls.
# Always exits 0 (advisory only — never blocks).

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only check gh pr create and gh pr merge
if ! is_gh_pr_command "$CMD_LINE" "create|merge"; then
  exit 0
fi

IS_MERGE=false
if is_gh_pr_command "$CMD_LINE" "merge"; then
  IS_MERGE=true
fi

# Get the list of changed files — from PR diff for merges, git diff for creates
ALL_CHANGED=$(get_pr_changed_files "$CMD_LINE" "$IS_MERGE")

# Get changed source files (exclude tests, config, docs, hooks, container agent-runner)
# container/agent-runner/src/ runs inside containers — tested via smoke tests, not host unit tests
CHANGED_SRC=$(echo "$ALL_CHANGED" | \
  grep -E '\.(ts|js|tsx|jsx)$' | \
  grep -vE '(\.test\.|\.spec\.|\.test-util\.|__tests__|\.config\.|vitest\.|CLAUDE\.md|\.claude/|container/agent-runner/)' || true)

# Get changed test files
CHANGED_TESTS=$(echo "$ALL_CHANGED" | \
  grep -E '\.(test|spec)\.(ts|js|tsx|jsx)$' || true)

# If no source changes, nothing to check
if [ -z "$CHANGED_SRC" ]; then
  exit 0
fi

# Count source files and test files
SRC_COUNT=$(echo "$CHANGED_SRC" | wc -l | tr -d ' ')
TEST_COUNT=0
if [ -n "$CHANGED_TESTS" ]; then
  TEST_COUNT=$(echo "$CHANGED_TESTS" | wc -l | tr -d ' ')
fi

# Check which source files have NO corresponding test file changed
UNCOVERED=""
while IFS= read -r src_file; do
  [ -z "$src_file" ] && continue
  # Derive expected test file patterns
  basename=$(basename "$src_file" | sed 's/\.\(ts\|js\|tsx\|jsx\)$//')
  dir=$(dirname "$src_file")

  # Look for matching test in changed tests.
  # Match patterns:
  #   1. Exact: {basename}.test.ts (e.g., ipc.test.ts for ipc.ts)
  #   2. Prefixed: {basename}-*.test.ts (e.g., ipc-github-issues.test.ts for ipc.ts)
  #   3. Directory: {dir}/__tests__/
  #   4. Import: any changed test file that imports from the source file
  FOUND=false
  if [ -n "$CHANGED_TESTS" ]; then
    if echo "$CHANGED_TESTS" | grep -qE "(${basename}[\.-](test|spec)\.|${basename}-[a-z0-9-]+\.(test|spec)\.|${dir}/__tests__/)"; then
      FOUND=true
    fi

    # Check if any changed test file imports from this source file
    if [ "$FOUND" = false ]; then
      while IFS= read -r test_file; do
        [ -z "$test_file" ] && continue
        [ ! -f "$test_file" ] && continue
        # Match imports like: from './cases.js' or from '../cases.js' etc.
        if grep -qE "from ['\"].*/${basename}(\.js)?['\"]" "$test_file" 2>/dev/null; then
          FOUND=true
          break
        fi
      done <<< "$CHANGED_TESTS"
    fi
  fi

  if [ "$FOUND" = false ]; then
    UNCOVERED="${UNCOVERED}  - ${src_file}\n"
  fi
done <<< "$CHANGED_SRC"

# If all source files have test coverage changes, allow
if [ -z "$UNCOVERED" ]; then
  echo "✅ Test coverage check: $SRC_COUNT source file(s) changed, $TEST_COUNT test file(s) updated." >&2
  exit 0
fi

# Build the warning/block message
MSG="⚠️  Test coverage policy (CLAUDE.md rule #7):

$SRC_COUNT source file(s) changed but these have NO corresponding test changes:
$(echo -e "$UNCOVERED")
$TEST_COUNT test file(s) were modified.

Before proceeding, ensure:
1. Unit tests cover the actual changes (not just pass pre-existing tests)
2. A smoke test plan exists for integration-level changes
3. If no tests exist for a module, write them

This check prevents the 'all tests pass but none test the fix' pattern."

# Advisory warning for both create and merge (CI enforces the real gate)
echo "$MSG" >&2
echo "" >&2
if [ "$IS_MERGE" = true ]; then
  echo "⚠️  CI pr-policy check will block merge if tests are missing." >&2
else
  echo "💡 Consider adding tests before creating the PR. CI will check this." >&2
fi

exit 0
