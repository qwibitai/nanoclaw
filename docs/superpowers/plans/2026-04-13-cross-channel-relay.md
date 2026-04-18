# Cross-Channel Relay

**Date:** 2026-04-13
**Status:** Complete
**Effort:** ~0.5 day

## What Was Built

A `relay_message` command that lets the main channel agent relay messages to any registered group/channel.

### Components

1. **IPC Handler** (`src/ipc.ts`) -- New `relay_message` case in `processTaskIpc`:
   - Main-group-only privilege check
   - Resolves target group by display name or folder name (case-insensitive)
   - Calls `deps.sendMessage()` to deliver via the target group's channel
   - Graceful failures for unknown groups or missing fields

2. **Container MCP Tool** (`container/agent-runner/src/ipc-mcp-stdio.ts`) -- New `relay_message` tool:
   - Parameters: `target_group` (name or folder), `text` (message body)
   - Client-side main-group check with clear error message
   - Writes IPC file to tasks directory for host processing

3. **Tests** (`src/__tests__/ipc-relay.test.ts`) -- 7 test cases:
   - Relay by display name
   - Relay by folder name
   - Case-insensitive matching
   - Permission denied for non-main groups
   - Unknown target group (graceful failure)
   - Missing text field
   - Missing targetGroup field

## Usage

From the main channel:
- "Send that to Dev Team"
- "Forward this to the family chat"

The agent calls `relay_message({ target_group: "Dev Team", text: "..." })`.
