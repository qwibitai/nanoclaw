# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added claude-mem MCP server registration and tool allowlisting inside the container agent.

## Key sections

### allowedTools array
- Added: `'mcp__mcp-search__*'` — allows the agent to use all tools from the mcp-search MCP server (search, timeline, get_observations, smart_search, smart_unfold, smart_outline)
- The wildcard pattern matches the Claude Code MCP tool naming convention: `mcp__<server-name>__<tool-name>`

### mcpServers configuration
- Added conditional mcp-search MCP server alongside the existing nanoclaw server
- Uses spread operator with conditional: `...(fs.existsSync('/opt/claude-mem/scripts/mcp-server.cjs') ? { ... } : {})`
- Only registers the server if the script exists at `/opt/claude-mem/scripts/mcp-server.cjs` (mounted from host by container-runner)
- Environment variables:
  - `CLAUDE_MEM_WORKER_HOST: 'host.docker.internal'` — resolves to the Docker host
  - `CLAUDE_MEM_WORKER_PORT: '37777'` — default claude-mem worker port
  - `CLAUDE_MEM_PROJECT: containerInput.groupFolder` — isolates memory per group

## Invariants
- The nanoclaw MCP server is always registered (unchanged)
- The mcp-search server is only registered when the mount exists
- All existing allowedTools entries are preserved
- The hooks configuration is unchanged
- All other query options are unchanged

## Design decisions

### Conditional registration
The `fs.existsSync` check means the skill degrades gracefully — if claude-mem is not installed or the mount fails, agents work normally without memory tools. No errors, no warnings.

### Per-group project isolation
`CLAUDE_MEM_PROJECT: containerInput.groupFolder` ensures each NanoClaw group has isolated memory. Group A's observations are not visible to Group B's agents.

### host.docker.internal
The claude-mem worker runs on the host, not inside containers. Containers reach it via Docker's built-in `host.docker.internal` DNS entry (enabled by `--add-host` in container-runner.ts).

## Must-keep
- All existing MCP server configurations
- The conditional pattern for mcp-search registration
- The `mcp__mcp-search__*` entry in allowedTools
- All existing hooks and query options
