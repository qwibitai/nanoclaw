#!/bin/bash
# enforce-worktree-writes.sh — Level 3 kaizen enforcement
# Blocks Edit/Write tools that target SOURCE CODE in the main checkout on main branch.
# Source code changes must go through worktrees and PRs.
#
# Allowed on main checkout (runtime/config, not source code):
#   - .claude/          (memory, hooks, skills, settings)
#   - groups/           (per-group memory and config — runtime data)
#   - data/             (sessions, IPC, case workspaces — runtime data)
#   - store/            (SQLite database — runtime data)
#   - logs/             (log files — runtime data)
#   - .claude/worktrees/ (worktree directories)
#
# Blocked on main checkout when on main branch (source code):
#   - src/, container/, package.json, tsconfig.json, docs/, etc.
#
# Runs as PreToolUse hook on Edit and Write tool calls.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# If no file path, allow (shouldn't happen for Edit/Write)
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Resolve the main checkout path from git
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -z "$GIT_COMMON" ]; then
  exit 0
fi

# Determine main checkout root
if [ "$GIT_COMMON" = ".git" ]; then
  MAIN_ROOT=$(pwd)
else
  MAIN_ROOT=$(dirname "$GIT_COMMON")
fi

# Resolve FILE_PATH to absolute
ABS_FILE_PATH=$(realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

# Only care about files inside the main checkout
if ! echo "$ABS_FILE_PATH" | grep -q "^${MAIN_ROOT}/"; then
  exit 0
fi

# Strip the main root prefix to get the relative path
REL_PATH="${ABS_FILE_PATH#${MAIN_ROOT}/}"

# Allow: worktree directories
if echo "$REL_PATH" | grep -q "^\.claude/worktrees/"; then
  exit 0
fi

# Allow: .claude/ config (memory, hooks, skills, settings)
if echo "$REL_PATH" | grep -q "^\.claude/"; then
  exit 0
fi

# Allow: runtime/data directories (not source code, no PR needed)
if echo "$REL_PATH" | grep -qE "^(groups|data|store|logs)/"; then
  exit 0
fi

# Everything else is source code — block if main checkout is on main branch
MAIN_BRANCH=$(git -C "$MAIN_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [ "$MAIN_BRANCH" != "main" ]; then
  exit 0
fi

# Block the write — source code on main branch
jq -n \
  --arg file "$FILE_PATH" \
  --arg main_root "$MAIN_ROOT" \
  --arg reason "Cannot write to '$FILE_PATH' — it's source code in the main checkout ($MAIN_ROOT) on main branch. Use a worktree for code changes. Runtime dirs (groups/, data/, store/, logs/) and .claude/ are allowed." \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
exit 0
