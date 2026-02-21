# What this skill adds

- Adds IPC request handling for `update_canvas`.
- Adds response file writing under each group namespace (`/ipc/<group>/responses`).
- Extends `IpcDeps` with `updateCanvas(...)` carrying `eventsJsonl` payloads.

# Key sections

- `IpcDeps.updateCanvas` callback contract.
- `writeResponseFile(...)` helper.
- New `case 'update_canvas'` branch in `processTaskIpc`.

# Invariants

- Existing message/task authorization logic must not change.
- Existing IPC task types (`schedule_task`, `pause_task`, etc.) must keep current behavior.
- IPC watcher polling cadence and error handling must stay unchanged.

# Must-keep sections

- Per-group namespace scanning in `startIpcWatcher`.
- Authorization checks for message sends and scheduled task mutations.
