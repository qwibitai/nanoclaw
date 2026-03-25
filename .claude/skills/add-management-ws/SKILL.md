---
name: add-management-ws
description: Add WebSocket management API server. Provides remote control of NanoClaw via authenticated WebSocket connections. Required by /add-k8s.
---

# Add WebSocket Management API

Adds a WebSocket management server with token authentication, request/response framing, and event streaming. This is the foundation for remote management interfaces (K8s, web UIs, etc.).

Adds:
- WebSocket server with timing-safe token auth
- HTTP health/readiness endpoints (`/health`, `/readyz`)
- `AgentRunner` interface for pluggable runner backends
- Stream-json parser for Claude CLI output
- Protocol types: `chat.send`, `chat.abort`, `chat.delta`, `chat.final`, `chat.error`, `agent.tool`

## Phase 1: Pre-flight

### Check if already applied

Check if `src/management/server.ts` exists. If it does, skip to Phase 3 (Configure).

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
git fetch upstream skill/management-ws
git merge upstream/skill/management-ws
```

This merges in:
- `src/management/` directory (server, protocol, auth, handlers, agent-runner interface, stream-parser)
- `ws` + `@types/ws` npm dependencies
- `MANAGEMENT_TOKEN` and `MANAGEMENT_PORT` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files.

### Install dependencies

```bash
npm install
```

### Validate

```bash
npm run build
npm test
```

Build and tests must be clean before proceeding.

## Phase 3: Configure

### Set management token

Add to `.env`:

```bash
MANAGEMENT_TOKEN=<generate-a-secure-random-token>
```

### Set port (optional)

Default is 18789. Override with:

```bash
MANAGEMENT_PORT=18789
```

## Phase 4: Verify

### Run the tests

```bash
npm test
```

All management tests should pass.

### Test the health endpoint manually

```bash
npm run build
node --input-type=module -e "
import { ManagementServer } from './dist/management/server.js';
import { createHandlers } from './dist/management/handlers.js';
import { EventEmitter } from 'events';

const runner = Object.assign(new EventEmitter(), {
  spawn: async (opts) => ({ sessionKey: opts.sessionKey, startedAt: new Date() }),
  sendMessage: async () => {},
  kill: async () => {},
  killAll: async () => {},
  get activeCount() { return 0; },
  getSession: () => undefined,
});

const handlers = createHandlers(runner);
const server = new ManagementServer({ port: 18789, handlers });
await server.start();
console.log('Management server running on :18789');
const res = await fetch('http://localhost:18789/health');
console.log('Health:', await res.json());
await server.stop();
console.log('OK');
"
```

Expected: `Health: { status: 'ok' }` then `OK`.

## Troubleshooting

### WebSocket connection rejected

1. Verify `MANAGEMENT_TOKEN` is set in your `.env`
2. Ensure the first frame sent is `{"type":"auth","token":"your-token"}`
3. Auth must happen within 5 seconds or the connection is closed
