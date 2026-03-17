#!/bin/bash
# Tests for pr-review-loop.sh — state file keying by PR URL
#
# INVARIANT: PR URL extraction works with Claude Code's actual PostToolUse
#   JSON format (tool_response.content), not just the assumed tool_output.stdout.
# INVARIANT: PR URLs from different repos produce different state file names.
# INVARIANT: State files track review rounds correctly across push/diff/merge.
# SUT: pr-review-loop.sh

source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../pr-review-loop.sh"
STATE_DIR="/tmp/.pr-review-state-test-$$"
export DEBUG_LOG="/dev/null"

setup() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
}

teardown() {
  rm -rf "$STATE_DIR"
}

# Source the hook's functions for direct testing
source "$(dirname "$0")/../lib/parse-command.sh"

# Override STATE_DIR in the hook by testing the functions directly
echo "=== pr_url_to_state_file ==="

# INVARIANT: PR URLs from different repos produce different state file names
# SUT: pr_url_to_state_file
source_with_state_dir() {
  local STATE_DIR="$1"
  local url="$2"
  echo "$STATE_DIR/$(echo "$url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
}

NANOCLAW_STATE=$(source_with_state_dir "$STATE_DIR" "https://github.com/Garsson-io/nanoclaw/pull/33")
PRINTS_STATE=$(source_with_state_dir "$STATE_DIR" "https://github.com/Garsson-io/garsson-prints/pull/2")

assert_contains "nanoclaw PR state file includes repo name" "Garsson-io_nanoclaw_33" "$NANOCLAW_STATE"
assert_contains "prints PR state file includes repo name" "Garsson-io_garsson-prints_2" "$PRINTS_STATE"
assert_not_contains "nanoclaw state != prints state" "$PRINTS_STATE" "$NANOCLAW_STATE"

echo ""
echo "=== PR create with tool_response.content (real Claude Code format) ==="

setup

# This is the ACTUAL format Claude Code sends for PostToolUse on Bash tool calls.
# tool_response has {content, is_error}, NOT {stdout, stderr, exit_code}.
REAL_FORMAT_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/nanoclaw --title \"test\""},
  "tool_response": {
    "content": "https://github.com/Garsson-io/nanoclaw/pull/42\n",
    "is_error": false
  }
}')

OUTPUT=$(echo "$REAL_FORMAT_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "tool_response.content: outputs review prompt" "MANDATORY SELF-REVIEW" "$OUTPUT"
assert_contains "tool_response.content: mentions the PR URL" "nanoclaw/pull/42" "$OUTPUT"

STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_42"
if [ -f "$STATE_FILE" ]; then
  echo "  PASS: state file created from tool_response.content"
  ((PASS++))
  STORED_URL=$(grep '^PR_URL=' "$STATE_FILE" | cut -d= -f2-)
  assert_eq "state file has correct URL" "https://github.com/Garsson-io/nanoclaw/pull/42" "$STORED_URL"
else
  echo "  FAIL: state file NOT created from tool_response.content"
  ((FAIL++))
  ls -la "$STATE_DIR/" 2>/dev/null
fi

teardown

echo ""
echo "=== PR create with tool_response.content containing extra text ==="

setup

# gh pr create may output extra text before/after the URL
EXTRA_TEXT_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --title \"test\""},
  "tool_response": {
    "content": "Creating pull request for feature-branch into main in Garsson-io/nanoclaw\n\nhttps://github.com/Garsson-io/nanoclaw/pull/55\n",
    "is_error": false
  }
}')

OUTPUT=$(echo "$EXTRA_TEXT_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "extra text: outputs review prompt" "MANDATORY SELF-REVIEW" "$OUTPUT"

STATE_FILE="$STATE_DIR/Garsson-io_nanoclaw_55"
if [ -f "$STATE_FILE" ]; then
  echo "  PASS: state file created when URL is embedded in multi-line output"
  ((PASS++))
else
  echo "  FAIL: state file NOT created when URL is in multi-line output"
  ((FAIL++))
fi

teardown

echo ""
echo "=== PR create with tool_response.is_error=true exits silently ==="

setup

ERROR_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --title \"test\""},
  "tool_response": {
    "content": "pull request create failed: GraphQL: No commits between main and feature",
    "is_error": true
  }
}')

OUTPUT=$(echo "$ERROR_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: is_error=true exits silently"
  ((PASS++))
else
  echo "  FAIL: is_error=true should produce no output"
  ((FAIL++))
fi

teardown

echo ""
echo "=== Backward compat: PR create with tool_output.stdout (test format) ==="

setup

# Tests and older hook versions may use tool_output.stdout — ensure backward compat
LEGACY_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/garsson-prints --title \"test\""},
  "tool_output": {
    "stdout": "https://github.com/Garsson-io/garsson-prints/pull/2",
    "stderr": "",
    "exit_code": "0"
  }
}')

OUTPUT=$(echo "$LEGACY_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "legacy format: outputs review prompt" "MANDATORY SELF-REVIEW" "$OUTPUT"
assert_contains "legacy format: mentions the PR URL" "garsson-prints/pull/2" "$OUTPUT"

STATE_FILE="$STATE_DIR/Garsson-io_garsson-prints_2"
if [ -f "$STATE_FILE" ]; then
  echo "  PASS: state file created from legacy tool_output.stdout"
  ((PASS++))
  STORED_URL=$(grep '^PR_URL=' "$STATE_FILE" | cut -d= -f2-)
  assert_eq "legacy state file has correct URL" "https://github.com/Garsson-io/garsson-prints/pull/2" "$STORED_URL"
else
  echo "  FAIL: state file NOT created from legacy format"
  ((FAIL++))
fi

teardown

echo ""
echo "=== Two PRs from different repos don't conflict ==="

setup

PR_CREATE_PRINTS=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/garsson-prints --title \"test\""},
  "tool_response": {
    "content": "https://github.com/Garsson-io/garsson-prints/pull/2",
    "is_error": false
  }
}')

PR_CREATE_NANOCLAW=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/nanoclaw --title \"test2\""},
  "tool_response": {
    "content": "https://github.com/Garsson-io/nanoclaw/pull/40",
    "is_error": false
  }
}')

echo "$PR_CREATE_PRINTS" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null
echo "$PR_CREATE_NANOCLAW" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null

PRINTS_FILE="$STATE_DIR/Garsson-io_garsson-prints_2"
NANOCLAW_FILE="$STATE_DIR/Garsson-io_nanoclaw_40"

if [ -f "$PRINTS_FILE" ] && [ -f "$NANOCLAW_FILE" ]; then
  echo "  PASS: both state files exist independently"
  ((PASS++))
else
  echo "  FAIL: expected two independent state files"
  ((FAIL++))
  ls -la "$STATE_DIR/"
fi

echo ""
echo "=== Push finds most recent active state ==="

PUSH_INPUT=$(jq -n '{
  "tool_input": {"command": "git push"},
  "tool_response": {
    "content": "Everything up-to-date",
    "is_error": false
  }
}')

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "push triggers next review round" "ROUND" "$PUSH_OUTPUT"

echo ""
echo "=== Merge cleans up state file ==="

MERGE_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr merge 2 --repo Garsson-io/garsson-prints --squash"},
  "tool_response": {
    "content": "Merged https://github.com/Garsson-io/garsson-prints/pull/2",
    "is_error": false
  }
}')

echo "$MERGE_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null
PRINTS_FILE="$STATE_DIR/Garsson-io_garsson-prints_2"
if [ ! -f "$PRINTS_FILE" ]; then
  echo "  PASS: merge cleans up state file for correct PR"
  ((PASS++))
else
  echo "  FAIL: state file still exists after merge"
  ((FAIL++))
fi

echo ""
echo "=== Push with no active state exits silently ==="

teardown
setup

PUSH_EMPTY=$(echo "$PUSH_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$PUSH_EMPTY" ]; then
  echo "  PASS: push with no state produces no output"
  ((PASS++))
else
  echo "  FAIL: push with no state produced output: $PUSH_EMPTY"
  ((FAIL++))
fi

echo ""
echo "=== PR create with no URL in output exits silently ==="

NO_URL_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --title test"},
  "tool_response": {
    "content": "some error or unexpected output",
    "is_error": false
  }
}')

NO_URL_OUTPUT=$(echo "$NO_URL_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
if [ -z "$NO_URL_OUTPUT" ]; then
  echo "  PASS: PR create with no URL exits silently"
  ((PASS++))
else
  echo "  FAIL: PR create with no URL produced output"
  ((FAIL++))
fi

teardown

print_results
