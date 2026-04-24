#!/bin/bash
# tool-observer.sh — Captures PostToolUse and PostToolUseFailure events
# from Claude Code agent sessions and writes them as JSON files to the
# IPC tool-events directory for host-side collection.
#
# PostToolUse / PostToolUseFailure hook for Claude Code.
# Receives JSON on stdin with tool_name, tool_use_id, session_id,
# tool_input, tool_response, and hook_event_name.

INPUT=$(cat)

# Extract fields from hook JSON
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"')
TS=$(date +%s%N)

# Determine IPC output directory from environment
IPC_DIR="${NANOCLAW_IPC_INPUT_DIR:-/workspace/ipc/input}"
TOOL_EVENTS_DIR="$(dirname "$IPC_DIR")/tool-events"
mkdir -p "$TOOL_EVENTS_DIR"

# Write event file with truncated tool_response (max 2000 chars)
echo "$INPUT" | jq -c --arg event "$EVENT" '{
  tool_name: .tool_name,
  tool_use_id: .tool_use_id,
  session_id: .session_id,
  hook_event: $event,
  tool_input: (.tool_input | tostring | .[0:1000]),
  tool_response: (.tool_response | tostring | .[0:2000])
}' > "${TOOL_EVENTS_DIR}/${TS}-${TOOL}.json" 2>/dev/null

# Always exit 0 — observability hooks must never block tool execution
exit 0
