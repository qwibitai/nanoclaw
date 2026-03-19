#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# pr-review-loop.sh — Level 2 kaizen enforcement (Issue #29)
# Multi-round PR self-review with state tracking.
#
# Triggers on:
#   1. gh pr create  — starts review loop (round 1)
#   2. git push      — after pushing fixes, enforces next review round
#   3. gh pr diff    — outputs checklist for current round
#   4. gh pr merge   — cleans up state file
#
# Uses state file to track review progress across tool calls.
# Always exits 0 — advisory, not blocking.

source "$(dirname "$0")/lib/parse-command.sh"
source "$(dirname "$0")/lib/state-utils.sh"

DEBUG_LOG="/tmp/pr-review-hook-debug.log"
echo "[$(date -Iseconds)] pr-review-loop.sh INVOKED" >> "$DEBUG_LOG"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')

# Only trigger on successful commands
if [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Ensure state directory exists (STATE_DIR set by state-utils.sh)
mkdir -p "$STATE_DIR" 2>/dev/null
chmod 700 "$STATE_DIR" 2>/dev/null

# State file is keyed by PR URL (set after trigger detection).
# Using branch name fails when PRs target other repos (e.g., garsson-prints)
# because git rev-parse resolves the nanoclaw CWD, not the target repo.
STATE_FILE=""

# Determine which trigger fired
IS_PR_CREATE=false
IS_GIT_PUSH=false
IS_PR_DIFF=false
IS_PR_MERGE=false

if is_gh_pr_command "$CMD_LINE" "create"; then
  IS_PR_CREATE=true
  echo "[$(date -Iseconds)] trigger=PR_CREATE" >> "$DEBUG_LOG"
elif is_git_command "$CMD_LINE" "push"; then
  IS_GIT_PUSH=true
  echo "[$(date -Iseconds)] trigger=GIT_PUSH" >> "$DEBUG_LOG"
elif is_gh_pr_command "$CMD_LINE" "diff"; then
  IS_PR_DIFF=true
  echo "[$(date -Iseconds)] trigger=PR_DIFF" >> "$DEBUG_LOG"
elif is_gh_pr_command "$CMD_LINE" "merge"; then
  IS_PR_MERGE=true
  echo "[$(date -Iseconds)] trigger=PR_MERGE" >> "$DEBUG_LOG"
else
  echo "[$(date -Iseconds)] no trigger matched | cmd=$(echo "$CMD_LINE" | head -c 200)" >> "$DEBUG_LOG"
  exit 0
fi

# Convert a PR URL to a safe state file path.
# Uses shared pr_url_to_state_key from state-utils.sh (kaizen #172).
pr_url_to_state_file() {
  local url="$1"
  echo "$STATE_DIR/$(pr_url_to_state_key "$url")"
}

# Find the most recent state file matching given statuses, scoped to the current branch.
# Uses shared state-utils.sh for worktree isolation — never iterate state files directly.
# Usage: find_state_by_status "needs_review" or find_state_by_status "needs_review" "passed"
find_state_by_status() {
  local latest=""
  local latest_mtime=0
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    local matched=false
    for want in "$@"; do
      if [ "$status" = "$want" ]; then
        matched=true
        break
      fi
    done
    if $matched; then
      local mtime
      mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo "0")
      if [ "$mtime" -gt "$latest_mtime" ]; then
        latest="$f"
        latest_mtime="$mtime"
      fi
    fi
  done < <(list_state_files_for_current_worktree)
  echo "$latest"
}

# Convenience: find state needing review (for gh pr diff)
find_active_state() {
  find_state_by_status "needs_review"
}

# Safe state read — grep/cut instead of source to prevent code injection
read_state() {
  if [ -z "$STATE_FILE" ] || [ ! -f "$STATE_FILE" ]; then
    PR_URL=""
    ROUND=1
    STATUS=""
    return 1
  fi
  PR_URL=$(grep -E '^PR_URL=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  ROUND=$(grep -E '^ROUND=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  STATUS=$(grep -E '^STATUS=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  ROUND=${ROUND:-1}
  STATUS=${STATUS:-needs_review}
  echo "[$(date -Iseconds)] read_state | file=$STATE_FILE round=$ROUND status=$STATUS" >> "$DEBUG_LOG"
  # Validate PR_URL looks like a GitHub URL (reject anything else)
  if [ -n "$PR_URL" ] && ! echo "$PR_URL" | grep -qE '^https://github\.com/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+/pull/[0-9]+$'; then
    PR_URL=""
    return 1
  fi
  return 0
}

# Safe state write
write_state() {
  local url="$1"
  local round="$2"
  local status="$3"
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  printf 'PR_URL=%s\nROUND=%s\nSTATUS=%s\nBRANCH=%s\n' "$url" "$round" "$status" "$branch" > "$STATE_FILE"
  chmod 600 "$STATE_FILE" 2>/dev/null
  echo "[$(date -Iseconds)] write_state | file=$STATE_FILE round=$round status=$status branch=$branch" >> "$DEBUG_LOG"
}

# Clean up state file
cleanup_state() {
  echo "[$(date -Iseconds)] cleanup_state | file=$STATE_FILE" >> "$DEBUG_LOG"
  rm -f "$STATE_FILE" 2>/dev/null
}

# Helper: output the review checklist
print_checklist() {
  local pr_url="$1"
  local round="$2"
  local max_rounds="$3"

  cat <<CHECKLIST

Use the /review-pr skill for the full checklist. Run \`/review-pr $pr_url\` now.

The skill covers: requirements verification, clarity, testability, code quality,
purpose/impact, security, documentation & system docs updates, and kaizen.

PROCESS:
1. Run \`/review-pr $pr_url\` — it will load the full checklist
2. Walk through EVERY section
3. If issues found: fix, commit, push, log what you fixed
4. Re-review from step 1 (next round)
5. If clean: state "REVIEW PASSED (round $round/$max_rounds)" and proceed

When review is clean, the hook will stop reminding you on subsequent pushes.

After $max_rounds rounds with remaining issues:
1. Comment on the PR summarizing unresolved issues and what was attempted:
   \`gh pr comment $pr_url --body "@aviadr1 Self-review hit $max_rounds rounds. Remaining issues: [list]. Need human eyes."\`
2. Ping Aviad on Telegram with the PR URL and a problem summary:
   \`cat > data/ipc/main/messages/review-escalation-\$(date +%s).json << MSGEOF
   {"type":"message","chatJid":"tg:-5128317012","text":"🔍 PR self-review stuck after $max_rounds rounds: $pr_url\\n\\n[Write a short paragraph: what the PR does, what issues remain, and why you couldn't resolve them]"}
   MSGEOF\`
3. Then proceed — do not loop further
CHECKLIST
}

MAX_ROUNDS=4

# TRIGGER 4: gh pr merge — set up post-merge workflow gate
if $IS_PR_MERGE; then
  # Reconstruct PR URL using full fallback chain (kaizen #111, #105):
  # stdout → stderr → command URL → --repo + bare number → git remote + bare number
  MERGE_PR_URL=$(reconstruct_pr_url "$CMD_LINE" "$STDOUT" "$STDERR" "merge")
  if [ -n "$MERGE_PR_URL" ]; then
    STATE_FILE=$(pr_url_to_state_file "$MERGE_PR_URL")
  else
    STATE_FILE=$(find_active_state)
  fi
  # Clean up the review state (review is done — PR is merging/merged)
  cleanup_state

  # Detect --auto flag: merge is queued, not yet complete
  IS_AUTO=false
  if echo "$CMD_LINE" | grep -qE '\-\-auto'; then
    IS_AUTO=true
  fi

  # Guard: skip state file creation if PR URL is empty (kaizen #111).
  # Without a URL, the state filename is malformed ("post-merge-") and
  # enforcement hooks block on unattributable state. Better to skip than corrupt.
  if [ -z "$MERGE_PR_URL" ]; then
    cat <<'EOF'

⚠️ Could not determine PR URL from command output or arguments.
Post-merge workflow gate was NOT set — run /kaizen manually after confirming the merge.
EOF
    exit 0
  fi

  # Write post-merge workflow state to a dedicated state file
  MERGE_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  POST_MERGE_KEY=$(pr_url_to_state_key "$MERGE_PR_URL")
  POST_MERGE_STATE="$STATE_DIR/post-merge-${POST_MERGE_KEY}"

  if $IS_AUTO; then
    # Auto-merge: PR isn't merged yet. Write awaiting_merge state.
    # post-merge-clear.sh will promote to needs_post_merge when agent
    # confirms merge via `gh pr view` (kaizen #93 fix).
    printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' "$MERGE_PR_URL" "awaiting_merge" "$MERGE_BRANCH" > "$POST_MERGE_STATE"
    chmod 600 "$POST_MERGE_STATE" 2>/dev/null

    cat <<EOF

⏳ Auto-merge queued for: $MERGE_PR_URL

The PR will merge when CI passes. After confirming the merge (via \`gh pr view\`),
the post-merge workflow will activate. You will need to:
1. Run \`/kaizen\` for reflection
2. Mark the case as done
3. Sync main
4. Update linked issue

EOF
  else
    # Direct merge: PR is merged now. Write needs_post_merge state.
    printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' "$MERGE_PR_URL" "needs_post_merge" "$MERGE_BRANCH" > "$POST_MERGE_STATE"
    chmod 600 "$POST_MERGE_STATE" 2>/dev/null

    cat <<EOF

🎉 PR merged: $MERGE_PR_URL

Now complete the post-merge workflow:
1. **Kaizen reflection (REQUIRED)** — Run \`/kaizen\` NOW. Reflect on impediments, what you'd do differently, and what the system should learn. This is not optional — skipping kaizen reflection after merge is a recurring failure pattern.
2. **Post-merge action needed** — classify per CLAUDE.md "Post-Merge: Deploy & Maintenance Policy":
   - CLAUDE.md/docs only → no action, active on next conversation
   - src/ changes → needs \`npm run build\` + service restart (~10s downtime)
   - container/Dockerfile → needs \`./container/build.sh\` + restart
   - package.json deps → needs \`npm install\` + build + restart
3. **Sync main** — \`git -C /home/aviadr1/projects/nanoclaw fetch origin main && git -C /home/aviadr1/projects/nanoclaw merge origin/main --no-edit\`
4. **Update linked issue** — Close the kaizen/tracking issue with lessons learned.
5. **Spec update** — If a spec/PRD exists, move completed work to "Already Solved".

⛔ You will NOT be able to finish until /kaizen is run.

EOF
  fi
  exit 0
fi

# TRIGGER 1: gh pr create — start the review loop
if $IS_PR_CREATE; then
  PR_URL=$(reconstruct_pr_url "$CMD_LINE" "$STDOUT" "$STDERR" "create")
  if [ -z "$PR_URL" ]; then
    exit 0
  fi

  STATE_FILE=$(pr_url_to_state_file "$PR_URL")
  write_state "$PR_URL" "1" "needs_review"
  # Record initial SHA for diff-size scaling (kaizen #117)
  INITIAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$INITIAL_SHA" ] && [ -f "$STATE_FILE" ]; then
    echo "LAST_REVIEWED_SHA=$INITIAL_SHA" >> "$STATE_FILE"
  fi

  cat <<EOF

📋 PR created: $PR_URL

MANDATORY SELF-REVIEW LOOP — you MUST complete this before proceeding.

Review the PR, fix issues, re-review. Repeat up to $MAX_ROUNDS rounds until clean.

ROUND 1/$MAX_ROUNDS: Start your review now.

For EACH round, work through this checklist. If you find issues, fix them,
commit, push, then start the next round.
EOF
  print_checklist "$PR_URL" "1" "$MAX_ROUNDS"
  echo ""
  echo "Track your round: \"ROUND N/$MAX_ROUNDS: [reviewing|issues found|clean]\""
  exit 0
fi

# TRIGGER 2: git push — agent pushed fixes, enforce next review round
# Must come before the gh pr diff handler because push needs to find
# state files with STATUS=passed (review done, then agent pushed fixes).
if $IS_GIT_PUSH; then
  # Find state with needs_review OR passed (push after passed = new round)
  STATE_FILE=$(find_state_by_status "needs_review" "passed")
  if ! read_state; then
    exit 0
  fi
  # If already escalated, don't re-engage
  if [ "$STATUS" = "escalated" ]; then
    exit 0
  fi

  # Skip round increment for merge-from-main pushes (kaizen #85, Fix B)
  # When strict branch protection requires syncing with main, the push
  # contains no code changes — just a merge commit. Don't penalize the agent.
  LATEST_PARENTS=$(git log -1 --format='%P' HEAD 2>/dev/null)
  PARENT_COUNT=$(echo "$LATEST_PARENTS" | wc -w)
  if [ "$PARENT_COUNT" -ge 2 ]; then
    MAIN_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "")
    if [ -n "$MAIN_HEAD" ] && echo "$LATEST_PARENTS" | grep -qF "$MAIN_HEAD"; then
      echo "[$(date -Iseconds)] skip round increment: merge-from-main push" >> "$DEBUG_LOG"
      exit 0
    fi
  fi

  NEXT_ROUND=$((ROUND + 1))

  # Scale review depth to diff size (kaizen #117).
  # If the push changed ≤15 lines of code, auto-pass with abbreviated review.
  # This saves 2-4 minutes per iterative fix-push cycle (CI fixes, typos, etc.).
  DIFF_LINES=0
  LAST_SHA=$(grep -E '^LAST_REVIEWED_SHA=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -n "$LAST_SHA" ]; then
    DIFF_LINES=$(git diff --stat "$LAST_SHA"..HEAD 2>/dev/null | tail -1 | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
    DIFF_DELS=$(git diff --stat "$LAST_SHA"..HEAD 2>/dev/null | tail -1 | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")
    DIFF_LINES=$((${DIFF_LINES:-0} + ${DIFF_DELS:-0}))
  fi

  SMALL_DIFF_THRESHOLD=15
  if [ "$DIFF_LINES" -gt 0 ] && [ "$DIFF_LINES" -le "$SMALL_DIFF_THRESHOLD" ]; then
    # Small diff — abbreviated review: show changes inline, auto-pass
    DIFF_PREVIEW=$(git diff "$LAST_SHA"..HEAD -- . ':!*.lock' 2>/dev/null | head -60)
    write_state "$PR_URL" "$NEXT_ROUND" "passed"
    # Record new SHA for next push
    NEW_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
    if [ -n "$NEW_SHA" ] && [ -f "$STATE_FILE" ]; then
      echo "LAST_REVIEWED_SHA=$NEW_SHA" >> "$STATE_FILE"
    fi
    cat <<EOF

🔍 Small push detected ($DIFF_LINES lines changed) — abbreviated review (round $NEXT_ROUND/$MAX_ROUNDS).

\`\`\`diff
$DIFF_PREVIEW
\`\`\`

Changes are minor. Review auto-passed. If you pushed a substantive fix,
run \`gh pr diff $PR_URL\` for a full review.

EOF
    exit 0
  fi

  if [ "$NEXT_ROUND" -gt "$MAX_ROUNDS" ]; then
    cat <<EOF

⚠️ REVIEW ROUND $MAX_ROUNDS/$MAX_ROUNDS COMPLETE — you've pushed fixes $MAX_ROUNDS times.

You MUST now escalate:
1. Comment on the PR: \`gh pr comment $PR_URL --body "@aviadr1 Self-review hit $MAX_ROUNDS rounds. Remaining issues: [list]. Need human eyes."\`
2. Notify via Telegram IPC
3. Then proceed — do not loop further

Mark review as escalated.
EOF
    write_state "$PR_URL" "$MAX_ROUNDS" "escalated"
    exit 0
  fi

  write_state "$PR_URL" "$NEXT_ROUND" "needs_review"

  cat <<EOF

🔄 Push detected during PR review. Starting ROUND $NEXT_ROUND/$MAX_ROUNDS.

You MUST re-review the PR before proceeding. Do NOT skip this review round.

Run \`gh pr diff $PR_URL\` now and walk through the checklist again.

Track your round: "ROUND $NEXT_ROUND/$MAX_ROUNDS: [reviewing|issues found|clean]"
EOF
  exit 0
fi

# For gh pr diff, find only needs_review state
STATE_FILE=$(find_active_state)
if ! read_state; then
  exit 0
fi

# If review already passed or escalated, don't nag
if [ "$STATUS" = "passed" ] || [ "$STATUS" = "escalated" ]; then
  exit 0
fi

# TRIGGER 3: gh pr diff — agent is reviewing, output the checklist
if $IS_PR_DIFF; then
  # Check if the diff output contains "REVIEW PASSED" from a previous tool call's
  # stdout — this means the agent declared the review clean. But that's the agent's
  # text response, not the diff output. Instead, we look for "REVIEW PASSED" in
  # the COMMAND itself (agent might pipe/echo it). For reliability, we just show
  # the checklist and let the agent declare pass — the next gh pr diff without
  # subsequent push means the agent found it clean.

  cat <<EOF

📋 REVIEW ROUND $ROUND/$MAX_ROUNDS — walk through the full checklist below.

If you find issues: fix, commit, push (which starts the next round).
If clean: state "REVIEW PASSED (round $ROUND/$MAX_ROUNDS)" and the hook
will stop reminding you. To mark review complete, the agent should not push
further changes — the next push would start a new round.
EOF
  print_checklist "$PR_URL" "$ROUND" "$MAX_ROUNDS"

  # After reviewing the diff (without a subsequent push), review is implicitly
  # passed. If the agent pushes again, that triggers the next round.
  # If they don't push, the "passed" status stops further nags.
  write_state "$PR_URL" "$ROUND" "passed"
  # Record reviewed SHA for diff-size scaling (kaizen #117)
  REVIEWED_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$REVIEWED_SHA" ] && [ -f "$STATE_FILE" ]; then
    echo "LAST_REVIEWED_SHA=$REVIEWED_SHA" >> "$STATE_FILE"
  fi

  cat <<EOF

✅ REVIEW PASSED (round $ROUND/$MAX_ROUNDS)

Now report to the user:
1. **What this PR achieves** — summarize the changes and their purpose in 2-3 sentences
2. **PR status** — ready to merge, link: $PR_URL
3. **Post-merge action needed** — classify per CLAUDE.md "Post-Merge: Deploy & Maintenance Policy":
   - CLAUDE.md/docs only → no action needed
   - src/ changes → needs \`npm run build\` + service restart (~10s downtime)
   - container/Dockerfile → needs \`./container/build.sh\` + restart
   - package.json deps → needs \`npm install\` + build + restart

EOF
  exit 0
fi

exit 0
