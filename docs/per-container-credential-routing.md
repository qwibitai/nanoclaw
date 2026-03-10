# Per-Container Credential Routing

## Problem

The credential proxy runs on a single port shared by all containers. Currently it injects the same credentials for every request. With per-group auth (`add-group-auth` skill), each group may have its own Claude credentials. The proxy needs to know **which container** is making a request so it can inject the correct credentials.

## Approach: TCP Source IP Identification

Each Docker container on a bridge network gets a unique IP (e.g. `172.17.0.2`, `172.17.0.3`). The kernel assigns this — containers cannot spoof it. The proxy can read `req.socket.remoteAddress` to identify the caller.

### Flow

1. `container-runner.ts` spawns a container
2. After start, query its IP: `docker inspect --format '{{.NetworkSettings.IPAddress}}' <name>`
3. Register the mapping: `containerIP → group`
4. Proxy receives request, reads `req.socket.remoteAddress`, looks up the group
5. Injects that group's credentials (or falls back to the default/shared credentials)
6. On container exit, remove the mapping

### Why This Works

- Docker bridge assigns each container a unique IP
- Source IP is set by the kernel — not spoofable from within the container
- No Unix sockets, no `SO_PEERCRED`, no PID namespace translation needed
- Simple TCP-level identification, no changes to the container image

### Platform Caveat

On **Docker Desktop** (macOS/Windows), containers run inside a VM. All containers may appear to come from the same gateway IP, making source-IP identification unreliable. This approach works reliably on **bare-metal Linux** where each container has a distinct bridge IP.

Possible workaround for Docker Desktop: assign containers to a custom bridge network with known IPs, or use `--ip` to pin container IPs at launch time.

## Alternatives Considered

| Approach | Verdict |
|----------|---------|
| Unix socket + `SO_PEERCRED` | Gives PID/UID — but UID is shared across all container processes, PID requires namespace translation |
| Binary path verification via `/proc/<pid>/exe` | Works for caller verification but doesn't identify *which* container |
| Per-container proxy port | Reliable but wasteful — one port per container |
| Custom header from container | Trivially spoofable by any process in the container |
| Separate Docker network per container | Reliable but complex network management |
