#!/bin/bash
# Tests for kaizen-reflect.sh — post-merge kaizen gate (Kaizen #108)
#
# INVARIANT: Every successful gh pr merge creates a needs_pr_kaizen state file,
#   so the agent is blocked from non-kaizen commands until it files an issue
#   or explicitly declares no action needed.
# INVARIANT: Failed merges do NOT create kaizen gate state.
# INVARIANT: PR creates also set the gate (existing behavior, regression check).
# INVARIANT: The gate state file contains correct PR_URL, STATUS, and BRANCH.
# SUT: kaizen-reflect.sh (merge path state creation)

source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-reflect.sh"
setup_test_env

TEST_IPC_DIR=$(mktemp -d)
MOCK_DIR_CUSTOM=$(mktemp -d)

cleanup() {
  rm -rf "$TEST_IPC_DIR" "$MOCK_DIR_CUSTOM"
  cleanup_test_env
}
trap cleanup EXIT

setup() {
  reset_state
  rm -f "$TEST_IPC_DIR"/*.json 2>/dev/null
}

# Mock gh to return a known PR title
setup_gh_mock() {
  local pr_title="${1:-Test PR title}"
  echo "$pr_title" > "$MOCK_DIR_CUSTOM/.pr-title"
  cat > "$MOCK_DIR_CUSTOM/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr view"; then
  cat "$(dirname "$0")/.pr-title"
  exit 0
fi
if echo "$@" | grep -q "pr diff"; then
  echo "src/index.ts"
  exit 0
fi
exit 0
MOCK
  chmod +x "$MOCK_DIR_CUSTOM/gh"
}

# Mock git for branch name
cat > "$MOCK_DIR_CUSTOM/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "rev-parse --abbrev-ref"; then
  echo "wt/260319-k108-merge-gate"
  exit 0
fi
if echo "$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/nanoclaw.git"
  exit 0
fi
if echo "$@" | grep -q "diff --name-only"; then
  echo "src/index.ts"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$MOCK_DIR_CUSTOM/git"

# Helper: check if kaizen gate state file exists
has_pr_kaizen_state() {
  local count
  count=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l)
  [ "$count" -gt 0 ]
}

# Helper: get the kaizen state file content
get_kaizen_state_content() {
  cat "$STATE_DIR"/pr-kaizen-* 2>/dev/null
}

echo "=== Successful merge creates kaizen gate state ==="

setup
setup_gh_mock "Fix auth bug"

MERGE_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr merge 42 --repo Garsson-io/nanoclaw --squash"},
  "tool_response": {
    "stdout": "Merged https://github.com/Garsson-io/nanoclaw/pull/42",
    "stderr": "",
    "exit_code": "0"
  }
}')

echo "$MERGE_INPUT" | IPC_DIR="$TEST_IPC_DIR" PATH="$MOCK_DIR_CUSTOM:$PATH" bash "$HOOK" 2>/dev/null

if has_pr_kaizen_state; then
  echo "  PASS: merge creates needs_pr_kaizen state file"
  ((PASS++))
else
  echo "  FAIL: merge did NOT create needs_pr_kaizen state file"
  ((FAIL++))
fi

# Verify state file contents
CONTENT=$(get_kaizen_state_content)
assert_contains "state has correct PR URL" "nanoclaw/pull/42" "$CONTENT"
assert_contains "state has needs_pr_kaizen status" "needs_pr_kaizen" "$CONTENT"
assert_contains "state has branch field" "BRANCH=" "$CONTENT"

echo ""
echo "=== Failed merge does NOT create kaizen gate state ==="

setup

ERROR_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr merge 42 --repo Garsson-io/nanoclaw --squash"},
  "tool_response": {
    "stdout": "",
    "stderr": "GraphQL: Pull request is not mergeable",
    "exit_code": "1"
  }
}')

echo "$ERROR_INPUT" | IPC_DIR="$TEST_IPC_DIR" PATH="$MOCK_DIR_CUSTOM:$PATH" bash "$HOOK" 2>/dev/null

if ! has_pr_kaizen_state; then
  echo "  PASS: failed merge does not create state"
  ((PASS++))
else
  echo "  FAIL: failed merge incorrectly created state"
  ((FAIL++))
fi

echo ""
echo "=== PR create also creates kaizen gate state (regression) ==="

setup
setup_gh_mock "New feature"

CREATE_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --title \"test\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/nanoclaw/pull/99",
    "stderr": "",
    "exit_code": "0"
  }
}')

echo "$CREATE_INPUT" | IPC_DIR="$TEST_IPC_DIR" PATH="$MOCK_DIR_CUSTOM:$PATH" bash "$HOOK" 2>/dev/null

if has_pr_kaizen_state; then
  echo "  PASS: PR create also sets kaizen gate (existing behavior)"
  ((PASS++))
else
  echo "  FAIL: PR create did NOT set kaizen gate"
  ((FAIL++))
fi

echo ""
echo "=== Merge reflection prompt mentions gate ==="

setup
setup_gh_mock "Some PR"

MERGE_INPUT2=$(jq -n '{
  "tool_input": {"command": "gh pr merge 55 --squash"},
  "tool_response": {
    "stdout": "Merged https://github.com/Garsson-io/nanoclaw/pull/55",
    "stderr": "",
    "exit_code": "0"
  }
}')

OUTPUT=$(echo "$MERGE_INPUT2" | IPC_DIR="$TEST_IPC_DIR" PATH="$MOCK_DIR_CUSTOM:$PATH" bash "$HOOK" 2>/dev/null)

assert_contains "merge prompt mentions GATED" "GATED" "$OUTPUT"
assert_contains "merge prompt mentions BLOCKED" "BLOCKED" "$OUTPUT"
assert_contains "merge prompt mentions KAIZEN_NO_ACTION" "KAIZEN_NO_ACTION" "$OUTPUT"

echo ""
echo "=== Existing enforce-pr-kaizen.sh blocks after merge gate set ==="

setup
setup_gh_mock "Test PR"

# Simulate merge to set the gate
MERGE_INPUT3=$(jq -n '{
  "tool_input": {"command": "gh pr merge 60 --squash"},
  "tool_response": {
    "stdout": "Merged https://github.com/Garsson-io/nanoclaw/pull/60",
    "stderr": "",
    "exit_code": "0"
  }
}')

echo "$MERGE_INPUT3" | IPC_DIR="$TEST_IPC_DIR" PATH="$MOCK_DIR_CUSTOM:$PATH" bash "$HOOK" 2>/dev/null

# Now verify enforce-pr-kaizen.sh blocks a non-kaizen command
ENFORCE_HOOK="$(dirname "$0")/../enforce-pr-kaizen.sh"
BLOCK_INPUT=$(jq -n '{"tool_input":{"command":"npm run build"}}')
BLOCK_OUTPUT=$(echo "$BLOCK_INPUT" | PATH="$MOCK_DIR_CUSTOM:$PATH" bash "$ENFORCE_HOOK" 2>/dev/null)

if is_denied "$BLOCK_OUTPUT"; then
  echo "  PASS: enforce-pr-kaizen blocks after merge-triggered gate"
  ((PASS++))
else
  echo "  FAIL: enforce-pr-kaizen did NOT block after merge gate"
  echo "    output: $BLOCK_OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== pr-kaizen-clear.sh clears merge-triggered gate ==="

# The gate is still set from previous test — clear it via gh issue create
CLEAR_HOOK="$(dirname "$0")/../pr-kaizen-clear.sh"
CLEAR_INPUT=$(jq -n '{
  "tool_name": "Bash",
  "tool_input": {"command": "gh issue create --repo Garsson-io/kaizen --title \"test\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/kaizen/issues/200",
    "stderr": "",
    "exit_code": "0"
  }
}')

CLEAR_OUTPUT=$(echo "$CLEAR_INPUT" | PATH="$MOCK_DIR_CUSTOM:$PATH" bash "$CLEAR_HOOK" 2>/dev/null)

if ! has_pr_kaizen_state; then
  echo "  PASS: pr-kaizen-clear clears merge-triggered gate"
  ((PASS++))
else
  echo "  FAIL: pr-kaizen-clear did NOT clear merge-triggered gate"
  ((FAIL++))
fi
assert_contains "clear output mentions gate cleared" "gate cleared" "$CLEAR_OUTPUT"

# Verify enforce-pr-kaizen now allows commands
ALLOW_OUTPUT=$(echo "$BLOCK_INPUT" | PATH="$MOCK_DIR_CUSTOM:$PATH" bash "$ENFORCE_HOOK" 2>/dev/null)
assert_eq "commands allowed after gate cleared" "" "$ALLOW_OUTPUT"

print_results
