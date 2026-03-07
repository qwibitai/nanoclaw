# Intent: src/container-runner.ts modifications

## What changed
Updated `buildContainerArgs` to support Apple Container's .env shadowing mechanism. The function now accepts an `isMain` parameter and uses it to decide how container user identity is configured.

## Why
Apple Container (VirtioFS) only supports directory mounts, not file mounts. The previous approach of mounting `/dev/null` over `.env` from the host causes a `VZErrorDomain` crash. Instead, main-group containers now start as root so the entrypoint can `mount --bind /dev/null` over `.env` inside the Linux VM, then drop to the host user via `setpriv`.

## Key sections

### buildContainerArgs (signature change)
- Added: `isMain: boolean` parameter
- Main containers: passes `RUN_UID`/`RUN_GID` env vars instead of `--user`, so the container starts as root
- Non-main containers: unchanged, still uses `--user` flag

### buildVolumeMounts
- Removed: the `/dev/null` → `/workspace/project/.env` shadow mount
- The .env shadowing is now handled inside the container entrypoint instead

### runContainerAgent (call site)
- Changed: `buildContainerArgs(mounts, containerName)` → `buildContainerArgs(mounts, containerName, input.isMain)`

## Invariants
- All exported interfaces unchanged: `ContainerInput`, `ContainerOutput`, `runContainerAgent`, `AvailableGroup`
- Non-main containers behave identically (still get `--user` flag)
- JSON-RPC server/client setup unchanged
- Handler registration unchanged
- Secrets passed via JSON-RPC initialize request

## Must-keep
- The `isMain` parameter on `buildContainerArgs` (consumed by `runContainerAgent`)
- The `RUN_UID`/`RUN_GID` env vars for main containers (consumed by entrypoint.sh)
- The `--user` flag for non-main containers (file permission compatibility)
