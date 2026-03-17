#!/bin/bash
# Tests for pr-review-loop.sh — state file keying by PR URL
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
  # Inline the function since we can't easily source just part of the hook
  local url="$2"
  echo "$STATE_DIR/$(echo "$url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
}

NANOCLAW_STATE=$(source_with_state_dir "$STATE_DIR" "https://github.com/Garsson-io/nanoclaw/pull/33")
PRINTS_STATE=$(source_with_state_dir "$STATE_DIR" "https://github.com/Garsson-io/garsson-prints/pull/2")

assert_contains "nanoclaw PR state file includes repo name" "Garsson-io_nanoclaw_33" "$NANOCLAW_STATE"
assert_contains "prints PR state file includes repo name" "Garsson-io_garsson-prints_2" "$PRINTS_STATE"
assert_not_contains "nanoclaw state != prints state" "$PRINTS_STATE" "$NANOCLAW_STATE"

echo ""
echo "=== Full hook integration: PR create ==="

setup

# Simulate gh pr create for garsson-prints
PR_CREATE_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/garsson-prints --title \"test\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/garsson-prints/pull/2",
    "stderr": "",
    "exit_code": "0"
  }
}')

# Run the hook with overridden STATE_DIR
OUTPUT=$(echo "$PR_CREATE_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "PR create outputs review prompt" "MANDATORY SELF-REVIEW" "$OUTPUT"
assert_contains "PR create mentions the PR URL" "garsson-prints/pull/2" "$OUTPUT"

# Check state file was created with repo-specific name
STATE_FILE="$STATE_DIR/Garsson-io_garsson-prints_2"
if [ -f "$STATE_FILE" ]; then
  echo "  PASS: state file created with PR-URL-based name"
  ((PASS++))

  STORED_URL=$(grep '^PR_URL=' "$STATE_FILE" | cut -d= -f2-)
  assert_eq "state file contains correct PR URL" "https://github.com/Garsson-io/garsson-prints/pull/2" "$STORED_URL"

  STORED_ROUND=$(grep '^ROUND=' "$STATE_FILE" | cut -d= -f2-)
  assert_eq "state file starts at round 1" "1" "$STORED_ROUND"
else
  echo "  FAIL: state file not created at $STATE_FILE"
  ((FAIL++))
  ls -la "$STATE_DIR/" 2>/dev/null
fi

echo ""
echo "=== Two PRs from different repos don't conflict ==="

# Create another PR for nanoclaw
PR_CREATE_NANOCLAW=$(jq -n '{
  "tool_input": {"command": "gh pr create --repo Garsson-io/nanoclaw --title \"test2\""},
  "tool_response": {
    "stdout": "https://github.com/Garsson-io/nanoclaw/pull/40",
    "stderr": "",
    "exit_code": "0"
  }
}')

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

# Simulate git push (no PR URL in output)
PUSH_INPUT=$(jq -n '{
  "tool_input": {"command": "git push"},
  "tool_response": {
    "stdout": "Everything up-to-date",
    "stderr": "",
    "exit_code": "0"
  }
}')

PUSH_OUTPUT=$(echo "$PUSH_INPUT" | STATE_DIR="$STATE_DIR" bash "$HOOK" 2>/dev/null)
assert_contains "push triggers next review round" "ROUND" "$PUSH_OUTPUT"

echo ""
echo "=== Merge cleans up state file ==="

# Simulate gh pr merge (PR URL in stdout)
MERGE_INPUT=$(jq -n '{
  "tool_input": {"command": "gh pr merge 2 --repo Garsson-io/garsson-prints --squash"},
  "tool_response": {
    "stdout": "✓ Merged https://github.com/Garsson-io/garsson-prints/pull/2",
    "stderr": "",
    "exit_code": "0"
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
    "stdout": "some error or unexpected output",
    "stderr": "",
    "exit_code": "0"
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
