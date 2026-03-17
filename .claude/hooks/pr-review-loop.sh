#!/bin/bash
# pr-review-loop.sh — Level 3 kaizen enforcement (Issue #29, #46)
# Multi-round PR self-review with state tracking.
#
# Triggers on:
#   1. gh pr create  — starts review loop (round 1)
#   2. git push      — after pushing fixes, enforces next review round
#   3. gh pr diff    — outputs checklist for current round
#   4. gh pr merge   — cleans up state file
#
# Uses state file to track review progress across tool calls.
# Always exits 0 (PostToolUse). Enforcement is done by the PreToolUse
# gate in enforce-pr-review.sh (Issue #46), which blocks non-review
# commands while STATUS=needs_review.

source "$(dirname "$0")/lib/parse-command.sh"

DEBUG_LOG="/tmp/pr-review-hook-debug.log"
echo "[$(date -Iseconds)] pr-review-loop.sh INVOKED" >> "$DEBUG_LOG"

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

# State directory for review tracking
STATE_DIR="${STATE_DIR:-/tmp/.pr-review-state}"
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
# e.g. https://github.com/Garsson-io/nanoclaw/pull/33 → Garsson-io_nanoclaw_33
pr_url_to_state_file() {
  local url="$1"
  echo "$STATE_DIR/$(echo "$url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
}

# Find the most recent active state file (for push/diff triggers that don't know the PR URL).
find_active_state() {
  local latest=""
  local latest_mtime=0
  for f in "$STATE_DIR"/*; do
    [ -f "$f" ] || continue
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "needs_review" ]; then
      local mtime
      mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo "0")
      if [ "$mtime" -gt "$latest_mtime" ]; then
        latest="$f"
        latest_mtime="$mtime"
      fi
    fi
  done
  echo "$latest"
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
  printf 'PR_URL=%s\nROUND=%s\nSTATUS=%s\n' "$url" "$round" "$status" > "$STATE_FILE"
  chmod 600 "$STATE_FILE" 2>/dev/null
  echo "[$(date -Iseconds)] write_state | file=$STATE_FILE round=$round status=$status" >> "$DEBUG_LOG"
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

Review the PR against each question below. Be honest and thorough.

**Clarity & Conventions:**
- Is it clear and understandable?
- Does it follow our guidelines and conventions (CLAUDE.md, kaizen policies)?

**Testability & Correctness:**
- Is it designed for testability? What would make it more testable and more correct?
- Do the tests need harness, simulator, hypothesis, fixtures?
- Does it have clear INVARIANTS and SUT?
- Did you smoke test it (actually ran it)?

**Code Quality:**
- Does it need DRYing up? More reuse? Refactoring?

**Purpose & Impact:**
- Is the PR achieving its intended purpose? Is the intended purpose clear?
- Is it correct?
- Does it improve our codebase overall? Does it degrade anything? Create noise?

**Security & QoL:**
- Review security — any injection, path traversal, or trust boundary issues?
- Review QoL — is it improving the maintainability and understandability of the codebase?

**Kaizen:**
- Is it kaizen? Is it recursive kaizen?

PROCESS:
1. Run \`gh pr diff $pr_url\` to review the actual diff
2. Walk through each checklist item against the diff
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

# TRIGGER 4: gh pr merge — clean up state file
if $IS_PR_MERGE; then
  # Try to find state by PR URL from output, or fall back to most recent active
  MERGE_PR_URL=$(echo "$STDOUT" | grep -oE 'https://github\.com/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+/pull/[0-9]+' | head -1)
  if [ -n "$MERGE_PR_URL" ]; then
    STATE_FILE=$(pr_url_to_state_file "$MERGE_PR_URL")
  else
    STATE_FILE=$(find_active_state)
  fi
  cleanup_state
  exit 0
fi

# TRIGGER 1: gh pr create — start the review loop
if $IS_PR_CREATE; then
  PR_URL=$(echo "$STDOUT" | grep -oE 'https://github\.com/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+/pull/[0-9]+' | head -1)
  if [ -z "$PR_URL" ]; then
    PR_URL=$(echo "$STDERR" | grep -oE 'https://github\.com/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+/pull/[0-9]+' | head -1)
  fi
  if [ -z "$PR_URL" ]; then
    echo "[$(date -Iseconds)] PR_CREATE: no URL found | stdout=$(echo "$STDOUT" | head -c 500) | stderr=$(echo "$STDERR" | head -c 500)" >> "$DEBUG_LOG"
    exit 0
  fi

  STATE_FILE=$(pr_url_to_state_file "$PR_URL")
  write_state "$PR_URL" "1" "needs_review"

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

# For git push and gh pr diff, find the most recent active state file
STATE_FILE=$(find_active_state)
if ! read_state; then
  exit 0
fi

# If review already passed or escalated, don't nag
if [ "$STATUS" = "passed" ] || [ "$STATUS" = "escalated" ]; then
  exit 0
fi

# TRIGGER 2: git push — agent pushed fixes, enforce next review round
if $IS_GIT_PUSH; then
  NEXT_ROUND=$((ROUND + 1))

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
  exit 0
fi

exit 0
