#!/bin/bash
# review-pr-on-create.sh — Level 2 kaizen enforcement (Issue #29)
# Fires after `gh pr create` succeeds. Outputs a structured self-review
# checklist so the creating agent reviews its own work before moving on.
#
# Runs as PostToolUse hook on Bash tool calls.
# Always exits 0 — advisory, not blocking.

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_output.stdout // empty')
STDERR=$(echo "$INPUT" | jq -r '.tool_output.stderr // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_output.exit_code // "0"')

# Only trigger on successful commands
if [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only trigger on gh pr create commands (not gh pr view, gh pr list, etc.)
if ! echo "$CMD_LINE" | grep -qE 'gh\s+pr\s+create'; then
  exit 0
fi

# Extract PR URL from output to embed in review instructions
PR_URL=$(echo "$STDOUT" | grep -oE 'https://github\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
if [ -z "$PR_URL" ]; then
  PR_URL=$(echo "$STDERR" | grep -oE 'https://github\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
fi

if [ -z "$PR_URL" ]; then
  exit 0
fi

cat <<EOF

📋 PR created: $PR_URL

MANDATORY SELF-REVIEW LOOP — you MUST complete this before proceeding.

Review the PR, fix issues, re-review. Repeat up to 4 rounds until clean.

For EACH round, work through this checklist. If you find issues, fix them,
commit, push, then start the next round.

**Context & Purpose:**
- WHY: What problem does this PR solve?
- WHO: Who requested this work?
- WHAT: Is the purpose clear from title + description?
- HOW: Is the approach sound?
- HOW TO TEST: Are verification steps documented?
- IMPACT: What breaks if wrong? What improves if right?

**Code Quality:**
- Clear and understandable?
- Follows guidelines/conventions (CLAUDE.md, kaizen policies)?
- Designed for testability?
- Needs DRYing, reuse, or refactoring?

**Test Quality:**
- Clear INVARIANTS and SUT?
- Need harness, simulator, hypothesis, fixtures?
- Edge cases covered?
- Smoke tested (actually ran it)?

**Final Gate:**
- Achieving intended purpose?
- Purpose clear to first-time reader?
- Would you merge this reviewing someone else's PR?

PROCESS:
1. Run \`gh pr diff $PR_URL\` to review the actual diff
2. Walk through each checklist item against the diff
3. If issues found: fix, commit, push, log what you fixed
4. Re-review from step 1 (next round)
5. If clean: state "REVIEW PASSED (round N/4)" and proceed

After 4 rounds with remaining issues:
1. Comment on the PR summarizing unresolved issues and what was attempted:
   \`gh pr comment $PR_URL --body "@aviadr1 Self-review hit 4 rounds. Remaining issues: [list]. Need human eyes."\`
2. Ping Aviad on Telegram with the PR URL and a short summary of the problem:
   Write a JSON file to notify via IPC:
   \`cat > data/ipc/main/messages/review-escalation-\$(date +%s).json << MSGEOF
   {"type":"message","chatJid":"tg:-5128317012","text":"🔍 PR self-review stuck after 4 rounds: $PR_URL\\n\\n[Write a short paragraph: what the PR does, what issues remain, and why you couldn't resolve them]"}
   MSGEOF\`
3. Then proceed — do not loop further

Track your round: "ROUND N/4: [reviewing|issues found|clean]"
EOF

exit 0
