# Intent: src/ipc.ts modifications

## What changed
Added media IPC support — download requests from container and outbound media messages.

## Key changes

### Imports
- Added: `isMediaDownloaded`, `resolveContainerMediaPath`, `writeDownloadError` from `./media.js`
- Added: `MediaSendOptions` from `./types.js`

### IpcDeps interface
Added two new dependency functions:
- `sendMedia(jid, filePath, options?)` — Send a file to a channel
- `downloadMedia(groupFolder, mediaId)` — Download media from channel to host

### processTaskIpc data type
Added media-related fields: `mediaId`, `containerFilePath`, `caption`, `filename`

### New switch cases

#### `media_download`
Container requests host to download a media file (lazy download). The agent calls `get_media` MCP tool → IPC file written → host downloads from channel → saves to media dir → container polls for file.

Dedup: checks `isMediaDownloaded()` before downloading — concurrent/duplicate IPC requests for the same mediaId are skipped.

Error handling: on download failure, writes a `.error` sentinel file via `writeDownloadError()` so the container's polling loop can detect failure immediately instead of waiting for the 30s timeout.

Authorization: implicit (sourceGroup determines which group's refs are accessed).

#### `media_message`
Container sends a file to a chat via IPC. Container writes file to `/workspace/media/`, then issues IPC request with container path.

Authorization: same pattern as text messages — `isMain || (targetGroup.folder === sourceGroup)`.

The container path is resolved to host path via `resolveContainerMediaPath()` which guards against path traversal.

## Invariants
- All existing IPC cases are unchanged
- Authorization model is consistent with existing patterns
- Error handling follows existing try/catch + logger pattern

## Must-keep
- All existing switch cases (schedule_task, pause/resume/cancel_task, refresh_groups, register_group)
- Authorization checks for all operations
- Error directory for failed IPC files
- The ipcWatcherRunning singleton guard
