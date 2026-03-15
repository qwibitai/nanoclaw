# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added Proton MCP server to the agent's available tools so it can read and send emails via Proton Bridge.

## Key sections

### mcpServers (inside runQuery → query() call)
- Added: `proton` MCP server alongside existing servers:
  ```
  proton: {
    command: 'node',
    args: ['/home/node/.proton-mcp/../proton-mcp/index.js'],
  },
  ```
  Note: The exact path depends on where the proton-mcp tool is mounted. If mounted via the tools/ pattern, use the appropriate container path.

### allowedTools (inside runQuery → query() call)
- Added: `'mcp__proton__*'` to allow all Proton MCP tools

## Invariants
- The `nanoclaw` MCP server configuration is unchanged
- All existing allowed tools are preserved
- The query loop, IPC handling, MessageStream, and all other logic is untouched
- Hooks (PreCompact, sanitize Bash) are unchanged
- Output protocol (markers) is unchanged

## Must-keep
- The `nanoclaw` MCP server with its environment variables
- All existing allowedTools entries
- The hook system (PreCompact, PreToolUse sanitize)
- The IPC input/close sentinel handling
- The MessageStream class and query loop
