# Intent: container/agent-runner/src/index.ts

## What Changed
- Added `KNOWN_SESSION_COMMANDS` whitelist (`/compact`)
- Added slash command handling block in `main()` between prompt building and query loop
- Slash commands use `query()` with string prompt (not MessageStream), `allowedTools: []`, no mcpServers
- Tracks `compactBoundarySeen`, `hadError`, `resultEmitted` flags
- Observes `compact_boundary` system event to confirm compaction
- PreCompact hook still registered for transcript archival
- Error subtype checking: `resultSubtype?.startsWith('error')` emits `status: 'error'`
- Container exits after slash command completes (no IPC wait loop)

## Key Sections
- **KNOWN_SESSION_COMMANDS** (before query loop): Set containing `/compact`
- **Slash command block** (after prompt building, before query loop): Detects session command, runs query with minimal options, handles result/error/boundary events
- **Existing query loop**: Unchanged

## Invariants (must-keep)
- ContainerInput/ContainerOutput interfaces
- readStdin, writeOutput, log utilities
- OUTPUT_START_MARKER / OUTPUT_END_MARKER protocol
- MessageStream class with push/end/asyncIterator
- IPC polling (drainIpcInput, waitForIpcMessage, shouldClose)
- runQuery function with all existing logic
- createPreCompactHook for transcript archival
- createSanitizeBashHook for secret stripping
- parseTranscript, formatTranscriptMarkdown helpers
- main() stdin parsing, SDK env setup, query loop
- SECRET_ENV_VARS list
