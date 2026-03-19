#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# warn-code-quality.sh — Advisory warnings for code quality (kaizen #89)
#
# On git commit (fast, per-file checks):
#   1. Test files with >3 vi.mock/jest.mock calls (testability signal)
#   2. Source files over 500 lines (bloat signal)
# On gh pr create/merge (cross-file analysis):
#   3. Duplicate code via jscpd across all changed files
#
# Runs as PreToolUse hook on Bash (git commit, gh pr create/merge).
# Always exits 0 (advisory only — never blocks).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

IS_COMMIT=false
IS_PR=false

if echo "$COMMAND" | grep -qE '^\s*git\s+commit\b'; then
  IS_COMMIT=true
elif echo "$COMMAND" | grep -qE '^\s*gh\s+pr\s+(create|merge)\b'; then
  IS_PR=true
fi

if ! $IS_COMMIT && ! $IS_PR; then
  exit 0
fi

# Get changed files
if $IS_COMMIT; then
  CHANGED_FILES=$(git diff --cached --name-only 2>/dev/null || true)
else
  CHANGED_FILES=$(git diff --name-only origin/main...HEAD 2>/dev/null || true)
fi

[ -z "$CHANGED_FILES" ] && exit 0

WARNINGS=""

# Checks 1 & 2: commit-time only (fast, per-file)
if $IS_COMMIT; then

# Check 1: Mock count in test files
MOCK_THRESHOLD=3
STAGED_TESTS=$(echo "$CHANGED_FILES" | grep -E '\.(test|spec)\.(ts|js|tsx|jsx)$' || true)

if [ -n "$STAGED_TESTS" ]; then
  while IFS= read -r TEST_FILE; do
    [ -f "$TEST_FILE" ] || continue
    MOCK_COUNT=$(grep -c 'vi\.mock\|jest\.mock\|vi\.spyOn.*mockImplementation' "$TEST_FILE" 2>/dev/null || echo "0")
    if [ "$MOCK_COUNT" -gt "$MOCK_THRESHOLD" ]; then
      SUT_FILE=$(echo "$TEST_FILE" | sed -E 's/\.(test|spec)\.(ts|js|tsx|jsx)$/.\2/')
      SUT_INFO=""
      if [ -f "$SUT_FILE" ]; then
        SUT_IMPORTS=$(grep -c '^import ' "$SUT_FILE" 2>/dev/null || echo "?")
        [ "$SUT_IMPORTS" != "?" ] && SUT_INFO=" (source has $SUT_IMPORTS imports)"
      fi
      WARNINGS="${WARNINGS}  🧪 $(basename "$TEST_FILE"): $MOCK_COUNT mocks (threshold: $MOCK_THRESHOLD)${SUT_INFO}\n"
    fi
  done <<< "$STAGED_TESTS"
fi

# Check 2: File length for source files
LINE_THRESHOLD=500
SOURCE_FILES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|js|tsx|jsx)$' | grep -vE '\.(test|spec)\.' || true)

if [ -n "$SOURCE_FILES" ]; then
  while IFS= read -r SRC_FILE; do
    [ -f "$SRC_FILE" ] || continue
    LINE_COUNT=$(wc -l < "$SRC_FILE" 2>/dev/null || echo "0")
    LINE_COUNT=$(echo "$LINE_COUNT" | tr -d ' ')
    if [ "$LINE_COUNT" -gt "$LINE_THRESHOLD" ]; then
      WARNINGS="${WARNINGS}  📏 $(basename "$SRC_FILE"): $LINE_COUNT lines (threshold: $LINE_THRESHOLD)\n"
    fi
  done <<< "$SOURCE_FILES"
fi

fi # end commit-only checks

# Check 3: jscpd duplication (PR create/merge only — cross-file analysis)
if $IS_PR && command -v npx >/dev/null 2>&1; then
  JSCPD_DIR=$(mktemp -d)
  # All changed files (jscpd supports 150+ languages), exclude symlinks and known fragments
  ALL_FILES=$(echo "$CHANGED_FILES" | while read -r f; do [ -f "$f" ] && [ ! -L "$f" ] && echo "$f"; done | grep -v 'settings-fragment' | head -30 || true)
  if [ -n "$ALL_FILES" ]; then
    # shellcheck disable=SC2086
    npx jscpd --reporters json --output "$JSCPD_DIR" --min-lines 10 --min-tokens 75 --silent $ALL_FILES 2>/dev/null || true
    if [ -f "$JSCPD_DIR/jscpd-report.json" ]; then
      CLONE_COUNT=$(jq -r '.statistics.total.clones // 0' "$JSCPD_DIR/jscpd-report.json" 2>/dev/null || echo "0")
      if [ "$CLONE_COUNT" -gt 0 ]; then
        DUP_PERCENT=$(jq -r '.statistics.total.percentage // 0' "$JSCPD_DIR/jscpd-report.json" 2>/dev/null)
        DUP_LINES=$(jq -r '.statistics.total.duplicatedLines // 0' "$JSCPD_DIR/jscpd-report.json" 2>/dev/null)
        WARNINGS="${WARNINGS}  📋 Duplication: ${DUP_PERCENT}% ($CLONE_COUNT clones, $DUP_LINES duplicated lines)\n"
        # Show clone locations
        CLONE_DETAILS=$(jq -r '.duplicates[]? | "     \(.firstFile.name):\(.firstFile.start)-\(.firstFile.end) ↔ \(.secondFile.name):\(.secondFile.start)-\(.secondFile.end)"' "$JSCPD_DIR/jscpd-report.json" 2>/dev/null || true)
        [ -n "$CLONE_DETAILS" ] && WARNINGS="${WARNINGS}${CLONE_DETAILS}\n"
      fi
    fi
    rm -rf "$JSCPD_DIR"
  fi
fi

# Output warnings
if [ -n "$WARNINGS" ]; then
  if $IS_COMMIT; then
    CONTEXT="staged files"
  else
    CONTEXT="PR changed files"
  fi
  cat <<EOF

⚠️  Code quality warnings in $CONTEXT:

$(echo -e "$WARNINGS")
See: Zen of Kaizen — "Avoiding overengineering is not a license to underengineer."

EOF
fi

exit 0
