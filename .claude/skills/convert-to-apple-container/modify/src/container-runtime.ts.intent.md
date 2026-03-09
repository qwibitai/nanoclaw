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
- Dynamically detected at startup via `container network ls --format json`
- Reads `status.ipv4Gateway` from the `default` network (e.g. `192.168.65.1`)
- The subnet varies across machines — cannot be hardcoded
- Falls back to `192.168.64.1` if detection fails
- Docker uses `'host.docker.internal'` which is resolved differently

### PROXY_BIND_HOST
- Set to `'0.0.0.0'` — Apple Container VMs reach the host via the bridge gateway, so the proxy must listen on all interfaces
- Docker (macOS) uses `'127.0.0.1'` because Docker Desktop routes `host.docker.internal` to loopback
- Overridable via `CREDENTIAL_PROXY_HOST` env var

### hostGatewayArgs
- Returns `[]` — Apple Container provides host networking natively on macOS
- Docker version returns `['--add-host=host.docker.internal:host-gateway']` on Linux

## Invariants
- All exports remain identical: `CONTAINER_RUNTIME_BIN`, `CONTAINER_HOST_GATEWAY`, `PROXY_BIND_HOST`, `readonlyMountArgs`, `stopContainer`, `hostGatewayArgs`, `ensureContainerRuntimeRunning`, `cleanupOrphans`
- `stopContainer` implementation is unchanged (`<bin> stop <name>`)
- Logger usage pattern is unchanged
- Error handling pattern is unchanged

## Must-keep
- The exported function signatures (consumed by container-runner.ts and index.ts)
- The error box-drawing output format
- The orphan cleanup logic (find + stop pattern)
- `CONTAINER_HOST_GATEWAY` must match the address the credential proxy is reachable at from within the VM
