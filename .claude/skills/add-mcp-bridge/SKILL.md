---
name: add-mcp-bridge
description: Bridge host-side MCP servers into agent containers. Use for MCP servers that can't run inside Linux containers (e.g. macOS-native APIs like Apple Reminders, Calendar via EventKit). Triggers on "mcp bridge", "host mcp", "bridge mcp", "add mcp bridge".
---

# Add MCP Bridge

This skill bridges host-side MCP servers into agent containers via IPC. Use it for MCP servers that **cannot run inside Linux containers** — typically macOS-native APIs that require EventKit, IOKit, or other OS frameworks.

For MCP servers that **can** run inside containers (HTTP APIs like Fastmail, Plex, etc.), use the standard approach: add them directly to `mcpServers` in `container/agent-runner/src/index.ts`. See `/add-parallel` for an example.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/mcp-bridge.ts` exists. If it does, skip to Phase 3 (Configuration). The code changes are already in place.

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch upstream skill/mcp-bridge
git merge upstream/skill/mcp-bridge
```

If there are merge conflicts, resolve them. The key files added/modified:

| File | Change |
|------|--------|
| `src/mcp-bridge.ts` | **New** — Generic JSON-RPC subprocess manager for host MCP servers |
| `src/ipc.ts` | **Modified** — MCP request/response forwarding via IPC files |
| `src/index.ts` | **Modified** — Env-based MCP bridge initialization |
| `src/container-runner.ts` | **Modified** — IPC directories + bridge manifest |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **Modified** — Dynamic tool discovery from host |

### Rebuild

```bash
npm run build
./container/build.sh
```

## Phase 3: Configuration

### Ask the user

Use `AskUserQuestion` to collect MCP server details:

AskUserQuestion: What MCP server(s) do you want to bridge from the host? I need for each:
1. A short name (e.g. "reminders", "calendar")
2. The path to the MCP server binary on the host
3. Any command-line arguments (optional)

### Configure .env

Add entries to `.env` for each server. The naming convention is:

```
MCP_BRIDGE_SERVERS=server1,server2
MCP_BRIDGE_SERVER1_COMMAND=/path/to/mcp-server-binary
MCP_BRIDGE_SERVER1_ARGS=--flag1 --flag2
MCP_BRIDGE_SERVER2_COMMAND=/path/to/other-binary
```

Rules:
- `MCP_BRIDGE_SERVERS` is a comma-separated list of server names
- Each server needs `MCP_BRIDGE_{NAME}_COMMAND` (uppercase, hyphens replaced with underscores)
- `_ARGS` is optional — space-separated arguments

Example for Apple Reminders + Calendar:
```
MCP_BRIDGE_SERVERS=reminders,calendar
MCP_BRIDGE_REMINDERS_COMMAND=/path/to/apple-reminders-mcp
MCP_BRIDGE_CALENDAR_COMMAND=/path/to/apple-calendar-mcp
```

### Restart

```bash
npm run build
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux
# systemctl --user restart nanoclaw
```

## Phase 4: Verify

Tell the user to send a message that would trigger one of the bridged tools. Check container logs for:
- `MCP bridge server registered` — server was configured
- `MCP server initialized` — server process started successfully
- `MCP bridge request completed` — tool call was forwarded and returned

If tools don't appear in the container, check:
1. `.env` has `MCP_BRIDGE_SERVERS` set
2. The MCP server binary path exists and is executable
3. Container logs for errors: `cat groups/*/logs/container-*.log | tail -50`

## How It Works

```
Agent (in container)
  ↓ calls tool (e.g. list_reminders)
IPC MCP Server (ipc-mcp-stdio.ts)
  ↓ writes request to /workspace/ipc/mcp_requests/
Host IPC Watcher (ipc.ts)
  ↓ reads request, forwards to McpBridge
McpBridge (mcp-bridge.ts)
  ↓ JSON-RPC stdio call to host MCP server process
Host MCP Server (e.g. Apple Reminders via EventKit)
  ↓ returns result
McpBridge → writes response to /workspace/ipc/mcp_responses/
  ↓
Container polls response, returns to agent
```

Tool discovery happens automatically at container startup. The container calls `list_tools` via IPC, the host queries all registered MCP servers for their tool schemas, and the container dynamically registers them. No hardcoded tool definitions needed.

## Uninstalling

To remove the MCP bridge:

1. Remove `MCP_BRIDGE_*` entries from `.env`
2. Revert the merge: `git log --oneline` to find the merge commit, then `git revert -m 1 <merge-commit>`
3. Rebuild: `npm run build && ./container/build.sh`
4. Restart the service
