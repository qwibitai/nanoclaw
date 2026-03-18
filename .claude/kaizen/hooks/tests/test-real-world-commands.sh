#!/bin/bash
# test-real-world-commands.sh — Test hooks against real-world command patterns
#
# Hooks fail in production because they're tested with simplified commands
# like "gh pr create --title test" but Claude generates complex commands with:
#   - Heredocs (<<'EOF' ... EOF)
#   - Nested subshells $(cat <<'EOF' ... EOF)
#   - Pipes and chains (cmd1 && cmd2 | cmd3)
#   - Multi-line strings
#   - HEREDOC bodies containing gh/git text (false positives)
#
# INVARIANT: Hooks correctly identify commands regardless of complexity.
# SUT: All hooks + parse-command.sh library.

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

# Mock git to return clean status and branch info
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
  echo "src/index.ts"
  exit 0
fi
if echo "$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/nanoclaw.git"
  exit 0
fi
/usr/bin/git "$@"
MOCK
chmod +x "$MOCK_DIR/git"

# Mock gh
cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr diff"; then
  echo "src/index.ts"
  exit 0
fi
if echo "$@" | grep -q "pr view"; then
  echo ""
  exit 0
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/gh"

VERIFY="$HOOKS_DIR/check-verification.sh"
DIRTY="$HOOKS_DIR/check-dirty-files.sh"
ENFORCE_CASE="$HOOKS_DIR/enforce-case-worktree.sh"
PR_REVIEW="$HOOKS_DIR/enforce-pr-review.sh"
PARSE_CMD="$HOOKS_DIR/lib/parse-command.sh"
PR_LOOP="$HOOKS_DIR/pr-review-loop.sh"

echo "=== Heredoc in PR body: verification section detected ==="

# Real pattern: gh pr create with heredoc body containing ## Verification
CMD='gh pr create --title "fix: stuff" --body "$(cat <<'\''EOF'\''
## Summary
- Fixed the thing

## Test plan
- [x] Tests pass

## Verification
- [ ] Run npm run build
- [ ] Check logs

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"'

INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$CMD" '{command: $c}')")
run_single_hook "$VERIFY" "$INPUT" 10 "$(printf 'PATH=%s' "$MOCK_DIR:$PATH")"

# Verification section IS present in the heredoc — should be detected
if [ -z "$HOOK_STDOUT" ] || ! validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: verification detected in heredoc body"
  ((PASS++))
else
  echo "  FAIL: verification not detected in heredoc body — false deny"
  echo "    reason: $(echo "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' | head -3)"
  ((FAIL++))
fi

echo ""
echo "=== Heredoc body containing 'gh pr create' text: no false positive ==="

# A heredoc body might contain text like "run gh pr create" as documentation.
# The hook should NOT treat that as a gh pr create command.
CMD='cat > /tmp/docs.md << '\''EOF'\''
To create a PR, run:
  gh pr create --title "your title" --body "description"
  git push origin your-branch
EOF'

INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$CMD" '{command: $c}')")
run_single_hook "$DIRTY" "$INPUT" 10 "$(printf 'PATH=%s' "$MOCK_DIR:$PATH")"
assert_eq "heredoc with gh pr create text: not a trigger" "" "$HOOK_STDOUT"

# Also test pr-review-loop
POST_INPUT=$(build_post_tool_use_input "Bash" "$(jq -n --arg c "$CMD" '{command: $c}')" "" "" "0")
run_single_hook "$PR_LOOP" "$POST_INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
assert_eq "pr-review-loop: heredoc text is not a trigger" "" "$HOOK_STDOUT"

echo ""
echo "=== Piped commands: gh pr create piped to tee ==="

CMD='gh pr create --title "test" --body "## Verification
- check it" | tee /tmp/pr-output.log'

INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$CMD" '{command: $c}')")
run_single_hook "$VERIFY" "$INPUT" 10 "$(printf 'PATH=%s' "$MOCK_DIR:$PATH")"
if [ -z "$HOOK_STDOUT" ] || ! validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: piped gh pr create with verification passes"
  ((PASS++))
else
  echo "  FAIL: piped command wrongly denied"
  ((FAIL++))
fi

echo ""
echo "=== Chained commands: git add && git commit && git push ==="

CMD='git add src/index.ts && git commit -m "fix: update routing" && git push origin wt/260315-test'

INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$CMD" '{command: $c}')")
run_single_hook "$ENFORCE_CASE" "$INPUT" 10 "$(printf 'PATH=%s' "$MOCK_DIR:$PATH")"
# On a wt/* branch, should be allowed
if [ -z "$HOOK_STDOUT" ] || ! validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: chained git commands allowed on wt/ branch"
  ((PASS++))
else
  echo "  FAIL: chained git commands denied on wt/ branch"
  echo "    reason: $(echo "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' | head -2)"
  ((FAIL++))
fi

echo ""
echo "=== Multi-line command with continuation ==="

CMD='gh pr create \
  --title "feat: add voice transcription" \
  --body "## Summary
Added whisper integration

## Verification
- Run npm test"'

INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$CMD" '{command: $c}')")
run_single_hook "$VERIFY" "$INPUT" 10 "$(printf 'PATH=%s' "$MOCK_DIR:$PATH")"
if [ -z "$HOOK_STDOUT" ] || ! validate_deny_output "$HOOK_STDOUT"; then
  echo "  PASS: multi-line command with verification passes"
  ((PASS++))
else
  echo "  FAIL: multi-line command denied"
  ((FAIL++))
fi

echo ""
echo "=== gh pr create output in stderr (some gh versions) ==="

# Some gh versions output the PR URL to stderr instead of stdout
POST_INPUT=$(build_post_tool_use_input "Bash" \
  '{"command":"gh pr create --title test --body test"}' \
  "" \
  "https://github.com/Garsson-io/nanoclaw/pull/88" \
  "0")

run_single_hook "$PR_LOOP" "$POST_INPUT" 10 "STATE_DIR=$STATE_DIR"
assert_contains "PR URL from stderr triggers review" "MANDATORY SELF-REVIEW" "$HOOK_STDOUT"

STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_88"
if [ -f "$STATE_FILE" ]; then
  echo "  PASS: state file created from stderr URL"
  ((PASS++))
else
  echo "  FAIL: state file not created from stderr URL"
  ((FAIL++))
fi

echo ""
echo "=== Empty tool_input.command ==="

INPUT=$(build_pre_tool_use_input "Bash" '{"command":""}')
for hook in "$PR_REVIEW" "$ENFORCE_CASE" "$DIRTY" "$VERIFY"; do
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    echo "  PASS: $(basename $hook) handles empty command gracefully"
    ((PASS++))
  else
    echo "  FAIL: $(basename $hook) crashed on empty command (exit $HOOK_EXIT)"
    ((FAIL++))
  fi
done

echo ""
echo "=== Missing tool_input entirely ==="

INPUT='{"session_id":"test","hook_event_name":"PreToolUse","tool_name":"Bash"}'
for hook in "$PR_REVIEW" "$ENFORCE_CASE" "$DIRTY" "$VERIFY"; do
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    echo "  PASS: $(basename $hook) handles missing tool_input gracefully"
    ((PASS++))
  else
    echo "  FAIL: $(basename $hook) crashed on missing tool_input (exit $HOOK_EXIT)"
    echo "    stderr: $HOOK_STDERR"
    ((FAIL++))
  fi
done

echo ""
echo "=== Malformed JSON input ==="

for hook in "$PR_REVIEW" "$ENFORCE_CASE" "$DIRTY" "$VERIFY"; do
  run_single_hook "$hook" "not json at all" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
  # Should not crash fatally — exit 0 or handle gracefully
  if [ "$HOOK_EXIT" -le 2 ]; then
    echo "  PASS: $(basename $hook) survives malformed JSON"
    ((PASS++))
  else
    echo "  FAIL: $(basename $hook) crashed on malformed JSON (exit $HOOK_EXIT)"
    ((FAIL++))
  fi
done

echo ""
echo "=== Command with special characters ==="

CMD="gh pr create --title 'fix: handle \$PATH & \"quotes\"' --body '## Verification\n- test'"
INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$CMD" '{command: $c}')")

for hook in "$PR_REVIEW" "$DIRTY" "$VERIFY"; do
  run_single_hook "$hook" "$INPUT" 10 "$(printf 'STATE_DIR=%s\nPATH=%s' "$STATE_DIR" "$MOCK_DIR:$PATH")"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    echo "  PASS: $(basename $hook) handles special chars"
    ((PASS++))
  else
    echo "  FAIL: $(basename $hook) crashed on special chars (exit $HOOK_EXIT)"
    ((FAIL++))
  fi
done

echo ""
echo "=== Very long command (> 10KB) ==="

LONG_BODY=$(python3 -c "print('x' * 10000)" 2>/dev/null || printf '%10000s' '' | tr ' ' 'x')
CMD="gh pr create --title test --body '## Verification\n${LONG_BODY}'"
INPUT=$(build_pre_tool_use_input "Bash" "$(jq -n --arg c "$CMD" '{command: $c}')")

run_single_hook "$VERIFY" "$INPUT" 10 "$(printf 'PATH=%s' "$MOCK_DIR:$PATH")"
if [ "$HOOK_EXIT" -eq 0 ]; then
  echo "  PASS: verification hook handles very long command"
  ((PASS++))
else
  echo "  FAIL: verification hook crashed on long command (exit $HOOK_EXIT)"
  ((FAIL++))
fi

harness_summary
