# Intent: Add MediaPayload interface and sendMedia to Channel

Add the `MediaPayload` interface for typed media file metadata (type, filePath, filename).
Add optional `sendMedia?(jid: string, media: MediaPayload): Promise<void>` method to the `Channel` interface.

These additions enable channels to send media files (images, files, audio, video) through the IPC pipeline.

**Invariants:**
- All existing interfaces and types remain unchanged
- `sendMedia` is optional — channels that don't support media simply omit it
- `MediaPayload.type` is a union of `'image' | 'file' | 'audio' | 'video'`
