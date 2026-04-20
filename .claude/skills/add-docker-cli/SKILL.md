---
name: add-docker-cli
description: Add Docker CLI access so the container agent can manage host containers. Monitor, start, stop, inspect, and view logs of Docker containers running on the host machine.
---

# Add Docker CLI

Gives the container agent full Docker CLI access to the host's Docker daemon via socket mount. The agent can monitor containers, view logs, start/stop services, and more.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-docker-cli` is in `applied_skills`, skip to Phase 3 (Verify).

## Security Notice

**STOP — Read this before proceeding.**

This skill mounts the host's Docker socket (`/var/run/docker.sock`) into the container agent. This gives the agent **full control over Docker on the host machine**, including the ability to:

- Start, stop, and remove any container
- Pull and delete images
- Inspect container environments (which may contain secrets)
- Run new containers with arbitrary mounts (potential host filesystem access)

The socket is only mounted for the **main group** — non-main groups do not get Docker access. The agent-facing instructions include a "Never Run" list for destructive commands, but this is advisory, not enforced.

**Only apply this skill if you trust your main group agent with Docker-level access to your host.**

Confirm with the user that they understand these implications before continuing.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-docker-cli
```

This deterministically:
- Adds `container/skills/docker/SKILL.md` (agent-facing documentation)
- Three-way merges Docker CLI install into `container/Dockerfile`
- Three-way merges Docker socket mount + group-add into `src/container-runner.ts`
- Records application in `.nanoclaw/state.yaml`

If merge conflicts occur, read the intent files:
- `modify/container/Dockerfile.intent.md`
- `modify/src/container-runner.ts.intent.md`

### Validate

```bash
npm test
npm run build
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Test Docker access

Ask the agent to list running containers:

> What Docker containers are running right now?

The agent should be able to run `docker ps` and return results.

### Test container inspection

Ask the agent to check logs of a specific container:

> Show me the last 20 lines of logs from the redis container

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i docker
```

Look for:
- Mount configuration showing `/var/run/docker.sock` — socket is mounted
- No permission errors in container output

## Troubleshooting

### Agent says "docker: command not found"

Container needs rebuilding. Run `./container/build.sh` and restart the service.

### Permission denied on Docker socket

The container needs `--group-add 0` to access the socket (Docker Desktop maps it to root:root inside Linux containers). Verify `src/container-runner.ts` includes the group-add logic. On native Linux, the socket may be owned by a `docker` group with a different GID — you may need to change `'0'` to the actual GID (find it with `stat -c '%g' /var/run/docker.sock`).

### Docker socket not found

Docker Desktop must be running. The socket at `/var/run/docker.sock` must exist on the host.

### Only works for main group

By design, only the main group gets Docker socket access. Non-main groups are sandboxed and should not have host-level container control.

## Advanced: Remote Docker

The Docker CLI supports remote hosts via `DOCKER_HOST`. To connect to remote machines:

- **SSH**: `DOCKER_HOST=ssh://user@remote-server docker ps` (requires SSH keys mounted into the container via `additionalMounts`)
- **TCP+TLS**: `DOCKER_HOST=tcp://remote:2376 docker ps` (requires TLS certs)

These require additional mount configuration beyond this skill's scope.
