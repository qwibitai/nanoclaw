# Intent: container/Dockerfile modifications

## What changed
Updated the entrypoint script to shadow `.env` inside the container and drop privileges at runtime, replacing the Docker-style host-side file mount approach.

## Why
Apple Container (VirtioFS) only supports directory mounts, not file mounts. The Docker approach of mounting `/dev/null` over `.env` from the host causes `VZErrorDomain Code=2 "A directory sharing device configuration is invalid"`. The fix moves the shadowing into the entrypoint using `mount --bind` (which works inside the Linux VM).

## Key sections

### Entrypoint script
- Added: `mount --bind /dev/null /workspace/project/.env` when running as root and `.env` exists
- Added: Privilege drop via `setpriv --reuid=$RUN_UID --regid=$RUN_GID --clear-groups` for main-group containers
- Added: `chown` of `/tmp/input.json` and `/tmp/dist` to target user before dropping privileges
- Removed: `USER node` directive — main containers start as root to perform the bind mount, then drop privileges in the entrypoint. Non-main containers still get `--user` from the host.

### Dual-path execution
- Root path (main containers): shadow .env → compile → capture stdin → chown → setpriv drop → exec node
- Non-root path (other containers): compile → capture stdin → exec node

## Invariants
- The entrypoint still reads JSON from stdin and runs the agent-runner
- The compiled output goes to `/tmp/dist` (read-only after build)
- `node_modules` is symlinked, not copied
- Non-main containers are unaffected (they arrive as non-root via `--user`)

## Must-keep
- The `set -e` at the top
- The stdin capture to `/tmp/input.json` (required because setpriv can't forward stdin piping)
- The `chmod -R a-w /tmp/dist` (prevents agent from modifying its own runner)
- The `chown -R node:node /workspace` in the build step
