# Intent: container/Dockerfile modifications

## What changed
Added `/workspace/media` to the workspace directory creation.

## Key change
The `mkdir -p` line that creates workspace directories now includes `/workspace/media`:
```
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/media
```

This ensures the media directory exists in the container before any mounts are applied, preventing permission issues.

## Invariants
- All other Dockerfile instructions are unchanged
- The media directory is created alongside existing workspace directories
- Ownership is set to node user (via existing `chown -R node:node /workspace`)
