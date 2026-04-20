# Intent: container/Dockerfile modifications

## What changed
Added Docker CLI (static binary) so the container agent can manage host Docker containers.

## Key sections

### After apt-get install block
- Added: New `RUN` step that downloads Docker CLI static binary from download.docker.com
- Uses `uname -m` for architecture detection (works for both x86_64 and aarch64)
- Only installs the CLI binary (`docker/docker` from the tarball), not the daemon
- Version pinned to 27.5.1

## Invariants (must-keep)
- All Chromium dependencies unchanged
- agent-browser and claude-code npm global installs unchanged
- WORKDIR, COPY agent-runner, npm install, npm run build sequence unchanged
- Workspace directory creation unchanged
- Entrypoint script unchanged
- User switching (node user) unchanged
- ENTRYPOINT unchanged
