#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-case-exists.sh — Level 2 kaizen enforcement (Issue #94)
# PreToolUse hook on Edit|Write: blocks source code edits in worktrees
# that don't have a corresponding case record in the database.
#
# This catches agents that skip case creation (via case_create IPC)
# before starting implementation work in a worktree.
#
# Only fires in worktrees (not main checkout — enforce-worktree-writes.sh
# handles that). Only blocks source files (same allowlist as
# enforce-worktree-writes.sh).

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# If no file path, allow
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Detect worktree: git-dir differs from git-common-dir
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)

# Only enforce in worktrees (not main checkout)
if [ -z "$GIT_DIR" ] || [ -z "$GIT_COMMON" ] || [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  exit 0
fi

# Resolve the worktree root
WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$WORKTREE_ROOT" ]; then
  exit 0
fi

# Resolve file to absolute path
ABS_FILE_PATH=$(realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

# Only care about files inside this worktree
if ! echo "$ABS_FILE_PATH" | grep -q "^${WORKTREE_ROOT}/"; then
  exit 0
fi

# Get relative path within worktree
REL_PATH="${ABS_FILE_PATH#${WORKTREE_ROOT}/}"

# Allow: non-source files (same allowlist as enforce-worktree-writes.sh)
if echo "$REL_PATH" | grep -qE "^(\.claude/|groups/|data/|store/|logs/)"; then
  exit 0
fi

# This is a source file edit in a worktree — check for a case
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -z "$BRANCH" ]; then
  exit 0
fi

# Resolve DB path from main checkout
MAIN_ROOT=$(dirname "$GIT_COMMON")
DB_PATH="$MAIN_ROOT/store/messages.db"

if [ ! -f "$DB_PATH" ]; then
  # No DB — can't enforce, allow (defensive)
  exit 0
fi

# Query for a case matching this branch (any non-terminal status)
# Pass values via env vars to avoid shell injection in node -e
CASE_COUNT=$(ENFORCE_DB_PATH="$DB_PATH" ENFORCE_BRANCH="$BRANCH" node -e "
  const db = require('better-sqlite3')(process.env.ENFORCE_DB_PATH);
  const row = db.prepare(
    \"SELECT COUNT(*) as cnt FROM cases WHERE branch_name = ? AND status IN ('suggested','backlog','active','blocked')\"
  ).get(process.env.ENFORCE_BRANCH);
  console.log(row.cnt);
" 2>/dev/null)

# If query failed or case exists, allow
if [ -z "$CASE_COUNT" ] || [ "$CASE_COUNT" -gt 0 ] 2>/dev/null; then
  exit 0
fi

# No case found — block the edit
jq -n \
  --arg branch "$BRANCH" \
  --arg file "$FILE_PATH" \
  --arg reason "No case record found for branch '$BRANCH'. All dev work must have a case before writing code.

Create a case first using case_create IPC (via /implement-spec or directly).
This ensures:
  - status:active label is applied to the kaizen issue
  - /pick-work filters out this work (prevents duplicate effort)
  - Kaizen reflection fires on completion

If this is exploratory work (not implementation), use the main checkout with .claude/ paths instead." \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
exit 0
