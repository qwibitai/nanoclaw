#!/bin/bash
# test-schema-validation.sh — Validate hook output schemas match Claude Code expectations
#
# Claude Code expects specific JSON structures from hooks. If the schema
# is wrong, the hook "runs" but Claude Code ignores the output, making
# it look like the hook failed.
#
# INVARIANT: All deny outputs produce valid JSON matching Claude Code's expected schema.
# INVARIANT: All allow outputs are either empty or valid JSON without deny decision.
# SUT: Every hook script's output format.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/harness.sh"

STATE_DIR="$HARNESS_TEMP/pr-review-state"
mkdir -p "$STATE_DIR"
export STATE_DIR
export DEBUG_LOG="$HARNESS_TEMP/debug.log"

setup_mock_dir
trap 'rm -rf "$MOCK_DIR"' EXIT

# Setup mocks
setup_git_status_mock " M src/dirty.ts"

echo "=== Deny JSON schema validation ==="

# Collect deny outputs from hooks that should deny
DENY_TESTS=(
  # hook_script:command:description
  "$HOOKS_DIR/check-dirty-files.sh:gh pr create --title test --body test:dirty files on pr create"
  "$HOOKS_DIR/enforce-case-worktree.sh:git commit -m test:commit on wrong branch"
)

# Set up state for enforce-pr-review
printf 'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/42\nROUND=1\nSTATUS=needs_review\n' > "$STATE_DIR/Garsson-io_nanoclaw_42"
DENY_TESTS+=("$HOOKS_DIR/enforce-pr-review.sh:npm test:blocked by review gate")

# Mock git for enforce-case-worktree to return main branch
cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "status --porcelain"; then
  echo " M src/dirty.ts"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --abbrev-ref"; then
  echo "main"
  exit 0
fi
if echo "$@" | grep -q "diff --name-only"; then
  echo "src/index.ts"
  exit 0
fi
if echo "$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/nanoclaw.git"
  exit 0
fi
/usr/bin/git "$@" 2>/dev/null
MOCK
chmod +x "$MOCK_DIR/git"

for test_spec in "${DENY_TESTS[@]}"; do
  IFS=':' read -r hook cmd desc <<< "$test_spec"
  INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$cmd" '{command: $c}')")
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"

  if [ -z "$HOOK_STDOUT" ]; then
    echo "  FAIL: $desc — no output (expected deny JSON)"
    ((FAIL++))
    continue
  fi

  # 1. Must be valid JSON
  if ! echo "$HOOK_STDOUT" | jq empty 2>/dev/null; then
    echo "  FAIL: $desc — invalid JSON output"
    echo "    raw: ${HOOK_STDOUT:0:200}"
    ((FAIL++))
    continue
  fi

  # 2. Must have hookSpecificOutput at top level
  if ! echo "$HOOK_STDOUT" | jq -e '.hookSpecificOutput' >/dev/null 2>&1; then
    echo "  FAIL: $desc — missing hookSpecificOutput key"
    echo "    keys: $(echo "$HOOK_STDOUT" | jq 'keys')"
    ((FAIL++))
    continue
  fi

  # 3. Must have permissionDecision = "deny"
  local decision
  decision=$(echo "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.permissionDecision')
  if [ "$decision" != "deny" ]; then
    echo "  FAIL: $desc — permissionDecision='$decision' (expected 'deny')"
    ((FAIL++))
    continue
  fi

  # 4. Must have non-empty permissionDecisionReason
  local reason
  reason=$(echo "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
  if [ -z "$reason" ]; then
    echo "  FAIL: $desc — empty permissionDecisionReason"
    ((FAIL++))
    continue
  fi

  # 5. Exit code should be 0 (deny is communicated via JSON, not exit code)
  if [ "$HOOK_EXIT" -ne 0 ]; then
    echo "  FAIL: $desc — exit code $HOOK_EXIT (expected 0, deny is via JSON)"
    ((FAIL++))
    continue
  fi

  # 6. Reason should not contain raw control characters or broken encoding
  if echo "$reason" | grep -Pq '[\x00-\x08\x0b\x0c\x0e-\x1f]'; then
    echo "  FAIL: $desc — reason contains control characters"
    ((FAIL++))
    continue
  fi

  echo "  PASS: $desc — valid deny schema"
  ((PASS++))
done

echo ""
echo "=== Allow output schema validation ==="

# Reset mocks for clean state
rm -f "$STATE_DIR"/*
setup_git_status_mock ""

cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "status --porcelain"; then
  exit 0
fi
if echo "$@" | grep -q "rev-parse --abbrev-ref"; then
  echo "wt/260315-test"
  exit 0
fi
if echo "$@" | grep -q "diff --name-only"; then
  exit 0
fi
if echo "$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/nanoclaw.git"
  exit 0
fi
/usr/bin/git "$@" 2>/dev/null
MOCK
chmod +x "$MOCK_DIR/git"

ALLOW_TESTS=(
  "$HOOKS_DIR/check-dirty-files.sh:npm test:non-trigger command"
  "$HOOKS_DIR/enforce-pr-review.sh:npm test:no active review"
  "$HOOKS_DIR/enforce-case-worktree.sh:npm test:non-git command"
  "$HOOKS_DIR/check-verification.sh:npm test:non-pr command"
  "$HOOKS_DIR/check-test-coverage.sh:npm test:non-pr command"
)

for test_spec in "${ALLOW_TESTS[@]}"; do
  IFS=':' read -r hook cmd desc <<< "$test_spec"
  INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$cmd" '{command: $c}')")
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"

  # Allow: exit 0 and either no stdout or stdout without deny
  if [ "$HOOK_EXIT" -ne 0 ]; then
    echo "  FAIL: $desc — exit code $HOOK_EXIT (expected 0 for allow)"
    ((FAIL++))
    continue
  fi

  if [ -n "$HOOK_STDOUT" ]; then
    if echo "$HOOK_STDOUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then
      echo "  FAIL: $desc — produced deny JSON (expected allow)"
      ((FAIL++))
      continue
    fi
  fi

  echo "  PASS: $desc — valid allow output"
  ((PASS++))
done

echo ""
echo "=== PostToolUse output format ==="

# PostToolUse hooks should output advisory text on stdout (shown in transcript)
# or stderr (exit 2 = fed back to Claude). They should NOT output deny JSON.

POST_INPUT=$(build_post_tool_use_input "Bash" \
  '{"command":"gh pr create --title test --body test"}' \
  "https://github.com/Garsson-io/nanoclaw/pull/70" "" "0")

POST_HOOKS=(
  "$HOOKS_DIR/pr-review-loop.sh"
  "$HOOKS_DIR/kaizen-reflect.sh"
)

for hook in "${POST_HOOKS[@]}"; do
  run_single_hook "$hook" "$POST_INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"

  # Should not produce deny JSON
  if echo "$HOOK_STDOUT" | jq -e '.hookSpecificOutput.permissionDecision' >/dev/null 2>&1; then
    echo "  FAIL: $(basename $hook) — PostToolUse hook should not output permissionDecision JSON"
    ((FAIL++))
  elif [ -n "$HOOK_STDOUT" ]; then
    echo "  PASS: $(basename $hook) — outputs advisory text (not deny JSON)"
    ((PASS++))
  else
    # Some PostToolUse hooks may produce no output for some triggers — that's ok
    echo "  PASS: $(basename $hook) — no output (acceptable)"
    ((PASS++))
  fi

  # Exit should always be 0 for advisory hooks
  if [ "$HOOK_EXIT" -ne 0 ]; then
    echo "  FAIL: $(basename $hook) — exit $HOOK_EXIT (advisory hooks should always exit 0)"
    ((FAIL++))
  else
    echo "  PASS: $(basename $hook) — exits 0"
    ((PASS++))
  fi
done

echo ""
echo "=== Stop hook output format ==="

# Stop hooks use exit code 2 to block, not JSON deny
STOP_INPUT=$(build_stop_input "task_complete")

# verify-before-stop.sh needs TypeScript changes to be meaningful
# Test with no changes — should exit 0
run_single_hook "$HOOKS_DIR/verify-before-stop.sh" "$STOP_INPUT" 10 "$(printf 'PATH=%s' "$MOCK_DIR:$PATH")"
if [ "$HOOK_EXIT" -eq 0 ]; then
  echo "  PASS: verify-before-stop exits 0 with no TS changes"
  ((PASS++))
else
  echo "  FAIL: verify-before-stop exit $HOOK_EXIT with no TS changes"
  ((FAIL++))
fi

# check-cleanup-on-stop.sh should always exit 0
run_single_hook "$HOOKS_DIR/check-cleanup-on-stop.sh" "$STOP_INPUT" 10
if [ "$HOOK_EXIT" -eq 0 ]; then
  echo "  PASS: check-cleanup-on-stop always exits 0"
  ((PASS++))
else
  echo "  FAIL: check-cleanup-on-stop exit $HOOK_EXIT (should always be 0)"
  ((FAIL++))
fi

harness_summary
