#!/bin/bash
# enforce-case-worktree.sh — Level 2 kaizen enforcement
# Blocks git commit/push if not in a case worktree or recognized branch.
# Runs as PreToolUse hook on Bash tool calls.
#
# Exit 0 = allow
# JSON with permissionDecision deny = block

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

# Block: committing/pushing outside a worktree
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
jq -n \
  --arg branch "$BRANCH" \
  --arg reason "Dev work must happen in a worktree, not on '$BRANCH' in the main checkout. Use claude-wt to launch in an isolated worktree." \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
exit 0
