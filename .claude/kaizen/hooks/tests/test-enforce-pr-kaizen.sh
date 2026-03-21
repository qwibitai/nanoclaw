#!/bin/bash
# Tests for enforce-pr-kaizen.sh — PreToolUse hook that blocks non-kaizen
# commands until PR creation kaizen reflection is complete.
#
# INVARIANT UNDER TEST: After gh pr create, non-kaizen Bash commands are
# blocked until the agent submits a valid KAIZEN_IMPEDIMENTS declaration.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../enforce-pr-kaizen.sh"
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

# Helper: run the PreToolUse hook with a command
run_pretool_hook() {
  local command="$1"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

echo "=== No kaizen gate: all commands allowed ==="

setup

# INVARIANT: Without kaizen gate, commands pass through
OUTPUT=$(run_pretool_hook "npm run build")
assert_eq "no gate, build allowed" "" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: non-kaizen commands blocked ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Non-kaizen commands are denied when gate is active
OUTPUT=$(run_pretool_hook "npm run build")
if is_denied "$OUTPUT"; then
  echo "  PASS: npm run build denied during kaizen gate"
  ((PASS++))
else
  echo "  FAIL: npm run build NOT denied"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

OUTPUT=$(run_pretool_hook "git commit -m 'fix'")
if is_denied "$OUTPUT"; then
  echo "  PASS: git commit denied during kaizen gate"
  ((PASS++))
else
  echo "  FAIL: git commit NOT denied"
  ((FAIL++))
fi

echo ""
echo "=== Kaizen gate active: gh issue create allowed ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: gh issue create is allowed (it's the kaizen action)
OUTPUT=$(run_pretool_hook "gh issue create --repo Garsson-io/kaizen --title 'test'")
assert_eq "gh issue create allowed" "" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: KAIZEN_NO_ACTION allowed ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: KAIZEN_NO_ACTION declaration is allowed
OUTPUT=$(run_pretool_hook 'echo "KAIZEN_NO_ACTION: straightforward fix" >/dev/null')
assert_eq "KAIZEN_NO_ACTION allowed" "" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: read-only commands allowed ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Read-only git commands are allowed during kaizen gate
OUTPUT=$(run_pretool_hook "git status")
assert_eq "git status allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "git diff HEAD")
assert_eq "git diff allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "git log --oneline -5")
assert_eq "git log allowed" "" "$OUTPUT"

# INVARIANT: PR review commands are allowed
OUTPUT=$(run_pretool_hook "gh pr view https://github.com/Garsson-io/nanoclaw/pull/42")
assert_eq "gh pr view allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "gh pr diff https://github.com/Garsson-io/nanoclaw/pull/42")
assert_eq "gh pr diff allowed" "" "$OUTPUT"

# INVARIANT: Read-only filesystem commands are allowed
OUTPUT=$(run_pretool_hook "ls -la")
assert_eq "ls allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "cat README.md")
assert_eq "cat allowed" "" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: gh api allowed (CI monitoring) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: gh api calls are allowed during kaizen gate (needed for CI monitoring)
OUTPUT=$(run_pretool_hook "gh api repos/Garsson-io/nanoclaw/commits/abc123/check-runs")
assert_eq "gh api check-runs allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "gh api repos/Garsson-io/nanoclaw/check-runs/123/annotations")
assert_eq "gh api annotations allowed" "" "$OUTPUT"

# Piped gh api should also work
OUTPUT=$(run_pretool_hook "gh api repos/Garsson-io/nanoclaw/pulls/42 --jq '.state'")
assert_eq "gh api with jq allowed" "" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: gh run view/list/watch allowed (CI monitoring) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: gh run commands are allowed during kaizen gate (CI monitoring)
OUTPUT=$(run_pretool_hook "gh run view 12345 --repo Garsson-io/nanoclaw")
assert_eq "gh run view allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "gh run list --repo Garsson-io/nanoclaw --limit 5")
assert_eq "gh run list allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "gh run watch 12345 --repo Garsson-io/nanoclaw")
assert_eq "gh run watch allowed" "" "$OUTPUT"

# gh run delete should still be blocked (destructive)
OUTPUT=$(run_pretool_hook "gh run delete 12345")
if is_denied "$OUTPUT"; then
  echo "  PASS: gh run delete denied during kaizen gate"
  ((PASS++))
else
  echo "  FAIL: gh run delete NOT denied"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: only blocks own branch ==="

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42" "wt/other-branch"

# INVARIANT: Kaizen gate from another branch does not block this branch
OUTPUT=$(run_pretool_hook "npm run build")
assert_eq "other branch gate does not block" "" "$OUTPUT"

echo ""
echo "=== Stale state files are ignored ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"
# Backdate the state file to make it stale (>2 hours)
backdate_file "$STATE_DIR/pr-kaizen-Garsson-io_nanoclaw_42" 3

# INVARIANT: Stale state files do not block
OUTPUT=$(run_pretool_hook "npm run build")
assert_eq "stale gate does not block" "" "$OUTPUT"

echo ""
echo "=== Blocked message mentions PR URL ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

OUTPUT=$(run_pretool_hook "npm run build")
assert_contains "blocked message mentions PR" "pull/42" "$OUTPUT"
assert_contains "blocked message mentions KAIZEN_IMPEDIMENTS" "KAIZEN_IMPEDIMENTS" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: gh pr checks allowed ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: gh pr checks is allowed (read-only CI monitoring)
OUTPUT=$(run_pretool_hook "gh pr checks 42 --repo Garsson-io/nanoclaw")
assert_eq "gh pr checks allowed" "" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: KAIZEN_IMPEDIMENTS allowed ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: KAIZEN_IMPEDIMENTS declaration is allowed through
OUTPUT=$(run_pretool_hook "echo 'KAIZEN_IMPEDIMENTS: []'")
assert_eq "KAIZEN_IMPEDIMENTS allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"test\", \"disposition\": \"filed\", \"ref\": \"#198\"}]
IMPEDIMENTS")
assert_eq "KAIZEN_IMPEDIMENTS with heredoc allowed" "" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: gh issue comment allowed ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: gh issue comment is allowed (for adding incidents to existing issues)
OUTPUT=$(run_pretool_hook "gh issue comment 125 --repo Garsson-io/kaizen --body 'Incident #2'")
assert_eq "gh issue comment allowed" "" "$OUTPUT"

echo ""
echo "=== Kaizen gate active: gh issue list/search allowed (kaizen #150) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: gh issue list and search are allowed during kaizen gate
# (needed to find existing issues before filing new ones or adding incidents)
OUTPUT=$(run_pretool_hook "gh issue list --repo Garsson-io/kaizen --state open --limit 10")
assert_eq "gh issue list allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook "gh issue search --repo Garsson-io/kaizen 'hook allowlist'")
assert_eq "gh issue search allowed" "" "$OUTPUT"

# But gh issue close should still be blocked (destructive)
OUTPUT=$(run_pretool_hook "gh issue close 42 --repo Garsson-io/kaizen")
if is_denied "$OUTPUT"; then
  echo "  PASS: gh issue close denied during kaizen gate"
  ((PASS++))
else
  echo "  FAIL: gh issue close NOT denied"
  ((FAIL++))
fi

echo ""
echo "=== Kaizen gate active: KAIZEN_NO_ACTION [category] format allowed (kaizen #159) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: KAIZEN_NO_ACTION with bracket category format passes PreToolUse gate
# Bug: old grep checked for 'KAIZEN_NO_ACTION:' which doesn't match 'KAIZEN_NO_ACTION [docs-only]:'
OUTPUT=$(run_pretool_hook 'echo "KAIZEN_NO_ACTION [docs-only]: updated README formatting"')
assert_eq "KAIZEN_NO_ACTION [category] allowed" "" "$OUTPUT"

OUTPUT=$(run_pretool_hook 'echo "KAIZEN_NO_ACTION [test-only]: added missing test"')
assert_eq "KAIZEN_NO_ACTION [test-only] allowed" "" "$OUTPUT"

echo ""
echo "=== Segment-splitting prevents false positives (kaizen #172) ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Kaizen keywords buried inside non-kaizen commands (not at segment
# start) should be blocked. Segment splitting prevents matching keywords that
# appear as arguments to non-kaizen commands (e.g., inside grep patterns).
#
# Note: Segment splitting checks if ANY segment starts with a kaizen pattern.
# This is consistent with is_gh_pr_command and is_git_command behavior.
# So `npm build && echo KAIZEN_IMPEDIMENTS: []` passes because the second
# segment starts with `echo KAIZEN_IMPEDIMENTS:` — a valid kaizen command.

# Keyword appears as a grep argument, not a command — blocked
OUTPUT=$(run_pretool_hook "npm run build | grep KAIZEN_NO_ACTION")
if is_denied "$OUTPUT"; then
  echo "  PASS: npm | grep KAIZEN_NO_ACTION blocked (keyword is argument, not command)"
  ((PASS++))
else
  echo "  FAIL: npm | grep KAIZEN_NO_ACTION NOT blocked"
  ((FAIL++))
fi

# Keyword appears inside a string argument to another command — blocked
OUTPUT=$(run_pretool_hook "curl -d 'KAIZEN_IMPEDIMENTS: []' http://example.com")
if is_denied "$OUTPUT"; then
  echo "  PASS: KAIZEN_IMPEDIMENTS in curl argument blocked"
  ((PASS++))
else
  echo "  FAIL: KAIZEN_IMPEDIMENTS in curl argument NOT blocked"
  ((FAIL++))
fi

# Legitimate kaizen commands chained together should pass
OUTPUT=$(run_pretool_hook "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[]
IMPEDIMENTS")
assert_eq "echo KAIZEN_IMPEDIMENTS && cat allowed" "" "$OUTPUT"

# Legitimate: echo with KAIZEN_NO_ACTION at segment start
OUTPUT=$(run_pretool_hook "echo 'KAIZEN_NO_ACTION [docs-only]: updated README'")
assert_eq "echo KAIZEN_NO_ACTION at segment start allowed" "" "$OUTPUT"

teardown
print_results
