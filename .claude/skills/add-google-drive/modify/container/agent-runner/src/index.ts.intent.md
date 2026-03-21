# Intent: agent-runner/src/index.ts changes for add-google-drive

## What changed

Two additions to the `query()` options inside `runQuery()`:

1. `'mcp__gdrive__*'` added to `allowedTools` — grants the agent
   permission to call any tool exposed by the Google Drive MCP server.

2. A `gdrive` entry added to `mcpServers` — conditionally starts
   `@modelcontextprotocol/server-gdrive` via npx. The entry is only
   included when `gcp-oauth.keys.json` is present inside the container
   mount (`/home/node/.gdrive-mcp/gcp-oauth.keys.json`), preventing
   startup failures for users who haven't run OAuth yet.
   Env vars passed to the server:
   - `GDRIVE_OAUTH_PATH` → `/home/node/.gdrive-mcp/gcp-oauth.keys.json`
   - `GDRIVE_CREDENTIALS_PATH` → `/home/node/.gdrive-mcp/credentials.json`

## Invariants

- The `nanoclaw` MCP server entry and all existing allowedTools are
  unchanged.
- If `~/.gdrive-mcp/gcp-oauth.keys.json` does not exist inside the
  container, the gdrive MCP server is not registered at all — no
  startup error, the agent simply lacks Drive tools.
- No other part of the file is modified.
