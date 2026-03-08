# Intent: container/agent-runner/src/index.ts

## What Changed
- Added `KNOWN_SESSION_COMMANDS` whitelist (`/compact`)
- Added slash command handling block in `main()` between prompt building and query loop
- Slash commands use `query()` with string prompt (not MessageStream), `allowedTools: []`, no mcpServers
- Tracks `compactBoundarySeen`, `hadError`, `resultEmitted` flags
- Observes `compact_boundary` system event to confirm compaction
- PreCompact hook registered for transcript archival
- Error subtype checking: `resultSubtype?.startsWith('error')` emits error output
- Container exits after slash command completes (no query loop)

## Key Sections
- **KNOWN_SESSION_COMMANDS** (before query loop): Set containing `/compact`
- **Slash command block** (after prompt building, before query loop): Detects session command, runs query with minimal options, handles result/error/boundary events, emits output via transport notifications

## Invariants (must-keep)
- ContainerInput/ContainerOutput interfaces
- JsonRpcTransport for stdio communication (replaces old readStdin/writeOutput/IPC polling)
- MessageStream class with push/end/remaining/asyncIterator
- runQuery function with transport-based drain loop
- createPreCompactHook for transcript archival
- createIpcMcpServer for in-process MCP
- parseTranscript, formatTranscriptMarkdown helpers
- main() with transport init, initialize handshake, SDK env setup, query loop
