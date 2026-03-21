#!/bin/bash
# Tests for waiver elimination enforcement in pr-kaizen-clear.sh (kaizen #198)
#
# INVARIANT UNDER TEST: "waived" disposition is rejected for ALL finding types.
# Impediments must be filed, incident-recorded, or fixed-in-pr.
# Non-friction observations must be reclassified as type "positive" with "no-action".
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../pr-kaizen-clear.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

# Helper: create PR kaizen state file
create_pr_kaizen_state() {
  local pr_url="$1"
  local branch="${2:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  local filename
  filename="pr-kaizen-$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "needs_pr_kaizen" "$branch" > "$STATE_DIR/$filename"
}

# Helper: run PostToolUse hook simulating a Bash command
run_posttool_bash() {
  local command="$1"
  local stdout="$2"
  local exit_code="${3:-0}"
  local input
  input=$(jq -n \
    --arg cmd "$command" \
    --arg out "$stdout" \
    --arg ec "$exit_code" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: ($ec | tonumber) }
  }')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: check if kaizen state file exists
has_pr_kaizen_state() {
  local count
  count=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l)
  [ "$count" -gt 0 ]
}

PR_URL="https://github.com/Garsson-io/nanoclaw/pull/42"

# ============================================================
# "waived" disposition is REJECTED for all types (kaizen #198)
# ============================================================

echo "=== Waived impediment is REJECTED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"stacked PR gate confusion\", \"disposition\": \"waived\", \"reason\": \"one-time issue\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "stacked PR gate confusion", "disposition": "waived", "reason": "one-time issue"}]')

if has_pr_kaizen_state; then
  echo "  PASS: waived impediment blocked"
  ((PASS++))
else
  echo "  FAIL: waived impediment incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions kaizen #198" "kaizen #198" "$OUTPUT"
assert_contains "mentions reclassify" "reclassify" "$OUTPUT"

echo ""
echo "=== Waived meta-finding is REJECTED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"kaizen system lacks self-audit\", \"type\": \"meta\", \"disposition\": \"waived\", \"reason\": \"addressed in separate session\", \"impact_minutes\": 2}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "kaizen system lacks self-audit", "type": "meta", "disposition": "waived", "reason": "addressed in separate session", "impact_minutes": 2}]')

if has_pr_kaizen_state; then
  echo "  PASS: waived meta-finding blocked"
  ((PASS++))
else
  echo "  FAIL: waived meta-finding incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions kaizen #198" "kaizen #198" "$OUTPUT"

echo ""
echo "=== Waived positive finding is REJECTED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"good pattern\", \"type\": \"positive\", \"disposition\": \"waived\", \"reason\": \"not important\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "good pattern", "type": "positive", "disposition": "waived", "reason": "not important"}]')

if has_pr_kaizen_state; then
  echo "  PASS: waived positive finding blocked"
  ((PASS++))
else
  echo "  FAIL: waived positive finding incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions kaizen #198" "kaizen #198" "$OUTPUT"

echo ""
echo "=== Mixed: filed + waived is REJECTED ==="

setup
create_pr_kaizen_state "$PR_URL"

MIXED_BAD='[
  {"impediment": "hook confusion", "disposition": "filed", "ref": "#280"},
  {"impediment": "state accumulation", "disposition": "waived", "reason": "cosmetic only"}
]'

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
$MIXED_BAD
IMPEDIMENTS" \
  "KAIZEN_IMPEDIMENTS:
$MIXED_BAD")

if has_pr_kaizen_state; then
  echo "  PASS: mixed filed + waived blocked"
  ((PASS++))
else
  echo "  FAIL: mixed filed + waived incorrectly cleared"
  ((FAIL++))
fi

# ============================================================
# Valid dispositions still work
# ============================================================

echo ""
echo "=== Filed impediment PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"hook confusion\", \"disposition\": \"filed\", \"ref\": \"#280\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "hook confusion", "disposition": "filed", "ref": "#280"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: filed impediment cleared gate"
  ((PASS++))
else
  echo "  FAIL: filed impediment did NOT clear gate"
  ((FAIL++))
fi

echo ""
echo "=== Incident impediment PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"hook confusion\", \"disposition\": \"incident\", \"ref\": \"#280\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "hook confusion", "disposition": "incident", "ref": "#280"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: incident impediment cleared gate"
  ((PASS++))
else
  echo "  FAIL: incident impediment did NOT clear gate"
  ((FAIL++))
fi

echo ""
echo "=== Fixed-in-pr impediment PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"build failure\", \"disposition\": \"fixed-in-pr\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "build failure", "disposition": "fixed-in-pr"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: fixed-in-pr impediment cleared gate"
  ((PASS++))
else
  echo "  FAIL: fixed-in-pr impediment did NOT clear gate"
  ((FAIL++))
fi

echo ""
echo "=== Positive no-action PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"test-first approach worked well\", \"type\": \"positive\", \"disposition\": \"no-action\", \"reason\": \"Already natural pattern, needs no reinforcement\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "test-first approach worked well", "type": "positive", "disposition": "no-action", "reason": "Already natural pattern, needs no reinforcement"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: positive no-action cleared gate"
  ((PASS++))
else
  echo "  FAIL: positive no-action did NOT clear gate"
  ((FAIL++))
fi

echo ""
echo "=== Meta-finding filed PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"kaizen gate friction\", \"type\": \"meta\", \"disposition\": \"filed\", \"ref\": \"#198\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "kaizen gate friction", "type": "meta", "disposition": "filed", "ref": "#198"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: meta-finding filed cleared gate"
  ((PASS++))
else
  echo "  FAIL: meta-finding filed did NOT clear gate"
  ((FAIL++))
fi

echo ""
echo "=== Meta-finding with no-action is REJECTED (must file or reclassify as positive) ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"test output verbose\", \"type\": \"meta\", \"disposition\": \"no-action\", \"reason\": \"cosmetic\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "test output verbose", "type": "meta", "disposition": "no-action", "reason": "cosmetic"}]')

if has_pr_kaizen_state; then
  echo "  PASS: meta-finding no-action blocked (must file or reclassify)"
  ((PASS++))
else
  echo "  FAIL: meta-finding no-action incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== Impediment with no-action is REJECTED (not a valid disposition for impediments) ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"slow build\", \"disposition\": \"no-action\", \"reason\": \"one-time occurrence\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "slow build", "disposition": "no-action", "reason": "one-time occurrence"}]')

if has_pr_kaizen_state; then
  echo "  PASS: impediment with no-action blocked"
  ((PASS++))
else
  echo "  FAIL: impediment with no-action incorrectly cleared gate"
  ((FAIL++))
fi

# ============================================================
# Error message quality
# ============================================================

echo ""
echo "=== Rejection message provides reclassification guidance ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"test thing\", \"disposition\": \"waived\", \"reason\": \"cosmetic\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "test thing", "disposition": "waived", "reason": "cosmetic"}]')

assert_contains "mentions filing as alternative" "gh issue create" "$OUTPUT"
assert_contains "mentions positive reclassification" "positive" "$OUTPUT"
assert_contains "mentions no-action" "no-action" "$OUTPUT"

echo ""
echo "=== Mixed: filed + positive no-action PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

MIXED_GOOD='[
  {"impediment": "hook confusion", "disposition": "filed", "ref": "#280"},
  {"finding": "cosmetic log noise", "type": "positive", "disposition": "no-action", "reason": "purely visual, no time impact"}
]'

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
$MIXED_GOOD
IMPEDIMENTS" \
  "KAIZEN_IMPEDIMENTS:
$MIXED_GOOD")

if ! has_pr_kaizen_state; then
  echo "  PASS: mixed filed + positive no-action cleared gate"
  ((PASS++))
else
  echo "  FAIL: mixed filed + positive no-action did NOT clear gate"
  ((FAIL++))
fi

# ============================================================
# Done
# ============================================================

cleanup_test_env
print_results
