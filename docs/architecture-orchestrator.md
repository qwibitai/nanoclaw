# NanoClaw — Architecture: Orchestrator

## Executive Summary

The orchestrator is a single long-running Node.js process that bridges WhatsApp with the Claude Agent SDK. It handles message ingestion, persistence, routing, container lifecycle, IPC, and scheduled tasks. It is designed to run as a system service (launchd/systemd) and restart cleanly after crashes.

**Version:** 1.1.0
**Language:** TypeScript (ESM, strict)
**Runtime:** Node.js 22+
**Database:** SQLite (better-sqlite3, synchronous API)

---

## Architecture Pattern

**Event-driven polling pipeline** with per-group queue isolation.

The orchestrator does NOT use async event streams for message delivery. Instead it uses a pull-based 2-second poll loop to read new messages from the local SQLite database — where WhatsApp messages are written by the Baileys library as they arrive. This decouples message ingestion from processing, making the system resilient to container slowness or crashes.

```
WhatsApp → [Baileys WebSocket] → SQLite write
                                      ↓
                          [2s poll loop] ← index.ts
                                      ↓
                          GroupQueue (per-group FIFO)
                                      ↓
                        ContainerRunner (spawn + I/O)
                                      ↓
                          IPC watcher + response send
```

---

## Technology Stack

| Category | Technology | Version | Role |
|----------|-----------|---------|------|
| Runtime | Node.js | ≥ 20 | Process host |
| Language | TypeScript | ^5.9.3 | Type-safe source |
| WhatsApp | @whiskeysockets/baileys | ^7.0.0-rc.9 | WA Web protocol client |
| Database | better-sqlite3 | ^11.10.0 | SQLite synchronous driver |
| Logging | pino + pino-pretty | ^9.14.0 | Structured JSON logging |
| Scheduling | cron-parser | ^5.5.0 | Cron expression evaluation |
| Config | yaml | ^2.8.2 | YAML config parsing |
| Validation | zod | ^4.3.6 | Schema validation |
| QR | qrcode + qrcode-terminal | latest | WhatsApp auth QR rendering |
| Testing | vitest | ^4.0.18 | Unit test runner |
| Formatting | prettier | ^3.8.1 | Code style |

---

## Module Overview

### `src/index.ts` — Orchestrator Core

The main entry point and state machine. Responsibilities:

- Initialize SQLite database (`db.ts`)
- Load environment (`env.ts`)
- Connect to WhatsApp (`channels/whatsapp.ts`)
- Start IPC watcher (`ipc.ts`)
- Start scheduler loop (`task-scheduler.ts`)
- Run the 2-second message poll loop
- Dispatch messages to `GroupQueue`
- Call `runAgent()` → `runContainerAgent()`
- Graceful shutdown (SIGTERM/SIGINT handlers)

**Key flow — `processGroupMessages()`:**
1. Query new messages since `last_agent_timestamp[chatJid]`
2. Format messages as XML using `router.ts`
3. Push to `GroupQueue`
4. Update `last_agent_timestamp` in `router_state`

### `src/channels/whatsapp.ts` — WhatsApp Channel

Implements the `Channel` interface. Built on Baileys v7 (WhatsApp Web protocol).

Key behaviors:
- **Multi-file auth**: Auth state in `store/auth/` (creds.json + key store)
- **LID→phone translation**: Resolves Linked Device IDs to phone-number JIDs for group member identification
- **Outgoing queue**: Rate-limited message send queue to avoid WA spam detection
- **Typing indicators**: Composing/paused states sent around agent responses
- **Group metadata sync**: Cached for 24h; refreshed on demand; synced on startup via `__group_sync__` cursor
- **Reconnect logic**: Exponential backoff reconnection on disconnect

### `src/db.ts` — Database Layer

Synchronous SQLite operations via `better-sqlite3`. All methods are plain functions (not async).

Tables managed: `chats`, `messages`, `scheduled_tasks`, `task_run_logs`, `router_state`, `sessions`, `registered_groups`

Migration strategy:
- `CREATE TABLE IF NOT EXISTS` on every startup
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in try/catch for additive migrations
- JSON file migration (legacy → SQLite) runs once on first startup after upgrade
- Backfill logic for `is_bot_message` and channel/group fields

### `src/container-runner.ts` — Container Lifecycle

Spawns and manages the Docker/Apple Container process for each agent invocation.

Key behaviors:
- Builds volume mount arguments (calls `mount-security.ts` for validation)
- Writes `ContainerInput` JSON to container stdin
- Parses `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` pairs from stdout (streaming)
- Handles container timeout (default: 30 minutes)
- Calls `writeTasksSnapshot()` and `writeGroupsSnapshot()` before spawn

Container naming: `nanoclaw-{groupFolder}-{timestamp}` for traceability.

### `src/ipc.ts` — IPC Watcher

Polls `data/ipc/{group}/messages/` and `data/ipc/{group}/tasks/` every 1 second for JSON files written by running containers.

Authorization: Each IPC file must reference the correct `groupFolder` and `chatJid`. Cross-group writes are rejected.

Processed IPC types:
- `message` → `channel.sendMessage()`
- `schedule_task` → `db.createScheduledTask()`
- `pause_task` / `resume_task` / `cancel_task` → `db.updateTaskStatus()`
- `register_group` → `db.registerGroup()`
- `refresh_groups` → reload registered groups into memory

### `src/group-queue.ts` — Concurrency Control

Per-group queue that serializes container invocations and manages global concurrency.

- **Max concurrency**: 5 containers globally (`MAX_CONCURRENT_CONTAINERS`)
- **Task priority**: Scheduled tasks run before queued user messages
- **Retry**: 5 attempts with exponential backoff (5s base delay)
- **Multi-turn**: New messages to a busy group are fed into the running container via IPC input files (not a new container spawn)
- **Close signal**: `closeStdin()` writes `{ type: "_close" }` sentinel when all queued messages are flushed

### `src/task-scheduler.ts` — Scheduler

Polls `scheduled_tasks` table every 60 seconds for due tasks. Dispatches via `GroupQueue` (same path as regular messages, with `isTask=true` flag for priority).

After each run:
- Updates `last_run` and `next_run` (cron/interval recalculated, once → completed)
- Writes `task_run_logs` entry
- Updates `last_result` with truncated agent output

### `src/mount-security.ts` — Mount Security

Validates volume mounts against the allowlist before passing to the container.

Allowlist location: `~/.config/nanoclaw/mount-allowlist.json` (outside project root, tamper-resistant).

Default blocked path patterns: `.ssh`, `.gnupg`, `.aws`, `.netrc`, `.npmrc`, `.pypirc`, `.docker`, `.kube`, `.azure`, `.gcloud`.

`nonMainReadOnly: true` → non-main groups can only get read-only mounts from the allowlist.

### `src/container-runtime.ts` — Runtime Abstraction

Thin wrapper that selects between `docker` and `container` (Apple Container) binaries. The binary is set as `CONTAINER_RUNTIME_BIN`. Provides:
- `ensureContainerRuntimeRunning()` — check if daemon is available
- `cleanupOrphans()` — remove stale `nanoclaw-*` containers from prior runs
- `readonlyMountArgs()` — generate `:ro` mount flag strings
- `stopContainer()` — SIGTERM a running container

---

## Data Architecture

All persistent state lives in `store/messages.db` (SQLite). See [data-models.md](./data-models.md) for full schema.

**Runtime-only state** (not persisted):
- WhatsApp WebSocket connection
- Per-group `GroupQueue` instances
- Container process handles
- IPC file polling timer references

---

## Authentication / Security

### WhatsApp Authentication
- **Method**: Baileys multi-file auth (WA Web protocol, no official API)
- **Storage**: `store/auth/creds.json` + key files (AES-256 encrypted WA keys)
- **Re-auth**: Delete `store/auth/` and run `npm run auth`

### Claude Authentication
- **Method**: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in `.env`
- **Passed to containers**: Via environment variable in container spawn

### Container Security
- Containers run with restricted mounts (allowlist-enforced)
- IPC files are validated for group ownership before processing
- Path traversal is prevented in `group-folder.ts` (rejects `..` segments)
- Bash environment sanitization strips secrets before subprocess calls in the agent

---

## Async / Event Patterns

| Pattern | Used For |
|---------|---------|
| Pull-based poll (2s) | New message detection |
| Pull-based poll (60s) | Scheduled task firing |
| Pull-based poll (1s) | IPC file processing |
| Process spawn + stdio | Container agent invocation |
| Async queue (GroupQueue) | Per-group message serialization |
| Retry with exponential backoff | Container failure recovery |
| Baileys event emitter | WhatsApp message ingestion → SQLite writes |

The orchestrator deliberately avoids complex async pipelines in favor of simple polling. This makes the system easy to reason about and resilient to slow operations.

---

## Source Tree

See [source-tree-analysis.md](./source-tree-analysis.md) for the full annotated directory tree.

**Critical paths:**
```
src/
├── index.ts         ← Start here
├── container-runner.ts + container-runtime.ts + mount-security.ts
├── ipc.ts
├── group-queue.ts
├── task-scheduler.ts
├── db.ts
└── channels/whatsapp.ts
```

---

## Development Workflow

See [development-guide.md](./development-guide.md) for full instructions.

Quick start:
```bash
npm install
npm run dev          # Hot-reload development
npm run typecheck    # TypeScript check
npm test             # Vitest unit tests
```

---

## Deployment

See [deployment-guide.md](./deployment-guide.md) for full instructions.

Service commands:
```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw    # restart
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # stop

# Linux
systemctl --user restart nanoclaw
```

---

## CI/CD

GitHub Actions (`.github/workflows/test.yml`):
- Triggers on PR to `main`
- Steps: `npm ci` → `tsc --noEmit` → `vitest run`
- No container build in CI (Docker not available in standard runners)

Deployment is manual — managed via `launchd`/`systemd` on the host machine.
