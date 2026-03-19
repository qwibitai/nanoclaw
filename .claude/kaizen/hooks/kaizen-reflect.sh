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

# Extract PR URL using full fallback chain (kaizen #111, #105)
if $IS_CREATE; then
  PR_URL=$(reconstruct_pr_url "$CMD_LINE" "$STDOUT" "$STDERR" "create")
elif $IS_MERGE; then
  PR_URL=$(reconstruct_pr_url "$CMD_LINE" "$STDOUT" "$STDERR" "merge")
fi

# Get current branch for context
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Get changed files for context (uses PR diff for merges, git diff for creates)
CHANGED=$(get_pr_changed_files "$CMD_LINE" "$IS_MERGE" 2>/dev/null | head -20)

if [ "$IS_CREATE" = true ]; then
  # L3 enforcement (kaizen #57): set state gate for PR creation kaizen
  source "$(dirname "$0")/lib/state-utils.sh"
  # Guard: skip state file if PR URL is empty (kaizen #111)
  if [ -z "$PR_URL" ]; then
    exit 0
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null
  chmod 700 "$STATE_DIR" 2>/dev/null
  KAIZEN_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  KAIZEN_STATE_FILE="$STATE_DIR/pr-kaizen-$(echo "$PR_URL" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$PR_URL" "needs_pr_kaizen" "$KAIZEN_BRANCH" > "$KAIZEN_STATE_FILE"
  chmod 600 "$KAIZEN_STATE_FILE" 2>/dev/null

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

5. **🔍 INCIDENTS ARE DATA — check before filing:**
   Before filing a NEW kaizen issue, search existing open issues:
     `gh issue list --repo Garsson-io/kaizen --state open --search "<keywords>"`
   If a match exists, ADD AN INCIDENT COMMENT instead of filing a duplicate:
     ## Incident #N (YYYY-MM-DD)
     **PR/Context:** #NNN
     **Impact:** [time wasted | blocked | wrong output | human notified]
     **Details:** [what happened]
   Incidents on existing issues are MORE VALUABLE than new issues —
   they accumulate evidence that drives prioritization and level escalation.

6. **⚡ STRUCTURED IMPEDIMENTS — you are GATED until ALL are addressed:**
   Reflection without action is decoration. For EVERY impediment you
   identified above, you MUST choose a disposition. First, do any filing
   or incident-commenting needed, then submit a single JSON declaration:

   ```bash
   echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
   [
     {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
     {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
     {"impediment": "description", "disposition": "fixed-in-pr"},
     {"impediment": "description", "disposition": "waived", "reason": "why"}
   ]
   IMPEDIMENTS
   ```

   Valid dispositions:
   - **filed** — new kaizen issue created (requires "ref": "#NNN")
   - **incident** — comment added to existing issue (requires "ref": "#NNN")
   - **fixed-in-pr** — already fixed in this PR
   - **waived** — not worth filing (requires "reason": "why")

   If you genuinely found NO impediments (include a reason):
     `echo 'KAIZEN_IMPEDIMENTS: [] straightforward fix, no process issues'`

   For trivial changes (typo, formatting, docs-only), you may also use:
     `echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'`
   Valid categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor

   ⛔ You will be BLOCKED from non-kaizen commands until you submit
   a valid KAIZEN_IMPEDIMENTS declaration covering ALL impediments.

Ensure the PR description includes the Kaizen section:
  ## Kaizen
  - **Root cause:** [what caused this]
  - **Fix level:** L[1/2/3]
  - **Repeat failure?** [yes/no]
  - **Escalation needed?** [yes/no]
  - **Impediments:** [structured list from reflection]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REFLECT
fi

if [ "$IS_MERGE" = true ]; then
  # L3 enforcement (kaizen #108): set state gate for post-merge kaizen action
  # Reuses the same needs_pr_kaizen gate as PR creation — same enforcement
  # infrastructure (enforce-pr-kaizen.sh blocks, pr-kaizen-clear.sh clears).
  source "$(dirname "$0")/lib/state-utils.sh"
  # Guard: skip state file if PR URL is empty (kaizen #111)
  if [ -z "$PR_URL" ]; then
    exit 0
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null
  chmod 700 "$STATE_DIR" 2>/dev/null
  KAIZEN_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  KAIZEN_STATE_FILE="$STATE_DIR/pr-kaizen-$(echo "$PR_URL" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$PR_URL" "needs_pr_kaizen" "$KAIZEN_BRANCH" > "$KAIZEN_STATE_FILE"
  chmod 600 "$KAIZEN_STATE_FILE" 2>/dev/null

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

5. **🔍 INCIDENTS ARE DATA — check before filing:**
   Before filing a NEW kaizen issue, search existing open issues:
     `gh issue list --repo Garsson-io/kaizen --state open --search "<keywords>"`
   If a match exists, ADD AN INCIDENT COMMENT instead of filing a duplicate:
     ## Incident #N (YYYY-MM-DD)
     **PR/Context:** #NNN
     **Impact:** [time wasted | blocked | wrong output | human notified]
     **Details:** [what happened]
   Incidents on existing issues are MORE VALUABLE than new issues —
   they accumulate evidence that drives prioritization and level escalation.

6. **⚡ STRUCTURED IMPEDIMENTS — you are GATED until ALL are addressed:**
   Reflection without action is decoration. For EVERY impediment you
   identified above, you MUST choose a disposition. First, do any filing
   or incident-commenting needed, then submit a single JSON declaration:

   ```bash
   echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
   [
     {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
     {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
     {"impediment": "description", "disposition": "fixed-in-pr"},
     {"impediment": "description", "disposition": "waived", "reason": "why"}
   ]
   IMPEDIMENTS
   ```

   Valid dispositions:
   - **filed** — new kaizen issue created (requires "ref": "#NNN")
   - **incident** — comment added to existing issue (requires "ref": "#NNN")
   - **fixed-in-pr** — already fixed in this PR
   - **waived** — not worth filing (requires "reason": "why")

   If you genuinely found NO impediments (include a reason):
     `echo 'KAIZEN_IMPEDIMENTS: [] straightforward fix, no process issues'`

   For trivial changes (typo, formatting, docs-only), you may also use:
     `echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'`
   Valid categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor

   ⛔ You will be BLOCKED from non-kaizen commands until you submit
   a valid KAIZEN_IMPEDIMENTS declaration covering ALL impediments.

7. **Cleanup:**
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
