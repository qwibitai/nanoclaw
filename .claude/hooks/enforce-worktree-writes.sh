#!/bin/bash
# enforce-worktree-writes.sh — Level 3 kaizen enforcement
# Blocks Edit/Write tools on main branch to prevent dirtying the main checkout.
# Allows writes to .claude/ (memory, hooks, skills, settings) since those are config.
#
# Runs as PreToolUse hook on Edit and Write tool calls.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# If no file path, allow (shouldn't happen for Edit/Write)
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Allow writes to .claude/ directory (memory, hooks, skills, settings)
if echo "$FILE_PATH" | grep -q '/\.claude/'; then
  exit 0
fi

# Only enforce on main branch in the main checkout
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [ "$BRANCH" != "main" ]; then
  exit 0
fi

# Check we're in the main checkout, not a worktree
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ "$GIT_COMMON" != ".git" ]; then
  exit 0
fi

# Block the write
jq -n \
  --arg file "$FILE_PATH" \
  --arg reason "Cannot write to '$FILE_PATH' on main branch. Create a feature branch first (git checkout -b feat/...) or use a case worktree. Only .claude/ config files are allowed on main." \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
exit 0
