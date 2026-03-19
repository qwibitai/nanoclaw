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

  cat <<REFLECT

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 KAIZEN REFLECTION — Post-PR Creation (background)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Launch a background kaizen-bg subagent to handle reflection while you continue working.

**Use the Agent tool** with these parameters:
- subagent_type: "kaizen-bg"
- run_in_background: true
- prompt: Include this context:
  - Event: PR created
  - PR URL: $PR_URL
  - Branch: $BRANCH
  - Changed files: $CHANGED
  - List any impediments/friction you encountered during this work

The kaizen-bg subagent will search for duplicate issues, file incidents, and
create new kaizen issues as needed. It will report results back to you.

**When the subagent completes**, use its results to clear the gate:

\`\`\`bash
echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[
  {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
  {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
  {"impediment": "description", "disposition": "fixed-in-pr"},
  {"impediment": "description", "disposition": "waived", "reason": "why"}
]
IMPEDIMENTS
\`\`\`

If the subagent found no impediments: \`echo 'KAIZEN_IMPEDIMENTS: []'\`

⛔ You are GATED until you submit a valid KAIZEN_IMPEDIMENTS declaration.
Allowed commands: gh issue/pr, gh api, gh run, git read-only, ls/cat.

For trivial changes (typo, formatting, docs-only), you may also use:
  \`echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'\`
Valid categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor
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

  cat <<REFLECT

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 KAIZEN REFLECTION — Post-Merge (background)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Launch a background kaizen-bg subagent to handle reflection while you continue
with post-merge steps (deploy verification, main sync, case closure).

**Use the Agent tool** with these parameters:
- subagent_type: "kaizen-bg"
- run_in_background: true
- prompt: Include this context:
  - Event: PR merged
  - PR URL: $PR_URL
  - Branch: $BRANCH
  - Changed files: $CHANGED
  - List any impediments/friction you encountered during this work
  - Ask it to also check if any open kaizen issues are now resolved by this merge

The kaizen-bg subagent will search for duplicate issues, file incidents, and
create new kaizen issues as needed. It will report results back to you.

**When the subagent completes**, use its results to clear the gate:

\`\`\`bash
echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[
  {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
  {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
  {"impediment": "description", "disposition": "fixed-in-pr"},
  {"impediment": "description", "disposition": "waived", "reason": "why"}
]
IMPEDIMENTS
\`\`\`

If the subagent found no impediments: \`echo 'KAIZEN_IMPEDIMENTS: []'\`

⛔ You are GATED until you submit a valid KAIZEN_IMPEDIMENTS declaration.
Allowed commands: gh issue/pr, gh api, gh run, git read-only, ls/cat.

For trivial changes (typo, formatting, docs-only), you may also use:
  \`echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'\`
Valid categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor

**Also complete post-merge steps** (these are NOT delegated to the subagent):
- Follow Post-Merge deployment procedure in CLAUDE.md
- Sync main: \`git -C /home/aviadr1/projects/nanoclaw fetch origin main && git -C /home/aviadr1/projects/nanoclaw merge --ff-only origin/main\`
- Close resolved kaizen issues
- Delete merged branch and worktree
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
