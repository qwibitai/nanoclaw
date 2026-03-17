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

# Get current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Allow: case branches, skill branches, explicit feature branches, worktree nonces
if echo "$BRANCH" | grep -qE '^(case/|skill/|260[0-9]{3}-|feat/|wt/)'; then
  exit 0
fi

# Allow: detached HEAD (e.g., during rebase)
if [ "$BRANCH" = "HEAD" ]; then
  exit 0
fi

# Block: committing/pushing on main or unrecognized branches
jq -n \
  --arg branch "$BRANCH" \
  --arg reason "Dev work must happen in a worktree, not on '$BRANCH'. Use claude-wt to launch in an isolated worktree, or create a branch (case/*, skill/*, feat/*, wt/*, YYMMDD-*)." \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
exit 0
