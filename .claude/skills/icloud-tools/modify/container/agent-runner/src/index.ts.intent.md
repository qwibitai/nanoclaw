# Intent: container/agent-runner/src/index.ts modifications

## What changed
Registered icloud-tools MCP server tools and protected credentials from Bash leakage.

## Key sections
### SECRET_ENV_VARS array
- Added `'ICLOUD_APP_PASSWORD'` — stripped from Bash subprocess env

### allowedTools array (in query() options)
- Added `'mcp__icloud-tools__*'` — wildcard allows all icloud-tools MCP tools

## Invariants (must-keep)
- All existing SECRET_ENV_VARS and allowedTools unchanged
- MessageStream, query loop, IPC polling unchanged
- Pre-compact hook and Bash sanitize hook unchanged
