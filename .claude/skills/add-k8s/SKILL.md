---
name: add-k8s
description: Run NanoClaw in Kubernetes. Adds child-process runner, Dockerfile.ws, and K8s entrypoint. Requires /add-management-ws first.
---

# Add Kubernetes Support

Runs NanoClaw as a WebSocket management API server in a container, spawning Claude CLI as child processes instead of Docker containers. Designed for Kubernetes and other container orchestrators where Docker-in-Docker isn't available.

## Prerequisites

This skill requires `/add-management-ws` to be applied first. Check if `src/management/server.ts` exists — if not, run `/add-management-ws` first.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/k8s-entrypoint.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

Verify management-ws is applied:

```bash
ls src/management/server.ts
```

If missing, tell the user to run `/add-management-ws` first.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/k8s
git merge upstream/skill/k8s
```

This merges in:
- `src/child-process-runner.ts` (AgentRunner implementation using Claude CLI)
- `src/k8s-entrypoint.ts` (wires runner + management server)
- `container/Dockerfile.ws` (K8s-optimized container image)
- `container/build-ws.sh` (build script)
- `start:ws` npm script
- Env var additions in `.env.example`

### Install dependencies

```bash
npm install
```

### Build the container image

```bash
./container/build-ws.sh
```

## Phase 3: Configure

### Set environment variables

Add to `.env`:

```bash
# Required
MANAGEMENT_TOKEN=<your-token>
ANTHROPIC_API_KEY=<your-api-key>

# Optional
MANAGEMENT_PORT=18789
MAX_CONCURRENT_AGENTS=3
MODEL_PRIMARY=claude-sonnet-4-20250514
SYSTEM_PROMPT=
```

## Phase 4: Verify

### Test locally with Docker

```bash
docker run -p 18789:18789 \
  -e MANAGEMENT_TOKEN=test-secret \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  nanoclaw-ws:latest
```

In another terminal, test the health endpoint:

```bash
curl http://localhost:18789/health
```

Expected: `{"status":"ok"}`

### Test WebSocket connection

```bash
node --input-type=module -e "
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:18789');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token: 'test-secret' }));
});
ws.on('message', (data) => {
  console.log(JSON.parse(data.toString()));
  ws.close();
});
"
```

Expected: `{ type: 'auth', ok: true }`

## Troubleshooting

### "No Anthropic credentials configured"

The child-process runner checks for credentials before spawning Claude CLI. Ensure one of these is set:
- `ANTHROPIC_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_BASE_URL` (for proxy setups)

### Container builds but Claude CLI not found

The Dockerfile installs `@anthropic-ai/claude-code` globally. If the install failed, check the build logs. May need to rebuild with `--no-cache`:

```bash
docker builder prune -f
./container/build-ws.sh
```

### Max concurrent agents reached

Increase `MAX_CONCURRENT_AGENTS` env var. Default is 3.
