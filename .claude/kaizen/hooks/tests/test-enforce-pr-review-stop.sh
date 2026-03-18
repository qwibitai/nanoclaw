#!/bin/bash
# Tests for enforce-pr-review-stop.sh — Stop hook that blocks Claude from
# stopping when a PR review is pending.
#
# INVARIANT UNDER TEST: Claude cannot finish its response while
# STATUS=needs_review exists for the current branch's PR.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../enforce-pr-review-stop.sh"
STATE_DIR="/tmp/.pr-review-state-test-stop-$$"
export STATE_DIR
export DEBUG_LOG="/dev/null"

setup() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
}

teardown() {
  rm -rf "$STATE_DIR"
}

# Helper: create a state file with given status
create_state() {
  local pr_url="$1"
  local round="$2"
  local status="$3"
  local branch="${4:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')}"
  local filename
  filename=$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')
  printf 'PR_URL=%s\nROUND=%s\nSTATUS=%s\nBRANCH=%s\n' "$pr_url" "$round" "$status" "$branch" > "$STATE_DIR/$filename"
}

# Default mock gh: returns OPEN for all PRs (prevents real API calls in tests)
# find_needs_review_state now checks PR state via gh (kaizen #85, Fix A)
STOP_MOCK_DIR=$(mktemp -d)
cat > "$STOP_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
echo "OPEN"
exit 0
MOCK
chmod +x "$STOP_MOCK_DIR/gh"

# Helper: run the Stop hook with given stop_hook_active value
run_stop_hook() {
  local stop_hook_active="${1:-false}"
  local input
  input=$(jq -n --arg active "$stop_hook_active" '{
    session_id: "test-session",
    hook_event_name: "Stop",
    stop_hook_active: ($active == "true"),
    last_assistant_message: "PR created: https://github.com/example/repo/pull/1"
  }')
  echo "$input" | PATH="$STOP_MOCK_DIR:$PATH" bash "$HOOK" 2>/dev/null
}

# Helper: check if output contains a block decision
is_blocked() {
  local output="$1"
  echo "$output" | jq -e '.decision == "block"' >/dev/null 2>&1
}

echo "=== No active review: stop allowed ==="

setup

# INVARIANT: When no state files exist, Claude can stop freely
# SUT: enforce-pr-review-stop.sh with empty STATE_DIR
OUTPUT=$(run_stop_hook "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stop allowed with no active review"
  ((PASS++))
else
  echo "  FAIL: stop blocked with no active review"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Active review (needs_review): stop blocked ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# INVARIANT: When STATUS=needs_review, Claude cannot stop
# SUT: enforce-pr-review-stop.sh block logic
OUTPUT=$(run_stop_hook "false")
if is_blocked "$OUTPUT"; then
  echo "  PASS: stop blocked during active review"
  ((PASS++))
else
  echo "  FAIL: stop NOT blocked during active review"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

# INVARIANT: Block reason includes PR URL and round number
REASON=$(echo "$OUTPUT" | jq -r '.reason // empty')
assert_contains "block reason includes PR URL" "nanoclaw/pull/42" "$REASON"
assert_contains "block reason includes round" "round 1" "$REASON"
assert_contains "block reason includes gh pr diff instruction" "gh pr diff" "$REASON"

echo ""
echo "=== Passed review: stop allowed ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "passed"

# INVARIANT: When STATUS=passed, Claude can stop
# SUT: enforce-pr-review-stop.sh with passed state
OUTPUT=$(run_stop_hook "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stop allowed after review passed"
  ((PASS++))
else
  echo "  FAIL: stop blocked after review passed"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Escalated review: stop allowed ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "4" "escalated"

# INVARIANT: When STATUS=escalated, Claude can stop
# SUT: enforce-pr-review-stop.sh with escalated state
OUTPUT=$(run_stop_hook "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stop allowed after review escalated"
  ((PASS++))
else
  echo "  FAIL: stop blocked after review escalated"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Stop hook active (retry): still blocks if needs_review ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# INVARIANT: Even when stop_hook_active=true (retry), if review is still
# needed, the hook must still block. This is safe because Claude is forced
# to make a tool call (which PreToolUse will funnel to gh pr diff).
OUTPUT=$(run_stop_hook "true")
if is_blocked "$OUTPUT"; then
  echo "  PASS: retry still blocked when review pending"
  ((PASS++))
else
  echo "  FAIL: retry NOT blocked when review pending"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: other branch's review does not block stop ==="

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/55" "1" "needs_review" "wt/other-worktree-branch"

# INVARIANT: A needs_review state from a different branch does NOT block stop
# SUT: enforce-pr-review-stop.sh branch filtering via state-utils.sh
OUTPUT=$(run_stop_hook "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: other branch's needs_review does not block stop"
  ((PASS++))
else
  echo "  FAIL: other branch's needs_review is blocking stop"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Legacy state files (no BRANCH) do not block stop ==="

setup
local_file="$STATE_DIR/Garsson-io_nanoclaw_99"
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/99\nROUND=1\nSTATUS=needs_review\n' > "$local_file"

# INVARIANT: Legacy state files without BRANCH field are skipped
# SUT: enforce-pr-review-stop.sh via state-utils.sh
OUTPUT=$(run_stop_hook "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: legacy state file (no BRANCH) does not block stop"
  ((PASS++))
else
  echo "  FAIL: legacy state file (no BRANCH) is blocking stop"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Stale state files do not block stop ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/60" "1" "needs_review"
STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_60"
touch -d "3 hours ago" "$STATE_FILE" 2>/dev/null || touch -t "$(date -d '3 hours ago' +%Y%m%d%H%M.%S 2>/dev/null || date -v-3H +%Y%m%d%H%M.%S)" "$STATE_FILE" 2>/dev/null

# INVARIANT: State files older than MAX_STATE_AGE are treated as stale
# SUT: enforce-pr-review-stop.sh via state-utils.sh staleness check
OUTPUT=$(MAX_STATE_AGE=7200 run_stop_hook "false")
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stale state file does not block stop"
  ((PASS++))
else
  echo "  FAIL: stale state file is blocking stop"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Multiple PRs: blocks if ANY on current branch needs review ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/70" "2" "passed"
create_state "https://github.com/Garsson-io/garsson-prints/pull/5" "1" "needs_review"

# INVARIANT: If any PR on current branch has needs_review, stop is blocked
# SUT: enforce-pr-review-stop.sh with mixed states
OUTPUT=$(run_stop_hook "false")
if is_blocked "$OUTPUT"; then
  echo "  PASS: stop blocked when one of multiple PRs needs review"
  ((PASS++))
else
  echo "  FAIL: stop NOT blocked despite pending review on one PR"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

REASON=$(echo "$OUTPUT" | jq -r '.reason // empty')
assert_contains "block reason references the right PR" "garsson-prints/pull/5" "$REASON"

echo ""
echo "=== JSON output is valid ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "2" "needs_review"

# INVARIANT: Hook output is valid JSON with required fields
# SUT: enforce-pr-review-stop.sh JSON output format
OUTPUT=$(run_stop_hook "false")
DECISION=$(echo "$OUTPUT" | jq -r '.decision // empty')
REASON=$(echo "$OUTPUT" | jq -r '.reason // empty')

assert_eq "decision field is 'block'" "block" "$DECISION"
if [ -n "$REASON" ]; then
  echo "  PASS: reason field is non-empty"
  ((PASS++))
else
  echo "  FAIL: reason field is empty"
  ((FAIL++))
fi

teardown
rm -rf "$STOP_MOCK_DIR"

print_results
