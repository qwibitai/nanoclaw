# Intent: src/index.ts

## What Changed

- Imported `clearThinkingState` from `./ipc.js`
- Added `sendMessageWithId` and `editMessage` callbacks to IPC deps, delegating to channel via findChannel
- In `onMessage` callback: call `clearThinkingState(chatJid)` on new inbound messages (not from self, not bot)

## Key Sections

- **Imports**: Added clearThinkingState
- **IPC deps**: Two new methods that look up the channel and call its optional methods
- **onMessage callback**: clearThinkingState call before sender allowlist check

## Invariants (must-keep)

- State management (lastTimestamp, sessions, registeredGroups, lastAgentTimestamp)
- loadState/saveState functions
- registerGroup function with folder validation
- getAvailableGroups function
- processGroupMessages trigger logic, cursor management, idle timer, error rollback
- runAgent task/group snapshot writes, session tracking, wrappedOnOutput
- startMessageLoop with dedup-by-group and piping logic
- recoverPendingMessages startup recovery
- main() with channel setup, scheduler, IPC watcher, queue
- ensureContainerSystemRunning
- Graceful shutdown with queue.shutdown
