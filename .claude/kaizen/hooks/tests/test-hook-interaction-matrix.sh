#!/bin/bash
# Hook Interaction Matrix Tests (kaizen #163)
#
# INVARIANT UNDER TEST: Hook gates, allowlists, and clear mechanisms are
# mutually consistent — commands allowed by a gate's allowlist actually work
# with the corresponding clear hook, and format expectations match across
# the PreToolUse gate and PostToolUse clear boundaries.
#
# These tests catch the category of bug where individual hooks pass their
# unit tests but the interaction between them creates deadlocks:
# - Format mismatches (#159): gate allows format X, clear expects format Y
# - Allowlist gaps (#150, #151): legitimate workflow commands blocked by gate
# - Gate/clear coupling (#125): clear hook format doesn't match gate allowlist
#
# Test structure: For each gate→clear pair, verify:
# 1. Gate blocks when active (sanity)
# 2. Every allowed command passes through the gate
# 3. Every clear format that the clear hook accepts is also allowed by the gate
# 4. The full lifecycle works: gate active → clear command → gate released

source "$(dirname "$0")/test-helpers.sh"

HOOKS_DIR="$(dirname "$0")/.."
ENFORCE_PR_KAIZEN="$HOOKS_DIR/enforce-pr-kaizen.sh"
PR_KAIZEN_CLEAR="$HOOKS_DIR/pr-kaizen-clear.sh"
ENFORCE_PR_REVIEW="$HOOKS_DIR/enforce-pr-review.sh"
ENFORCE_PR_REVIEW_TOOLS="$HOOKS_DIR/enforce-pr-review-tools.sh"
PR_REVIEW_LOOP="$HOOKS_DIR/pr-review-loop.sh"

setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

# Helper: create PR kaizen state
create_pr_kaizen_state() {
  local pr_url="$1"
  local branch="${2:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  local filename
  filename="pr-kaizen-$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "needs_pr_kaizen" "$branch" > "$STATE_DIR/$filename"
}

# Helper: run PreToolUse hook with a Bash command
run_pretool_bash() {
  local hook="$1"
  local command="$2"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | bash "$hook" 2>/dev/null
}

# Helper: run PreToolUse hook with a tool (non-Bash)
# Usage: run_pretool_tool hook tool_name [tool_input_json]
run_pretool_tool() {
  local hook="$1"
  local tool_name="$2"
  local tool_input_json="${3:-}"
  local input
  if [ -n "$tool_input_json" ]; then
    input=$(jq -n --arg tool "$tool_name" --argjson ti "$tool_input_json" '{tool_name: $tool, tool_input: $ti}')
  else
    input=$(jq -n --arg tool "$tool_name" '{tool_name: $tool, tool_input: {}}')
  fi
  echo "$input" | bash "$hook" 2>/dev/null
}

# Helper: run PostToolUse hook simulating a successful Bash command
run_posttool_bash() {
  local hook="$1"
  local command="$2"
  local stdout="${3:-}"
  local input
  input=$(jq -n \
    --arg cmd "$command" \
    --arg out "$stdout" \
    '{
      tool_name: "Bash",
      tool_input: {command: $cmd},
      tool_response: {stdout: $out, exit_code: "0"}
    }')
  echo "$input" | bash "$hook" 2>/dev/null
}

# ================================================================
# INTERACTION PAIR 1: enforce-pr-kaizen ↔ pr-kaizen-clear
# Gate: enforce-pr-kaizen.sh (PreToolUse/Bash)
# Clear: pr-kaizen-clear.sh (PostToolUse/Bash)
# ================================================================

echo "=== PAIR 1: Kaizen gate ↔ Kaizen clear ==="
echo ""

echo "--- 1a: KAIZEN_NO_ACTION bracketed format consistency (#159) ---"
# INVARIANT: The format pr-kaizen-clear.sh expects must pass through enforce-pr-kaizen.sh
# This was the exact bug in #159: gate allowed KAIZEN_NO_ACTION: but clear expected [category]:

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# The bracketed format that pr-kaizen-clear.sh validates
BRACKETED_CMD="echo 'KAIZEN_NO_ACTION [docs-only]: updated README'"
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "$BRACKETED_CMD")
assert_eq "bracketed KAIZEN_NO_ACTION passes gate" "" "$OUTPUT"

# Now verify the clear hook actually clears on this format
OUTPUT=$(run_posttool_bash "$PR_KAIZEN_CLEAR" "$BRACKETED_CMD" "KAIZEN_NO_ACTION [docs-only]: updated README")
assert_contains "bracketed KAIZEN_NO_ACTION clears gate" "gate cleared" "$OUTPUT"

echo ""
echo "--- 1b: All KAIZEN_NO_ACTION categories pass gate AND clear it ---"

for category in docs-only formatting typo config-only test-only trivial-refactor; do
  setup
  create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

  CMD="echo 'KAIZEN_NO_ACTION [$category]: test reason'"
  STDOUT_TEXT="KAIZEN_NO_ACTION [$category]: test reason"

  # Must pass gate
  OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "$CMD")
  assert_eq "KAIZEN_NO_ACTION [$category] passes gate" "" "$OUTPUT"

  # Must clear gate
  OUTPUT=$(run_posttool_bash "$PR_KAIZEN_CLEAR" "$CMD" "$STDOUT_TEXT")
  assert_contains "KAIZEN_NO_ACTION [$category] clears gate" "gate cleared" "$OUTPUT"
done

echo ""
echo "--- 1c: KAIZEN_IMPEDIMENTS format consistency ---"

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# Empty array with reason — must pass gate AND clear it
IMPEDIMENTS_CMD="echo 'KAIZEN_IMPEDIMENTS: [] straightforward fix'"
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "$IMPEDIMENTS_CMD")
assert_eq "KAIZEN_IMPEDIMENTS empty array passes gate" "" "$OUTPUT"

OUTPUT=$(run_posttool_bash "$PR_KAIZEN_CLEAR" "$IMPEDIMENTS_CMD" "KAIZEN_IMPEDIMENTS: [] straightforward fix")
assert_contains "KAIZEN_IMPEDIMENTS empty array clears gate" "gate cleared" "$OUTPUT"

echo ""
echo "--- 1d: Full impediments JSON — gate pass + clear ---"

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# Structured impediments — the full format
FULL_CMD='echo '\''KAIZEN_IMPEDIMENTS:'\'' && cat <<'\''IMPEDIMENTS'\''
[{"impediment": "hook allowlist gap", "disposition": "filed", "ref": "#163"}]
IMPEDIMENTS'
FULL_STDOUT='KAIZEN_IMPEDIMENTS:
[{"impediment": "hook allowlist gap", "disposition": "filed", "ref": "#163"}]'

OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "$FULL_CMD")
assert_eq "full KAIZEN_IMPEDIMENTS passes gate" "" "$OUTPUT"

OUTPUT=$(run_posttool_bash "$PR_KAIZEN_CLEAR" "$FULL_CMD" "$FULL_STDOUT")
assert_contains "full KAIZEN_IMPEDIMENTS clears gate" "gate cleared" "$OUTPUT"

echo ""
echo "--- 1e: gh issue list/search allowed during kaizen gate (#150) ---"

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# These are needed for searching duplicates before filing new issues
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "gh issue list --repo Garsson-io/kaizen --limit 20")
assert_eq "gh issue list passes kaizen gate" "" "$OUTPUT"

OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "gh issue search --repo Garsson-io/kaizen 'hook'")
assert_eq "gh issue search passes kaizen gate" "" "$OUTPUT"

OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "gh issue view 42 --repo Garsson-io/kaizen")
assert_eq "gh issue view passes kaizen gate" "" "$OUTPUT"

# But gh issue edit/close should still be blocked (not read-only)
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "gh issue close 42 --repo Garsson-io/kaizen")
if is_denied "$OUTPUT"; then
  echo "  PASS: gh issue close blocked during kaizen gate"
  ((PASS++))
else
  echo "  FAIL: gh issue close NOT blocked during kaizen gate"
  ((FAIL++))
fi

echo ""
echo "--- 1f: Full lifecycle — gate → reflection → clear → unblocked ---"

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# Step 1: Verify gate is blocking
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "npm run build")
if is_denied "$OUTPUT"; then
  echo "  PASS: lifecycle: npm build blocked before reflection"
  ((PASS++))
else
  echo "  FAIL: lifecycle: npm build NOT blocked before reflection"
  ((FAIL++))
fi

# Step 2: Search for duplicates (allowed)
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "gh issue list --repo Garsson-io/kaizen --limit 50")
assert_eq "lifecycle: issue search allowed during gate" "" "$OUTPUT"

# Step 3: File impediments (allowed + clears)
CLEAR_CMD="echo 'KAIZEN_IMPEDIMENTS: [] no process issues'"
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "$CLEAR_CMD")
assert_eq "lifecycle: impediments declaration allowed" "" "$OUTPUT"

run_posttool_bash "$PR_KAIZEN_CLEAR" "$CLEAR_CMD" "KAIZEN_IMPEDIMENTS: [] no process issues" >/dev/null

# Step 4: Gate should now be cleared
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "npm run build")
assert_eq "lifecycle: npm build allowed after gate cleared" "" "$OUTPUT"

# ================================================================
# INTERACTION PAIR 2: enforce-pr-review + enforce-pr-review-tools
# Gate: enforce-pr-review.sh (PreToolUse/Bash) + enforce-pr-review-tools.sh (PreToolUse/Edit|Write|Agent)
# Clear: pr-review-loop.sh (PostToolUse/Bash) via gh pr diff
# ================================================================

echo ""
echo "=== PAIR 2: PR review gate ↔ Review tools gate ==="
echo ""

echo "--- 2a: Agent(kaizen-bg) allowed during PR review (#151) ---"

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# kaizen-bg background agent should be allowed
OUTPUT=$(run_pretool_tool "$ENFORCE_PR_REVIEW_TOOLS" "Agent" '{"subagent_type":"kaizen-bg","run_in_background":true,"prompt":"reflect on impediments","description":"kaizen reflection"}')
assert_eq "Agent(kaizen-bg, bg=true) passes review gate" "" "$OUTPUT"

# But regular Agent should still be blocked
OUTPUT=$(run_pretool_tool "$ENFORCE_PR_REVIEW_TOOLS" "Agent" '{"prompt":"do something","description":"general work"}')
if is_denied "$OUTPUT"; then
  echo "  PASS: regular Agent blocked during review"
  ((PASS++))
else
  echo "  FAIL: regular Agent NOT blocked during review"
  ((FAIL++))
fi

# Agent(kaizen-bg) in foreground is also allowed — kaizen-bg is always exempt
OUTPUT=$(run_pretool_tool "$ENFORCE_PR_REVIEW_TOOLS" "Agent" '{"subagent_type":"kaizen-bg","run_in_background":false,"prompt":"reflect","description":"kaizen"}')
assert_eq "Agent(kaizen-bg, fg) passes review gate" "" "$OUTPUT"

echo ""
echo "--- 2b: Bash review commands allowed by enforce-pr-review ---"

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# All review commands should pass through enforce-pr-review
for cmd in \
  "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/42" \
  "gh pr view https://github.com/Garsson-io/nanoclaw/pull/42" \
  "gh pr comment https://github.com/Garsson-io/nanoclaw/pull/42 --body 'LGTM'" \
  "gh api repos/Garsson-io/nanoclaw/pulls/42" \
  "gh run view 12345 --repo Garsson-io/nanoclaw" \
  "git diff HEAD~1" \
  "git log --oneline -5" \
  "git status" \
  "ls -la" \
  "cat README.md"; do
  OUTPUT=$(run_pretool_bash "$ENFORCE_PR_REVIEW" "$cmd")
  assert_eq "review gate allows: $(echo "$cmd" | cut -c1-50)" "" "$OUTPUT"
done

# Non-review commands should be blocked
for cmd in \
  "npm run build" \
  "git commit -m 'test'" \
  "gh pr merge 42" \
  "npm install"; do
  OUTPUT=$(run_pretool_bash "$ENFORCE_PR_REVIEW" "$cmd")
  if is_denied "$OUTPUT"; then
    echo "  PASS: review gate blocks: $(echo "$cmd" | cut -c1-50)"
    ((PASS++))
  else
    echo "  FAIL: review gate does NOT block: $(echo "$cmd" | cut -c1-50)"
    ((FAIL++))
  fi
done

echo ""
echo "--- 2c: Review gate + tools gate consistency ---"

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# When review is active, Edit/Write should be blocked by tools gate
for tool in Edit Write; do
  OUTPUT=$(run_pretool_tool "$ENFORCE_PR_REVIEW_TOOLS" "$tool" '{"file_path":"/some/file.ts"}')
  if is_denied "$OUTPUT"; then
    echo "  PASS: $tool blocked during review (tools gate)"
    ((PASS++))
  else
    echo "  FAIL: $tool NOT blocked during review (tools gate)"
    ((FAIL++))
  fi
done

# When review is passed, both gates should allow
setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "passed"

OUTPUT=$(run_pretool_bash "$ENFORCE_PR_REVIEW" "npm run build")
assert_eq "bash allowed after review passed" "" "$OUTPUT"

OUTPUT=$(run_pretool_tool "$ENFORCE_PR_REVIEW_TOOLS" "Edit" '{"file_path":"/some/file.ts"}')
assert_eq "Edit allowed after review passed" "" "$OUTPUT"

# ================================================================
# INTERACTION PAIR 3: Kaizen gate + Review gate coexistence
# Both gates can be active simultaneously — verify no deadlocks
# ================================================================

echo ""
echo "=== PAIR 3: Simultaneous gates — no deadlocks ==="
echo ""

echo "--- 3a: Both review and kaizen gates active ---"

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# Review commands should still pass through review gate
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_REVIEW" "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/42")
assert_eq "dual gates: gh pr diff passes review gate" "" "$OUTPUT"

# Kaizen commands should still pass through kaizen gate
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "gh issue create --repo Garsson-io/kaizen --title 'test'")
assert_eq "dual gates: gh issue create passes kaizen gate" "" "$OUTPUT"

# Non-kaizen and non-review commands should be blocked by BOTH
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_REVIEW" "npm run build")
if is_denied "$OUTPUT"; then
  echo "  PASS: dual gates: npm build blocked by review gate"
  ((PASS++))
else
  echo "  FAIL: dual gates: npm build NOT blocked by review gate"
  ((FAIL++))
fi

OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "npm run build")
if is_denied "$OUTPUT"; then
  echo "  PASS: dual gates: npm build blocked by kaizen gate"
  ((PASS++))
else
  echo "  FAIL: dual gates: npm build NOT blocked by kaizen gate"
  ((FAIL++))
fi

echo ""
echo "--- 3b: Clearing one gate doesn't affect the other ---"

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# Clear kaizen gate
CLEAR_CMD="echo 'KAIZEN_IMPEDIMENTS: [] no issues'"
run_posttool_bash "$PR_KAIZEN_CLEAR" "$CLEAR_CMD" "KAIZEN_IMPEDIMENTS: [] no issues" >/dev/null

# Kaizen gate should be cleared
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "npm run build")
assert_eq "kaizen gate cleared, npm allowed" "" "$OUTPUT"

# Review gate should STILL be active
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_REVIEW" "npm run build")
if is_denied "$OUTPUT"; then
  echo "  PASS: review gate still active after kaizen cleared"
  ((PASS++))
else
  echo "  FAIL: review gate NOT active after kaizen cleared"
  ((FAIL++))
fi

# ================================================================
# INTERACTION PAIR 4: Cross-worktree gate clearing (kaizen #239)
# State created on branch A, cleared from branch B
# ================================================================

echo ""
echo "=== PAIR 4: Cross-worktree kaizen gate lifecycle (#239) ==="
echo ""

echo "--- 4a: State on different branch — gate still blocks (correct) ---"

setup
# State created on a different branch
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/50" "wt/other-worktree"

# PreToolUse gate uses branch-scoped lookup — should NOT find cross-branch state
# (enforcement hooks must be branch-scoped to prevent cross-worktree contamination)
OUTPUT=$(run_pretool_bash "$ENFORCE_PR_KAIZEN" "npm run build")
assert_eq "cross-wt: non-kaizen cmd allowed when gate is on other branch" "" "$OUTPUT"

echo ""
echo "--- 4b: Cross-branch KAIZEN_IMPEDIMENTS declaration clears gate (#239) ---"

setup
# State was created on branch wt/other but we are on current branch
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/50" "wt/other-worktree"

# PostToolUse (pr-kaizen-clear) uses cross-branch lookup — should find and clear
CLEAR_CMD="echo 'KAIZEN_IMPEDIMENTS: [] no process issues'"
OUTPUT=$(run_posttool_bash "$PR_KAIZEN_CLEAR" "$CLEAR_CMD" "KAIZEN_IMPEDIMENTS: [] no process issues")
assert_contains "cross-wt: KAIZEN_IMPEDIMENTS clears gate from different branch" "gate cleared" "$OUTPUT"

# Verify state file was actually removed
REMAINING=$(ls "$STATE_DIR"/ 2>/dev/null | wc -l)
REMAINING=$(echo "$REMAINING" | tr -d ' ')
assert_eq "cross-wt: state file removed after cross-branch clear" "0" "$REMAINING"

echo ""
echo "--- 4c: Cross-branch KAIZEN_NO_ACTION declaration clears gate (#239) ---"

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/51" "wt/another-wt"

NO_ACTION_CMD="echo 'KAIZEN_NO_ACTION [docs-only]: README update'"
OUTPUT=$(run_posttool_bash "$PR_KAIZEN_CLEAR" "$NO_ACTION_CMD" "KAIZEN_NO_ACTION [docs-only]: README update")
assert_contains "cross-wt: KAIZEN_NO_ACTION clears gate from different branch" "gate cleared" "$OUTPUT"

echo ""
echo "--- 4d: Full cross-worktree lifecycle ---"

setup
# Step 1: State created on different branch (simulates PR created in worktree A)
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/52" "wt/worktree-a"

# Step 2: Clear from current branch using empty array (simulates reflection in worktree B)
CLEAR_CMD="echo 'KAIZEN_IMPEDIMENTS: [] cross-worktree lifecycle test'"
CLEAR_STDOUT="KAIZEN_IMPEDIMENTS: [] cross-worktree lifecycle test"
OUTPUT=$(run_posttool_bash "$PR_KAIZEN_CLEAR" "$CLEAR_CMD" "$CLEAR_STDOUT")
assert_contains "cross-wt lifecycle: gate cleared" "gate cleared" "$OUTPUT"

# Step 3: Verify no orphaned state
REMAINING=$(ls "$STATE_DIR"/ 2>/dev/null | wc -l)
REMAINING=$(echo "$REMAINING" | tr -d ' ')
assert_eq "cross-wt lifecycle: no orphaned state files" "0" "$REMAINING"

# ================================================================
# INTERACTION PAIR 5: Auto-close kaizen issues on merge (#283)
# ================================================================

echo ""
echo "=== PAIR 5: Auto-close kaizen issues on merge (#283) ==="
echo ""

echo "--- 5a: auto_close_kaizen_issues extracts refs from PR body ---"

setup
# Create a mock gh that simulates a merged PR with kaizen issue refs
AUTOCLOSE_MOCK_DIR=$(mktemp -d)
cat > "$AUTOCLOSE_MOCK_DIR/gh" << 'MOCK_GH'
#!/bin/bash
if echo "$@" | grep -q "pr view.*--json state"; then
  echo "MERGED"
  exit 0
fi
if echo "$@" | grep -q "pr view.*--json body"; then
  echo "Closes https://github.com/Garsson-io/kaizen/issues/99"
  exit 0
fi
if echo "$@" | grep -q "issue view.*--json state"; then
  echo "OPEN"
  exit 0
fi
if echo "$@" | grep -q "issue close"; then
  echo "closed"
  exit 0
fi
echo "OPEN"
exit 0
MOCK_GH
chmod +x "$AUTOCLOSE_MOCK_DIR/gh"

OUTPUT=$(PATH="$AUTOCLOSE_MOCK_DIR:$PATH" auto_close_kaizen_issues "https://github.com/Garsson-io/nanoclaw/pull/42")
assert_contains "auto-close: closed referenced kaizen issue" "Auto-closed" "$OUTPUT"

echo ""
echo "--- 5b: auto_close_kaizen_issues skips non-merged PRs ---"

setup
cat > "$AUTOCLOSE_MOCK_DIR/gh" << 'MOCK_GH2'
#!/bin/bash
if echo "$@" | grep -q "pr view.*--json state"; then
  echo "OPEN"
  exit 0
fi
echo ""
exit 0
MOCK_GH2
chmod +x "$AUTOCLOSE_MOCK_DIR/gh"

OUTPUT=$(PATH="$AUTOCLOSE_MOCK_DIR:$PATH" auto_close_kaizen_issues "https://github.com/Garsson-io/nanoclaw/pull/42")
assert_eq "auto-close: no output for non-merged PR" "" "$OUTPUT"

echo ""
echo "--- 5c: auto_close_kaizen_issues handles empty PR URL ---"

OUTPUT=$(auto_close_kaizen_issues "")
assert_eq "auto-close: no-op for empty URL" "" "$OUTPUT"

rm -rf "$AUTOCLOSE_MOCK_DIR"

teardown
print_results
