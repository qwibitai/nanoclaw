#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# check-dirty-files.sh — Level 3 kaizen enforcement
# Ensures the agent makes a conscious choice about every file in the worktree
# before creating PRs or pushing code. Prevents forgotten work, debug artifacts,
# and blind stashing.
#
# Triggers:
#   gh pr create — BLOCK (agent is declaring "work is done")
#   git push     — BLOCK (agent is shipping code)
#   gh pr merge  — WARN  (PR is on GitHub, local state is advisory)
#
# Runs as PreToolUse hook on Bash tool calls.
# Exit 0 = allow
# JSON with permissionDecision deny = block

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Determine trigger type
IS_PR_CREATE=false
IS_GIT_PUSH=false
IS_PR_MERGE=false

if is_gh_pr_command "$CMD_LINE" "create"; then
  IS_PR_CREATE=true
elif is_git_command "$CMD_LINE" "push"; then
  IS_GIT_PUSH=true
elif is_gh_pr_command "$CMD_LINE" "merge"; then
  IS_PR_MERGE=true
else
  exit 0
fi

# Get dirty files, excluding noise patterns and lifecycle-managed files
# Uses git status --porcelain: first two chars are status, then filename
# .worktree-lock.json: managed by worktree lifecycle (kaizen #225)
DIRTY=$(git status --porcelain 2>/dev/null | \
  grep -vE '(node_modules/|\.DS_Store|dist/|\.tsbuildinfo|\.env\.local|\.worktree-lock\.json)' || true)

# No dirty files → allow
if [ -z "$DIRTY" ]; then
  exit 0
fi

# Count and categorize
DIRTY_COUNT=$(echo "$DIRTY" | wc -l | tr -d ' ')
MODIFIED=$(echo "$DIRTY" | grep -E '^ ?M' || true)
UNTRACKED=$(echo "$DIRTY" | grep -E '^\?\?' || true)
STAGED=$(echo "$DIRTY" | grep -E '^[MARCD] ' || true)

# Build the file list with categories
FILE_LIST=""
if [ -n "$STAGED" ]; then
  FILE_LIST="${FILE_LIST}Staged but not committed:\n$(echo "$STAGED" | sed 's/^/  /')\n\n"
fi
if [ -n "$MODIFIED" ]; then
  FILE_LIST="${FILE_LIST}Modified (unstaged):\n$(echo "$MODIFIED" | sed 's/^/  /')\n\n"
fi
if [ -n "$UNTRACKED" ]; then
  FILE_LIST="${FILE_LIST}Untracked:\n$(echo "$UNTRACKED" | sed 's/^/  /')\n\n"
fi

KAIZEN_REFLECTION="KAIZEN REFLECTION (mandatory):
Before proceeding, answer these questions in your response:
1. Why were these files left uncommitted? (forgot to stage? debug artifacts? mid-work?)
2. What process gap led to this? (rushing? no pre-push checklist? unclear scope?)
3. What would prevent this next time? (habit change? tooling? checklist?)

DO NOT use \`git stash\`. Stashing hides the problem — it doesn't solve it.
Either commit with a meaningful message, or discard with an explanation."

if [ "$IS_PR_MERGE" = true ]; then
  # Advisory for merge — warn but don't block
  cat >&2 <<MSG

⚠️  DIRTY FILES DETECTED — $DIRTY_COUNT file(s) with uncommitted changes:

$(echo -e "$FILE_LIST")
You're merging a PR, so this doesn't affect the merge itself.
But dirty files in a worktree suggest unfinished or forgotten work.

$KAIZEN_REFLECTION
MSG
  exit 0
fi

# For pr create and git push — BLOCK
ACTION="creating a PR"
if [ "$IS_GIT_PUSH" = true ]; then
  ACTION="pushing code"
fi

MSG="🚫 DIRTY FILES — $DIRTY_COUNT file(s) with uncommitted changes while $ACTION.

$(echo -e "$FILE_LIST")You MUST handle each file before proceeding:

FOR USEFUL FILES (part of this work):
  git add <file> && git commit -m 'meaningful message about what and why'

FOR ARTIFACTS/DEBUG/LEFTOVER FILES (not part of this work):
  git checkout -- <file>    (for modified tracked files)
  rm <file>                 (for untracked files)
  Explain in your response WHY each discarded file is not needed.

$KAIZEN_REFLECTION"

jq -n \
  --arg reason "$MSG" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'

exit 0
