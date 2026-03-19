#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-pr-kaizen.sh — Level 3 kaizen enforcement (Issue #57)
# PreToolUse gate: blocks non-kaizen Bash commands until the agent
# completes kaizen reflection after `gh pr create`.
#
# State is set by kaizen-reflect.sh (PostToolUse) with STATUS=needs_pr_kaizen.
# Gate clears when pr-kaizen-clear.sh detects kaizen action was taken.
#
# Allowed commands during kaizen gate:
#   gh issue create (filing kaizen issues)
#   gh issue list/search (finding existing issues — kaizen #150)
#   gh issue comment (adding incidents to existing issues)
#   gh issue list/search/view (searching for duplicates — kaizen #150)
#   echo "KAIZEN_IMPEDIMENTS: ..." (structured impediment declaration)
#   echo "KAIZEN_NO_ACTION [category]: ..." (restricted categories — kaizen #140)
#   gh pr view, gh pr diff, gh pr edit, gh pr comment, gh pr checks (PR-related)
#   gh api (read-only API calls — CI monitoring, PR status)
#   gh run view, gh run list, gh run watch (CI monitoring)
#   git diff, git log, git show, git status, git branch, git fetch
#   ls, cat, stat, find, head, tail, wc, file (read-only)

source "$(dirname "$0")/lib/parse-command.sh"
source "$(dirname "$0")/lib/state-utils.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Check for active PR kaizen gate
STATE_INFO=$(find_state_with_status "needs_pr_kaizen")
if [ $? -ne 0 ] || [ -z "$STATE_INFO" ]; then
  # No active kaizen gate — allow everything
  exit 0
fi

PR_URL=$(echo "$STATE_INFO" | cut -d'|' -f1)

# Check if the command is allowed during kaizen gate
is_kaizen_command() {
  local cmd="$1"
  # gh issue create/list/search — filing kaizen issues and finding existing ones (kaizen #150)
  if echo "$cmd" | grep -qE '^\s*gh\s+issue\s+(create|list|search)'; then
    return 0
  fi
  # KAIZEN_IMPEDIMENTS declaration — structured impediment tracking (kaizen #113)
  if echo "$cmd" | grep -qE 'KAIZEN_IMPEDIMENTS:'; then
    return 0
  fi
  # gh issue comment — adding incidents to existing issues
  if echo "$cmd" | grep -qE '^\s*gh\s+issue\s+comment'; then
    return 0
  fi
  # gh issue list/search/view — searching for duplicates during reflection (kaizen #150)
  if echo "$cmd" | grep -qE '^\s*gh\s+issue\s+(list|search|view)'; then
    return 0
  fi
  # KAIZEN_NO_ACTION declaration — format: KAIZEN_NO_ACTION [category]: reason (kaizen #159)
  if echo "$cmd" | grep -qE 'KAIZEN_NO_ACTION'; then
    return 0
  fi
  # gh pr diff/view/comment/edit/checks — PR-related commands
  if is_gh_pr_command "$cmd" "diff|view|comment|edit|checks"; then
    return 0
  fi
  # gh api — read-only API calls (CI monitoring, PR status checks)
  if echo "$cmd" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
    grep -qE '^gh[[:space:]]+api[[:space:]]'; then
    return 0
  fi
  # gh run view/list/watch — CI run monitoring
  if echo "$cmd" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
    grep -qE '^gh[[:space:]]+run[[:space:]]+(view|list|watch)'; then
    return 0
  fi
  # git read-only commands
  if is_git_command "$cmd" "diff|log|show|status|branch|fetch"; then
    return 0
  fi
  # Read-only filesystem commands
  local first_word
  first_word=$(echo "$cmd" | awk '{print $1}')
  case "$first_word" in
    ls|cat|stat|find|head|tail|wc|file) return 0 ;;
  esac
  return 1
}

if is_kaizen_command "$CMD_LINE"; then
  exit 0
fi

# Block the command — agent must complete kaizen reflection first
jq -n \
  --arg reason "BLOCKED: Kaizen reflection required — ALL impediments must be addressed.

You must reflect on the development process before proceeding.
  PR: $PR_URL

To clear this gate, submit a KAIZEN_IMPEDIMENTS JSON declaration:

  echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
  [
    {\"impediment\": \"description\", \"disposition\": \"filed\", \"ref\": \"#NNN\"},
    {\"impediment\": \"description\", \"disposition\": \"incident\", \"ref\": \"#NNN\"},
    {\"impediment\": \"description\", \"disposition\": \"fixed-in-pr\"},
    {\"impediment\": \"description\", \"disposition\": \"waived\", \"reason\": \"why\"}
  ]
  IMPEDIMENTS

If no impediments found: echo 'KAIZEN_IMPEDIMENTS: [] brief reason here'

For trivial changes only: echo 'KAIZEN_NO_ACTION [category]: reason'
  Categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor

Allowed commands during reflection:
  gh issue create/comment/list/search/view, gh pr diff/view/comment/edit
  gh api, gh run view/list/watch
  git diff, git log, git show, git status, git branch" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'

exit 0
