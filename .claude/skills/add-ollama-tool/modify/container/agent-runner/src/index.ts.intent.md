# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added Ollama MCP server configuration so the container agent can call local Ollama models as tools.

## Key sections

### allowedTools array (inside runQuery → options)
- Added: `'mcp__ollama__*'` to the allowedTools array (after `'mcp__nanoclaw__*'`)

### mcpServers object (inside runQuery → options)
- Added: `ollama` entry as a stdio MCP server
  - command: `'node'`
  - args: resolves to `ollama-mcp-stdio.js` in the same directory as `ipc-mcp-stdio.js`
  - Uses `path.join(path.dirname(mcpServerPath), 'ollama-mcp-stdio.js')` to compute the path

## Invariants (must-keep)
- All existing allowedTools entries unchanged
- nanoclaw MCP server config unchanged
- All other query options (permissionMode, hooks, env, etc.) unchanged
- MessageStream class unchanged
- IPC polling logic unchanged
- Session management unchanged
