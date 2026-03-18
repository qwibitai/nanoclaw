#!/bin/bash
# Tests for check-verification.sh hook
# Run: bash .claude/kaizen/hooks/tests/test-check-verification.sh
#
# INVARIANT: gh pr create is BLOCKED if the command body lacks a Verification section.
# INVARIANT: gh pr create is ALLOWED if the body contains verification markers.
# INVARIANT: gh pr merge outputs advisory verification reminder on stderr, never blocks.
# INVARIANT: Non-PR commands are ignored.
# INVARIANT: PR number is extracted correctly via extract_pr_number (not greedy match).
# SUT: check-verification.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
HOOK="$HOOKS_DIR/check-verification.sh"
source "$SCRIPT_DIR/test-helpers.sh"

setup_mock_dir
trap 'rm -rf "$MOCK_DIR"' EXIT

# Default mock: gh pr view returns a body with verification section
setup_gh_mock_with_body() {
  local body="$1"
  cat > "$MOCK_DIR/gh" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "pr view"; then
  echo "$body"
  exit 0
fi
exit 1
MOCK
  chmod +x "$MOCK_DIR/gh"
}

echo "=== Non-PR commands are ignored ==="

OUTPUT=$(echo '{"tool_input":{"command":"npm run build"}}' | bash "$HOOK" 2>&1)
assert_eq "npm command exits silently" "" "$OUTPUT"

OUTPUT=$(echo '{"tool_input":{"command":"git push origin main"}}' | bash "$HOOK" 2>&1)
assert_eq "git push exits silently" "" "$OUTPUT"

echo ""
echo "=== Create: body WITH verification → allow ==="

# The hook checks the full COMMAND for verification markers
BODY_WITH_VERIFY='gh pr create --title "test" --body "$(cat <<'"'"'EOF'"'"'
## Summary
Some changes

## Verification
- [ ] Run npm run build
EOF
)"'

OUTPUT=$(run_hook "$HOOK" "$BODY_WITH_VERIFY")
assert_eq "body with Verification section → allow (no deny)" "" "$OUTPUT"

echo ""
echo "=== Create: body with 'Test plan' → allow ==="

BODY_WITH_TESTPLAN='gh pr create --title "test" --body "$(cat <<'"'"'EOF'"'"'
## Summary
Changes

## Test plan
- [ ] Run tests
EOF
)"'

OUTPUT=$(run_hook "$HOOK" "$BODY_WITH_TESTPLAN")
assert_eq "body with Test plan section → allow" "" "$OUTPUT"

echo ""
echo "=== Create: body WITHOUT verification → deny ==="

BODY_NO_VERIFY='gh pr create --title "test" --body "just a summary, nothing else here"'

OUTPUT=$(run_hook "$HOOK" "$BODY_NO_VERIFY")
assert_contains "missing verification → deny" "deny" "$OUTPUT"
assert_contains "deny message mentions Verification" "Verification" "$OUTPUT"

echo ""
echo "=== Create: heredoc body with 'verify' keyword → allow ==="

BODY_VERIFY_KEYWORD='gh pr create --title "test" --body "$(cat <<'"'"'EOF'"'"'
## Summary
Fix stuff

How to verify: run the tests
EOF
)"'

OUTPUT=$(run_hook "$HOOK" "$BODY_VERIFY_KEYWORD")
assert_eq "body with verify keyword → allow" "" "$OUTPUT"

echo ""
echo "=== Merge: with verification section → advisory on stderr ==="

setup_gh_mock_with_body "## Summary
Some PR

## Verification
- [ ] Run npm run build
- [ ] Check status"

STDERR=$(run_hook_stderr "$HOOK" "gh pr merge 42")
assert_contains "merge shows verification steps" "POST-MERGE VERIFICATION" "$STDERR"
assert_contains "merge shows actual steps" "npm run build" "$STDERR"

echo ""
echo "=== Merge: without verification section → warning on stderr ==="

setup_gh_mock_with_body "## Summary
Some PR with no verification"

STDERR=$(run_hook_stderr "$HOOK" "gh pr merge 42")
assert_contains "merge warns about missing verification" "no Verification section" "$STDERR"

echo ""
echo "=== Merge: never blocks (always exit 0, no deny JSON) ==="

setup_gh_mock_with_body ""

OUTPUT=$(run_hook "$HOOK" "gh pr merge 42")
assert_eq "merge never outputs deny JSON" "" "$OUTPUT"

echo ""
echo "=== Merge: PR number extraction ==="

# Mock gh that echoes the PR number it receives
cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr view"; then
  # Echo the first positional arg after "pr view" to verify extraction
  for arg in "$@"; do
    if echo "$arg" | grep -qE '^[0-9]+$'; then
      echo "## Verification"
      echo "PR $arg verified"
      exit 0
    fi
  done
  echo ""
  exit 0
fi
exit 1
MOCK
chmod +x "$MOCK_DIR/gh"

STDERR=$(run_hook_stderr "$HOOK" "gh pr merge 42")
assert_contains "extracts PR number 42" "PR 42 verified" "$STDERR"

# Should NOT extract numbers from flags
STDERR=$(run_hook_stderr "$HOOK" "gh pr merge --delete-branch")
assert_not_contains "does not extract from flags" "PR" "$STDERR"

print_results
