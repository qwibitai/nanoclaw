# Intent: src/ipc.ts

## What Changed

- Added `sendMessageWithId` and `editMessage` to `IpcDeps` interface
- Added ThinkingState tracking (Map of chatJid to {messageId, lines, lastUpdate})
- Exported `clearThinkingState(chatJid)` function
- In message processing loop: handle `thinking` type (edit-in-place with max 8 lines) and `clear_thinking` type (reset state) before existing `message` handler

## Key Sections

- **IpcDeps interface**: Two new methods
- **ThinkingState**: New interface and Map, clearThinkingState export
- **processIpcFiles message loop**: New thinking/clear_thinking handlers before existing message handler

## Invariants (must-keep)

- Existing IpcDeps fields (sendMessage, registeredGroups, registerGroup, syncGroups, etc.)
- ipcWatcherRunning guard
- processIpcFiles structure: scan group folders, process messages, process tasks
- All existing message authorization (isMain || folder matches)
- All existing task types (schedule_task, pause_task, resume_task, cancel_task, update_task, refresh_groups, register_group)
- Error handling: move failed files to errors/ directory
- processTaskIpc signature and authorization model
