# Intent: src/index.ts

## What Changed
- Added `import { extractSessionCommand, isSessionCommandAllowed } from './session-commands.js'`
- Added session command interception block in `processGroupMessages()` between `missedMessages.length === 0` check and trigger check
- Added session command interception in `startMessageLoop()` between `isMainGroup` check and `needsTrigger` block

## Key Sections
- **Imports** (top of file): extractSessionCommand, isSessionCommandAllowed from session-commands
- **processGroupMessages**: Session command interception (authorized path with pre-compact + /compact, denied path advances cursor and returns)
- **startMessageLoop**: Session command detection, auth-gated closeStdin (prevents DoS), enqueue for processGroupMessages

## Invariants (must-keep)
- State management (lastTimestamp, sessions, registeredGroups, lastAgentTimestamp)
- loadState/saveState functions
- registerGroup function with folder validation
- getAvailableGroups function
- processGroupMessages trigger logic, cursor management, idle timer, error rollback with duplicate prevention
- runAgent task/group snapshot writes, session tracking, wrappedOnOutput
- startMessageLoop with dedup-by-group and piping logic
- recoverPendingMessages startup recovery
- main() with channel setup, scheduler, IPC watcher, queue
- ensureContainerSystemRunning using container-runtime abstraction
- Graceful shutdown with queue.shutdown
- Sender allowlist integration (drop mode, trigger check)
