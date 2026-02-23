# CamBot-Agent Architecture

Single Node.js process + N Docker containers. The host orchestrates messaging, state, and scheduling. Containers run Claude Agent SDK in isolation per group.

```
┌─────────────────────────────────────────────────────────────┐
│  Host Process (Node.js)                                     │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐  │
│  │ WhatsApp │  │   CLI    │  │ Scheduler │  │    IPC    │  │
│  │ Channel  │  │ Channel  │  │  (60s)    │  │  Watcher  │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └─────┬─────┘  │
│       │              │              │              │         │
│       └──────┬───────┘              │              │         │
│              ▼                      ▼              ▼         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Orchestrator (index.ts)                              │  │
│  │  Message loop · State · Agent invocation              │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  GroupQueue                                           │  │
│  │  Per-group serialization · Global pool (max 5)        │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         ▼                                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                     │
│  │Container│  │Container│  │Container│  (up to 5)           │
│  │ Group A │  │ Group B │  │ Group C │                      │
│  └─────────┘  └─────────┘  └─────────┘                     │
│       │              │              │         SQLite         │
│       └──────────────┼──────────────┘     (messages.db)     │
│                      ▼                                      │
│               Docker Engine                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Component Map

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: startup, message loop, state, agent invocation |
| `src/types.ts` | All TypeScript interfaces (`Channel`, `RegisteredGroup`, `NewMessage`, etc.) |
| `src/config.ts` | Constants: paths, intervals, timeouts, trigger regex, env reads |
| `src/env.ts` | Parses `.env` into typed record without polluting `process.env` |
| `src/logger.ts` | Pino logger; hooks `uncaughtException`/`unhandledRejection` |
| `src/router.ts` | Formats messages to XML, strips `<internal>` tags, dispatches to channels |
| `src/db.ts` | All SQLite operations: schema, migrations, queries |
| `src/group-queue.ts` | Per-group concurrency with global container cap, retry/backoff |
| `src/group-folder.ts` | Validates/resolves group folder paths; prevents path traversal |
| `src/container-runner.ts` | Builds volume mounts, spawns Docker containers, streams stdout |
| `src/container-runtime.ts` | Runtime abstraction: `readonlyMountArgs`, `stopContainer`, `cleanupOrphans` |
| `src/ipc.ts` | File-based IPC watcher: polls per-group dirs, processes messages and tasks |
| `src/task-scheduler.ts` | Polls SQLite for due tasks every 60s, dispatches to GroupQueue |
| `src/mount-security.ts` | Validates `additionalMounts` against external allowlist |
| `src/whatsapp-auth.ts` | Standalone script for WhatsApp QR/pairing-code auth |
| `src/channels/registry.ts` | Discovers and loads configured channels; auto-detects WhatsApp |
| `src/channels/whatsapp.ts` | Baileys WebSocket: LID translation, outgoing queue, metadata sync |
| `src/channels/cli.ts` | Interactive stdin/stdout channel for local dev |
| `container/agent-runner/src/index.ts` | In-container query loop: Claude Agent SDK, IPC input polling |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server: `send_message`, `schedule_task`, `list/pause/cancel_task` |

---

## Layer 1: Channels

Pluggable I/O adapters. Accept inbound messages, deliver outbound responses.

**Interface** (`types.ts`):
```
Channel {
  name, connect(), sendMessage(jid, text), isConnected(),
  ownsJid(jid), disconnect(), setTyping?(jid, bool), syncMetadata?(force)
}
```

**Callback injection**: Channels receive `onMessage`, `onChatMetadata`, `registeredGroups`, and `registerGroup` via `ChannelOpts` at construction. The orchestrator owns the callbacks; channels are passive producers.

**Registry** (`channels/registry.ts`): Hard-coded `ChannelDefinition[]` with `isConfigured()` guards. WhatsApp auto-activates if `store/auth/creds.json` exists. CLI activates only via `CHANNELS=cli` env var. Dynamic imports defer heavy dependencies.

**Routing**: Each channel implements `ownsJid(jid)` — the orchestrator iterates channels to find the owner. WhatsApp JIDs look like `12345@s.whatsapp.net`; CLI uses `cli:console`.

**Adding a channel**: Implement `Channel`, add a `ChannelDefinition` to the registry array. No other files need changes.

---

## Layer 2: Orchestrator

`src/index.ts` — the central coordinator.

**Startup sequence** (`main()`):
1. Verify Docker is running (`docker info`)
2. Kill orphaned `cambot-agent-*` containers
3. Open SQLite DB, create schema, migrate legacy JSON files
4. Load state: cursors, sessions, registered groups
5. Register SIGTERM/SIGINT handlers (graceful shutdown)
6. Load and connect all channels
7. Start scheduler loop (60s)
8. Start IPC watcher (1s)
9. Wire `queue.setProcessMessagesFn(processGroupMessages)`
10. Recover pending messages (re-enqueue groups with lagging cursors)
11. Enter message loop (2s poll, runs forever)

**Message loop**: Polls `getNewMessages(jids, lastTimestamp)` from SQLite. Advances `lastTimestamp` *before* processing (crash safety — recovery handles the gap). Non-main groups require `@Andy` trigger unless `requiresTrigger=false`. If a container is already active for the group, messages are injected via IPC; otherwise the group is enqueued.

**`processGroupMessages(chatJid)`**: Fetches all messages since `lastAgentTimestamp[chatJid]` (catch-up window), starts a container via `runAgent()`, manages typing indicators, and handles the 30-minute idle timeout.

---

## Layer 3: Queue & Concurrency

`src/group-queue.ts` — per-group serialization with a global container pool.

**Concurrency model**: Up to `MAX_CONCURRENT_CONTAINERS` (default 5) containers run simultaneously across all groups. Each group runs at most one container at a time.

**State machine per group**:
```
idle ──enqueue──▶ waiting ──slot opens──▶ active ──finishes──▶ idle
                                            │
                                            ├── pendingMessages → re-run
                                            └── pendingTasks → preempt idle, re-run
```

**Key operations**:
- `enqueueMessageCheck(jid)` — queue group for message processing
- `enqueueTask(jid, taskId, fn)` — queue scheduled task (deduped by ID)
- `sendMessage(jid, text)` — inject message into active container via IPC file
- `closeStdin(jid)` — write `_close` sentinel to signal container exit
- `notifyIdle(jid)` — container is idle; preempt if tasks are pending

**Drain priority**: Tasks first, then pending messages, then waiting groups.

**Retry/backoff**: 5 retries, exponential backoff (5s → 10s → 20s → 40s → 80s). After max retries, the group resets and retries on next incoming trigger.

**Shutdown**: Sets `shuttingDown` flag. Active containers are *not* killed — they detach and `--rm` cleans them up. This prevents killing agents mid-response.

---

## Layer 4: Container Isolation

Each group runs Claude Agent SDK inside a Docker container with isolated mounts.

**Volume mounts** (host → container):

| Host Path | Container Path | Mode | Notes |
|-----------|---------------|------|-------|
| `PROJECT_ROOT` | `/workspace/project` | ro | Main group only |
| `groups/<folder>/` | `/workspace/group` | rw | Agent working directory |
| `groups/global/` | `/workspace/global` | ro | Shared CLAUDE.md (non-main) |
| `data/sessions/<folder>/.claude/` | `/home/node/.claude` | rw | Session, settings, skills |
| `data/ipc/<folder>/` | `/workspace/ipc` | rw | IPC messages/tasks/input |
| `data/sessions/<folder>/agent-runner-src/` | `/app/src` | rw | Customizable runner source |
| Allowlisted paths | `/workspace/extra/<name>` | ro/rw | Validated by mount-security |

**Input protocol** (host → container):
- **Initial**: JSON on stdin — `{ prompt, sessionId?, groupFolder, chatJid, isMain, secrets }`
- **Follow-up messages**: JSON files in `data/ipc/<group>/input/<timestamp>.json`
- **Close signal**: Empty file `data/ipc/<group>/input/_close`

Secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) are passed via stdin only — never written to disk, unset from env before every Bash tool invocation.

**Output protocol** (container → host):
```
---CAMBOT_AGENT_OUTPUT_START---
{"status":"success","result":"...","newSessionId":"..."}
---CAMBOT_AGENT_OUTPUT_END---
```
Streamed incrementally via stdout. Each marker pair triggers `onOutput` callback. Timeout resets on each marker (activity detection).

**Container lifecycle**: `docker run -i --rm`, runs as `node` user (non-root). Recompiles agent-runner TypeScript on every start (allows per-group customization). Hard timeout = `max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30s)`. Graceful `docker stop` then `SIGKILL` on timeout.

---

## Layer 5: Skills Engine

Transformation system for adding features via three-way merge. See [cambot-agent-architecture-final.md](cambot-agent-architecture-final.md) for full details.

**What skills are**: Self-contained packages with `manifest.yaml`, `add/` (new files), and `modify/` (files to merge). Applied programmatically — no monolithic code changes.

**Apply flow**: Pre-flight → backup → file ops → copy adds → three-way merge (`git merge-file` against `.cambot-agent/base/`) → conflict resolution (rerere → Claude → user) → structured ops (npm deps, env vars, docker-compose) → tests → record state.

**Three-way merge**: `current` (working tree) × `base` (clean core) × `skill` (skill's modified version). Git's context matching handles moved code. Conflicts auto-resolve via `git rerere` with a shared resolution cache.

**State**: `.cambot-agent/state.yaml` tracks applied skills, file hashes, structured outcomes, custom patches. Enables deterministic replay and instant drift detection.

---

## Data Flows

### Inbound Message → Response

```
WhatsApp ─────► onMessage() ─────► storeMessage() ──► SQLite
                                                         │
Message Loop (2s poll) ◄─────── getNewMessages(cursor) ──┘
       │
       ├── container active? ──► queue.sendMessage() ──► IPC input file
       │
       └── no container ──► queue.enqueueMessageCheck()
                                    │
                           processGroupMessages()
                                    │
                              runContainerAgent()
                                    │
                          ┌─────────┴─────────┐
                          │  Docker Container  │
                          │  Claude Agent SDK  │
                          │  query() loop      │
                          └─────────┬──────────┘
                                    │
                        stdout markers (streaming)
                                    │
                              onOutput callback
                                    │
                          channel.sendMessage(jid, text)
                                    │
                                WhatsApp ────► User
```

### IPC: Container → Host

```
Container                           Host
─────────                           ────
MCP tool call                       IPC Watcher (1s poll)
  │                                      │
  ▼                                      ▼
Write JSON to                       Scan data/ipc/*/
/workspace/ipc/messages/              │
  or /tasks/                          ├── messages/*.json
                                      │     ├── Auth check (main can send anywhere,
                                      │     │   non-main only to own JID)
                                      │     └── channel.sendMessage()
                                      │
                                      └── tasks/*.json
                                            ├── schedule_task → createTask (SQLite)
                                            ├── pause/resume/cancel → updateTask
                                            └── register_group → registerGroup
```

### Scheduled Task Execution

```
Scheduler (60s poll)
       │
  getDueTasks() ◄── SQLite (WHERE next_run <= now)
       │
  queue.enqueueTask()
       │
  runTask()
       │
  runContainerAgent(isScheduledTask: true)
       │
  Container runs with [SCHEDULED TASK] label
       │
  10s close timer after first result
       │
  logTaskRun() + updateTaskAfterRun() ──► SQLite
       │
  Compute next_run (cron/interval) or complete (once)
```

---

## Design Patterns

| Pattern | Where Used |
|---------|------------|
| **Callback injection** | Channels receive `onMessage`/`onChatMetadata` at construction |
| **Cursor-based recovery** | Two-tier timestamps (`lastTimestamp` + `lastAgentTimestamp`) prevent message loss on crash |
| **Strategy pattern** | Channel registry (pluggable I/O); container runtime abstraction |
| **File-based IPC** | Containers write JSON files, host polls and processes (atomic rename for safety) |
| **Per-group isolation** | Separate mounts, sessions, IPC namespaces per group folder |
| **Exponential backoff** | GroupQueue retries: 5s × 2^n, max 5 attempts |
| **Sentinel files** | `_close` file signals container to exit; avoids signal complexity across Docker |
| **Streaming markers** | `OUTPUT_START`/`OUTPUT_END` pairs enable incremental result delivery |
| **Idle preemption** | Tasks arriving while container is idle trigger `closeStdin` to recycle it |
| **Graceful degradation** | Shutdown lets active containers finish; orphan cleanup on restart |

---

## Security Model

**Container isolation**: Each group gets its own Docker container with separate filesystem mounts. Containers run as non-root (`node` user). Project root is mounted read-only (main group only).

**Secret handling**: API keys passed via stdin, never written to disk. Agent-runner `unset`s secrets from env before every Bash tool invocation.

**IPC authorization**: Directory-name-based identity. Main group can send to any registered chat. Non-main groups can only send to their own JID.

**Mount security**: Additional mounts validated against `~/.config/cambot-agent/mount-allowlist.json` (outside project root — agents cannot read or modify it). Blocked patterns include `.ssh`, `.aws`, `.env`, `credentials`, private keys. Non-main groups forced read-only if `nonMainReadOnly=true`. Symlinks resolved before validation.

**Group folders**: `group-folder.ts` validates paths, blocks traversal (`..`), ensures folders resolve within `groups/` directory.

---

## Persistence (SQLite)

All state lives in `store/messages.db` via `better-sqlite3`.

| Table | Purpose |
|-------|---------|
| `chats` | Chat discovery — JID, name, channel, timestamps |
| `messages` | Message history — content, sender, timestamps, bot flag |
| `scheduled_tasks` | Task definitions — prompt, schedule, next_run, status |
| `task_run_logs` | Execution history — duration, status, result, errors |
| `router_state` | Key-value for cursors (`last_timestamp`, `last_agent_timestamp`) |
| `sessions` | Claude SDK session IDs per group folder |
| `registered_groups` | Group config — JID, folder, trigger pattern, container config |

**Cursor recovery**: On startup, `recoverPendingMessages()` compares each group's `lastAgentTimestamp` against the DB. Groups with unprocessed messages are re-enqueued. This handles crashes between cursor advance and agent completion.
