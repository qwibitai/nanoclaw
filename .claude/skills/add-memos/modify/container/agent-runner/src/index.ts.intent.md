# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added conditional MemOS MCP server registration so container agents get `search_memories`, `add_memory`, and `chat` tools when MemOS is configured.

## Key sections

### ContainerInput interface
- Added: `secrets?: Record<string, string>` field (receives secrets from host via stdin)

### runQuery() function signature
- Added: `memosConfig: { apiUrl: string; userId: string; mcpPath: string }` parameter

### Allowed tools
- Added: `...(memosConfig.apiUrl ? ['mcp__memos__*'] : [])` — conditionally includes MemOS tools only when configured

### MCP servers
- Added conditional `memos` server alongside existing `nanoclaw` server:
  ```typescript
  ...(memosConfig.apiUrl ? {
    memos: {
      command: 'node',
      args: [memosConfig.mcpPath],
      env: {
        MEMOS_API_URL: memosConfig.apiUrl,
        MEMOS_USER_ID: memosConfig.userId,
      },
    },
  } : {})
  ```
- Server runs `memos-mcp-stdio.js` (compiled from the `add/` file)

### main() function
- Added: derives `memosMcpPath`, `memosApiUrl`, `memosUserId` from `containerInput.secrets`
- Passes `{ apiUrl, userId, mcpPath }` to `runQuery()`

## Invariants
- All existing MCP tools (nanoclaw IPC) are unchanged
- The query loop, IPC message handling, and session management are unchanged
- SDK configuration (model, permissions, hooks) is unchanged
- The stdin/stdout protocol is unchanged
- PreCompact hook is unchanged

## Must-keep
- `nanoclaw` MCP server registration and all IPC tools
- `allowedTools` list with all existing tools
- `bypassPermissions` mode
- `settingSources: ['project', 'user']`
- The query loop and resume logic
- `createPreCompactHook` in hooks configuration
