#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-case-exists.sh — Level 2 kaizen enforcement (Issue #94)
# PreToolUse hook on Edit|Write: blocks source code edits in worktrees
# that don't have a corresponding case record in the database.
#
# This catches agents that skip case creation (via CLI or IPC)
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

# Query via the domain model (cases.ts getActiveCaseByBranch) — not raw SQL.
# Prefer worktree's compiled dist/ (has latest code), fall back to main's.
MAIN_ROOT=$(dirname "$GIT_COMMON")
DB_PATH="$MAIN_ROOT/store/messages.db"

if [ -d "$WORKTREE_ROOT/dist" ]; then
  DIST_DIR="$WORKTREE_ROOT/dist"
elif [ -d "$MAIN_ROOT/dist" ]; then
  DIST_DIR="$MAIN_ROOT/dist"
else
  exit 0  # No compiled dist — can't enforce
fi

if [ ! -f "$DB_PATH" ]; then
  exit 0  # No DB — can't enforce
fi

# Initialize DB (readonly) and call getActiveCaseByBranch() through the domain model.
# This uses the same code path as MCP tools / IPC handlers.
HAS_CASE=$(ENFORCE_BRANCH="$BRANCH" ENFORCE_DB="$DB_PATH" node -e "
  const Database = require('better-sqlite3');
  const cases = require('$DIST_DIR/cases.js');
  const database = new Database(process.env.ENFORCE_DB, { readonly: true });
  cases.createCasesSchema(database);
  const c = cases.getActiveCaseByBranch(process.env.ENFORCE_BRANCH);
  console.log(c ? '1' : '0');
  database.close();
" 2>/dev/null)

# If query failed or case exists, allow
if [ -z "$HAS_CASE" ] || [ "$HAS_CASE" = "1" ]; then
  exit 0
fi

# No case found — block the edit
jq -n \
  --arg branch "$BRANCH" \
  --arg file "$FILE_PATH" \
  --arg reason "No case record found for branch '$BRANCH'. All dev work must have a case before writing code.

Create a case first:
  node dist/cli-kaizen.js case-create --description \"your description\" --type dev --github-issue N

Or via /implement-spec (which calls the CLI for you).

This ensures:
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
