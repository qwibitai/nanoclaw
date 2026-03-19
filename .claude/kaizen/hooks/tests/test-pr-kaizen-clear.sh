#!/bin/bash
# Tests for pr-kaizen-clear.sh — PostToolUse hook that clears the PR
# creation kaizen gate when the agent submits structured impediments.
#
# INVARIANT UNDER TEST: The PR kaizen gate (needs_pr_kaizen) is cleared
# only when the agent submits a valid KAIZEN_IMPEDIMENTS JSON declaration
# covering all identified impediments with proper dispositions.
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

echo "=== Valid KAIZEN_IMPEDIMENTS with filed disposition clears gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: A valid structured impediment declaration clears the gate
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"IPC case creation fragile\", \"disposition\": \"filed\", \"ref\": \"#112\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "IPC case creation fragile", "disposition": "filed", "ref": "#112"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: valid KAIZEN_IMPEDIMENTS cleared gate"
  ((PASS++))
else
  echo "  FAIL: valid KAIZEN_IMPEDIMENTS did NOT clear gate"
  ((FAIL++))
fi
assert_contains "output mentions gate cleared" "gate cleared" "$OUTPUT"
assert_contains "output mentions impediment count" "1 impediment" "$OUTPUT"

echo ""
echo "=== Empty array with reason clears gate (kaizen #140) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Empty array with reason is valid — genuinely no impediments
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix'" \
  "KAIZEN_IMPEDIMENTS: [] straightforward bug fix")

if ! has_pr_kaizen_state; then
  echo "  PASS: empty KAIZEN_IMPEDIMENTS with reason cleared gate"
  ((PASS++))
else
  echo "  FAIL: empty KAIZEN_IMPEDIMENTS with reason did NOT clear gate"
  ((FAIL++))
fi
assert_contains "output mentions no impediments" "no impediments" "$OUTPUT"

echo ""
echo "=== Empty array WITHOUT reason does NOT clear gate (kaizen #140) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Empty array without reason is rejected — forces justification
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS: []'" \
  "KAIZEN_IMPEDIMENTS: []")

if has_pr_kaizen_state; then
  echo "  PASS: empty KAIZEN_IMPEDIMENTS without reason blocked"
  ((PASS++))
else
  echo "  FAIL: empty KAIZEN_IMPEDIMENTS without reason incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "output mentions reason required" "requires a reason" "$OUTPUT"

echo ""
echo "=== Multiple impediments with mixed dispositions clears gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: All valid dispositions are accepted
MULTI_JSON='[
  {"impediment": "slow CI", "disposition": "filed", "ref": "#200"},
  {"impediment": "hook confusion", "disposition": "incident", "ref": "#125"},
  {"impediment": "typo in docs", "disposition": "fixed-in-pr"},
  {"impediment": "minor lint warning", "disposition": "waived", "reason": "one-time occurrence"}
]'
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
$MULTI_JSON
IMPEDIMENTS" \
  "KAIZEN_IMPEDIMENTS:
$MULTI_JSON")

if ! has_pr_kaizen_state; then
  echo "  PASS: multi-impediment declaration cleared gate"
  ((PASS++))
else
  echo "  FAIL: multi-impediment declaration did NOT clear gate"
  ((FAIL++))
fi
assert_contains "output mentions 4 impediments" "4 impediment" "$OUTPUT"

echo ""
echo "=== Invalid JSON does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Malformed JSON is rejected
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS: not valid json'" \
  "KAIZEN_IMPEDIMENTS: not valid json")

if has_pr_kaizen_state; then
  echo "  PASS: invalid JSON did not clear gate"
  ((PASS++))
else
  echo "  FAIL: invalid JSON incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "output mentions invalid JSON" "Invalid JSON" "$OUTPUT"

echo ""
echo "=== Missing impediment field does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Entries without "impediment" field are rejected
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && echo '[{\"disposition\": \"filed\", \"ref\": \"#99\"}]'" \
  'KAIZEN_IMPEDIMENTS:
[{"disposition": "filed", "ref": "#99"}]')

if has_pr_kaizen_state; then
  echo "  PASS: missing impediment field rejected"
  ((PASS++))
else
  echo "  FAIL: missing impediment field incorrectly accepted"
  ((FAIL++))
fi
assert_contains "output mentions missing impediment" "missing" "$OUTPUT"

echo ""
echo "=== Missing disposition field does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Entries without "disposition" field are rejected
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && echo '[{\"impediment\": \"slow CI\"}]'" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "slow CI"}]')

if has_pr_kaizen_state; then
  echo "  PASS: missing disposition field rejected"
  ((PASS++))
else
  echo "  FAIL: missing disposition field incorrectly accepted"
  ((FAIL++))
fi
assert_contains "output mentions missing disposition" "missing" "$OUTPUT"

echo ""
echo "=== Invalid disposition value does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Only filed|incident|fixed-in-pr|waived are valid dispositions
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && echo '[{\"impediment\": \"slow CI\", \"disposition\": \"ignored\"}]'" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "slow CI", "disposition": "ignored"}]')

if has_pr_kaizen_state; then
  echo "  PASS: invalid disposition value rejected"
  ((PASS++))
else
  echo "  FAIL: invalid disposition value incorrectly accepted"
  ((FAIL++))
fi
assert_contains "output mentions invalid disposition" "invalid disposition" "$OUTPUT"

echo ""
echo "=== filed without ref does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: disposition "filed" requires a "ref" field
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && echo '[{\"impediment\": \"slow CI\", \"disposition\": \"filed\"}]'" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "slow CI", "disposition": "filed"}]')

if has_pr_kaizen_state; then
  echo "  PASS: filed without ref rejected"
  ((PASS++))
else
  echo "  FAIL: filed without ref incorrectly accepted"
  ((FAIL++))
fi
assert_contains "output mentions ref required" "requires" "$OUTPUT"

echo ""
echo "=== incident without ref does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: disposition "incident" requires a "ref" field
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && echo '[{\"impediment\": \"hook confusion\", \"disposition\": \"incident\"}]'" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "hook confusion", "disposition": "incident"}]')

if has_pr_kaizen_state; then
  echo "  PASS: incident without ref rejected"
  ((PASS++))
else
  echo "  FAIL: incident without ref incorrectly accepted"
  ((FAIL++))
fi
assert_contains "output mentions ref required" "requires" "$OUTPUT"

echo ""
echo "=== waived without reason does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: disposition "waived" requires a "reason" field
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && echo '[{\"impediment\": \"minor thing\", \"disposition\": \"waived\"}]'" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "minor thing", "disposition": "waived"}]')

if has_pr_kaizen_state; then
  echo "  PASS: waived without reason rejected"
  ((PASS++))
else
  echo "  FAIL: waived without reason incorrectly accepted"
  ((FAIL++))
fi
assert_contains "output mentions reason required" "requires" "$OUTPUT"

echo ""
echo "=== fixed-in-pr needs no extra fields ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: fixed-in-pr only requires impediment + disposition
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && echo '[{\"impediment\": \"typo\", \"disposition\": \"fixed-in-pr\"}]'" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "typo", "disposition": "fixed-in-pr"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: fixed-in-pr with no extra fields cleared gate"
  ((PASS++))
else
  echo "  FAIL: fixed-in-pr with no extra fields did NOT clear gate"
  ((FAIL++))
fi

echo ""
echo "=== KAIZEN_NO_ACTION with valid category clears gate (kaizen #140) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: KAIZEN_NO_ACTION with valid category and reason clears gate
OUTPUT=$(run_posttool_bash \
  'echo "KAIZEN_NO_ACTION [docs-only]: updated README formatting"' \
  "KAIZEN_NO_ACTION [docs-only]: updated README formatting")

if ! has_pr_kaizen_state; then
  echo "  PASS: KAIZEN_NO_ACTION [docs-only] cleared gate"
  ((PASS++))
else
  echo "  FAIL: KAIZEN_NO_ACTION [docs-only] did NOT clear gate"
  ((FAIL++))
fi
assert_contains "output mentions no action needed" "no action needed" "$OUTPUT"

echo ""
echo "=== KAIZEN_NO_ACTION without category does NOT clear gate (kaizen #140) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Legacy format (no category) is no longer accepted
OUTPUT=$(run_posttool_bash \
  'echo "KAIZEN_NO_ACTION: straightforward config change"' \
  "KAIZEN_NO_ACTION: straightforward config change")

if has_pr_kaizen_state; then
  echo "  PASS: KAIZEN_NO_ACTION without category blocked"
  ((PASS++))
else
  echo "  FAIL: KAIZEN_NO_ACTION without category incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "output mentions missing category" "Missing category" "$OUTPUT"

echo ""
echo "=== KAIZEN_NO_ACTION with invalid category does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Only valid categories are accepted
OUTPUT=$(run_posttool_bash \
  'echo "KAIZEN_NO_ACTION [bugfix]: fixed a minor bug"' \
  "KAIZEN_NO_ACTION [bugfix]: fixed a minor bug")

if has_pr_kaizen_state; then
  echo "  PASS: KAIZEN_NO_ACTION with invalid category blocked"
  ((PASS++))
else
  echo "  FAIL: KAIZEN_NO_ACTION with invalid category incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "output mentions invalid category" "Invalid category" "$OUTPUT"

echo ""
echo "=== KAIZEN_NO_ACTION with category but no reason does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: A reason must be provided even with valid category
OUTPUT=$(run_posttool_bash \
  'echo "KAIZEN_NO_ACTION [typo]:"' \
  "KAIZEN_NO_ACTION [typo]:")

if has_pr_kaizen_state; then
  echo "  PASS: KAIZEN_NO_ACTION with no reason blocked"
  ((PASS++))
else
  echo "  FAIL: KAIZEN_NO_ACTION with no reason incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "output mentions missing reason" "Missing reason" "$OUTPUT"

echo ""
echo "=== All valid KAIZEN_NO_ACTION categories accepted ==="

for category in docs-only formatting typo config-only test-only trivial-refactor; do
  setup
  create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

  OUTPUT=$(run_posttool_bash \
    "echo \"KAIZEN_NO_ACTION [$category]: test reason\"" \
    "KAIZEN_NO_ACTION [$category]: test reason")

  if ! has_pr_kaizen_state; then
    echo "  PASS: KAIZEN_NO_ACTION [$category] accepted"
    ((PASS++))
  else
    echo "  FAIL: KAIZEN_NO_ACTION [$category] rejected"
    ((FAIL++))
  fi
done

echo ""
echo "=== Audit log is written for no-action declarations ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# The hook resolves audit log relative to its own location
# HOOK is set at top of file: "$(dirname "$0")/../pr-kaizen-clear.sh"
HOOK_REAL_DIR="$(cd "$(dirname "$HOOK")" && pwd)"
TEST_AUDIT_LOG="${HOOK_REAL_DIR}/../audit/no-action.log"
rm -f "$TEST_AUDIT_LOG"

OUTPUT=$(run_posttool_bash \
  'echo "KAIZEN_NO_ACTION [typo]: fixed spelling in comment"' \
  "KAIZEN_NO_ACTION [typo]: fixed spelling in comment")

if [ -f "$TEST_AUDIT_LOG" ]; then
  AUDIT_CONTENT=$(cat "$TEST_AUDIT_LOG")
  if echo "$AUDIT_CONTENT" | grep -q "category=typo"; then
    echo "  PASS: audit log written with category"
    ((PASS++))
  else
    echo "  FAIL: audit log missing category"
    echo "    content: $AUDIT_CONTENT"
    ((FAIL++))
  fi
  if echo "$AUDIT_CONTENT" | grep -q "fixed spelling in comment"; then
    echo "  PASS: audit log written with reason"
    ((PASS++))
  else
    echo "  FAIL: audit log missing reason"
    echo "    content: $AUDIT_CONTENT"
    ((FAIL++))
  fi
else
  echo "  FAIL: audit log file not created"
  echo "    expected at: $TEST_AUDIT_LOG"
  ((FAIL++))
  ((FAIL++))
fi
# Clean up audit log after test
rm -f "$TEST_AUDIT_LOG"
rmdir "$(dirname "$TEST_AUDIT_LOG")" 2>/dev/null || true

echo ""
echo "=== gh issue create alone does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: gh issue create is allowed (by enforce-pr-kaizen) but does not
# clear the gate — agent must submit KAIZEN_IMPEDIMENTS afterward
OUTPUT=$(run_posttool_bash \
  "gh issue create --repo Garsson-io/kaizen --title 'improve X' --body 'details'" \
  "https://github.com/Garsson-io/kaizen/issues/99")

if has_pr_kaizen_state; then
  echo "  PASS: gh issue create alone did not clear gate"
  ((PASS++))
else
  echo "  FAIL: gh issue create alone incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== Failed command does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Failed commands never clear the gate
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS: []'" \
  "KAIZEN_IMPEDIMENTS: []" \
  "1")

if has_pr_kaizen_state; then
  echo "  PASS: failed command did not clear gate"
  ((PASS++))
else
  echo "  FAIL: failed command incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== Unrelated commands do NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Non-kaizen commands do not affect the gate
OUTPUT=$(run_posttool_bash "npm run build" "build complete")
if has_pr_kaizen_state; then
  echo "  PASS: npm run build did not clear gate"
  ((PASS++))
else
  echo "  FAIL: npm run build incorrectly cleared gate"
  ((FAIL++))
fi

OUTPUT=$(run_posttool_bash "git status" "nothing to commit")
if has_pr_kaizen_state; then
  echo "  PASS: git status did not clear gate"
  ((PASS++))
else
  echo "  FAIL: git status incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== No pending state: hook is a no-op ==="

setup

# INVARIANT: Without pending state, no output or side effects
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS: []'" \
  "KAIZEN_IMPEDIMENTS: []")
assert_eq "no pending state, no output" "" "$OUTPUT"

echo ""
echo "=== Non-Bash tool calls are ignored ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Non-Bash tool calls don't affect state
INPUT_EDIT=$(jq -n '{
  tool_name: "Edit",
  tool_input: { file_path: "/test.ts" },
  tool_response: {}
}')
OUTPUT=$(echo "$INPUT_EDIT" | bash "$HOOK" 2>/dev/null)
if has_pr_kaizen_state; then
  echo "  PASS: Edit tool call did not clear gate"
  ((PASS++))
else
  echo "  FAIL: Edit tool call incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: only clears own branch ==="

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42" "wt/other-branch"
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/43" "$CURRENT_BRANCH"

# INVARIANT: Clearing only affects state for the current branch
OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS: [] cross-worktree test'" \
  "KAIZEN_IMPEDIMENTS: [] cross-worktree test")

# PR 42 (other branch) should still exist
if [ -f "$STATE_DIR/pr-kaizen-Garsson-io_nanoclaw_42" ]; then
  echo "  PASS: other branch's kaizen state preserved"
  ((PASS++))
else
  echo "  FAIL: other branch's kaizen state was cleared"
  ((FAIL++))
fi

# PR 43 (our branch) should be cleared
if [ ! -f "$STATE_DIR/pr-kaizen-Garsson-io_nanoclaw_43" ]; then
  echo "  PASS: own branch's kaizen state cleared"
  ((PASS++))
else
  echo "  FAIL: own branch's kaizen state NOT cleared"
  ((FAIL++))
fi

teardown
print_results
