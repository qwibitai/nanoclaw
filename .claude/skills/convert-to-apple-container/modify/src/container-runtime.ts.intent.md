# Intent: src/container-runtime.ts modifications

## What changed
Replaced Docker runtime with Apple Container runtime. This is a full file replacement — the exported API is identical, only the implementation differs.

## Key sections

### CONTAINER_RUNTIME_BIN
- Changed: `'docker'` → `'container'` (the Apple Container CLI binary)

### readonlyMountArgs
- Changed: Docker `-v host:container:ro` → Apple Container `--mount type=bind,source=...,target=...,readonly`

### ensureContainerRuntimeRunning
- Changed: `docker info` → `container system status` for checking
- Added: auto-start via `container system start` when not running (Apple Container supports this; Docker requires manual start)
- Changed: error message references Apple Container instead of Docker

### cleanupOrphans
- Changed: `docker ps --filter name=nanoclaw- --format '{{.Names}}'` → `container ls --format json` with JSON parsing
- Apple Container returns JSON with `{ status, configuration: { id } }` structure

### CONTAINER_HOST_GATEWAY
- Set to `'192.168.64.1'` — the default gateway for Apple Container VMs to reach the host
- Docker uses `'host.docker.internal'` which is resolved differently

### hostGatewayArgs
- Returns `[]` — Apple Container provides host networking natively on macOS
- Docker version returns `['--add-host=host.docker.internal:host-gateway']` on Linux

## Invariants
- All exports remain identical: `CONTAINER_RUNTIME_BIN`, `CONTAINER_HOST_GATEWAY`, `readonlyMountArgs`, `stopContainer`, `hostGatewayArgs`, `ensureContainerRuntimeRunning`, `cleanupOrphans`
- `stopContainer` implementation is unchanged (`<bin> stop <name>`)
- Logger usage pattern is unchanged
- Error handling pattern is unchanged

## Must-keep
- The exported function signatures (consumed by container-runner.ts and index.ts)
- The error box-drawing output format
- The orphan cleanup logic (find + stop pattern)
- `CONTAINER_HOST_GATEWAY` must match the address the credential proxy is reachable at from within the VM
