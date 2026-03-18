#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# kaizen-reflect.sh — Level 2 kaizen enforcement (Issue #9)
# Triggers after `gh pr create` or `gh pr merge` to prompt structured
# kaizen reflection. Outputs reflection prompts on stdout so the agent
# sees them in the transcript (PostToolUse exit 0 → stdout shown).
#
# Runs as PostToolUse hook on Bash tool calls.
# Always exits 0 — this is advisory, not blocking.

source "$(dirname "$0")/lib/parse-command.sh"
source "$(dirname "$0")/lib/send-telegram-ipc.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')

# Only trigger on successful gh pr create or gh pr merge
if [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

IS_CREATE=false
IS_MERGE=false
if is_gh_pr_command "$CMD_LINE" "create"; then
  IS_CREATE=true
elif is_gh_pr_command "$CMD_LINE" "merge"; then
  IS_MERGE=true
else
  exit 0
fi

# Extract PR URL from output
PR_URL=$(echo "$STDOUT" | grep -oE 'https://github.com/[^ ]+/pull/[0-9]+' | head -1)
if [ -z "$PR_URL" ]; then
  PR_URL=$(echo "$STDERR" | grep -oE 'https://github.com/[^ ]+/pull/[0-9]+' | head -1)
fi

# Get current branch for context
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Get changed files for context (uses PR diff for merges, git diff for creates)
CHANGED=$(get_pr_changed_files "$CMD_LINE" "$IS_MERGE" 2>/dev/null | head -20)

if [ "$IS_CREATE" = true ]; then
  cat <<'REFLECT'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 KAIZEN REFLECTION — Post-PR Creation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before moving on, reflect on the work that led to this PR:

1. **What broke / what was the trigger?**
   - Was this a bug fix, new feature, or process improvement?
   - What was the root cause?

2. **What level is this fix?**
   - L1 (instructions only) → L2 (hooks/checks) → L3 (mechanistic)
   - Is this the RIGHT level, or should it be escalated?
   - Remember: MCP tools are Level 3 enforcement points. If the fix
     is "better instructions", ask if it should be mechanistic instead.

3. **Has this type of failure happened before?**
   - If yes → the previous level wasn't enough, escalate
   - Check: https://github.com/Garsson-io/kaizen/issues

4. **Process friction encountered?**
   - What slowed you down? Missing docs? Unclear architecture?
   - Would a hook, tool, or architectural change prevent this?

5. **⚡ MAKE IT ACTIONABLE — this is the most important step:**
   Reflection without action is decoration. For each improvement
   you identified above, you MUST do one of:
   - **Create a dev case** via `case_suggest_dev` tool if the fix
     requires code changes (hooks, MCP tools, architecture)
   - **File a kaizen issue** via `create_github_issue` tool if the
     fix needs design discussion or is out of scope right now
   - **Fix it now** in this PR if it's small enough to include
   - If none apply, explicitly state why no action is needed.
   Do NOT just list ideas — every insight must become tracked work
   or an explicit "no action needed" with a reason.

   # TODO(kaizen-L3): This action step is still Level 1 (instructions).
   # Escalate to Level 3: after this reflection prompt, verify the agent
   # actually called case_suggest_dev or create_github_issue. If it didn't
   # and listed improvements, block or re-prompt. See Garsson-io/kaizen#57.

Ensure the PR description includes the Kaizen section:
  ## Kaizen
  - **Root cause:** [what caused this]
  - **Fix level:** L[1/2/3]
  - **Repeat failure?** [yes/no]
  - **Escalation needed?** [yes/no]
  - **Action taken:** [dev case / kaizen issue / fixed in PR / no action needed]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REFLECT
fi

if [ "$IS_MERGE" = true ]; then
  cat <<'REFLECT'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 KAIZEN REFLECTION — Post-Merge
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The PR has been merged. Reflect on the outcome:

1. **Was the fix at the right level?**
   - L1 fixes often recur — should this be escalated to L2/L3?
   - Did this fix address symptoms or root cause?
   - MCP tools are Level 3 enforcement points — if this was L1,
     could the MCP tool enforce it mechanistically?

2. **Are any kaizen issues now resolved?**
   - Check: https://github.com/Garsson-io/kaizen/issues
   - Close issues that this PR resolves

3. **Deployment verification:**
   - Follow the Post-Merge deployment procedure in CLAUDE.md
   - Run the verification steps defined in the PR
   - Report results to leads

4. **Knowledge capture:**
   - Should any learnings go into CLAUDE.md or docs/?
   - Is there a pattern here that other agents should know?

5. **⚡ MAKE IT ACTIONABLE:**
   If you identified that this fix should be escalated, or found
   friction worth fixing — act NOW before cleanup:
   - **Create a dev case** via `case_suggest_dev` for code improvements
   - **File a kaizen issue** via `create_github_issue` for design work
   - Do NOT move to cleanup until actions are filed or explicitly skipped

   # TODO(kaizen-L3): Verify agent actually created actionable items
   # when reflection identified improvements. See Garsson-io/kaizen#57.

6. **Cleanup:**
   - Delete the merged branch (local + remote)
   - Remove the worktree if applicable
   - Update any related kaizen issues
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REFLECT

  # Send Telegram notification to leads (Kaizen #31 — L2 escalation from L1 instructions)
  # Extract PR title from the merge output or via gh pr view
  PR_TITLE=""
  PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
  REPO=$(echo "$PR_URL" | sed -n 's|https://github.com/\([^/]*/[^/]*\)/pull/.*|\1|p')
  if [ -n "$PR_NUM" ] && [ -n "$REPO" ]; then
    PR_TITLE=$(gh pr view "$PR_NUM" --repo "$REPO" --json title --jq '.title' 2>/dev/null || true)
  fi
  PR_TITLE="${PR_TITLE:-unknown}"

  NOTIFY_TEXT="$(printf '✅ PR merged: %s\n%s\nBranch: %s\n\nCheck CLAUDE.md post-merge procedure for deploy steps.' \
    "$PR_TITLE" "$PR_URL" "$BRANCH")"
  send_telegram_ipc "$NOTIFY_TEXT" >/dev/null 2>&1 || true
fi

exit 0
