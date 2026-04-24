#!/usr/bin/env bash
#
# PostToolUse / PostToolUseFailure hook
# Writes a tool call event to /workspace/ipc/tool-events/ for host-side collection.
#
# Receives hook JSON on stdin with fields:
#   - session_id, tool_name, tool_use_id, hook_event_name
#   - tool_input (object), tool_response (object or string)
#

set -euo pipefail

# Read hook input
INPUT=$(cat)

# Extract fields
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')

# Generate timestamp-based filename
TS=$(date +%s%N)
EVENT_FILE="/workspace/ipc/tool-events/${TS}-${TOOL}.json"

# Ensure directory exists
mkdir -p "$(dirname "$EVENT_FILE")"

# Build event JSON with truncated tool_response (2KB max)
echo "$INPUT" | jq -c --arg event "$EVENT" '{
  session_id: .session_id,
  tool_name: .tool_name,
  tool_use_id: .tool_use_id,
  hook_event: $event,
  tool_input: (.tool_input | tostring | .[0:2000]),
  tool_response: (.tool_response | tostring | .[0:2000]),
  timestamp: (now | todate)
}' > "$EVENT_FILE"

exit 0
