# Architecture

**Analysis Date:** 2026-02-27

## Pattern Overview

**Overall:** Multi-channel orchestrator with isolated agent containers.

**Key Characteristics:**
- Single Node.js orchestrator process manages multiple messaging channels (WhatsApp, Telegram)
- Agent execution isolated in Docker containers per-group, each with sandboxed filesystem and memory
- Messages fetched via polling, grouped by chat, queued for container processing
- Streaming output from containers enables real-time response delivery
- Database-backed state for messages, sessions, groups, and scheduled tasks
- IPC-based communication allows containers to control group registration and messaging

## Layers

**Orchestrator (Host Process):**
- Purpose: Central message router, channel manager, container lifecycle handler
- Location: `src/index.ts`
- Contains: Main event loop, state management, container invocation
- Depends on: Channels, database, container runner, group queue, IPC watcher
- Used by: Startup handlers, graceful shutdown

**Channels Layer:**
- Purpose: Abstract messaging platform integrations (WhatsApp, Telegram)
- Location: `src/channels/`
- Contains: `whatsapp.ts`, `telegram.ts`
- Depends on: Types, database, logger
- Used by: Orchestrator for message sending/receiving and platform-specific operations
- Pattern: Implements `Channel` interface for polymorphism

**Container Runner:**
- Purpose: Spawn and manage agent containers, handle IPC streaming
- Location: `src/container-runner.ts`
- Contains: Volume mount configuration, output parsing, container process spawning
- Depends on: Container runtime abstraction, mount security, environment reading
- Used by: Orchestrator, task scheduler

**Database Layer:**
- Purpose: Persist messages, group metadata, sessions, tasks, router state
- Location: `src/db.ts`
- Contains: SQLite schema, CRUD operations for all entities
- Depends on: Better-sqlite3
- Used by: All subsystems for state persistence

**Group Queue:**
- Purpose: Concurrency control and process lifecycle management
- Location: `src/group-queue.ts`
- Contains: Per-group state (active containers, pending messages/tasks), max concurrent limit enforcement
- Depends on: Logger
- Used by: Orchestrator for enqueuing messages/tasks and managing container lifecycle

**IPC Watcher:**
- Purpose: Monitor container-to-host communication for cross-group operations
- Location: `src/ipc.ts`
- Contains: File polling loop, message routing, task creation/deletion, group registration
- Depends on: Cron parser, database, logger, Telegram pool
- Used by: Startup sequence

**Task Scheduler:**
- Purpose: Execute scheduled tasks (cron, interval, once) at their due times
- Location: `src/task-scheduler.ts`
- Contains: Cron expression parsing, task run loop, database updates
- Depends on: Container runner, database, group queue, cron parser
- Used by: Startup sequence

**Router:**
- Purpose: Format messages for container input, strip internal tags from output
- Location: `src/router.ts`
- Contains: XML message formatting, channel lookup, outbound text sanitization
- Depends on: Types
- Used by: Orchestrator, task scheduler, IPC watcher

## Data Flow

**Incoming Message (Polling Loop):**

1. `startMessageLoop()` polls `getNewMessages()` every 2 seconds
2. Messages grouped by chat JID from database
3. For non-main groups: check for trigger pattern (@bot mention)
4. Fetch all messages since last processed timestamp (builds context)
5. Format as XML: `<messages><message sender="..." time="...">...</message></messages>`
6. If container active: pipe to stdin; if not: enqueue via `GroupQueue`
7. Container processes, outputs streamed back via stdout
8. Strip `<internal>...</internal>` blocks from output
9. Send sanitized text back via appropriate channel
10. Update `lastAgentTimestamp[chatJid]` to avoid reprocessing

**Scheduled Task Execution:**

1. `startSchedulerLoop()` polls `getDueTasks()` every 60 seconds
2. For each due task: check if group and session exist
3. Create/update group and session snapshots in filesystem
4. Call `runContainerAgent()` with task prompt
5. Container executes, output streamed
6. Log task run to `task_run_logs` table
7. Update `next_run` based on schedule type (cron/interval/once)

**Container-Initiated Group Registration (IPC):**

1. Container writes JSON file to `data/ipc/{groupFolder}/messages/register-group-{uuid}.json`
2. IPC watcher polls `data/ipc/` every 1 second
3. Authorization check: main group can register any group; non-main limited to own group
4. Call `registerGroup(jid, config)` which:
   - Creates group folder in `groups/{folder}/`
   - Stores in `registered_groups` table
   - Adds to orchestrator's in-memory `registeredGroups` map
5. Next message loop iteration sees new group in `registeredGroups`, processes its messages

**State Management:**

- Router state: `last_timestamp`, `last_agent_timestamp` per group (database `router_state` table)
- Session state: One session ID per group folder, used for Claude Agent SDK continuity (database `sessions` table)
- Group state: Metadata (name, folder, trigger pattern), mounted to containers at `/workspace/group/`
- Main group: Sees `groups/main/` + read-only project root; can register other groups
- Non-main groups: See only own `groups/{folder}/` folder and read-only `groups/global/`

## Key Abstractions

**Channel Interface:**
- Purpose: Polymorphic messaging platform support
- Examples: `WhatsAppChannel`, `TelegramChannel`
- Pattern: Implement `connect()`, `sendMessage()`, `isConnected()`, `ownsJid()`, optional `setTyping()`
- File: `src/types.ts` defines `Channel` interface

**RegisteredGroup:**
- Purpose: Configuration for a single group/chat that NanoClaw monitors
- Fields: `name`, `folder` (unique, validated), `trigger`, `containerConfig`
- Persisted in: Database `registered_groups` table
- Mounted into container at: `/workspace/group/`

**GroupQueue State Machine:**
- Purpose: Track per-group lifecycle (idle, active, waiting)
- States: `active` (container running), `idleWaiting` (paused but not dead), `pendingMessages` (queued)
- Concurrency: Max `MAX_CONCURRENT_CONTAINERS` (default 5) active groups
- Retry: Up to 5 retries with exponential backoff (BASE_RETRY_MS = 5000)

**ContainerInput/ContainerOutput:**
- Purpose: Typed contract for container IPC
- Input: `prompt`, `sessionId`, `groupFolder`, `chatJid`, `isMain`, `assistantName`
- Output: `status` ('success'/'error'), `result` (string), `newSessionId` (for session updates)
- File: `src/container-runner.ts`

## Entry Points

**Main Process:**
- Location: `src/index.ts` (line 444-542)
- Triggers: Direct execution (`npm start` or `tsx src/index.ts`)
- Responsibilities: Database init, channel connection, message/scheduler/IPC loop startup, graceful shutdown

**Channel Integrations:**
- WhatsApp: `src/channels/whatsapp.ts` - Connects via Baileys SDK, listens for `message` events
- Telegram: `src/channels/telegram.ts` - Connects via Grammy bot framework, listens for bot updates

**Container Spawning:**
- Location: `src/container-runner.ts` function `runContainerAgent()`
- Spawns Docker container with mounted volumes (group folder, project root for main)
- Writes prompt to container stdin, reads output from stdout
- Parses markers `---NANOCLAW_OUTPUT_START---` and `---NANOCLAW_OUTPUT_END---` to extract structured output

**IPC-Driven Requests:**
- Location: `src/ipc.ts` function `startIpcWatcher()`
- Watches `data/ipc/{groupFolder}/messages/` and `data/ipc/{groupFolder}/tasks/`
- Container writes JSON, host reads and acts (register group, send message, create task)

## Error Handling

**Strategy:** Graceful degradation with cursor rollback on container failures.

**Patterns:**

- **Message Processing Failure:** If container returns error or crashes before sending output to user:
  - Roll back `lastAgentTimestamp[chatJid]` so messages are reprocessed
  - Logged as "Agent error, rolled back message cursor for retry"
  - Retry on next message loop iteration

- **Message Sent But Container Errored:** If output was sent to user before error:
  - Keep cursor advanced to prevent duplicate messages
  - Log "Agent error after output was sent, skipping cursor rollback to prevent duplicates"

- **Channel Not Found:** If JID doesn't map to a connected channel:
  - Log warning "No channel owns JID"
  - Message is silently dropped (not retried)

- **Invalid Group Folder:** Path traversal prevention in `src/group-folder.ts`:
  - Validates folder name pattern: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`
  - Rejects reserved names (e.g., `global`)
  - Uses `path.relative()` to ensure `path.resolve()` stays within base directory

- **Container Timeout:** After `CONTAINER_TIMEOUT` (default 30min), container killed
  - Idle timeout after last output: `IDLE_TIMEOUT` (default 30min)

- **Task Validation:** Tasks with invalid `group_folder` are paused and logged, not retried

## Cross-Cutting Concerns

**Logging:** Pino logger at `src/logger.ts`
- Structured logging with fields (e.g., `{ groupJid, messageCount }`)
- Levels: debug, info, warn, error, fatal
- Used throughout for observability

**Validation:**
- **Group folders:** Validated via `isValidGroupFolder()` before path resolution
- **Input messages:** No validation (trusted from channel); output filtered for `<internal>` tags
- **Mounted paths:** Validated against `mount-allowlist.json` for security

**Authentication:**
- WhatsApp: Auth state stored in `store/auth/` (multi-file auth state)
- Telegram: Bot token from environment, optional bot pool for swarms
- Session continuity: Stored session ID per group folder passed to container

**Concurrency:**
- Per-group queuing ensures messages for same group processed sequentially
- Max 5 concurrent containers prevents host resource exhaustion
- Waiting queue for groups over limit

**Secrets:**
- Never logged or passed via environment; read from `.env` only where needed
- `src/env.ts` reads `.env` once at startup
- Container receives secrets via `ContainerInput.secrets` passed to stdin

---

*Architecture analysis: 2026-02-27*
