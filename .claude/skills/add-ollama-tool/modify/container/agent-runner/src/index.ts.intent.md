# Intent: container/agent-runner/src/index.ts modifications

## What changed
Replaced stdio-based Ollama MCP server with an in-process SDK MCP server that sends status notifications via JSON-RPC transport.

## Key sections

### Imports
- Removed: `import { fileURLToPath } from 'url';` (no longer needed for resolving stdio script path)
- Added: `import { createOllamaMcpServer } from './ollama-mcp-inprocess.js';`

### mcpServers (inside runQuery -> query() call)
- Changed: `ollama` MCP server from stdio child process to in-process server:
  ```
  // Before:
  ollama: { command: 'node', args: [fileURLToPath(new URL('./ollama-mcp-stdio.js', import.meta.url))] },
  // After:
  ollama: ollamaMcpServer,
  ```

### runQuery signature
- Added: `ollamaMcpServer` parameter (in-process MCP server instance)

### main()
- Added: `const ollamaMcpServer = createOllamaMcpServer(transport);` alongside existing IPC MCP server creation
- Updated: `runQuery` calls pass `ollamaMcpServer` as new parameter

### allowedTools (inside runQuery -> query() call)
- Unchanged: `'mcp__ollama__*'` still present to allow all Ollama MCP tools

## Invariants
- The in-process `nanoclaw` MCP server configuration is unchanged
- All existing allowed tools are preserved
- The query loop, JSON-RPC transport, MessageStream, and all other logic is untouched
- Hooks (PreCompact, sanitize Bash) are unchanged
- JSON-RPC transport initialization and drain loop unchanged

## Must-keep
- The in-process `nanoclaw` MCP server creation
- All existing allowedTools entries
- The hook system (PreCompact, PreToolUse sanitize)
- JSON-RPC transport initialization and drain loop
- The MessageStream class and query loop
