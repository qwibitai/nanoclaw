# What this skill adds

- Updates IPC auth tests for the new `IpcDeps.updateCanvas` dependency.
- Adds `update_canvas` forwarding tests for main and non-main contexts.

# Key sections

- `deps` setup now includes `updateCanvas`.
- New `describe('update_canvas authorization')` block.

# Invariants

- Existing auth tests for schedule/pause/resume/cancel/register must remain unchanged.
- Test DB setup/reset behavior must remain unchanged.

# Must-keep sections

- `beforeEach` DB/group setup.
- Existing authorization describe blocks.
