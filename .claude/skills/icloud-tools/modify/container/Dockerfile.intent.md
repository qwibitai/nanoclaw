# Intent: container/Dockerfile modifications

## What changed
Added build steps for the icloud-tools MCP server.

## Key sections
### icloud-tools build (after agent-runner)
- Copies package.json first for Docker layer caching
- Full npm install (devDeps needed for tsc), then compile, then prune
- Output: /opt/icloud-tools/dist/server.js

## Invariants (must-keep)
- All existing apt-get packages unchanged
- Chromium and agent-browser setup unchanged
- agent-runner build steps unchanged
- Workspace directories, entrypoint, user switching unchanged
