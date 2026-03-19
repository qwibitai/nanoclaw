# Intent: src/container-runner.ts modifications

## What changed
Added Docker socket mount and container group permissions so the agent can manage host Docker containers.

## Key sections

### buildVolumeMounts() — after agent-runner mount, before additionalMounts
- Added: Docker socket mount block that checks for `/var/run/docker.sock` existence
- Only mounts for main group (`isMain === true`) — non-main groups are sandboxed
- The socket is mounted read-write (Docker CLI needs write access to communicate with the daemon)

### buildContainerArgs() — after --user block, before mount loop
- Added: Detection of Docker socket in mount list via `mounts.some(m => m.containerPath === '/var/run/docker.sock')`
- Added: `--group-add 0` flag when Docker socket is present
- This is needed because Docker Desktop's Linux VM maps the socket to `root:root` inside containers
- Adding group 0 (root) gives the container user read/write access to the socket

## Invariants (must-keep)
- All existing mount logic unchanged (project root, .env shadow, group folder, sessions, IPC, agent-runner)
- User switching logic unchanged
- Additional mounts validation unchanged
- Container spawn, output parsing, timeout logic unchanged
- All exports unchanged
