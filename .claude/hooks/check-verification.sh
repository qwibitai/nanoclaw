#!/bin/bash
# check-verification.sh — Advisory early warning (Issue #10)
# Warns when PR body lacks a Verification section with concrete success criteria.
# Also reminds about post-deploy verification on merge.
# Real enforcement is in CI (pr-policy job in .github/workflows/ci.yml).
#
# Runs as PreToolUse hook on Bash tool calls.
# Always exits 0 (advisory only — never blocks).

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only check gh pr create and gh pr merge
if ! is_gh_pr_command "$CMD_LINE" "create|merge"; then
  exit 0
fi

IS_CREATE=false
IS_MERGE=false
if is_gh_pr_command "$CMD_LINE" "create"; then
  IS_CREATE=true
elif is_gh_pr_command "$CMD_LINE" "merge"; then
  IS_MERGE=true
fi

if [ "$IS_CREATE" = true ]; then
  # Extract the --body argument from the command
  # Handle both --body "..." and --body "$(cat <<...)" patterns
  BODY=$(echo "$COMMAND" | grep -oiP '(?<=--body\s)(\"[^"]*\"|'\''[^'\'']*'\''|\$\(cat\s+<<.*?EOF\s*\))')

  # Also check for heredoc content by looking for common verification markers
  HAS_VERIFICATION=false
  if echo "$COMMAND" | grep -qiE '(##\s*Verification|##\s*Test\s+plan|Success\s+criteria|verify|verification)'; then
    HAS_VERIFICATION=true
  fi

  if [ "$HAS_VERIFICATION" = false ]; then
    echo "⚠️  Missing Verification section in PR body (CLAUDE.md post-merge policy)." >&2
    echo "" >&2
    echo "Every PR must include a Verification section with:" >&2
    echo "1. Concrete success criteria" >&2
    echo "2. How to verify (commands or steps)" >&2
    echo "3. Expected outcome" >&2
    echo "" >&2
    echo "CI pr-policy check will block merge if this is missing." >&2
  fi
fi

if [ "$IS_MERGE" = true ]; then
  # For merge: fetch PR body and check for verification section
  # Extract PR number from command if present
  PR_NUM=$(extract_pr_number "$CMD_LINE" "merge")

  if [ -n "$PR_NUM" ]; then
    PR_BODY=$(gh pr view "$PR_NUM" --json body --jq '.body' 2>/dev/null || echo "")
  else
    # Try current branch PR
    PR_BODY=$(gh pr view --json body --jq '.body' 2>/dev/null || echo "")
  fi

  if [ -n "$PR_BODY" ]; then
    # Extract verification section
    VERIFICATION=$(echo "$PR_BODY" | sed -n '/^##.*[Vv]erification/,/^##/p' | head -20)

    if [ -n "$VERIFICATION" ]; then
      echo "" >&2
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
      echo "📋 POST-MERGE VERIFICATION REQUIRED" >&2
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
      echo "" >&2
      echo "After merge, you MUST run these verification steps:" >&2
      echo "" >&2
      echo "$VERIFICATION" >&2
      echo "" >&2
      echo "Follow the Post-Merge deployment procedure in CLAUDE.md." >&2
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    else
      echo "⚠️  This PR has no Verification section. After merge, manually verify the change works as expected." >&2
    fi
  fi
fi

exit 0
