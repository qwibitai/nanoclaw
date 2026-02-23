# ipc.ts intent

## Changes
- Added `sendFile?` callback to `IpcDeps` interface
- IPC message handler now supports `files` array (workspace-relative paths) and optional `fileComment`
- Resolves file paths relative to the group's folder: `path.resolve(GROUPS_DIR, sourceGroup, relativePath)`
- Routes file sending through the `sendFile` callback on the appropriate channel

## Invariants
- Existing `text` message handling must remain unchanged
- All other IPC message types (schedule_task, register_group, etc.) must remain unchanged
