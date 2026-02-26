# Intent: agent-runner/src/index.ts changes for add-composio

## What changed

Two additions to the `query()` options inside `runQuery()`:

1. `'mcp__composio__*'` added to `allowedTools` — grants the agent
   permission to call any tool exposed by the Composio MCP server.

2. A `composio` entry added to `mcpServers` — starts
   `@composio/mcp` via npx with one env var:
   - `COMPOSIO_API_KEY` → `process.env.COMPOSIO_API_KEY || ''`
     (injected into the container by container-runner.ts from
     `~/.composio/api.key` on the host)

## Invariants

- The `nanoclaw` and `gdrive` MCP server entries and all existing
  allowedTools are unchanged.
- If `~/.composio/api.key` does not exist on the host, no
  `COMPOSIO_API_KEY` env var is injected by container-runner.ts, so
  `process.env.COMPOSIO_API_KEY` will be `undefined` and the MCP server
  will fail to authenticate — the agent falls back gracefully and
  reports Composio tools are unavailable.
- No other part of the file is modified.
