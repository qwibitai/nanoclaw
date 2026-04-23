# Intent: src/ipc.ts modifications

## What changed
Extended IpcDeps with optional interaction methods, added attachment path resolution, and added handling for reaction/poll/reply IPC messages.

## Key sections

### IpcDeps interface
- Added `sendReaction?` — optional, channels that don't wire it get a warning log
- Added `sendReply?` — optional, falls back to `sendMessage` when not wired
- Added `sendPoll?` — optional, channels that don't wire it get a warning log
- All three use `?` (optional) so existing skill packages compile unchanged

### resolveAttachmentPaths() (new function)
- Maps container paths (`/workspace/group/`, `/workspace/ipc/`, `/workspace/extra/`) to host paths
- Uses prefix matching with path traversal protection (`path.resolve` + `startsWith` check)
- Missing files are logged and skipped
- Returns `undefined` if no valid paths resolve

### MAX_IPC_FILE_SIZE (new constant)
- 1MB limit on IPC file size to prevent abuse
- Files exceeding the limit are renamed to `.oversized` and skipped

### Message processing
- Added handling for `type: 'reaction'` — checks `deps.sendReaction` exists before calling
- Added handling for `type: 'poll'` — checks `deps.sendPoll` exists before calling
- Added handling for `replyToTimestamp`/`replyToAuthor` on `type: 'message'` — uses `deps.sendReply` if available, falls back to `deps.sendMessage`
- Added attachment resolution via `resolveAttachmentPaths` for message type

### GROUPS_DIR import
- Added import from `./config.js` for attachment path resolution

## Invariants
- All existing IPC message handling (authorization, error dirs) unchanged
- Task IPC processing (schedule, pause, resume, cancel, register) unchanged
- The polling interval and watcher lifecycle unchanged
- processTaskIpc signature and behavior unchanged
