# Intent: src/index.ts

## What Changed
- Added `extractSessionCommand, isSessionCommandAllowed` imports from `message-processor.js` (re-exported from session-commands)
- Added session command interception in `startMessageLoop()` between `isMainGroup` check and `needsTrigger` block

## Key Sections
- **Imports** (top of file): extractSessionCommand, isSessionCommandAllowed from message-processor
- **startMessageLoop**: Session command detection via `extractSessionCommand`, auth-gated `closeStdin` (prevents DoS by untrusted senders), enqueue for processGroupMessages which handles the actual command

Note: `processGroupMessages` now lives in `message-processor.ts` (not inline in index.ts). Session command handling within processGroupMessages is covered by the message-processor.ts overlay.

## Invariants (must-keep)
- State management (lastTimestamp, sessions, registeredGroups, lastAgentTimestamp, pendingSendCursor)
- loadState/saveState functions
- registerGroup/unregisterGroup functions
- buildProcessorDeps/buildHandlerDeps factory functions
- runAgent with session tracking, wrappedOnOutput, HandlerDeps, IPC fn registration
- startMessageLoop with dedup-by-group, optimistic cursor, async piping
- main() with credential proxy, channel setup, status tracker, scheduler, queue
- Graceful shutdown with queue.shutdown, proxyServer.close
- Sender allowlist integration (drop mode, trigger check)
