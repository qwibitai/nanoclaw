# Intent: src/container-runner.ts

## What Changed

- Added `--pull=never` flag to `buildContainerArgs` to prevent Docker from pulling images from registries
- IPC subdirs (messages, tasks, input) get `chmod 0o777` for cross-user container access
- Debug dir created under group sessions `.claude` dir with 0o777 permissions

## Key Sections

- **buildContainerArgs**: --pull=never added
- **buildVolumeMounts**: IPC dir chmod, debug dir creation

## Invariants (must-keep)

- ContainerInput/ContainerOutput interfaces
- buildVolumeMounts mount structure (group dir, sessions, IPC, extra dirs, env, agent-runner source)
- readSecrets function
- runContainerAgent streaming output parsing (OUTPUT_START/END markers)
- writeTasksSnapshot, writeGroupsSnapshot functions
- Mount security validation
- Host UID/GID mapping logic
