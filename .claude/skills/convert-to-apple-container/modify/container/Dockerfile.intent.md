# Intent: container/Dockerfile modifications

## What changed
Updated the entrypoint script to shadow `.env` inside the container and drop privileges at runtime, replacing the Docker-style host-side file mount approach.

## Why
Apple Container (VirtioFS) only supports directory mounts, not file mounts. The Docker approach of mounting `/dev/null` over `.env` from the host causes `VZErrorDomain Code=2`. The fix moves the shadowing into the entrypoint using `mount --bind`.

## Key sections

### Entrypoint script
- Added: `mount --bind /dev/null /workspace/project/.env` when running as root and `.env` exists
- Added: Privilege drop via `setpriv --reuid=$RUN_UID --regid=$RUN_GID --clear-groups` for main-group containers
- Removed: `USER node` directive — main containers start as root to perform the bind mount, then drop privileges in the entrypoint
- JSON-RPC requires live stdin — no stdin capture to temp file

### Dual-path execution
- Root path (main containers): shadow .env → compile → drop privileges → exec node (live stdin)
- Non-root path (other containers): compile → exec node (live stdin)

## Invariants
- Communication uses JSON-RPC 2.0 over stdio (stdin/stdout)
- The compiled output goes to `/tmp/dist` (read-only after build)
- `node_modules` is symlinked, not copied
- Non-main containers are unaffected (they arrive as non-root via `--user`)

## Must-keep
- The `set -e` at the top
- Live stdin passthrough (JSON-RPC transport reads stdin directly — no `cat > /tmp/input.json`)
- The `chmod -R a-w /tmp/dist` (prevents agent from modifying its own runner)
- The `chown -R node:node /workspace` in the build step
