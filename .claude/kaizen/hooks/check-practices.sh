#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# check-practices.sh — Advisory best practices prompt (Issue #210)
# Shows relevant engineering practices before PR creation based on change categories.
# Practices are loaded from .claude/kaizen/practices.md — a living checklist
# that grows as kaizen reflections identify new patterns.
#
# Runs as PreToolUse hook on Bash tool calls.
# Always exits 0 (advisory only — never blocks).

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only trigger on gh pr create
if ! is_gh_pr_command "$CMD_LINE" "create"; then
  exit 0
fi

# Resolve practices file relative to this hook's location
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
PRACTICES_FILE="$HOOK_DIR/../practices.md"

if [ ! -f "$PRACTICES_FILE" ]; then
  exit 0
fi

# Determine what files changed in this PR
CHANGED_FILES=$(get_pr_changed_files "$CMD_LINE" "false")

if [ -z "$CHANGED_FILES" ]; then
  exit 0
fi

# Categorize changes
HAS_SHELL=false
HAS_TS=false
HAS_TESTS=false
HAS_HOOKS=false
HAS_CONTAINER=false
HAS_DOCS=false

if echo "$CHANGED_FILES" | grep -qE '\.sh$'; then
  HAS_SHELL=true
fi
if echo "$CHANGED_FILES" | grep -vE '\.(test|spec)\.' | grep -qE '\.(ts|js|tsx|jsx)$'; then
  HAS_TS=true
fi
if echo "$CHANGED_FILES" | grep -qE '\.(test|spec)\.(ts|js|tsx|jsx)$'; then
  HAS_TESTS=true
fi
if echo "$CHANGED_FILES" | grep -qE 'kaizen/hooks/'; then
  HAS_HOOKS=true
fi
if echo "$CHANGED_FILES" | grep -qE 'container/'; then
  HAS_CONTAINER=true
fi
if echo "$CHANGED_FILES" | grep -qE '\.md$'; then
  HAS_DOCS=true
fi

# Build the relevant practices list
# Always-relevant practices
PRACTICES=()
PRACTICES+=("DRY — Any duplicated patterns that should be extracted?")
PRACTICES+=("Display URLs — All links (PRs, issues, CI) surfaced in text?")
PRACTICES+=("Evidence over summaries — Actual data pasted, not descriptions?")

# Category-specific practices
if [ "$HAS_SHELL" = true ] || [ "$HAS_HOOKS" = true ]; then
  PRACTICES+=("Error paths — Failure modes handled, not silently swallowed?")
fi

if [ "$HAS_TS" = true ]; then
  PRACTICES+=("Minimal surface — Simplest possible interface for consumers?")
  PRACTICES+=("Dependencies declared — Every import has a package.json entry?")
fi

if [ "$HAS_TESTS" = true ] || [ "$HAS_TS" = true ] || [ "$HAS_SHELL" = true ]; then
  PRACTICES+=("Test the interaction — Cross-component behavior verified?")
fi

if [ "$HAS_CONTAINER" = true ]; then
  PRACTICES+=("Test deployed artifact — Verified in actual container, not just source?")
  PRACTICES+=("Test fresh state — Works without cached artifacts or prior setup?")
fi

if [ "$HAS_HOOKS" = true ]; then
  PRACTICES+=("Worktree isolation — No cross-worktree state reads or writes?")
fi

if [ "$HAS_TS" = true ]; then
  PRACTICES+=("Harness or vertical — Code in the right repo?")
fi

# Print the advisory
echo "" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
echo "PRACTICES CHECKLIST" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
echo "" >&2
echo "Which of these are relevant to your change?" >&2
echo "" >&2

for practice in "${PRACTICES[@]}"; do
  echo "  * $practice" >&2
done

echo "" >&2
echo "Address relevant items or consciously skip." >&2
echo "Full checklist: .claude/kaizen/practices.md" >&2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2

exit 0
