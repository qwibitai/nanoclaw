# Intent: src/group-queue.ts modifications

## What changed
Support engines that don't spawn child processes (Codex runs in-process, no ChildProcess).

## Key sections

### registerProcess
- Changed: `proc: ChildProcess` → `proc: ChildProcess | null`
- When `proc` is null (Codex engine):
  - Skip `proc.on('exit', ...)` listener registration
  - Skip `proc.pid` access
  - Still set `state.active = true`, `state.containerName`, `state.groupFolder`
  - The group is tracked as active but without a process handle

### sendMessage
- Added: optional `sendMessageFn` callback field
- Added: `setSendMessageFn(fn)` method to set it
- In `sendMessage()`: if `sendMessageFn` is set, try it first. If it returns true, message was delivered. If false or not set, fall back to existing file-based IPC logic.
- This allows Codex engine to deliver messages directly to its thread (`thread.run(text)`) instead of writing JSON files to `data/ipc/{group}/input/`

### closeStdin
- Guard with null check: `if (state.process)` before accessing process streams
- When process is null, just mark the group for cleanup without process termination

## Invariants
- All existing file-based IPC logic is preserved as the fallback path
- `getGroup()`, `notifyIdle()`, `notifyAgentBusy()`, `isActive()` are unchanged
- Queue flush logic is unchanged
- State shape (`GroupState`) unchanged — `process` field type goes from `ChildProcess` to `ChildProcess | null`
- The `idleWaiting` mechanism is unchanged

## Must-keep
- The `DATA_DIR` based IPC path construction
- The `_close` sentinel logic for container shutdown
- All state management and queue flush logic
- The `lastActivity` timestamp tracking
- The `isTaskContainer` flag handling
