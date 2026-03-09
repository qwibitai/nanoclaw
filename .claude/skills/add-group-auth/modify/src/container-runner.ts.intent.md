# Intent: Pass group scope to credential proxy via URL prefix

## What changed
1. `buildContainerArgs` takes new `groupFolder` parameter
2. `ANTHROPIC_BASE_URL` now includes `/scope/<groupFolder>/` prefix so the proxy resolves per-group credentials
3. `detectAuthMode(groupFolder)` called with group scope instead of no args
4. Call site passes `group.folder` to `buildContainerArgs`

## Why
The credential proxy is now group-aware (see credential-proxy.ts.intent.md).
Each container's API traffic is tagged with its group identity via the URL prefix,
so the proxy can resolve the correct credentials for that group.

## Key sections

### buildContainerArgs signature (~line 215)
- Added `groupFolder: string` parameter

### ANTHROPIC_BASE_URL (~lines 225-230)
- Was: `http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`
- Now: `http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}/scope/${encodeURIComponent(groupFolder)}`

### detectAuthMode call (~line 237)
- Was: `detectAuthMode()`
- Now: `detectAuthMode(groupFolder)`

### Call site in runContainerAgent (~line 284)
- Was: `buildContainerArgs(mounts, containerName)`
- Now: `buildContainerArgs(mounts, containerName, group.folder)`

## Invariants
- No secrets passed via stdin (credential proxy handles injection)
- No `secrets` field on ContainerInput (removed by credential proxy PR)
- All other functions unchanged
- Volume mounts, timeout behavior, output parsing all unchanged
