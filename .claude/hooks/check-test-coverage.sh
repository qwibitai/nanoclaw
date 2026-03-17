#!/bin/bash
# check-test-coverage.sh — Level 2 kaizen enforcement (Issue #8)
# Intercepts `gh pr create` and `gh pr merge` to verify that changed source
# files have corresponding test coverage changes.
#
# Runs as PreToolUse hook on Bash tool calls.
# Exit 0 = allow (with advisory output on stderr)
# JSON with permissionDecision deny = block

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only check gh pr create and gh pr merge
if ! echo "$CMD_LINE" | grep -qE 'gh\s+pr\s+(create|merge)'; then
  exit 0
fi

IS_MERGE=false
if echo "$CMD_LINE" | grep -qE 'gh\s+pr\s+merge'; then
  IS_MERGE=true
fi

# Determine base branch for diff
BASE="main"

# Get changed source files (exclude tests, config, docs, hooks)
CHANGED_SRC=$(git diff --name-only "$BASE"...HEAD 2>/dev/null | \
  grep -E '\.(ts|js|tsx|jsx)$' | \
  grep -vE '(\.test\.|\.spec\.|__tests__|\.config\.|vitest\.|CLAUDE\.md|\.claude/)' || true)

# Get changed test files
CHANGED_TESTS=$(git diff --name-only "$BASE"...HEAD 2>/dev/null | \
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

  # Look for matching test in changed tests
  FOUND=false
  if [ -n "$CHANGED_TESTS" ]; then
    if echo "$CHANGED_TESTS" | grep -qE "(${basename}\.(test|spec)\.|${dir}/__tests__/)"; then
      FOUND=true
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

if [ "$IS_MERGE" = true ]; then
  # Block merge if tests are missing
  jq -n \
    --arg reason "$MSG" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
else
  # For PR creation: advisory warning (don't block, but make it loud)
  echo "$MSG" >&2
  echo "" >&2
  echo "💡 Consider adding tests before creating the PR, or document why tests aren't needed in the PR description." >&2
fi

exit 0
