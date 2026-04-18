# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added Corsair MCP server to the agent's available tools, conditioned on `CORSAIR_MCP_URL` being set.

## Key sections

### allowedTools (inside runQuery → query() call)
Added a spread after `mcp__nanoclaw__*`:
```typescript
'mcp__nanoclaw__*',
...(process.env.CORSAIR_MCP_URL ? ['mcp__corsair__*'] : []),
```
- Only enables Corsair tools when the server is configured
- Keeps the allowedTools array clean when Corsair is not installed

### mcpServers (inside runQuery → query() call)
Added a spread after the `nanoclaw` server:
```typescript
...(process.env.CORSAIR_MCP_URL ? {
  corsair: { url: process.env.CORSAIR_MCP_URL },
} : {}),
```
- Uses HTTP/SSE transport (the Corsair MCP server runs on the host, not as a stdio subprocess)
- URL is `http://host.docker.internal:{CORSAIR_MCP_PORT}/sse` — reaches the host from inside the container
- Conditional spread means the nanoclaw server is always registered regardless of Corsair

## Invariants
- The `nanoclaw` MCP server configuration is completely unchanged
- All existing allowedTools entries are preserved
- The query loop, IPC handling, MessageStream, close sentinel logic unchanged
- Hooks (PreCompact, sanitize Bash) unchanged
- Output protocol (OUTPUT_START_MARKER / OUTPUT_END_MARKER) unchanged

## Must-keep
- The `nanoclaw` MCP server with its three env vars
- All existing allowedTools entries
- The hook system
- IPC input drain and close sentinel handling
- The MessageStream class and the outer `while (true)` query loop
