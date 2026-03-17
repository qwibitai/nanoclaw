#!/bin/bash
# check-verification.sh — Level 2 kaizen enforcement (Issue #10)
# Intercepts `gh pr create` to ensure the PR body contains a Verification
# section with concrete success criteria. Also checks `gh pr merge` to
# remind about post-deploy verification.
#
# Runs as PreToolUse hook on Bash tool calls.
# Exit 0 = allow (with advisory on stderr)
# JSON with permissionDecision deny = block

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only check gh pr create and gh pr merge
if ! echo "$CMD_LINE" | grep -qE 'gh\s+pr\s+(create|merge)'; then
  exit 0
fi

IS_CREATE=false
IS_MERGE=false
if echo "$CMD_LINE" | grep -qE 'gh\s+pr\s+create'; then
  IS_CREATE=true
elif echo "$CMD_LINE" | grep -qE 'gh\s+pr\s+merge'; then
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
    MSG="⚠️  Missing Verification section in PR body (CLAUDE.md post-merge policy).

Every PR must include a Verification section with:
1. **Concrete success criteria** — what specific behavior proves this works?
2. **How to verify** — exact commands or steps to run after deploy
3. **Expected outcome** — what does success look like?

Example:
  ## Verification
  - [ ] Run \`npm run build\` — should complete without errors
  - [ ] Send a test message in Telegram — agent should respond within 30s
  - [ ] Check \`systemctl --user status nanoclaw\` — should show active

Add a Verification section to your PR body before creating."

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
  fi
fi

if [ "$IS_MERGE" = true ]; then
  # For merge: fetch PR body and check for verification section
  # Extract PR number from command if present
  PR_NUM=$(echo "$COMMAND" | grep -oE '[0-9]+' | head -1)

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
