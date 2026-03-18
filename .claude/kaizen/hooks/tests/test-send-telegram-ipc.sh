#!/bin/bash
# Tests for send-telegram-ipc.sh — Telegram IPC helper
#
# INVARIANT: send_telegram_ipc produces valid JSON with correct structure.
# INVARIANT: Special characters in message text are safely escaped (no injection).
# INVARIANT: Empty text returns failure without writing a file.
# INVARIANT: IPC_DIR override works for testing.
# SUT: send-telegram-ipc.sh

source "$(dirname "$0")/test-helpers.sh"
source "$(dirname "$0")/../lib/send-telegram-ipc.sh"

TEST_IPC_DIR=$(mktemp -d)
export IPC_DIR="$TEST_IPC_DIR"

cleanup() {
  rm -rf "$TEST_IPC_DIR"
}
trap cleanup EXIT

echo "=== Basic message ==="

send_telegram_ipc "Hello world"
assert_eq "returns success" "0" "$?"

if [ -f "$IPC_FILE" ]; then
  echo "  PASS: IPC file created"
  ((PASS++))

  # Validate JSON structure
  TYPE=$(jq -r '.type' "$IPC_FILE" 2>/dev/null)
  CHAT_JID=$(jq -r '.chatJid' "$IPC_FILE" 2>/dev/null)
  TEXT=$(jq -r '.text' "$IPC_FILE" 2>/dev/null)

  assert_eq "type is message" "message" "$TYPE"
  assert_eq "default chatJid" "tg:-5128317012" "$CHAT_JID"
  assert_eq "text matches" "Hello world" "$TEXT"
else
  echo "  FAIL: IPC file not created"
  ((FAIL++))
fi

echo ""
echo "=== Custom chatJid ==="

send_telegram_ipc "Test message" "tg:12345"
CHAT_JID=$(jq -r '.chatJid' "$IPC_FILE" 2>/dev/null)
assert_eq "custom chatJid" "tg:12345" "$CHAT_JID"

echo ""
echo "=== Special characters in text (injection safety) ==="

send_telegram_ipc 'PR title with "quotes" and $variables and $(commands) and `backticks`'
if [ -f "$IPC_FILE" ]; then
  # jq should parse it without error — proves valid JSON
  TEXT=$(jq -r '.text' "$IPC_FILE" 2>/dev/null)
  if [ $? -eq 0 ]; then
    echo "  PASS: JSON is valid despite special characters"
    ((PASS++))
    assert_contains "quotes preserved" '"quotes"' "$TEXT"
    assert_contains "dollar preserved" '$variables' "$TEXT"
    assert_contains "backticks preserved" '`backticks`' "$TEXT"
  else
    echo "  FAIL: JSON is invalid"
    ((FAIL++))
  fi
else
  echo "  FAIL: IPC file not created for special chars"
  ((FAIL++))
fi

echo ""
echo "=== Newlines in text ==="

send_telegram_ipc "$(printf 'Line 1\nLine 2\nLine 3')"
TEXT=$(jq -r '.text' "$IPC_FILE" 2>/dev/null)
LINES=$(echo "$TEXT" | wc -l)
assert_eq "multiline text has 3 lines" "3" "$LINES"

echo ""
echo "=== Empty text returns failure ==="

send_telegram_ipc ""
RESULT=$?
assert_eq "empty text returns 1" "1" "$RESULT"

echo ""
echo "=== File naming ==="

send_telegram_ipc "test"
assert_contains "file starts with notify-" "notify-" "$IPC_FILE"
assert_contains "file ends with .json" ".json" "$IPC_FILE"
assert_contains "file is in IPC_DIR" "$TEST_IPC_DIR" "$IPC_FILE"

print_results
