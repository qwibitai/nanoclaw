# Change: Use ACP Protocol for Cursor CLI Backend

## Why

`add-cursor-agent` defines the Cursor backend using per-request `agent --print --output-format stream-json` spawns, with MCP configuration written to the global `~/.cursor/mcp.json`. This has two concrete problems:

1. **Per-message process startup cost** — every message spawns a new `agent` process, adding latency.
2. **Concurrency bug** — multiple groups running simultaneously overwrite each other's `~/.cursor/mcp.json`, causing MCP server misconfiguration.

ACP (`agent acp`) is a persistent JSON-RPC 2.0 daemon that eliminates both issues: one process per conversation, and MCP servers registered per-session via `newSession()` params (no global file writes).

## What Changes

- `cursor-runner.ts` spawns `agent acp` once per conversation (instead of `agent --print` per message)
- ACP communication via `@agentclientprotocol/sdk` `ClientSideConnection` (JSON-RPC 2.0 over stdio)
- Session created with `connection.newSession({ workingDirectory, mcpServers })` — MCP registered in-process, no file I/O
- Streaming output via `client.sessionUpdate()` callback replacing hand-rolled NDJSON line parsing
- `writeConfigs()` / `cleanupConfigs()` / `previousMcpContent` / signal handlers — all deleted
- `container/agent-runner/package.json` adds `@agentclientprotocol/sdk`

No changes to `src/process-runner.ts`, `src/index.ts`, `src/task-scheduler.ts`, or the IPC `OUTPUT_START/END` protocol.

## Impact

- Affected specs: `agent-execution` (MODIFIED: Cursor CLI runner implementation)
- Affected code:
  - `container/agent-runner/src/cursor-runner.ts` — rewrite (~300 lines → ~180 lines)
  - `container/agent-runner/package.json` — add `@agentclientprotocol/sdk`
- Depends on: `add-cursor-agent` (must be applied or applied concurrently — defines the `AGENT_BACKEND=cursor` switch and `shared.ts`)
