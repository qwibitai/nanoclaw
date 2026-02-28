# What this skill adds

- Boots a local canvas HTTP server (`/canvas`, `/api/canvas/*`) at startup.
- Adds canvas update handling and exposes it to IPC as `updateCanvas`.
- Routes canvas updates through HTTP `POST /api/canvas/:group/events` using SpecStream JSONL.
- Ensures graceful shutdown includes canvas server teardown.

# Key sections

- New imports for `GENUI_PORT`, `CanvasServer`, and `CanvasStore`.
- New helper functions:
  - `findGroupByFolder`
  - `resolveTargetGroupFolder`
  - `normalizeCanvasEventsJsonl`
  - `updateCanvasState`
- `main()` now initializes/stops canvas server and wires `updateCanvas` into `startIpcWatcher`.

# Invariants

- Existing message loop, queueing, and channel behavior must remain intact.
- Existing startup/shutdown behavior must still gracefully stop channels/containers.
- Canvas authorization must preserve main vs non-main boundaries.

# Must-keep sections

- `processGroupMessages`, `runAgent`, `startMessageLoop`, `recoverPendingMessages`.
- Direct-run guard (`isDirectRun`) and exported helper (`_setRegisteredGroups`).
