#!/bin/bash
# enforce-worktree-writes.sh — Level 3 kaizen enforcement
# Blocks Edit/Write tools that target the main checkout to prevent dirtying it.
# Allows writes to .claude/ (memory, hooks, skills, settings) since those are config.
#
# Two protection modes:
#   1. Direct: CWD is main checkout on main branch → block writes
#   2. Cross-checkout: CWD is a worktree but FILE_PATH points to main checkout → block
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

# Resolve the main checkout path from git
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -z "$GIT_COMMON" ]; then
  exit 0
fi

# Determine main checkout root
if [ "$GIT_COMMON" = ".git" ]; then
  # We ARE in the main checkout
  MAIN_ROOT=$(pwd)
else
  # We're in a worktree — git-common-dir points to main's .git
  MAIN_ROOT=$(dirname "$GIT_COMMON")
fi

# Resolve FILE_PATH to absolute
ABS_FILE_PATH=$(realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

# Check if FILE_PATH is inside the main checkout (but not inside a worktree subdir)
# The main checkout's .claude/worktrees/ contains worktrees — those are OK
if echo "$ABS_FILE_PATH" | grep -q "^${MAIN_ROOT}/"; then
  # Make sure it's not inside a worktree directory
  if echo "$ABS_FILE_PATH" | grep -q "^${MAIN_ROOT}/\.claude/worktrees/"; then
    exit 0
  fi

  # Check if the main checkout is on main branch
  MAIN_BRANCH=$(git -C "$MAIN_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  if [ "$MAIN_BRANCH" != "main" ]; then
    exit 0
  fi

  # Block the write — file targets main checkout on main branch
  jq -n \
    --arg file "$FILE_PATH" \
    --arg main_root "$MAIN_ROOT" \
    --arg reason "Cannot write to '$FILE_PATH' — it targets the main checkout ($MAIN_ROOT) which is on main branch. Use your worktree path instead, or create a feature branch. Only .claude/ config files are allowed on main." \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
fi
exit 0
