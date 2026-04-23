#!/bin/bash
# service-guard.sh — Blocks agent sessions from restarting NanoClaw or
# running daemon-reload (which cascades restarts to all services).
#
# PreToolUse hook for Claude Code Bash tool invocations.
# Receives JSON on stdin with tool_input.command; outputs deny decision
# if the command matches a blocked pattern.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Block systemctl commands targeting nanoclaw (restart, stop, reload)
if echo "$COMMAND" | grep -qiE 'systemctl.*(restart|stop|reload|kill).*nanoclaw'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Agents cannot restart/stop/reload the nanoclaw service. Create a task instead."
    }
  }'
  exit 0
fi

# Block daemon-reload (causes cascade restarts of all services)
if echo "$COMMAND" | grep -qiE 'systemctl.*daemon-reload'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Agents cannot run daemon-reload. Create a task instead."
    }
  }'
  exit 0
fi

# Block reverse arg order: systemctl --user stop nanoclaw
if echo "$COMMAND" | grep -qiE 'systemctl.*nanoclaw'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Agents cannot target the nanoclaw service via systemctl. Create a task instead."
    }
  }'
  exit 0
fi

# Allow everything else
exit 0
