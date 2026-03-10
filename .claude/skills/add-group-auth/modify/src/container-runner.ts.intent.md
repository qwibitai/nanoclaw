# Intent: Register container IP for credential proxy identification

## What changed
1. `buildContainerArgs` takes `groupFolder` parameter (for `detectAuthMode`)
2. `ANTHROPIC_BASE_URL` is plain `http://{gateway}:{port}` (no `/scope/` prefix)
3. After spawn, queries container's bridge IP via `docker inspect` and registers it with the proxy
4. On container close/error, unregisters the IP mapping
5. `detectAuthMode(groupFolder)` called with group scope

## Why
The credential proxy now identifies containers by their Docker bridge IP
(see credential-proxy.ts.intent.md). Each container gets a unique IP on the
bridge network, assigned by the kernel and not spoofable from within the container.
This replaces the URL prefix approach which required path rewriting.

## Key sections

### getContainerIP helper (~lines 32-42)
- Runs `docker inspect --format '{{.NetworkSettings.IPAddress}}' <name>`
- Returns the container's bridge IP or null on failure

### IP registration after spawn (~lines 335-347)
- 500ms delay to let container start and get IP assigned
- Calls `registerContainerIP(ip, group.folder)` on success
- Warns if IP cannot be determined (proxy falls back to default credentials)

### ANTHROPIC_BASE_URL (~lines 242-247)
- `http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}/claude`
- `/claude` prefix identifies the service; proxy strips it before forwarding upstream

### Cleanup on close/error (~lines 473, 683)
- `unregisterContainerIP(containerIP)` on both close and error handlers

### Call site in runContainerAgent (~line 287)
- `buildContainerArgs(mounts, containerName, group.folder)`

## Invariants
- No secrets passed via stdin (credential proxy handles injection)
- No `secrets` field on ContainerInput
- All other functions unchanged
- Volume mounts, timeout behavior, output parsing all unchanged
