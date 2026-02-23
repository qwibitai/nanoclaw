# NanoClaw — Integration Architecture

## Overview

NanoClaw is a two-part system:

| Part | Location | Runtime |
|------|----------|---------|
| **Orchestrator** | `src/` | Node.js 22 on host |
| **Agent Runner** | `container/agent-runner/` | Node.js 22 inside Docker/Apple Container |

The parts communicate through three channels: **container I/O** (stdin/stdout), **IPC filesystem** (JSON files), and **shared SQLite** (read-only from containers).

---

## Architecture Diagram

```
WhatsApp Network
      │
      │ (Baileys WebSocket)
      ▼
┌─────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (host)                   │
│                                                         │
│  WhatsApp Channel     Message Loop        Task Scheduler│
│  whatsapp.ts    ───►  index.ts       ◄──  task-scheduler│
│                           │                             │
│                    GroupQueue (per-group)                │
│                           │                             │
│                   container-runner.ts                   │
│                           │                             │
│  SQLite DB ◄──── db.ts   │   IPC watcher ◄── ipc.ts   │
│  store/messages.db        │   data/ipc/{group}/         │
│                           │                             │
└───────────────────────────┼─────────────────────────────┘
                            │
           ┌────────────────┴────────────────┐
           │  Container I/O (stdin/stdout)    │
           │  ContainerInput JSON → stdin     │
           │  OUTPUT_START/END ← stdout       │
           └────────────────┬────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────┐
│               AGENT RUNNER (container)                   │
│                           │                             │
│              index.ts (Claude Agent SDK)                │
│                  ↕ query() loop                         │
│              ipc-mcp-stdio.ts (MCP stdio server)        │
│                           │                             │
│  Reads:                   │  Writes:                    │
│  data/tasks-{g}.json ◄────┤  data/ipc/{g}/messages/    │
│  data/groups.json         │  data/ipc/{g}/tasks/        │
│  groups/{g}/CLAUDE.md     │                             │
│  ~/.config/nanoclaw/...   │                             │
└───────────────────────────┴─────────────────────────────┘
```

---

## Integration Points

### 1. Orchestrator → Agent Runner: Container Spawn

**Direction:** Orchestrator → Agent Runner
**Transport:** Process spawn + stdin pipe
**Protocol:** JSON (`ContainerInput`) written to container stdin

```
Orchestrator: container-runner.ts
  → docker run nanoclaw-agent:latest
  → writes ContainerInput JSON to stdin
  → reads OUTPUT_START_MARKER / OUTPUT_END_MARKER from stdout
```

**Data format:**
```typescript
ContainerInput {
  messages: string[]       // XML-formatted conversation history
  groupFolder: string      // e.g. "main"
  chatJid: string          // WhatsApp JID
  assistantName: string    // e.g. "Andy"
  tasksSnapshot?: string   // JSON of scheduled tasks
  groupsSnapshot?: string  // JSON of registered groups
  isTask?: boolean         // true for scheduled task runs
  taskContext?: string     // Task prompt
}
```

**Response format:** Line-delimited stdout
```
OUTPUT_START_MARKER
<response text>
OUTPUT_END_MARKER
```

### 2. Agent Runner → Orchestrator: IPC Files

**Direction:** Agent Runner → Orchestrator
**Transport:** Shared filesystem (container volume mount)
**Protocol:** JSON files in `data/ipc/{groupFolder}/`

The agent writes IPC files; the IPC watcher (`src/ipc.ts`) polls every 1 second.

| IPC Type | Directory | Purpose |
|----------|-----------|---------|
| `message` | `data/ipc/{g}/messages/` | Send WhatsApp message |
| `schedule_task` | `data/ipc/{g}/tasks/` | Create scheduled task |
| `pause_task` | `data/ipc/{g}/tasks/` | Pause task |
| `resume_task` | `data/ipc/{g}/tasks/` | Resume task |
| `cancel_task` | `data/ipc/{g}/tasks/` | Cancel task |
| `register_group` | `data/ipc/{g}/tasks/` | Register new group |
| `refresh_groups` | `data/ipc/{g}/tasks/` | Reload group list |

**File naming:** `{timestamp}-{random}.json` (atomic write via temp+rename)

### 3. Orchestrator → Agent Runner: Follow-up Messages

**Direction:** Orchestrator → Agent Runner (running container)
**Transport:** Shared filesystem
**Protocol:** JSON files in `data/ipc/{groupFolder}/input/`

When new messages arrive while a container is running, the orchestrator writes them to the input directory. The agent runner polls this directory during its SDK query loop.

```typescript
// Follow-up message
{ type: "message", content: "follow-up text" }

// Sentinel: stop reading input
{ type: "_close" }
```

### 4. Orchestrator → Agent Runner: Snapshot Files

**Direction:** Orchestrator → Agent Runner (at container start)
**Transport:** Shared filesystem (host paths mounted into container)
**Protocol:** Static JSON files read at startup

| File | Purpose |
|------|---------|
| `data/tasks-{groupFolder}.json` | All scheduled tasks for this group |
| `data/groups.json` | All registered groups |

These are written by `container-runner.ts` before the container is spawned via `writeTasksSnapshot()` and `writeGroupsSnapshot()`.

### 5. Agent Runner ↔ Agent Runner: Shared Database (read-only)

The SQLite database at `store/messages.db` is mounted read-only into containers. The agent runner does NOT directly read the database (the snapshots above serve this purpose). However, the database path is accessible if needed for diagnostic tools.

---

## Volume Mounts

Every container receives these mounts:

| Host Path | Container Path | Mode |
|-----------|---------------|------|
| `groups/{name}/` | `/workspace` | read-write |
| `data/ipc/{name}/` | `/ipc` | read-write |
| `data/tasks-{name}.json` | `/tasks.json` | read-only |
| `data/groups.json` | `/groups.json` | read-only |
| `store/messages.db` | `/db/messages.db` | read-only |
| Additional mounts from `container_config` | varies | per-config |

Additional mounts from a group's `container_config` are validated against the allowlist in `~/.config/nanoclaw/mount-allowlist.json` before being added.

---

## Security Boundary

The container is the security boundary. The orchestrator enforces:

1. **Path traversal prevention** — `group-folder.ts` validates all paths before mount
2. **Mount allowlist** — Only paths in `~/.config/nanoclaw/mount-allowlist.json` can be mounted
3. **IPC authorization** — `chatJid` and `groupFolder` in IPC messages must match the registered group
4. **Cross-group isolation** — Each container only has access to its own group's IPC directories
5. **Secret sanitization** — `createSanitizeBashHook()` in the agent runner strips env secrets from Bash subprocess calls

---

## Data Flow: Message Processing

```
1. WhatsApp message received (whatsapp.ts)
   → stored in messages table (db.ts)

2. Poll loop detects new messages (index.ts, every 2s)
   → checks trigger pattern (requires_trigger)
   → groups messages by chatJid

3. GroupQueue dispatches to container (group-queue.ts)
   → up to MAX_CONCURRENT_CONTAINERS = 5 simultaneously
   → tasks have priority over regular messages

4. container-runner.ts spawns container
   → writes ContainerInput to stdin
   → mounts group filesystem, IPC dirs, snapshots

5. Agent runner processes (index.ts in container)
   → SDK query() loop with Claude API
   → MCP tools write IPC files

6. IPC watcher processes files (ipc.ts, every 1s)
   → send_message → whatsapp.ts.sendMessage()
   → schedule_task → db.ts insert
   → etc.

7. Response sent to WhatsApp (router.ts, whatsapp.ts)
   → stored in messages table as is_bot_message=1
```

---

## Data Flow: Scheduled Task

```
1. Task fires (task-scheduler.ts, every 60s)
   → queries scheduled_tasks WHERE next_run <= now

2. GroupQueue dispatches (isTask=true, priority)
   → container-runner.ts spawns container
   → ContainerInput.isTask = true, .taskContext = task.prompt

3. Agent runs in fresh or group context (contextMode)
   → performs requested action
   → may call send_message MCP tool to report results

4. Task log written (task_run_logs table)
   → status, duration_ms, result/error stored

5. Task updated (scheduled_tasks.next_run)
   → cron: recalculated from cron expression
   → interval: now + interval_ms
   → once: status = "completed", next_run = NULL
```
