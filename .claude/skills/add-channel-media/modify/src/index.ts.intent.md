# Intent: src/index.ts modifications

## What changed
Wired media support into the IPC dependency injection.

## Key changes

### Imports
Added from `./config.js`:
- `MAX_MEDIA_SIZE` — Size limit for media transfers

Added from `./media.js`:
- `getMediaRef` — Look up stored media reference by ID
- `getExtFromMime` — Convert MIME type to file extension
- `isMediaDownloaded` — Check if media file already exists on disk
- `saveMediaFile` — Save downloaded buffer to media directory
- `writeDownloadError` — Write error sentinel for container to detect

### IPC deps (in main() → startIpcWatcher)
Added two new IPC dependency implementations:

#### sendMedia
Routes media sends through the channel abstraction:
1. Find channel for JID via `findChannel()`
2. If channel has `sendMedia`, call it
3. Fallback: send filename as text message if channel doesn't support media

#### downloadMedia
Downloads media from the originating channel:
1. Dedup check: skip if `isMediaDownloaded()` returns true
2. Extract channel name from mediaId (e.g., "whatsapp" from "whatsapp:media:...")
3. Look up stored ref via `getMediaRef()`
4. Find the channel by name
5. Call `channel.downloadMedia(ref.ref)` to get buffer
6. Enforce `MAX_MEDIA_SIZE` — if buffer exceeds limit, write error sentinel and throw
7. Save buffer to media directory via `saveMediaFile()`

## Invariants
- All existing message processing, state management, and recovery logic is unchanged
- The runAgent function is completely unchanged
- Shutdown handler is unchanged

## Must-keep
- All existing imports and re-exports
- All existing IPC deps
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
