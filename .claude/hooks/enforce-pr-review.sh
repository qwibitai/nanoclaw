#!/bin/bash
# enforce-pr-review.sh — Level 3 kaizen enforcement (Issue #46)
# PreToolUse gate: blocks all Bash commands until the agent completes
# the mandatory PR self-review after `gh pr create` or `git push`.
#
# Reads state files written by pr-review-loop.sh (PostToolUse).
# When any state file has STATUS=needs_review, only review-related
# commands are allowed through. All others are denied.
#
# Allowed commands during review gate:
#   gh pr diff, gh pr view, gh pr comment, gh pr edit
#   git diff, git log, git show, git status, git branch
#
# State files older than 2 hours are considered stale and ignored,
# preventing permanent lockout from orphaned sessions.
#
# The gate opens when the agent runs `gh pr diff` (which sets STATUS=passed
# in the PostToolUse hook). If the agent pushes fixes, the gate re-engages.

source "$(dirname "$0")/lib/parse-command.sh"
source "$(dirname "$0")/lib/state-utils.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Uses shared find_needs_review_state from state-utils.sh for worktree isolation.

# Check if the command is allowed during review gate
is_review_command() {
  local cmd="$1"
  # gh pr diff/view/comment/edit — review-related PR commands
  if is_gh_pr_command "$cmd" "diff|view|comment|edit"; then
    return 0
  fi
  # git diff/log/show/status/branch — read-only review commands
  if is_git_command "$cmd" "diff|log|show|status|branch"; then
    return 0
  fi
  return 1
}

# Check for active review gate
REVIEW_INFO=$(find_needs_review_state)
if [ $? -ne 0 ] || [ -z "$REVIEW_INFO" ]; then
  # No active review — allow everything
  exit 0
fi

PR_URL=$(echo "$REVIEW_INFO" | cut -d'|' -f1)
ROUND=$(echo "$REVIEW_INFO" | cut -d'|' -f2)

# If the command is review-related, allow it through
if is_review_command "$CMD_LINE"; then
  exit 0
fi

# Block the command — agent must review first
jq -n \
  --arg reason "BLOCKED: PR review required before proceeding.

You have an active PR review that must be completed first:
  PR: $PR_URL (round $ROUND)

Run \`gh pr diff $PR_URL\` to review the diff, then work through the
self-review checklist. Only after reviewing can you proceed with other work.

Allowed commands during review:
  gh pr diff, gh pr view, gh pr comment, gh pr edit
  git diff, git log, git show, git status, git branch" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'

exit 0
