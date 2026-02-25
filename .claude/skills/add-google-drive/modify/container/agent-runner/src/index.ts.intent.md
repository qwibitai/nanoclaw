# Intent: agent-runner/src/index.ts changes for add-google-drive

## What changed

Two additions to the `query()` options inside `runQuery()`:

1. `'mcp__gdrive__*'` added to `allowedTools` — grants the agent
   permission to call any tool exposed by the Google Drive MCP server.

2. A `gdrive` entry added to `mcpServers` — starts
   `@modelcontextprotocol/server-gdrive` via npx with two env vars:
   - `GDRIVE_OAUTH_PATH` → `/home/node/.gdrive-mcp/gcp-oauth.keys.json`
     (the OAuth client credentials downloaded from GCP Console)
   - `GDRIVE_CREDENTIALS_PATH` → `/home/node/.gdrive-mcp/credentials.json`
     (where the server stores and reads access/refresh tokens)

## Invariants

- The `nanoclaw` MCP server entry and all existing allowedTools are
  unchanged.
- If `~/.gdrive-mcp/` does not exist on the host (not yet authorised),
  the directory is not mounted (see container-runner.ts.intent.md) and
  the gdrive MCP server will fail to start — the agent falls back
  gracefully and reports Drive tools are unavailable.
- No other part of the file is modified.
