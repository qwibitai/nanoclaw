# Intent: src/container-runner.ts modifications

## What changed
Added a read-only volume mount for the shared images directory so container agents can access downloaded images.

## Key sections

### buildVolumeMounts()
- Added: Images directory mount after the `.claude` sessions mount, before the IPC mount:
  ```
  const imagesDir = path.join(DATA_DIR, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  mounts.push({
    hostPath: imagesDir,
    containerPath: '/workspace/images',
    readonly: true,
  });
  ```
- Mount is read-only so agents can view but not delete images
- Directory is created if it doesn't exist (`mkdirSync` with `recursive: true`)

## Invariants
- All existing mounts are unchanged
- Mount ordering is preserved (images added after session mounts, before IPC mounts)
- `buildContainerArgs()`, `runContainerAgent()`, and all other functions are untouched
- Additional mount validation via `validateAdditionalMounts` is unchanged
- The `readSecrets()` function and stdin-based secret passing are unchanged
- Container lifecycle (spawn, timeout, output parsing) is unchanged

## Must-keep
- All existing volume mounts (project root, group dir, global, sessions, skills sync, IPC, agent-runner, additional)
- The mount security model (allowlist validation for additional mounts)
- The container output streaming and marker parsing
- Timeout and idle management
