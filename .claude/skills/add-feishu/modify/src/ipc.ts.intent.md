# Intent: Add media sending support to IPC message processing

Add `sendMedia` as an optional dependency in `IpcDeps` and handle `data.media` in the message processing branch.

**Changes:**
1. Import `resolveGroupFolderPath` from `group-folder.js` and `MediaPayload` from `types.js`
2. Add optional `sendMedia?: (jid: string, media: MediaPayload) => Promise<void>` to `IpcDeps`
3. In the message processing loop, when `data.media?.path` is present and `deps.sendMedia` exists:
   - Reject paths containing `..` (path traversal protection)
   - Convert container path (`/workspace/group/...`) to host path using `resolveGroupFolderPath`
   - Call `deps.sendMedia()` with the resolved host path
4. Fall back to `deps.sendMessage()` for text-only messages

**Security invariants:**
- Path traversal (`..`) is rejected
- Authorization check (isMain or same group) is applied before media sending, same as text
- Container paths are translated to host paths using the validated group folder resolver
- Preserve any existing task, snapshot, and host-specific IPC behavior outside the new media branch
