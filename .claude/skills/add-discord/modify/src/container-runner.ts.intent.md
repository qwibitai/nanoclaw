# Intent: Add files IPC subdirectory

Add `fs.mkdirSync(path.join(groupIpcDir, 'files'), { recursive: true });`
alongside the existing `messages`, `tasks`, and `input` directory creation
in the `buildVolumeMounts` function.

This creates a per-group `files/` directory under the IPC path so
channels can download attachments (images, documents, spreadsheets,
audio, etc.) for the agent to read/view with the Read tool.
The directory is created at container startup alongside other IPC
subdirectories.

This is an append-only change — existing mkdir lines must be preserved.
