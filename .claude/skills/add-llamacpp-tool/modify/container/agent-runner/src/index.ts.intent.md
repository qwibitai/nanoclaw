# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added llama.cpp MCP server configuration so the container agent can call a local llama-server instance as tools.

## Key sections

### allowedTools array (inside runQuery → options)
- Added: `'mcp__llamacpp__*'` to the allowedTools array (after `'mcp__nanoclaw__*'`)

### mcpServers object (inside runQuery → options)
- Added: `llamacpp` entry as a stdio MCP server
  - command: `'node'`
  - args: resolves to `llamacpp-mcp-stdio.js` in the same directory as `ipc-mcp-stdio.js`
  - Uses `path.join(path.dirname(mcpServerPath), 'llamacpp-mcp-stdio.js')` to compute the path

## Invariants (must-keep)
- All existing allowedTools entries unchanged
- nanoclaw MCP server config unchanged
- All other query options (permissionMode, hooks, env, etc.) unchanged
- MessageStream class unchanged
- IPC polling logic unchanged
- Session management unchanged
