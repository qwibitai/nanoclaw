# Fix: Agent containers can't reach OpenViking server

## Context

The `graham-second-brain` agent runs in an ephemeral NanoClaw container and needs to reach the `sb-openviking` server (running via docker compose in `~/.SB_PERSONAL/`). The agent's `sb-search` skill uses `http://host.docker.internal:1933` for HTTP API calls (L0/L1/L2 content endpoints).

**Problem**: The OV docker-compose binds to `127.0.0.1:1933`, but `host.docker.internal` resolves to the docker bridge IP (`172.17.0.1`) inside agent containers — not loopback. So the connection is refused.

**Confirmed** by running a test container:
```
$ docker run --rm --add-host=host.docker.internal:host-gateway ...
172.17.0.1      host.docker.internal
FAILED: connection refused
```

## Approach: Shared Docker network (opt-in per group)

Put the OV sidecar and only the agent groups that need it on a shared Docker network, so they can reach `sb-openviking:1933` via Docker DNS. This preserves NanoClaw's container isolation model — groups without `dockerNetwork` configured stay on the default bridge and cannot see sidecar containers. The `nanoclaw` network is NanoClaw-owned; sidecars join it, not the other way around.

### Step 1: Create external Docker network at NanoClaw startup

Add `ensureDockerNetwork()` to `src/container-runtime.ts` (alongside `ensureContainerRuntimeRunning()`). It creates the `nanoclaw` network idempotently — if it already exists, Docker returns non-zero and we silently move on.

Then call it from `ensureContainerSystemRunning()` in `src/index.ts`, right after the runtime check:

```typescript
function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  ensureDockerNetwork();
  cleanupOrphans();
}
```

This way the network is NanoClaw-owned infrastructure, created on every startup before any containers are spawned.

### Step 2: Update `~/.SB_PERSONAL/docker-compose.yml`

Join the external `nanoclaw` network while keeping the existing compose-managed network for internal use.

```yaml
services:
  openviking:
    ...existing config...
    networks:
      - default
      - nanoclaw

networks:
  nanoclaw:
    external: true
```

Keep `127.0.0.1:1933` port binding — it still provides host-side access for healthchecks, manual curl, and `bootstrap.sh`.

### Step 3: Add `dockerNetwork` to `ContainerConfig` type

**File**: `src/types.ts`

Add optional field to `ContainerConfig`:
```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  secretKeys?: string[];
  envKeys?: string[];
  dockerNetwork?: string; // Docker network to join (e.g. 'nanoclaw')
}
```

### Step 4: Apply `--network` in `buildContainerArgs()`

**File**: `src/container-runner.ts`

Pass the group's `ContainerConfig` into `buildContainerArgs()` (currently only receives mounts + name). Add `--network` flag when `dockerNetwork` is set.

```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  containerConfig?: ContainerConfig, // new parameter
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Join a Docker network if configured (e.g. for reaching sidecar containers)
  if (containerConfig?.dockerNetwork) {
    args.push('--network', containerConfig.dockerNetwork);
  }

  // ...rest unchanged...
}
```

Update the call site at line ~319 to pass `group.containerConfig`.

**Isolation preserved**: Only groups with `dockerNetwork` set join the shared network. All other groups remain on the default bridge with no route to sidecar containers. Even on the shared network, agents can't reach each other (ephemeral, no listening ports) — and the OV API still requires a valid user key (only mounted into `graham-second-brain`).

**Note**: `--network` and `--add-host=host.docker.internal:host-gateway` are compatible — Docker adds the host entry to the specified network. The credential proxy at `http://host.docker.internal:<port>` continues to work.

### Step 5: Register `graham-second-brain` with `dockerNetwork`

Update the group's `containerConfig` in the database to include:
```json
{
  "dockerNetwork": "nanoclaw",
  "additionalMounts": [
    { "hostPath": "~/.SB_PERSONAL", "containerPath": ".SB_PERSONAL", "readonly": false },
    { "hostPath": "~/.openviking", "containerPath": ".openviking", "readonly": true }
  ]
}
```

### Step 6: Update `ovcli.conf` and `SKILL.md` URLs

Change `http://host.docker.internal:1933` to `http://sb-openviking:1933` in:
- `~/.openviking/ovcli.conf` — the `url` field
- `groups/graham-second-brain/.claude/skills/sb-search/SKILL.md` — all curl endpoints and the `OV_CONFIG` bootstrap

### Step 7: Update `~/.SB_PERSONAL/scripts/bootstrap.sh` (convenience fallback)

Add `docker network create nanoclaw 2>/dev/null || true` before `docker compose up -d`. This is a defensive fallback so the sidecar can start standalone (e.g. if someone restarts it without NanoClaw running). The primary owner of the network is NanoClaw's startup (Step 1).

## Files to modify

| File | Change |
|------|--------|
| `src/container-runtime.ts` | Add `ensureDockerNetwork()` — idempotent network creation |
| `src/index.ts` | Call `ensureDockerNetwork()` in `ensureContainerSystemRunning()` |
| `src/types.ts` | Add `dockerNetwork?: string` to `ContainerConfig` |
| `src/container-runner.ts` | Pass `containerConfig` to `buildContainerArgs()`, add `--network` flag |
| `~/.SB_PERSONAL/docker-compose.yml` | Add external `nanoclaw` network |
| `~/.SB_PERSONAL/scripts/bootstrap.sh` | Defensive fallback: create `nanoclaw` network before compose up |
| `~/.openviking/ovcli.conf` | Change URL to `http://sb-openviking:1933` |
| `groups/graham-second-brain/.claude/skills/sb-search/SKILL.md` | Change all URLs to `http://sb-openviking:1933` |

## Verification

1. `docker network create nanoclaw` (if not exists)
2. Restart OV: `cd ~/.SB_PERSONAL && docker compose down && docker compose up -d`
3. Verify OV is on the network: `docker inspect sb-openviking --format '{{json .NetworkSettings.Networks}}' | python3 -m json.tool` — should show `nanoclaw`
4. Test from an agent container:
   ```bash
   docker run --rm --network=nanoclaw --add-host=host.docker.internal:host-gateway \
     --entrypoint sh nanoclaw-agent:latest \
     -c 'curl -sf http://sb-openviking:1933/health'
   ```
   Should return `{"status":"ok","healthy":true,...}`
5. `npm run build` — typecheck passes
6. Send a test message to `graham-second-brain` that triggers the `sb-search` skill — verify the curl calls to `http://sb-openviking:1933/api/v1/content/*` succeed
