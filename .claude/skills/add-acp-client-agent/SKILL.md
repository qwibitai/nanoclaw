---
name: add-acp-client-agent
description: Route a NanoClaw agent group to any external AI agent that speaks the ACP Client Protocol (agentclientprotocol.com) — a JSON-RPC 2.0 protocol over TCP or stdio. NanoClaw acts as the editor/client. Works with Groq (free), any AI coding agent, or a custom server. Supports bidirectional file access so the agent can read/write workspace files. No npm dependencies, no container rebuild needed.
---

# ACP Client Protocol Provider

Routes an agent group's conversations to any external AI agent that speaks the
[ACP Client Protocol](https://agentclientprotocol.com) — JSON-RPC 2.0 over
TCP or stdin/stdout. NanoClaw acts as the **editor/client**: it drives the
agent through `initialize → session/new → session/prompt` and collects
streaming `session/update` notifications.

The agent can also call back into NanoClaw via `fs/read_text_file` and
`fs/write_text_file` to read or write files in `/workspace`.

Two connection modes:
- **Subprocess**: NanoClaw spawns the agent as a child process (stdin/stdout)
- **TCP**: NanoClaw connects to a running agent server

No new npm dependencies. No container image rebuild required.

## Install

### Pre-flight

Skip to **Configuration** if all of these are already present:

- `src/providers/acp-client.ts`
- `container/agent-runner/src/providers/acp-client.ts`
- `import './acp-client.js';` in `src/providers/index.ts`
- `import './acp-client.js';` in `container/agent-runner/src/providers/index.ts`

All steps below are idempotent — safe to re-run.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the provider source files

```bash
git show origin/providers:src/providers/acp-client.ts \
  > src/providers/acp-client.ts

git show origin/providers:container/agent-runner/src/providers/acp-client.ts \
  > container/agent-runner/src/providers/acp-client.ts
```

### 3. Wire the self-registration imports

Append to `src/providers/index.ts` if the line is not already present:

```typescript
import './acp-client.js';
```

Append to `container/agent-runner/src/providers/index.ts` if not already present:

```typescript
import './acp-client.js';
```

### 4. Build the host

```bash
pnpm run build
```

No container rebuild needed — `container/agent-runner/src/` is bind-mounted
read-only into every container at spawn time.

### 5. Verify

```bash
grep -q "'./acp-client.js'" src/providers/index.ts \
  && echo "host barrel: OK" || echo "host barrel: MISSING"

grep -q "'./acp-client.js'" container/agent-runner/src/providers/index.ts \
  && echo "container barrel: OK" || echo "container barrel: MISSING"

pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit \
  && echo "container typecheck: OK"
```

## Configuration

### 1. Create the agent group folder

```bash
mkdir -p groups/<folder>
```

### 2. Create acp-client.json

**Subprocess mode** (NanoClaw spawns the agent — no server to manage):
```json
{ "command": ["python3", "/path/to/my-agent.py"] }
```

**TCP mode** (connect to a running agent server):
```json
{ "host": "host.docker.internal", "port": 7787 }
```

Per-group `acp-client.json` always wins over global env vars. Global fallback:
`ACP_CLIENT_CMD`, `ACP_CLIENT_HOST`, `ACP_CLIENT_PORT` in `.env`.

### 3. Create container.json

```json
{
  "mcpServers": {},
  "packages": { "apt": [], "npm": [] },
  "additionalMounts": [],
  "skills": "all",
  "agentGroupId": "ag-GENERATED",
  "groupName": "My ACP Client Agent",
  "assistantName": "My ACP Client Agent",
  "provider": "acp-client"
}
```

Generate a unique `agentGroupId`:
```bash
node -e "console.log('ag-' + Date.now() + '-' + Math.random().toString(36).slice(2,8))"
```

### 4. Set the provider in the database

Run this from the **project root** (the directory containing `data/` and `node_modules/`):

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
db.prepare('UPDATE agent_groups SET agent_provider = ? WHERE folder = ?')
  .run('acp-client', 'YOUR-GROUP-FOLDER');
console.log('updated:', db.prepare(
  'SELECT folder, agent_provider FROM agent_groups WHERE folder = ?'
).get('YOUR-GROUP-FOLDER'));
"
```

### 5. Choose routing mode

Ask the user how they want messages routed to this agent, then run the matching commands.

**Option A — Trigger prefix** (share a channel with the main agent)
Only messages starting with a specific prefix go to this agent. Ask the user for their preferred prefix (e.g. `groq:`, `agent:`, `a2a:`).

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
const ag = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get('YOUR-FOLDER');
db.prepare(\`INSERT INTO messaging_group_agents
  (id, messaging_group_id, agent_group_id, session_mode, priority,
   created_at, engage_mode, engage_pattern, sender_scope, ignored_message_policy)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`)
  .run('mga-' + Date.now(), 'YOUR-MESSAGING-GROUP-ID', ag.id,
       'per-thread', 20, new Date().toISOString(),
       'pattern', '^PREFIX:', 'all', 'drop');
console.log('wired trigger: ^PREFIX:');
"
```

Then exclude the prefix from the main agent's pattern:

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
const row = db.prepare(
  'SELECT id, engage_pattern FROM messaging_group_agents WHERE agent_group_id = ?'
).get('YOUR-MAIN-AGENT-GROUP-ID');
const updated = row.engage_pattern.replace(')', '|PREFIX:)');
db.prepare('UPDATE messaging_group_agents SET engage_pattern = ? WHERE id = ?')
  .run(updated, row.id);
console.log('main agent pattern updated:', updated);
"
```

**Option B — Default agent** (this agent handles all messages in the channel)
No prefix needed. Wire with `engage_mode = 'always'`.

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
const ag = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get('YOUR-FOLDER');
db.prepare(\`INSERT INTO messaging_group_agents
  (id, messaging_group_id, agent_group_id, session_mode, priority,
   created_at, engage_mode, engage_pattern, sender_scope, ignored_message_policy)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`)
  .run('mga-' + Date.now(), 'YOUR-MESSAGING-GROUP-ID', ag.id,
       'per-thread', 20, new Date().toISOString(),
       'always', null, 'all', 'drop');
console.log('wired as default agent');
"
```

If a main Claude agent is already wired to this messaging group, ask the user whether to remove it or keep it at a lower priority as a fallback.

**Option C — Dedicated channel**
The user will use a separate chat or channel exclusively for this agent. No wiring needed now — when the dedicated channel is set up, use Option B for it.
## Running an ACP agent for testing

### Option A — Groq test agent (subprocess mode, no server needed)

1. Get a free key at https://console.groq.com
2. Add `GROQ_API_KEY=your_key` to `.env`
3. Copy the test agent:

```bash
git show origin/providers:scripts/test-acp-client-server.py \
  > scripts/test-acp-client-server.py
```

4. Set subprocess mode in `acp-client.json`:

```json
{ "command": ["python3", "scripts/test-acp-client-server.py"] }
```

NanoClaw will spawn this script automatically per session. No port, no
terminal, no server to manage.

### Option B — TCP server mode (Groq)

```bash
GROQ_API_KEY=$(grep GROQ_API_KEY .env | cut -d= -f2) \
  nohup python3 scripts/test-acp-client-server.py --tcp 7787 \
  > logs/acp-client.log 2>&1 &
```

In `acp-client.json`: `{ "host": "host.docker.internal", "port": 7787 }`

### Option C — Echo mode (no API key)

```json
{ "command": ["python3", "scripts/test-acp-client-server.py", "--echo"] }
```

Returns `"Echo: <your message>"`. Useful for testing the protocol wiring without an API key.

### Option D — Any ACP-compatible agent

Any process that reads JSON-RPC 2.0 from stdin and writes to stdout. Minimum
required methods: `initialize`, `session/new`, `session/prompt`.

See `docs/acp-client-code-walkthrough.md` for a minimal Python implementation.

## How it works

1. NanoClaw opens a connection (subprocess or TCP) to the agent.
2. Sends `initialize` (handshake + capabilities).
3. Sends `session/new { cwd: "/workspace" }` — gets back a `sessionId`.
4. Sends `session/prompt` with the user's message.
5. While waiting, `session/update` notifications arrive with streaming text chunks.
6. The agent may send `fs/read_text_file` or `fs/write_text_file` requests at
   any time — NanoClaw serves these from `/workspace` (path-traversal protected).
7. When `session/prompt` responds with `stopReason: "done"`, all chunks are
   assembled and delivered to the user.
8. Connection is closed. Each turn opens a fresh connection.

## Troubleshooting

**"ACP_CLIENT_CMD or ACP_CLIENT_HOST+ACP_CLIENT_PORT required" in container logs**
The `acp-client.json` is missing or the database still has the old `agent_provider`.
Check step 2 (config file) and step 4 (DB update).

**"Failed to connect to ACP agent"**
In TCP mode: the agent server is not running or not reachable. Use
`host.docker.internal` (not `localhost`).
In subprocess mode: the command path is wrong or the script has a syntax error.
Test manually: `python3 scripts/test-acp-client-server.py --echo`

**No response / timeout**
The agent's `session/prompt` never responded with `stopReason: "done"`.
Check the agent logs for errors. In subprocess mode, check the process
didn't exit early.

**"Path outside workspace" error**
The agent sent an `fs/read_text_file` or `fs/write_text_file` for a path
outside `/workspace`. This is a security guard — the agent cannot access host
filesystem paths.

See `docs/acp-client-code-walkthrough.md` for the full protocol and code walkthrough.
