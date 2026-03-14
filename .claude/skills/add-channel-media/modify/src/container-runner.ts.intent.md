# Intent: src/container-runner.ts modifications

## What changed
Added per-group media directory mount to container configuration.

## Key changes

### Import
Added `MEDIA_DIR` from `./config.js`

### buildVolumeMounts()
Added a new mount block after the IPC directory mount:
```typescript
const groupMediaDir = path.join(MEDIA_DIR, group.folder);
fs.mkdirSync(groupMediaDir, { recursive: true });
mounts.push({
  hostPath: groupMediaDir,
  containerPath: '/workspace/media',
  readonly: false,
});
```

This mounts `data/media/{group.folder}/` into the container at `/workspace/media/`, giving each group isolated media storage. The directory is writable so agents can create files (charts, documents) to send outbound.

## Invariants
- All existing mounts are unchanged (group dir, sessions, IPC, agent-runner, additional mounts)
- Mount order: media mount is placed between IPC mount and agent-runner mount
- The container can read/write media files but cannot access other groups' media

## Must-keep
- All existing volume mount logic
- The readSecrets() function
- buildContainerArgs() and runContainerAgent()
- writeTasksSnapshot() and writeGroupsSnapshot()
