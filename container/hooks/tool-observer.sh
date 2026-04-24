#!/usr/bin/env bash
# Tool Observer Hook - PostToolUse and PostToolUseFailure event logger
# Receives hook JSON on stdin, writes event file to IPC tool-events directory

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract key fields
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"')
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

# Generate unique filename with nanosecond timestamp
TS=$(date +%s%N)
FILENAME="${TS}-${TOOL}.json"

# IPC output directory (mounted at /workspace/ipc from container)
IPC_DIR="${NANOCLAW_IPC_INPUT_DIR:-/workspace/ipc/input}"
TOOL_EVENTS_DIR="${IPC_DIR}/tool-events"

# Ensure tool-events directory exists
mkdir -p "$TOOL_EVENTS_DIR"

# Write event JSON to IPC directory
# Truncate tool_response to 2KB to avoid large files
echo "$INPUT" | jq -c --arg event "$EVENT" '{
  tool_name: .tool_name,
  tool_use_id: .tool_use_id,
  session_id: .session_id,
  hook_event: $event,
  tool_input: (.tool_input | tostring | .[0:2000]),
  tool_response: (.tool_response | tostring | .[0:2000]),
  timestamp: (now | todate)
}' > "$TOOL_EVENTS_DIR/$FILENAME"

exit 0
