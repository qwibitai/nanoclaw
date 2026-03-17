#!/bin/bash
# send-telegram-ipc.sh — Send a Telegram message via IPC.
# Source from hooks: source "$(dirname "$0")/lib/send-telegram-ipc.sh"
#
# Uses jq to construct JSON safely (no shell injection via message text).
# Writes to data/ipc/main/messages/ — the "main" group has permission to
# send to any chatJid.

# Send a Telegram message via IPC file.
# Usage: send_telegram_ipc "Your message text here"
# Returns: 0 on success, 1 on failure
# Sets: IPC_FILE to the path of the written file (for testing)
send_telegram_ipc() {
  local text="$1"
  local chat_jid="${2:-tg:-5128317012}"

  if [ -z "$text" ]; then
    return 1
  fi

  # Allow override for testing; anchor to project dir when available
  local ipc_dir="${IPC_DIR:-${CLAUDE_PROJECT_DIR:-.}/data/ipc/main/messages}"

  # Ensure directory exists
  if [ ! -d "$ipc_dir" ]; then
    mkdir -p "$ipc_dir" 2>/dev/null || return 1
  fi

  IPC_FILE="$ipc_dir/notify-$(date +%s)-$$-$RANDOM.json"

  # Use jq for safe JSON construction — prevents injection via message text
  if ! jq -n --arg text "$text" --arg jid "$chat_jid" \
    '{type:"message",chatJid:$jid,text:$text}' > "$IPC_FILE" 2>/dev/null; then
    rm -f "$IPC_FILE" 2>/dev/null
    return 1
  fi

  if [ ! -s "$IPC_FILE" ]; then
    rm -f "$IPC_FILE" 2>/dev/null
    return 1
  fi

  return 0
}
