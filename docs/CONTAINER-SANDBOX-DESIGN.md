# NanoClaw Container Sandbox System — Design Document

**Purpose:** Reference document for porting NanoClaw's Docker sandbox mechanism to a Go-based project. Covers the full lifecycle from image construction through runtime execution, IPC, credential isolation, multi-tenant security, and concurrency management.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Container Image Construction](#2-container-image-construction)
3. [Container Lifecycle](#3-container-lifecycle)
4. [Volume Mount System](#4-volume-mount-system)
5. [Credential Isolation (Proxy)](#5-credential-isolation-proxy)
6. [IPC System](#6-ipc-system)
7. [Agent Execution Inside the Container](#7-agent-execution-inside-the-container)
8. [Concurrency & Queue Management](#8-concurrency--queue-management)
9. [Timeout & Cleanup](#9-timeout--cleanup)
10. [Multi-Tenant Security Model](#10-multi-tenant-security-model)
11. [Mount Security & Allowlist](#11-mount-security--allowlist)
12. [Session Persistence](#12-session-persistence)
13. [Output Protocol](#13-output-protocol)
14. [Container Runtime Abstraction](#14-container-runtime-abstraction)
15. [Porting Considerations for Go](#15-porting-considerations-for-go)

---

## 1. Architecture Overview

NanoClaw runs a single Node.js host process (the "orchestrator") that receives messages from chat channels (WhatsApp, Telegram, Slack, Discord, Gmail). When a message triggers agent processing, the orchestrator spawns a Docker container to execute an AI agent (Claude via the Agent SDK). Each container is ephemeral (`--rm`), sandboxed, and communicates with the host exclusively through filesystem-based IPC and stdout markers.

```
┌─────────────────────────────────────────────────────────────────┐
│  HOST PROCESS (Node.js orchestrator)                            │
│                                                                 │
│  ┌──────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────┐ │
│  │ Channels │──│ GroupQueue    │──│ Container  │──│ IPC      │ │
│  │ Registry │  │ (concurrency │  │ Runner     │  │ Watcher  │ │
│  └──────────┘  │  manager)    │  └─────┬──────┘  └─────┬────┘ │
│                └──────────────┘        │               │       │
│                                        │               │       │
│  ┌──────────────┐  ┌──────────┐       │               │       │
│  │ Credential   │  │ SQLite   │       │               │       │
│  │ Proxy :3001  │  │ Database │       │               │       │
│  └──────┬───────┘  └──────────┘       │               │       │
│         │                              │               │       │
├─────────┼──────────────────────────────┼───────────────┼───────┤
│         │     Docker boundary          │               │       │
│         │                              │               │       │
│  ┌──────┴──────────────────────────────┴───────────────┴─────┐ │
│  │  CONTAINER (nanoclaw-agent:latest)                        │ │
│  │                                                           │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐ │ │
│  │  │ Agent Runner │──│ Claude SDK  │──│ MCP Server       │ │ │
│  │  │ (entrypoint) │  │ query()     │  │ (IPC → host)     │ │ │
│  │  └─────────────┘  └──────┬──────┘  └──────────────────┘ │ │
│  │                          │                                │ │
│  │  ┌───────────────────────┴──────────────────────────┐    │ │
│  │  │ Tools: Bash, Read, Write, Edit, WebSearch, etc.  │    │ │
│  │  │ Browser: Chromium (agent-browser)                │    │ │
│  │  └──────────────────────────────────────────────────┘    │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Principles

- **Ephemeral containers**: Each agent invocation is a fresh `docker run --rm`. No persistent container state.
- **Filesystem IPC**: Host and container communicate via bind-mounted directories with JSON files. No network sockets between host and container.
- **Credential proxy**: Real API keys never enter the container. A host-side HTTP proxy injects credentials on outbound API calls.
- **Per-group isolation**: Each "group" (chat room/user) gets isolated filesystem namespaces — separate working directories, IPC paths, and session storage.
- **Concurrency bounded**: A global limit (default 5) on simultaneously running containers, with a per-group queue.

---

## 2. Container Image Construction

### Dockerfile

**Source:** `container/Dockerfile`

The image is built on `node:22-slim` and includes:

```dockerfile
FROM node:22-slim

# System dependencies for headless browser automation
RUN apt-get update && apt-get install -y \
    chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxrandr2 libasound2 libpangocairo-1.0-0 \
    libcups2 libdrm2 libxshmfence1 curl git

# Global tool installs
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Application code (agent-runner)
WORKDIR /app
COPY agent-runner/package*.json ./
RUN npm install
COPY agent-runner/ ./
RUN npm run build

# Workspace directories (mount targets)
RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
    /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Non-root execution
USER node
WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
```

### Entrypoint Script

The entrypoint is embedded in the Dockerfile at build time:

```bash
#!/bin/bash
set -e
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
```

**Key behaviors:**
1. **Recompiles TypeScript on startup** — The agent-runner source is bind-mounted from a per-group writable directory. This allows per-group customization of agent behavior. Compilation happens at `/tmp/dist` to avoid modifying the mounted source.
2. **Reads input from stdin** — `cat > /tmp/input.json` consumes all stdin until EOF, then passes it to the Node.js process.
3. **Read-only compiled output** — `chmod -R a-w /tmp/dist` makes the compiled code immutable within the container.

### Build Script

**Source:** `container/build.sh`

```bash
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .
```

Supports runtime override via `CONTAINER_RUNTIME` env var (designed for future alternative runtimes).

### Build Cache Warning

Docker BuildKit caches COPY steps aggressively. The `--no-cache` flag alone does NOT invalidate COPY steps — the builder's volume retains stale files. A truly clean rebuild requires pruning the builder volume first: `docker builder prune`, then re-running `build.sh`.

---

## 3. Container Lifecycle

### Phase 1: Pre-launch (Host-side)

```
1. Group directory created (if missing): groups/{folder}/
2. Volume mounts computed: buildVolumeMounts()
   - Group directory, IPC namespace, session storage, agent-runner source
   - Optional: project root (main), global memory, additional mounts
3. Skills synced: container/skills/ → DATA_DIR/sessions/{folder}/.claude/skills/
4. Settings file created (if missing): .claude/settings.json with SDK feature flags
5. Container name generated: nanoclaw-{safeName}-{timestamp}
6. Container args built: docker run -i --rm --name ... -e ... -v ... image
```

### Phase 2: Spawn

```typescript
const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
});
container.stdin.write(JSON.stringify(input));
container.stdin.end();
```

The container is spawned with all three stdio streams piped. Input is a single JSON object written to stdin, then stdin is closed (EOF triggers the entrypoint's `cat` to finish).

### Phase 3: Execution (Inside Container)

```
1. Entrypoint recompiles agent-runner: npx tsc --outDir /tmp/dist
2. Reads stdin JSON into /tmp/input.json
3. Starts Node.js agent-runner: node /tmp/dist/index.js < /tmp/input.json
4. Agent-runner:
   a. Parses ContainerInput from stdin
   b. Creates MessageStream (async iterable)
   c. Starts IPC polling loop (every 500ms) for follow-up messages
   d. Calls Claude Agent SDK query() with:
      - cwd: /workspace/group
      - resume: sessionId (if continuing)
      - MCP server: nanoclaw (for send_message, schedule_task, etc.)
      - Allowed tools: Bash, Read, Write, Edit, WebSearch, etc.
      - permissionMode: bypassPermissions (sandbox is the security boundary)
   e. Iterates SDK message stream, emitting results via OUTPUT markers
5. After query completes: waits for next IPC message or _close sentinel
6. Loop: new messages → new query → wait → repeat
```

### Phase 4: Output Capture (Host-side)

The host parses stdout for sentinel markers:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Agent response text","newSessionId":"uuid"}
---NANOCLAW_OUTPUT_END---
```

- **Streaming mode**: Markers parsed incrementally as stdout data arrives. Each complete marker pair triggers an `onOutput` callback immediately. Used for real-time message relay to chat.
- **Legacy mode**: Entire stdout accumulated, last marker pair extracted on container exit.

### Phase 5: Idle & Close

After emitting a result, the container enters an idle state:
1. Agent-runner calls `waitForIpcMessage()` — polls `/workspace/ipc/input/` every 500ms
2. Host can send follow-up messages via `GroupQueue.sendMessage()` → writes JSON to input dir
3. Container picks up new messages, runs another query
4. Close triggers:
   - `_close` sentinel file written to IPC input dir
   - Idle timeout expires (host-side, triggers `docker stop`)
   - Hard timeout (host-side, triggers SIGKILL fallback)

### Phase 6: Cleanup

- `--rm` flag ensures container removal on exit
- Host clears state: `active=false`, `process=null`, `containerName=null`
- `activeCount` decremented, waiting groups drained
- Log file written to `groups/{folder}/logs/container-{timestamp}.log`

---

## 4. Volume Mount System

### Core Mounts (Always Present)

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `groups/{folder}/` | `/workspace/group` | rw | Group's working directory |
| `DATA_DIR/sessions/{folder}/.claude` | `/home/node/.claude` | rw | Claude SDK session storage |
| `DATA_DIR/ipc/{folder}/` | `/workspace/ipc` | rw | IPC namespace (messages, tasks, input) |
| `DATA_DIR/sessions/{folder}/agent-runner-src` | `/app/src` | rw | Per-group agent-runner source |

### Main Group Additional Mounts

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| Project root (cwd) | `/workspace/project` | **ro** | Project source code |
| `.env` (if exists) | `/workspace/project/.env` | ro (`/dev/null`) | **Shadow mount** — blocks secret access |

### Non-Main Group Additional Mounts

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `groups/global/` | `/workspace/global` | **ro** | Shared global memory |

### User-Configured Additional Mounts

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| Any allowlisted path | `/workspace/extra/{name}` | ro or rw | External directories |

### Mount Construction Logic

```typescript
function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  if (isMain) {
    mounts.push({ hostPath: projectRoot, containerPath: '/workspace/project', readonly: true });
    // Shadow .env to prevent secret leakage
    if (fs.existsSync(envFile)) {
      mounts.push({ hostPath: '/dev/null', containerPath: '/workspace/project/.env', readonly: true });
    }
    mounts.push({ hostPath: groupDir, containerPath: '/workspace/group', readonly: false });
  } else {
    mounts.push({ hostPath: groupDir, containerPath: '/workspace/group', readonly: false });
    // Global memory (read-only for non-main)
    if (fs.existsSync(globalDir)) {
      mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
    }
  }

  // Per-group session storage
  mounts.push({ hostPath: groupSessionsDir, containerPath: '/home/node/.claude', readonly: false });
  // Per-group IPC namespace
  mounts.push({ hostPath: groupIpcDir, containerPath: '/workspace/ipc', readonly: false });
  // Per-group agent-runner source (recompiled on startup)
  mounts.push({ hostPath: groupAgentRunnerDir, containerPath: '/app/src', readonly: false });
  // Additional validated mounts
  if (group.containerConfig?.additionalMounts) {
    mounts.push(...validateAdditionalMounts(group.containerConfig.additionalMounts, group.name, isMain));
  }

  return mounts;
}
```

---

## 5. Credential Isolation (Proxy)

### Problem

Containers run untrusted AI agent code. They must call the Anthropic API but should never possess real credentials.

### Solution: Host-Side HTTP Proxy

**Source:** `src/credential-proxy.ts`

The host runs an HTTP proxy on a configurable port (default 3001). Containers are configured with:

```
ANTHROPIC_BASE_URL=http://host.docker.internal:3001
ANTHROPIC_API_KEY=placeholder  (or CLAUDE_CODE_OAUTH_TOKEN=placeholder)
```

The proxy intercepts every request and injects real credentials:

```
Container → HTTP request with placeholder key
    → Proxy (host:3001)
        → Strips placeholder credentials
        → Injects real ANTHROPIC_API_KEY or OAuth token
        → Forwards to upstream (api.anthropic.com)
    → Response back to container
```

### Two Authentication Modes

1. **API Key mode**: Proxy deletes the `x-api-key` header from the container's request and injects the real key.
2. **OAuth mode**: Proxy replaces the `Authorization: Bearer placeholder` header with the real OAuth token on token-exchange requests. Post-exchange requests carry a temporary API key that's valid as-is.

### Proxy Bind Host (Platform-Specific)

| Platform | Bind Address | Reason |
|----------|-------------|--------|
| macOS | `127.0.0.1` | Docker Desktop VM routes `host.docker.internal` to loopback |
| WSL | `127.0.0.1` | Same VM routing as macOS |
| Linux | `docker0` bridge IP | Binds only to the docker bridge, not all interfaces |
| Linux fallback | `0.0.0.0` | If docker0 interface not found |

### Security Properties

- Real secrets are loaded from `.env` only by the proxy process, never exposed to containers
- The proxy runs in the host process, outside any container
- The `.env` file is shadow-mounted with `/dev/null` inside the main group's container
- Containers can only reach the proxy via `host.docker.internal`, not the real API

---

## 6. IPC System

### Overview

IPC uses filesystem-based message passing through bind-mounted directories. Each group gets its own IPC namespace at `DATA_DIR/ipc/{groupFolder}/`. Three subdirectories serve different communication flows:

### 6.1 Container → Host: Messages (`/workspace/ipc/messages/`)

Used by the in-container MCP server to send chat messages back to users.

**Protocol:**
1. Container writes a JSON file to `/workspace/ipc/messages/`:
   ```json
   {
     "type": "message",
     "chatJid": "target-chat-id",
     "text": "Hello from the agent!",
     "sender": "Researcher",
     "groupFolder": "my-group",
     "timestamp": "2026-03-15T10:00:00.000Z"
   }
   ```
2. Atomic write: temp file → `fs.renameSync()` → final path
3. Host polls every 1000ms, reads and deletes processed files
4. Authorization check: non-main groups can only send to their own chat JID

### 6.2 Container → Host: Tasks (`/workspace/ipc/tasks/`)

Used to schedule recurring/one-time tasks, register groups, and manage task lifecycle.

**Supported operations:**
- `schedule_task` — Create a new scheduled task
- `pause_task` / `resume_task` — Pause/resume by task ID
- `cancel_task` — Delete a task
- `update_task` — Modify prompt, schedule type, or schedule value
- `register_group` — Register a new chat group (main only)
- `refresh_groups` — Re-sync group metadata (main only)

### 6.3 Host → Container: Follow-up Messages (`/workspace/ipc/input/`)

Used to send new user messages to an already-running container.

**Protocol:**
1. Host writes JSON file to `DATA_DIR/ipc/{folder}/input/`:
   ```json
   { "type": "message", "text": "Follow-up question..." }
   ```
2. Container polls every 500ms via `drainIpcInput()`
3. Messages are pushed into the active `MessageStream` and processed by the SDK

**Close sentinel:** Writing a `_close` file (any content) to the input directory signals the container to finish its current work and exit.

### 6.4 In-Container MCP Server

**Source:** `container/agent-runner/src/ipc-mcp-stdio.ts`

The agent-runner starts an MCP (Model Context Protocol) server as a stdio subprocess. The Claude SDK connects to it and exposes the following tools to the AI agent:

| Tool | Description | Authorization |
|------|-------------|---------------|
| `send_message` | Send a message to the user/group | Non-main: own chat only |
| `schedule_task` | Create a recurring/one-time task | Non-main: own group only |
| `list_tasks` | List scheduled tasks | Non-main: own tasks only |
| `pause_task` | Pause a scheduled task | Non-main: own tasks only |
| `resume_task` | Resume a paused task | Non-main: own tasks only |
| `cancel_task` | Cancel and delete a task | Non-main: own tasks only |
| `update_task` | Modify an existing task | Non-main: own tasks only |
| `register_group` | Register a new chat group | Main only |

The MCP server receives its identity via environment variables:
```
NANOCLAW_CHAT_JID=target-chat-id
NANOCLAW_GROUP_FOLDER=my-group
NANOCLAW_IS_MAIN=1|0
```

---

## 7. Agent Execution Inside the Container

### Input Protocol

The container receives a single JSON object via stdin:

```typescript
interface ContainerInput {
  prompt: string;          // The user's message (or formatted history)
  sessionId?: string;      // Resume an existing Claude session
  groupFolder: string;     // Identity: which group this container serves
  chatJid: string;         // Target chat JID for responses
  isMain: boolean;         // Privilege level
  isScheduledTask?: boolean; // Whether this is a scheduled task invocation
  assistantName?: string;  // Display name for the agent
}
```

### SDK Configuration

The agent-runner calls the Claude Agent SDK `query()` with:

```typescript
query({
  prompt: messageStream,  // AsyncIterable<SDKUserMessage> — keeps session alive
  options: {
    cwd: '/workspace/group',
    additionalDirectories: ['/workspace/extra/...'],  // Discovered dynamically
    resume: sessionId,                                 // Continue prior session
    systemPrompt: { preset: 'claude_code', append: globalClaudeMd },
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
      'mcp__nanoclaw__*'
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: ['ipc-mcp-stdio.js'],
        env: { NANOCLAW_CHAT_JID, NANOCLAW_GROUP_FOLDER, NANOCLAW_IS_MAIN }
      }
    },
    hooks: {
      PreCompact: [archiveTranscriptHook]  // Archives conversation before compaction
    }
  }
})
```

### MessageStream Pattern

A custom `MessageStream` class implements `AsyncIterable<SDKUserMessage>`. It:
- Keeps `isSingleUserTurn=false` so agent subagent teams can run to completion
- Accepts `push(text)` to inject new messages mid-query
- Accepts `end()` to signal no more messages
- Concurrent IPC polling pushes follow-up messages into the stream

### Query Loop

The agent-runner runs a loop:
```
while (true) {
  1. Run query with current prompt
  2. Stream SDK messages, emit results via OUTPUT markers
  3. If _close detected during query → exit
  4. Emit session-update marker
  5. Wait for next IPC message (poll input/ dir every 500ms)
  6. If _close → exit
  7. Use new message as next prompt, continue loop
}
```

This allows a single container to handle multiple conversation turns without restarting.

---

## 8. Concurrency & Queue Management

### GroupQueue

**Source:** `src/group-queue.ts`

The `GroupQueue` class manages container execution across all groups with a global concurrency limit.

### State Per Group

```typescript
interface GroupState {
  active: boolean;              // Container currently running
  idleWaiting: boolean;         // Container alive but waiting for IPC input
  isTaskContainer: boolean;     // Running a scheduled task (not interactive)
  runningTaskId: string | null; // Currently executing task ID
  pendingMessages: boolean;     // New messages arrived while container was active
  pendingTasks: QueuedTask[];   // Scheduled tasks waiting for execution
  process: ChildProcess | null; // Handle to container process
  containerName: string | null; // Docker container name
  groupFolder: string | null;   // Group folder name
  retryCount: number;           // Consecutive failure count
}
```

### Concurrency Control

```
MAX_CONCURRENT_CONTAINERS = 5 (default, configurable)

On new message:
  if group already has active container → queue message (set pendingMessages=true)
  if at concurrency limit → queue message + add to waitingGroups
  else → spawn container immediately

On container exit:
  1. Decrement activeCount
  2. Drain group: pending tasks first, then pending messages
  3. Drain waiting groups: pull next group from waitingGroups if slots available
```

### Priority: Tasks Before Messages

When a container finishes and both tasks and messages are pending:
1. Tasks execute first (they won't be re-discovered from SQLite like messages)
2. Messages drain after all tasks complete

### Idle Container Preemption

When a container is idle-waiting and a task arrives:
1. `notifyIdle(groupJid)` sets `idleWaiting=true`
2. On `enqueueTask()`, if idle → write `_close` sentinel to preempt the idle container
3. Container exits, task runs in a fresh container

### Retry Logic

On container failure:
- Retry up to 5 times with exponential backoff: 5s, 10s, 20s, 40s, 80s
- On max retries exceeded: drop pending messages (will retry on next incoming message)

### Shutdown Behavior

On shutdown, active containers are **not killed** — they're allowed to finish via their own idle/hard timeouts. The `--rm` flag handles cleanup. This prevents restarts from killing agents mid-work.

---

## 9. Timeout & Cleanup

### Timeout Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `CONTAINER_TIMEOUT` | 30 minutes (1800000ms) | Maximum wall-clock time for a container |
| `IDLE_TIMEOUT` | 30 minutes (1800000ms) | How long to keep a container alive after last output |
| Per-group override | via `containerConfig.timeout` | Groups can override the default |
| Effective timeout | `max(configTimeout, IDLE_TIMEOUT + 30s)` | Grace period for _close sentinel |

### Timeout Behavior

```
Container spawned → hard timer starts (30 min)

On OUTPUT_START_MARKER detected → reset hard timer
On stderr data → do NOT reset timer (SDK writes debug logs continuously)

On timeout:
  1. Try graceful stop: docker stop {name} (15s timeout)
  2. If graceful stop fails: SIGKILL
  3. If had output before timeout → treat as idle cleanup (success, not error)
  4. If no output → treat as timeout error
```

### Orphan Cleanup

On host startup, `cleanupOrphans()` kills all containers matching the `nanoclaw-*` name pattern:

```bash
docker ps --filter name=nanoclaw- --format '{{.Names}}'
# Then: docker stop {name} for each orphan
```

### Output Size Limits

`CONTAINER_MAX_OUTPUT_SIZE = 10MB` (default). Both stdout and stderr are truncated independently if they exceed this limit. A warning is logged on truncation.

### Log Files

Each container run produces a log file at `groups/{folder}/logs/container-{timestamp}.log` containing:
- Timestamp, group name, container name, duration, exit code
- Verbose mode (LOG_LEVEL=debug or error): full input, container args, mounts, stderr, stdout
- Normal mode: input summary (prompt length, session ID), mount paths only

---

## 10. Multi-Tenant Security Model

### Privilege Levels

| Capability | Main Group | Non-Main Groups |
|------------|-----------|-----------------|
| Trigger required | No | Yes (configurable) |
| Project root mounted | Yes (read-only) | No |
| Global memory access | Implicitly (via project root) | Read-only via /workspace/global |
| Send messages to any chat | Yes | Own chat only |
| Schedule tasks for other groups | Yes | Own group only |
| Register new groups | Yes | No |
| Refresh group metadata | Yes | No |
| See all tasks | Yes | Own tasks only |
| See all available groups | Yes | No |
| Set isMain via IPC | No (defense in depth) | No |
| Additional mount write access | Controlled by allowlist | Forced read-only if `nonMainReadOnly` |

### Isolation Boundaries

1. **Container boundary**: Each container is a fresh Linux namespace with its own PID, network, mount tree
2. **Filesystem boundary**: Per-group mount namespaces — groups cannot access each other's directories
3. **IPC boundary**: Per-group IPC directories — cross-group writes are blocked by host-side authorization
4. **Session boundary**: Per-group Claude SDK sessions — isolated at `/home/node/.claude/`
5. **Credential boundary**: Proxy injects real credentials — containers only see placeholders
6. **Concurrency boundary**: Per-group serial execution — no two containers run for the same group simultaneously

### Cross-Group Attack Prevention

| Attack Vector | Mitigation |
|--------------|------------|
| Container modifies host code | Project root mounted read-only |
| Container reads .env secrets | Shadow mount with /dev/null |
| Container writes IPC for another group | Host verifies source identity from directory path |
| Agent sets isMain=true via IPC | register_group ignores isMain field (hardcoded defense) |
| Container escapes via path traversal | `path.relative()` checks + directory existence validation |
| Symlink attacks on allowlisted mounts | `fs.realpathSync()` resolves all symlinks before validation |
| Container accesses sensitive host files | Blocked patterns (`.ssh`, `.aws`, `.gnupg`, `.docker`, `credentials`, etc.) |
| Agent modifies security config | Mount allowlist stored at `~/.config/nanoclaw/` — outside project root, never mounted |

---

## 11. Mount Security & Allowlist

### Allowlist Location

`~/.config/nanoclaw/mount-allowlist.json` — stored outside the project root so containers cannot modify it.

### Allowlist Schema

```json
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/Documents/work",
      "allowReadWrite": false,
      "description": "Work documents (read-only)"
    }
  ],
  "blockedPatterns": ["password", "secret", "token"],
  "nonMainReadOnly": true
}
```

### Default Blocked Patterns (Always Enforced)

```
.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, .pypirc,
id_rsa, id_ed25519, private_key, .secret
```

User-defined patterns are merged with defaults (never replace).

### Validation Flow

```
1. Load allowlist (cached in memory, loaded once per process)
2. If no allowlist → BLOCK all additional mounts
3. Validate container path: no "..", not absolute, not empty
4. Expand host path (resolve ~/) and resolve all symlinks
5. Check against blocked patterns (component-level and full-path matching)
6. Check if real path is under an allowed root
7. Determine effective readonly:
   - Requested read-write AND root allows it AND (isMain OR !nonMainReadOnly) → rw
   - Otherwise → readonly
8. Mount at /workspace/extra/{containerPath}
```

---

## 12. Session Persistence

### SQLite Schema

Sessions are tracked in SQLite with a `sessions` table:
- `group_folder` → `session_id` (1:1 mapping)
- Updated after each container run with the `newSessionId` from the output

### Claude SDK Session Storage

Each group gets an isolated Claude SDK session directory:
```
DATA_DIR/sessions/{groupFolder}/.claude/
```

Mounted into the container at `/home/node/.claude/`. Contains:
- `settings.json` — SDK feature flags (agent teams, auto-memory, additional directories)
- `skills/` — Synced from `container/skills/` on each launch
- SDK-managed session data (conversation history, tool state)

### Settings Template

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
```

### Per-Group Agent-Runner Source

Each group gets a copy of the agent-runner source at:
```
DATA_DIR/sessions/{groupFolder}/agent-runner-src/
```

This is mounted at `/app/src` (rw) and recompiled on container startup. This allows per-group customization of agent behavior — groups can add tools, modify the query configuration, or change how messages are processed without affecting other groups.

### Memory Files

| File | Location | Access |
|------|----------|--------|
| Group memory | `groups/{folder}/CLAUDE.md` | rw (agent can modify) |
| Global memory | `groups/global/CLAUDE.md` | ro for non-main, loaded via `systemPrompt.append` |
| Additional dir memory | `/workspace/extra/*/CLAUDE.md` | Loaded by SDK via `additionalDirectories` |

---

## 13. Output Protocol

### Sentinel Markers

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Agent response text","newSessionId":"uuid-here"}
---NANOCLAW_OUTPUT_END---
```

### Output Schema

```typescript
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;    // Agent's text response (null for session-update markers)
  newSessionId?: string;     // Updated session ID for persistence
  error?: string;            // Error message (when status='error')
}
```

### Multiple Outputs Per Container

A single container run can emit multiple output markers:
1. **Query result markers** — One per SDK result (including agent teams subagent results)
2. **Session-update marker** — Emitted after each query completes (`result: null`), used to track session ID
3. **Final state** — Container closes and host resolves the promise

### Streaming Parse Logic

```typescript
// Incremental parsing of stdout
parseBuffer += chunk;
let startIdx;
while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
  const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
  if (endIdx === -1) break;  // Incomplete pair, wait for more data

  const jsonStr = parseBuffer.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
  parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

  const parsed = JSON.parse(jsonStr);
  resetTimeout();  // Activity detected — reset hard timeout
  await onOutput(parsed);
}
```

---

## 14. Container Runtime Abstraction

**Source:** `src/container-runtime.ts`

All Docker-specific logic is isolated in one file, designed for easy replacement:

```typescript
// Binary name
export const CONTAINER_RUNTIME_BIN = 'docker';

// Host gateway hostname
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

// Platform-specific proxy bind host
export const PROXY_BIND_HOST = detectProxyBindHost();

// Functions
export function hostGatewayArgs(): string[]         // --add-host on Linux
export function readonlyMountArgs(host, container)   // -v host:container:ro
export function stopContainer(name): string          // docker stop {name}
export function ensureContainerRuntimeRunning()      // docker info check
export function cleanupOrphans()                     // kill nanoclaw-* containers
```

### Platform-Specific Behavior

| Behavior | macOS | WSL | Linux |
|----------|-------|-----|-------|
| Host gateway | Built-in | Built-in | `--add-host=host.docker.internal:host-gateway` |
| Proxy bind | `127.0.0.1` | `127.0.0.1` | docker0 bridge IP or `0.0.0.0` |
| WSL detection | N/A | `/proc/sys/fs/binfmt_misc/WSLInterop` exists | N/A |
| UID mapping | Skip if 0 or 1000 | Skip if 0 or 1000 | `--user {uid}:{gid}` |

---

## 15. Porting Considerations for Go

### What Maps Directly

| NanoClaw Concept | Go Equivalent |
|------------------|--------------|
| `child_process.spawn()` | `os/exec.Command()` with `cmd.StdinPipe()`, `cmd.StdoutPipe()` |
| `fs.writeFileSync()` / `fs.readFileSync()` for IPC | `os.WriteFile()` / `os.ReadFile()` with atomic rename |
| `http.createServer()` for credential proxy | `net/http.ListenAndServe()` or `httputil.ReverseProxy` |
| `setTimeout()` polling loops | `time.Ticker` or `time.AfterFunc()` |
| `Map<string, GroupState>` | `sync.Map` or `map` with `sync.Mutex` |
| `Promise<ContainerOutput>` | Channel (`chan ContainerOutput`) or context-based patterns |
| SQLite via `better-sqlite3` | `modernc.org/sqlite` or `mattn/go-sqlite3` |
| `MessageStream` (AsyncIterable) | Go channel (`chan string`) |

### Key Patterns to Preserve

1. **Filesystem IPC with atomic writes**: Use `os.WriteFile()` to a temp file, then `os.Rename()`. This is the foundation of all host↔container communication.

2. **Credential proxy**: Implement as a `httputil.ReverseProxy` with a custom `Director` function that injects credentials. Bind to the docker bridge IP on Linux.

3. **Stdout marker parsing**: Use `bufio.Scanner` or `io.Reader` with a sliding buffer to detect `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` pairs.

4. **Concurrency limiting**: Use a semaphore pattern (`chan struct{}` of size N) for the global container limit. Use a `sync.Mutex` per group for serial execution.

5. **Graceful shutdown**: Use `cmd.Process.Signal(syscall.SIGTERM)` with a timeout, then `cmd.Process.Kill()` as fallback. Use `context.Context` for propagating cancellation.

6. **Mount validation**: Port the allowlist loader and path validation. Use `filepath.EvalSymlinks()` for symlink resolution and `filepath.Rel()` for escape detection.

### Architecture Suggestions for Go

```go
// Core types
type ContainerInput struct {
    Prompt       string `json:"prompt"`
    SessionID    string `json:"sessionId,omitempty"`
    GroupFolder  string `json:"groupFolder"`
    ChatJID      string `json:"chatJid"`
    IsMain       bool   `json:"isMain"`
    IsScheduled  bool   `json:"isScheduledTask,omitempty"`
}

type ContainerOutput struct {
    Status       string `json:"status"`
    Result       *string `json:"result"`
    NewSessionID string `json:"newSessionId,omitempty"`
    Error        string `json:"error,omitempty"`
}

// GroupQueue with channels
type GroupQueue struct {
    mu             sync.Mutex
    groups         map[string]*GroupState
    activeCount    int32  // atomic
    maxConcurrent  int
    semaphore      chan struct{}
    waitingGroups  chan string
}

// Container runner
func RunContainer(ctx context.Context, group RegisteredGroup, input ContainerInput) (<-chan ContainerOutput, error) {
    // Build args, mounts
    // cmd := exec.CommandContext(ctx, "docker", args...)
    // Pipe stdin, parse stdout for markers
    // Return channel of outputs
}

// Credential proxy
func StartCredentialProxy(port int, host string) error {
    proxy := &httputil.ReverseProxy{
        Director: func(req *http.Request) {
            // Inject real credentials
        },
    }
    return http.ListenAndServe(fmt.Sprintf("%s:%d", host, port), proxy)
}
```

### What to Consider Changing

1. **Agent-runner language**: The in-container agent-runner is Node.js (required for Claude Agent SDK). If porting the host to Go, the container internals can remain Node.js — they're decoupled via the stdin/stdout/IPC protocol.

2. **IPC mechanism**: Filesystem polling is simple but has latency (500ms–1000ms). Consider Unix domain sockets or named pipes for lower-latency IPC in a Go implementation. However, filesystem IPC has the advantage of surviving container restarts and being trivially debuggable.

3. **Build system**: Go can use `os/exec` to call `docker build` or integrate with the Docker SDK (`github.com/docker/docker/client`) for programmatic image building.

4. **Configuration**: Replace `.env` file parsing with Go's `os.Getenv()` or a config library like `viper`. Keep the separation between config values (available everywhere) and secrets (only in the proxy).

5. **Container runtime**: Consider supporting both Docker and Podman from the start. The runtime abstraction (`container-runtime.ts`) makes this straightforward — the same pattern works in Go with an interface.

---

## Appendix A: Complete Container Argument Example

```bash
docker run -i --rm \
  --name nanoclaw-my-group-1710500000000 \
  -e TZ=America/New_York \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:3001 \
  -e ANTHROPIC_API_KEY=placeholder \
  --add-host=host.docker.internal:host-gateway \
  --user 1001:1001 \
  -e HOME=/home/node \
  -v /home/user/nanoclaw:/workspace/project:ro \
  -v /dev/null:/workspace/project/.env:ro \
  -v /home/user/nanoclaw/groups/my-group:/workspace/group \
  -v /home/user/nanoclaw/data/sessions/my-group/.claude:/home/node/.claude \
  -v /home/user/nanoclaw/data/ipc/my-group:/workspace/ipc \
  -v /home/user/nanoclaw/data/sessions/my-group/agent-runner-src:/app/src \
  -v /home/user/projects/myapp:/workspace/extra/myapp:ro \
  nanoclaw-agent:latest
```

## Appendix B: Complete Message Flow

```
User sends "What's the weather?" in chat
  │
  ▼
Channel handler stores message in SQLite
  │
  ▼
Message loop (every 2000ms) detects new message
  │
  ▼
Trigger check: message starts with @AssistantName?
  │
  ▼
GroupQueue.enqueueMessageCheck(groupJid)
  │
  ├─ Container active? → GroupQueue.sendMessage() writes IPC file to input/
  │                       Container picks it up in 500ms, pushes to MessageStream
  │
  └─ No container? → GroupQueue.runForGroup()
       │
       ▼
     processGroupMessages(groupJid)
       │
       ▼
     Fetch messages since lastAgentTimestamp from SQLite
       │
       ▼
     formatMessages() → create prompt with full history
       │
       ▼
     buildVolumeMounts() → compute all mount paths
       │
       ▼
     buildContainerArgs() → docker run -i --rm ...
       │
       ▼
     spawn(docker, args, {stdio: pipe})
       │
       ▼
     Write ContainerInput JSON to stdin, close stdin
       │
       ▼
     Container starts:
       ├─ Entrypoint: recompile /app/src → /tmp/dist
       ├─ Read stdin → /tmp/input.json
       └─ node /tmp/dist/index.js < /tmp/input.json
            │
            ▼
          Agent-runner: parse input, create MessageStream
            │
            ▼
          SDK query() with prompt, session resume, MCP server
            │
            ▼
          Claude processes, uses tools (Bash, Read, WebSearch...)
            │
            ▼
          SDK emits result message
            │
            ▼
          writeOutput(): ---NANOCLAW_OUTPUT_START--- {JSON} ---NANOCLAW_OUTPUT_END---
            │
            ▼
     Host captures stdout, parses markers
       │
       ▼
     onOutput callback → sendMessage(chatJid, result)
       │
       ▼
     "The weather today is sunny and 72°F" sent to chat
       │
       ▼
     Container enters idle state (waitForIpcMessage)
       │
       ▼
     30min idle timeout → _close sentinel → container exits
       │
       ▼
     Host: update lastAgentTimestamp, decrement activeCount, drain queue
```
