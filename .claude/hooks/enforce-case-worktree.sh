#!/bin/bash
# enforce-case-worktree.sh — Advisory early warning
# Warns when git commit/push is attempted outside a worktree.
# Real enforcement is in git hooks (.husky/pre-commit, .husky/pre-push).
#
# Runs as PreToolUse hook on Bash tool calls.
# Always exits 0 (advisory only — never blocks).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only check git commit and git push commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s+(commit|push)'; then
  exit 0
fi

# Allow if running inside a git worktree
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -n "$GIT_DIR" ] && [ -n "$GIT_COMMON" ] && [ "$GIT_DIR" != "$GIT_COMMON" ]; then
  exit 0
fi

# Advisory warning (git hooks will enforce the real block)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "⚠️  You're about to commit/push on '$BRANCH' in the main checkout." >&2
echo "   Git pre-commit/pre-push hooks will block this." >&2
echo "   Use a worktree for dev work (claude-wt or git worktree add)." >&2
exit 0
