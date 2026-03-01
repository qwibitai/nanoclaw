# NanoClaw Architecture Walkthrough

A guide for contributors who want to understand how NanoClaw is built before making changes.

---

## Table of Contents

1. [What It Is](#1-what-it-is)
2. [Repository Layout](#2-repository-layout)
3. [Bootstrap and Startup](#3-bootstrap-and-startup)
4. [WhatsApp Channel](#4-whatsapp-channel)
5. [Message Loop and Trigger Matching](#5-message-loop-and-trigger-matching)
6. [Concurrency Control (GroupQueue)](#6-concurrency-control-groupqueue)
7. [Container Runner](#7-container-runner)
8. [Inside the Container](#8-inside-the-container)
9. [IPC: Two-Way Communication](#9-ipc-two-way-communication)
10. [Task Scheduler](#10-task-scheduler)
11. [Database](#11-database)
12. [Security Model](#12-security-model)
13. [Skills Engine](#13-skills-engine)
14. [End-to-End Message Flow](#14-end-to-end-message-flow)
15. [Commit History Highlights](#15-commit-history-highlights)
16. [Where to Start Contributing](#16-where-to-start-contributing)

---

## 1. What It Is

NanoClaw is a **personal Claude assistant** that bridges WhatsApp (and optionally Slack, Telegram, or email) to the Claude Agent SDK. The core design philosophy is:

> Security through OS-level isolation rather than application-level permission checks.

Instead of trying to sandbox Claude in software, each conversation runs in an ephemeral Docker (or Apple Container) with only the directories it is allowed to see explicitly mounted in. Nothing else is reachable.

The codebase is intentionally small (~2,000 lines of main code) so a contributor can read it all in an afternoon.

---

## 2. Repository Layout

```
nanoclaw/
├── src/                        # Host-side orchestrator (Node.js, TypeScript)
│   ├── index.ts                # Main loop, agent invocation, state
│   ├── channels/
│   │   └── whatsapp.ts         # WhatsApp via Baileys
│   ├── container-runner.ts     # Spawn containers, parse output
│   ├── container-runtime.ts    # Docker / Apple Container detection
│   ├── group-queue.ts          # Per-group FIFO + global concurrency limit
│   ├── ipc.ts                  # Watch IPC dirs, dispatch agent actions
│   ├── task-scheduler.ts       # Cron / interval / one-shot tasks
│   ├── db.ts                   # SQLite via better-sqlite3
│   ├── router.ts               # Message formatting, <internal> stripping
│   ├── config.ts               # All tunables (env vars, paths, timeouts)
│   ├── mount-security.ts       # Allowlist validation for extra mounts
│   ├── group-folder.ts         # Safe path resolution for group dirs
│   └── types.ts                # Shared TypeScript interfaces
│
├── container/                  # Everything that runs inside the container
│   ├── Dockerfile              # node:22-slim + Chromium + claude-code
│   ├── build.sh                # Build helper
│   ├── agent-runner/           # TypeScript project compiled at container start
│   │   └── src/index.ts        # Claude Agent SDK integration
│   └── skills/                 # Skill markdown files synced to each group
│
├── groups/                     # Per-group memory (each group is a subdirectory)
│   ├── main/                   # Admin / self-chat group
│   │   └── CLAUDE.md           # Andy's personality, capabilities, instructions
│   └── global/                 # Read-only shared memory for all groups
│
├── store/                      # Runtime persistence (gitignored)
│   ├── auth/                   # WhatsApp session files (Baileys)
│   └── messages.db             # SQLite database
│
└── data/                       # Runtime state (gitignored)
    ├── sessions/               # Per-group .claude/ dirs and agent-runner source
    └── ipc/                    # Per-group IPC namespaces
```

**Key insight:** `src/` never runs inside a container. It is the host process that orchestrates everything. The code that actually talks to the Claude Agent SDK lives in `container/agent-runner/`.

---

## 3. Bootstrap and Startup

Entry point: `src/index.ts:448` — `main()`

```
main()
  ├── ensureContainerSystemRunning()    # Docker running? Orphan cleanup
  ├── initDatabase()                    # Create/migrate SQLite tables
  ├── loadState()                       # Restore cursors and group map from DB
  ├── new WhatsAppChannel(...)          # Build channel
  ├── whatsapp.connect()                # QR auth / reconnect, blocks until open
  ├── startSchedulerLoop(...)           # Scheduled task loop (60s poll)
  ├── startIpcWatcher(...)              # IPC file watcher (1s poll)
  ├── queue.setProcessMessagesFn(...)   # Wire up the queue callback
  ├── recoverPendingMessages()          # Crash recovery: re-enqueue missed msgs
  └── startMessageLoop()               # Main 2s poll loop — runs forever
```

**Configuration** (`src/config.ts`) is all compile-time constants and env-var reads. Key values:

| Variable | Default | Purpose |
|---|---|---|
| `ASSISTANT_NAME` | `Andy` | Trigger word, message prefix |
| `POLL_INTERVAL` | `2000` ms | Message loop cadence |
| `SCHEDULER_POLL_INTERVAL` | `60000` ms | Task scheduler cadence |
| `IDLE_TIMEOUT` | `1800000` ms (30 min) | Keep container alive after last output |
| `CONTAINER_TIMEOUT` | `1800000` ms (30 min) | Hard kill timer |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Global concurrency cap |

`TRIGGER_PATTERN` (`src/config.ts:56`) is a regex built from `ASSISTANT_NAME`: `^@Andy\b` (case-insensitive). Messages that don't match this pattern are stored in the database but not acted on — they accumulate as context for the next trigger.

---

## 4. WhatsApp Channel

File: `src/channels/whatsapp.ts`

NanoClaw uses [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), a reverse-engineered WhatsApp Web library. The flow is:

```
makeWASocket()                          # :71  — open WA Web connection
  └── ev.on('connection.update')        # :82  — handle open/close/qr events
  └── ev.on('creds.update', saveCreds)  # :170 — persist auth state to store/auth/
  └── ev.on('messages.upsert')          # :172 — inbound messages
```

**Authentication:** Session files live in `store/auth/`. Once authenticated you don't need to QR again unless you log out. If a QR is triggered at runtime the process exits and sends a macOS notification (`:89`).

**Inbound message handling** (`:172`):

1. Translate LID JIDs to phone JIDs (`:179`) — WhatsApp sometimes sends encrypted LID identifiers instead of phone numbers.
2. Call `onChatMetadata()` for every message — this is how new groups get discovered and named in the `chats` table.
3. If the chat JID is in `registeredGroups`: extract text content and call `onMessage()` which calls `storeMessage()`.

**What counts as text** (`:198`):
```
msg.message?.conversation
msg.message?.extendedTextMessage?.text
msg.message?.imageMessage?.caption
msg.message?.videoMessage?.caption
```
Voice notes, stickers, and protocol messages (encryption, read receipts) produce no content and are skipped.

**Bot message detection** (`:216`): With a dedicated phone number `fromMe` is reliable. With a shared number, the bot marks its own messages with the `ASSISTANT_NAME:` prefix so they can be identified and excluded from context fed back to the agent.

**Outgoing messages** (`sendMessage`, `:235`): Prefixes with `Andy: ` on shared numbers. If disconnected, queues the message and flushes when reconnected (`:357`).

**Typing indicators** (`setTyping`, `:278`): Sends a Baileys `sendPresenceUpdate('composing' | 'paused', jid)`.

---

## 5. Message Loop and Trigger Matching

File: `src/index.ts:328` — `startMessageLoop()`

Runs an infinite loop with a 2-second sleep (`src/config.ts:16` — `POLL_INTERVAL = 2000`).

```
while (true) {
  messages = getNewMessages(registeredJids, lastTimestamp, ASSISTANT_NAME)
  // getNewMessages() queries SQLite for rows newer than lastTimestamp,
  // filtered to registered groups, excluding bot messages

  for each group with new messages:
    if needsTrigger && no trigger in batch → skip (messages stay in DB as context)

    allPending = getMessagesSince(chatJid, lastAgentTimestamp[chatJid])
    // Pulls all messages since the last time we ran the agent,
    // so non-trigger context that piled up is included

    if queue.sendMessage(chatJid, formatted):
      // Container for this group is alive and idle-waiting — pipe directly in
      advance lastAgentTimestamp cursor
    else:
      // No container running — enqueue for a new spawn
      queue.enqueueMessageCheck(chatJid)

  await sleep(POLL_INTERVAL)
}
```

Two cursors are maintained:

- `lastTimestamp` — global "seen" marker, advances for every new message. Prevents re-scanning old rows on the next poll.
- `lastAgentTimestamp[chatJid]` — per-group "processed" marker. The agent only sees messages newer than this. Rolls back on error (`:235`) so messages are retried on the next invocation.

Both cursors are persisted to the `router_state` table so they survive restarts.

---

## 6. Concurrency Control (GroupQueue)

File: `src/group-queue.ts`

The queue has two jobs:
1. Enforce the global `MAX_CONCURRENT_CONTAINERS` limit.
2. Allow follow-up messages to be piped into an already-running container without restarting it.

**State per group** (`:17`):

```typescript
interface GroupState {
  active: boolean          // container is running
  idleWaiting: boolean     // container done with last query, waiting for more input
  isTaskContainer: boolean // this container was spawned for a scheduled task
  pendingMessages: boolean // message arrived while container was busy
  pendingTasks: QueuedTask[]
  process: ChildProcess | null
  containerName: string | null
}
```

**Message path:**

```
enqueueMessageCheck(jid)
  → if active || at limit: set pendingMessages = true, add to waitingGroups
  → else: runForGroup(jid) → processMessagesFn(jid) [calls processGroupMessages]
```

**Piping** (`sendMessage`, `:154`): If a container is `active` and not a task container, write a JSON file to `data/ipc/<folder>/input/`. The container polls this directory and feeds the text as a new user message into the SDK's `MessageStream` without restarting. This keeps conversation context alive across multiple messages.

**Idle preemption** (`notifyIdle`, `:142`): When the agent finishes a query it calls `notifyIdle()`. If there are pending tasks in the queue, `closeStdin()` is called immediately to send a `_close` sentinel to the container, allowing the task to run without waiting for the 30-minute idle timeout.

**Retry with backoff** (`scheduleRetry`, `:255`): On failure, retries up to 5 times with `5s, 10s, 20s, 40s, 80s` delays.

**Drain order** (`drainGroup`, `:278`): When a container finishes, tasks are drained before messages, then other waiting groups are considered.

---

## 7. Container Runner

File: `src/container-runner.ts`

This is where `docker run` (or `container run`) gets constructed and executed.

### Volume Mounts

`buildVolumeMounts()` (`:57`) assembles the mount list depending on whether this is the main group:

| Host path | Container path | RW? | Main only? |
|---|---|---|---|
| `process.cwd()` (project root) | `/workspace/project` | ro | yes |
| `groups/<folder>` | `/workspace/group` | rw | no |
| `groups/global` | `/workspace/global` | ro | no |
| `data/sessions/<folder>/.claude` | `/home/node/.claude` | rw | no |
| `data/ipc/<folder>` | `/workspace/ipc` | rw | no |
| `data/sessions/<folder>/agent-runner-src` | `/app/src` | rw | no |
| Additional mounts (allowlist-validated) | `/workspace/extra/*` | configurable | no |

The project root is mounted **read-only** for the main group (`:71`). This is critical: the agent can read the source code to help debug/update NanoClaw, but cannot modify `src/`, `package.json`, etc. and have those changes silently take effect on the next restart.

### Container Input

Secrets (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) are read from `.env` at spawn time (`readSecrets`, `:206`) and injected via stdin JSON — never written to disk or passed as environment variables to the container process itself, which would make them visible to child `Bash` commands.

```typescript
// src/container-runner.ts:298
container.stdin.write(JSON.stringify(input));
container.stdin.end();
delete input.secrets;  // remove from memory immediately after sending
```

### Output Parsing

The container wraps each result in sentinel markers:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Here is your answer...","newSessionId":"ses_abc123"}
---NANOCLAW_OUTPUT_END---
```

The host streams stdout and parses these pairs as they arrive (`:330`), calling `onOutput()` for each one. This enables real-time streaming of multi-part agent responses to WhatsApp before the container has finished.

### Settings Injection

Before running, `buildVolumeMounts()` creates `data/sessions/<folder>/.claude/settings.json` (`:112`) with:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
```

This enables agent swarms, multi-directory CLAUDE.md loading, and Claude's memory feature.

### Skills Sync

At mount time (`:136`), skills from `container/skills/` are copied into `data/sessions/<folder>/.claude/skills/`. Each group gets its own copy. This means you can add a skill by dropping a directory under `container/skills/` — no Docker rebuild required for groups that already have running sessions.

---

## 8. Inside the Container

Files: `container/Dockerfile`, `container/agent-runner/src/index.ts`

### The Image

```dockerfile
FROM node:22-slim
# Chromium for browser automation (agent-browser skill)
RUN apt-get install -y chromium ...
RUN npm install -g agent-browser @anthropic-ai/claude-code
COPY agent-runner/ ./
RUN npm run build
USER node  # non-root, required for --dangerously-skip-permissions
ENTRYPOINT ["/app/entrypoint.sh"]
```

### The Entrypoint

The entrypoint script (built inline in the Dockerfile `:56`):
1. `npx tsc --outDir /tmp/dist` — recompile agent-runner source (which is mounted from `data/sessions/<folder>/agent-runner-src/`). Groups can customize this source.
2. `cat > /tmp/input.json` — buffer stdin to a temp file.
3. `node /tmp/dist/index.js < /tmp/input.json` — run with stdin redirected.
4. The agent-runner immediately deletes `/tmp/input.json` after reading it (`:500`).

### The Agent Runner (`container/agent-runner/src/index.ts`)

This is the piece that actually uses the Claude Agent SDK. Key flow:

```
main()
  ├── readStdin() → parse ContainerInput JSON
  ├── build sdkEnv (merge secrets into process.env copy — not into actual process.env)
  ├── drainIpcInput() — consume any queued messages from before container start
  └── query loop:
        runQuery(prompt, sessionId, ...)
          ├── new MessageStream()      # push-based async iterable
          ├── stream.push(prompt)      # initial message
          ├── pollIpcDuringQuery()     # poll /workspace/ipc/input/ while running
          │     ├── if _close sentinel: stream.end(), closedDuringQuery = true
          │     └── if .json files: stream.push(text) — pipes into live query
          └── for await (message of query({ prompt: stream, ... })):
                if message.type === 'result': writeOutput({status, result, newSessionId})

        if closedDuringQuery: break
        writeOutput({ result: null, newSessionId })   # session-update marker
        nextMessage = waitForIpcMessage()             # block until more input or _close
        if nextMessage === null: break
        prompt = nextMessage → loop
```

The `MessageStream` class (`:66`) is an async iterable that stays open until `end()` is called. Passing it as `prompt` to `query()` instead of a plain string keeps `isSingleUserTurn = false`, which allows agent-teams subagents to run to completion.

**SDK options** (`:417`):

```typescript
query({
  prompt: stream,
  options: {
    cwd: '/workspace/group',            // working directory for tools
    resume: sessionId,                  // continue existing session
    permissionMode: 'bypassPermissions',
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
                   'WebSearch', 'WebFetch', 'Task', 'TeamCreate', ...],
    mcpServers: { nanoclaw: { command: 'node', args: [mcpServerPath] } },
    hooks: {
      PreCompact: [createPreCompactHook()],   // archive transcript before compaction
      PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }]
    }
  }
})
```

**Security hooks:**
- `createSanitizeBashHook()` (`:193`) prepends `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null; ` to every Bash command, preventing subprocesses from inheriting secrets.
- `createPreCompactHook()` (`:146`) archives the full transcript to `conversations/` as a markdown file before the SDK compacts it.

---

## 9. IPC: Two-Way Communication

File: `src/ipc.ts`

The agent writes JSON files to directories mounted at `/workspace/ipc/`. The host watches these directories. This is how the agent triggers side effects that require host-side authority (sending messages, managing tasks, registering groups).

**Directory layout** (per group):
```
data/ipc/<folder>/
  messages/    ← agent writes {type:"message", chatJid, text} files here
  tasks/       ← agent writes task management commands here
  input/       ← host writes follow-up messages here; agent polls and consumes
  errors/      ← failed files moved here for inspection
```

**IPC watcher** (`startIpcWatcher`, `:34`): Polls every 1 second. For each group directory, processes all `.json` files in `messages/` and `tasks/`.

**Authorization model** (`:60`): The group's identity is derived from the **directory path** (`sourceGroup = 'main'` or `'family-chat'`), not from user-supplied data in the JSON payload. An agent cannot claim to be `main` in its IPC payload to gain elevated access.

**Supported operations:**

| `type` | Who can use | What it does |
|---|---|---|
| `message` | any group | Send text to a chat JID (blocked if not own group, unless main) |
| `schedule_task` | any group | Create a task (only for own group unless main) |
| `pause_task` / `resume_task` / `cancel_task` | any group | Manage own tasks |
| `register_group` | main only | Add a new group to `registered_groups` |
| `refresh_groups` | main only | Re-sync group metadata from WhatsApp |

**Follow-up message flow** (the "piping" path):

When the host message loop detects a new message for an already-running container, it calls `queue.sendMessage()` (`:154` in `group-queue.ts`) which writes a JSON file to `data/ipc/<folder>/input/`. Inside the container, `pollIpcDuringQuery()` picks this up within 500ms and pushes it into the live `MessageStream`.

---

## 10. Task Scheduler

File: `src/task-scheduler.ts`

Every 60 seconds (`SCHEDULER_POLL_INTERVAL`), `startSchedulerLoop()` (`:217`) queries the database for due tasks:

```
getDueTasks()  →  tasks where next_run <= now AND status = 'active'
```

For each due task, it calls `queue.enqueueTask()` which obeys the same global concurrency limit as user messages. The task runs via `runTask()` (`:42`):

1. Look up the registered group for this task.
2. Write a tasks snapshot so the container can see its own task list.
3. Call `runContainerAgent()` with `isScheduledTask: true`.
4. Schedule a close sentinel 10 seconds after the first result (`:127`) — tasks are single-turn and don't need the 30-minute idle window.
5. After completion: log to `task_run_logs`, compute `next_run` for cron/interval types, update `scheduled_tasks`.

**Schedule types:**

| Type | `schedule_value` | Next run calculation |
|---|---|---|
| `cron` | `"0 9 * * MON"` | Parsed with `cron-parser` using host timezone |
| `interval` | `"3600000"` (ms) | `Date.now() + ms` |
| `once` | `"2026-03-01T09:00:00Z"` | Runs once, then `status = 'completed'` |

**Context modes:**
- `isolated` — fresh session, no memory of previous conversations.
- `group` — reuses the group's current `session_id`, so the task has access to the conversation history.

---

## 11. Database

File: `src/db.ts`

Uses [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — synchronous, no async/await. The database file lives at `store/messages.db`.

**Schema:**

```sql
chats           -- JID → name, last activity, channel, is_group
messages        -- all inbound + outbound messages (PK: id + chat_jid)
scheduled_tasks -- task definitions with next_run, status
task_run_logs   -- execution history per task
router_state    -- key/value store for last_timestamp, last_agent_timestamp
sessions        -- group_folder → session_id
registered_groups -- jid → name, folder, trigger_pattern, container_config
```

`initDatabase()` creates the schema and runs column-addition migrations automatically — adding a column via `ALTER TABLE IF NOT EXISTS` pattern so old databases are safe on upgrade.

Messages are stored by `onMessage` in `WhatsAppChannel`, which fires for every inbound message. `getNewMessages()` and `getMessagesSince()` exclude bot messages (`is_bot_message = 0`) so the agent never sees its own previous replies in the formatted prompt.

---

## 12. Security Model

Security is layered, with each layer being independent:

### Container Isolation
Each agent run is a separate ephemeral container (`--rm`). It sees only what is explicitly mounted. The host filesystem, network, and processes are not reachable. Containers run as the non-root `node` user.

### Filesystem Access Control
`src/mount-security.ts` validates any extra mounts requested in `containerConfig.additionalMounts`. It:
- Resolves symlinks to prevent `../../.ssh` traversal.
- Checks against blocked patterns: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.gcloud`, `credentials`, `.env`, private key files, etc.
- Enforces read-only for non-main groups if `nonMainReadOnly` is set in the allowlist.
- The allowlist itself lives at `~/.config/nanoclaw/mount-allowlist.json` — outside the project root and never mounted into containers.

### Credential Isolation
Secrets are read from `.env` on the host, passed via stdin JSON to the container, and immediately deleted. They are injected only into the SDK's `env` option (not `process.env`), so `Bash` subcommands cannot inherit them. The `createSanitizeBashHook()` explicitly unsets them as an additional layer.

### IPC Authorization
Group identity in IPC is derived from the directory path, not from user-supplied payload fields. A compromised or prompt-injected agent in a non-main group cannot escalate to main-group privileges.

### Trust Hierarchy

| Actor | Trust level | Notes |
|---|---|---|
| Main group (self-chat) | Admin | Can register groups, schedule cross-group tasks, refresh metadata |
| Non-main groups | User | Can only act on own group |
| Container agents | Sandboxed | Explicit filesystem mounts, secrets isolated from Bash |
| WhatsApp message content | Untrusted | Potential prompt injection vector |

---

## 13. Skills Engine

Skills are markdown files in `container/skills/<skill-name>/SKILL.md` (plus any supporting files). They are synced to `data/sessions/<folder>/.claude/skills/` at container mount time (`src/container-runner.ts:136`).

Claude Code picks up skills automatically from `.claude/skills/` and exposes them as `/skill-name` slash commands.

**To add a new skill:**
1. Create `container/skills/my-skill/SKILL.md` with a YAML front-matter header and instructions.
2. The skill will be available to all groups on their next container spawn — no Docker rebuild needed unless the skill requires new system dependencies.
3. If it needs new npm packages, add them to `container/agent-runner/package.json` and rebuild the image.

---

## 14. End-to-End Message Flow

Here is a complete trace of a user sending `@Andy summarize today's news` in the Family Chat group:

```
1.  User sends "@Andy summarize today's news" in WhatsApp Family Chat

2.  Baileys fires 'messages.upsert' in src/channels/whatsapp.ts:172
    - Translates JID if needed
    - Calls onChatMetadata() to update the chats table
    - family-chat JID is in registeredGroups → calls onMessage()

3.  onMessage() → storeMessage() in src/db.ts
    - Inserts row into messages table (is_bot_message=0)

4.  2 seconds later: startMessageLoop() polls in src/index.ts:340
    - getNewMessages() finds the new row (timestamp > lastTimestamp)
    - family-chat group has requiresTrigger, checks for "@Andy" → match ✓
    - lastTimestamp advances, saveState()
    - getMessagesSince(chatJid, lastAgentTimestamp['family-chat']) gathers all
      pending context (including non-trigger messages that piled up)
    - formatMessages() wraps them in XML: <message from="Alice" ...>...</message>

5.  queue.sendMessage(chatJid, formatted) → false (no active container)
    queue.enqueueMessageCheck(chatJid)

6.  GroupQueue.runForGroup() in src/group-queue.ts:190
    - activeCount++ (now 1)
    - calls processGroupMessages('family-chat@g.us')

7.  processGroupMessages() in src/index.ts:133
    - Writes tasks snapshot and groups snapshot for the container
    - channel.setTyping(chatJid, true) → WhatsApp shows "typing..."
    - calls runContainerAgent(group, { prompt, sessionId, ... })

8.  runContainerAgent() in src/container-runner.ts:242
    - buildVolumeMounts() assembles mounts for family-chat
    - buildContainerArgs() builds: docker run -i --rm --name nanoclaw-family-chat-... \
        -v .../groups/family-chat:/workspace/group \
        -v .../groups/global:/workspace/global:ro \
        -v .../data/sessions/family-chat/.claude:/home/node/.claude \
        -v .../data/ipc/family-chat:/workspace/ipc \
        -v .../data/sessions/family-chat/agent-runner-src:/app/src \
        nanoclaw-agent:latest
    - spawn() launches the container
    - Writes JSON input to container stdin (including API key)
    - Starts streaming stdout, watching for OUTPUT_START/END markers

9.  Inside the container — entrypoint.sh:
    - Recompiles /app/src → /tmp/dist
    - Pipes stdin to /tmp/input.json
    - node /tmp/dist/index.js < /tmp/input.json

10. container/agent-runner/src/index.ts — main():
    - Reads and parses ContainerInput from stdin
    - Deletes /tmp/input.json
    - Builds sdkEnv with API key
    - Loads /workspace/group/CLAUDE.md (via SDK cwd setting)
    - Loads /workspace/global/CLAUDE.md (injected as systemPrompt append)
    - Calls query({ prompt: MessageStream, options: { cwd: '/workspace/group', ... } })

11. Claude Agent SDK runs the agent:
    - Reads CLAUDE.md, understands it's Andy in Family Chat
    - Fetches news via WebSearch or Bash (curl, etc.)
    - Generates a summary

12. SDK emits a 'result' message:
    - writeOutput({ status: 'success', result: 'Here is today's news summary...' })
    - Prints: ---NANOCLAW_OUTPUT_START---\n{...}\n---NANOCLAW_OUTPUT_END---

13. Host stdout handler in src/container-runner.ts:330
    - Parses the JSON between markers
    - Calls onOutput(parsed)

14. onOutput callback in src/index.ts:194
    - Strips <internal>...</internal> blocks
    - channel.sendMessage(chatJid, text)
    - resetIdleTimer() → sets 30-min timer to close container

15. WhatsApp sends the reply:
    "Andy: Here is today's news summary..."
    - channel.setTyping(chatJid, false)

16. Container stays alive (idle-waiting) for 30 minutes.
    If another message arrives, it is piped directly into the running container
    without spawning a new one, keeping conversation context.

17. After 30 minutes of silence:
    - idleTimer fires → queue.closeStdin(chatJid)
    - Writes _close sentinel to data/ipc/family-chat/input/
    - Container's waitForIpcMessage() returns null → main() exits
    - Container process ends, --rm cleans it up
    - GroupQueue.drainGroup() handles any pending work
```

---

## 15. Commit History Highlights

The entire initial architecture was committed in a single large drop (`93bb94f`, Feb 2026) — 188 files, ~37,000 lines. Development then iterated quickly:

| Commit | Date | What changed |
|---|---|---|
| `93bb94f` | Feb 21 | Initial codebase — complete architecture in one drop |
| `c6b69e8` | Feb 21 | Fix: idle preemption only fires when scheduled tasks arrive, not on every message |
| `3d8c0d1` | Feb 21 | Tests: `isTaskContainer` and `idleWaiting` reset coverage |
| `5f58941` | Feb 21 | Fix: `.catch()` on fire-and-forget async calls to prevent unhandled rejections |
| `ccef3bb` | Feb 22 | Security: block symlink escapes in skills file ops |
| `5fb1064` | Feb 22 | Security: mount project root read-only to prevent container escape |
| `c6391cc` | Feb 22 | Security: block group folder path escapes (`../`) |
| `77f7423` | Feb 22 | Fix: pass host timezone to container; reject UTC-suffixed timestamps in cron |
| `107aff8` | Feb 22 | Fix: pass `assistantName` to container instead of hardcoding `Andy` |
| `264f855` | Feb 23 | UX: replace "ask the user" text with `AskUserQuestion` tool in skills |
| `9fb1790` | Feb 23 | Fix: type safety improvements and error logging |
| `1216b5b` | Feb 23 | Feature: `/update` skill for pulling upstream NanoClaw changes |
| `1ff1fd6` | Feb 23 | Feature: Qodo skills for PR review and coding rules |
| `ec176a0` | Feb 24 | Fix: use `fetchLatestWaWebVersion` to prevent 405 connection failures |
| `29a5daf` | Feb 24 | Refactor: remove deterministic caching from skills engine |
| `18c0432` | Feb 24 | Fix: QR data handling in WhatsApp auth |
| `ee7f720` | Feb 25 | Feature: `/add-slack` channel skill |
| `11c2010` | Feb 25 | Refactor: CI optimization, logging, formatting pass |
| `a6a1178` | Feb 27 | Chore: add Husky + `format:fix` script |

**Security hardening pattern:** The Feb 22 wave shows the typical pattern — initial drop, then immediately harden the security boundaries (symlinks, path escapes, ro mounts, timezone).

---

## 16. Where to Start Contributing

**Easy first issues:**
- Add a new skill: `container/skills/<name>/SKILL.md` (no build needed)
- Improve logging in `src/container-runner.ts`
- Add test coverage (Vitest) for `src/router.ts` or `src/ipc.ts`

**Medium complexity:**
- Add a new channel (see `/add-slack` or `/add-telegram` skills as templates for how channels implement the `Channel` interface in `src/types.ts`)
- Add a new IPC operation type in `src/ipc.ts` + corresponding agent-runner handling
- Improve the `GroupQueue` drain order logic in `src/group-queue.ts`

**Higher complexity:**
- Changes to the container input/output protocol (must update both `src/container-runner.ts` and `container/agent-runner/src/index.ts` atomically)
- Database schema changes (add a migration in `src/db.ts:initDatabase()`)
- Changes to mount security (`src/mount-security.ts`) — test carefully against symlink traversal

**Testing:**
```bash
npm test           # Vitest unit tests
npm run build      # TypeScript compile check
npm run format     # Prettier formatting
```

The test files co-locate with source: `src/ipc.test.ts`, `src/db.test.ts`, `src/group-queue.test.ts`, etc.
