# What this skill adds

- Ensures `/workspace/ipc/responses` exists in each group IPC namespace for synchronous canvas tool replies.

# Key sections

- `buildVolumeMounts(...)` now creates `responses` alongside `messages`, `tasks`, and `input`.

# Invariants

- Existing mount isolation boundaries must remain unchanged.
- Existing session/skills mount behavior must remain unchanged.
- Main/non-main mount permissions must remain unchanged.

# Must-keep sections

- `buildVolumeMounts` logic for project/group/global mounts.
- IPC namespace mount at `/workspace/ipc`.
