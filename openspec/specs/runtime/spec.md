## runtime

Personal Claude assistant forked from NanoClaw (qwibitai/nanoclaw). Multi-channel support, persistent memory per conversation, scheduled tasks, and container-isolated agent execution.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     HOST (macOS)                         │
│                  (Main Node.js Process)                   │
│                                                           │
│  ┌──────────────┐              ┌────────────────────┐    │
│  │ Channels      │────────────▶│   SQLite Database  │    │
│  │ (self-register│◀────────────│   (messages.db)    │    │
│  │  at startup)  │             └─────────┬──────────┘    │
│  └──────────────┘                        │               │
│         ┌────────────────────────────────┘               │
│         ▼                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Message Loop  │  │ Scheduler    │  │ IPC Watcher   │  │
│  │ (polls SQLite)│  │ (checks due) │  │ (file-based)  │  │
│  └───────┬──────┘  └──────┬──────┘  └───────────────┘  │
│          └────────┬───────┘                               │
│                   │ spawns container                      │
│                   ▼                                       │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              CONTAINER (Linux VM)                     │ │
│  │  Working dir: /workspace/group (mounted from host)    │ │
│  │  Tools: Bash, Read, Write, Edit, WebSearch, etc.      │ │
│  │  MCP: mcp__nanoclaw__* (scheduler tools via IPC)      │ │
│  └─────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology |
|-----------|------------|
| Channel System | Channel registry (`src/channels/registry.ts`) |
| Message Storage | SQLite (better-sqlite3) |
| Container Runtime | Containers (lightweight Linux VMs) |
| Agent | @anthropic-ai/claude-agent-sdk |
| Browser | agent-browser + Chromium |
| Runtime | Node.js 20+ |

### Channel System

Channels self-register at startup. No channels built in — each is a skill that adds code to `src/channels/`.

**Registry** (`src/channels/registry.ts`):
- `registerChannel(name, factory)` — factory receives `ChannelOpts`, returns `Channel | null`
- Factory returns `null` if credentials missing → channel skipped with WARN log
- Barrel file `src/channels/index.ts` triggers all registrations via imports

**Channel interface:**
- `connect()`, `sendMessage(jid, text)`, `isConnected()`, `ownsJid(jid)`, `disconnect()`
- Optional: `setTyping(jid, isTyping)`, `syncGroups(force)`

### Memory System

Hierarchical CLAUDE.md files:

| Level | Location | Read By | Written By |
|-------|----------|---------|------------|
| Global | `groups/CLAUDE.md` | All groups | Main only |
| Group | `groups/{name}/CLAUDE.md` | That group | That group |
| Files | `groups/{name}/*.md` | That group | That group |

Agent runs with `cwd = groups/{group-name}/`, Claude Agent SDK with `settingSources: ['project']` auto-loads parent and current CLAUDE.md.

### Session Management

- Session ID per group stored in SQLite (`sessions` table, keyed by `group_folder`)
- Passed to Claude Agent SDK `resume` option for conversation continuity
- Transcripts: JSONL files in `data/sessions/{group}/.claude/`

### Message Flow

1. Channel receives message → stored in SQLite
2. Message loop polls every 2s
3. Router checks: registered group? trigger pattern match?
4. Catch-up: fetch all messages since last agent interaction
5. Spawn Claude in container with conversation context + session resume
6. Claude processes (reads CLAUDE.md, uses tools)
7. Router prefixes response with assistant name, sends via owning channel

### Trigger Pattern

Messages must start with trigger (default: `@Andy`, case insensitive). Configurable via `ASSISTANT_NAME` env var.

### Scheduled Tasks

Full agent capabilities in group context. Schedule types: `cron`, `interval` (ms), `once` (ISO timestamp).

MCP tools: `schedule_task`, `list_tasks`, `get_task`, `update_task`, `pause_task`, `resume_task`, `cancel_task`, `send_message`

### Container Configuration

- Image: configurable (`CONTAINER_IMAGE`, default `nanoclaw-agent:latest`)
- Timeout: `CONTAINER_TIMEOUT` (default 30min)
- Max concurrent: `MAX_CONCURRENT_CONTAINERS` (default 5)
- Idle timeout: `IDLE_TIMEOUT` (default 30min)
- Volume mounts: group dir → `/workspace/group`, global → `/workspace/global/`, sessions → `/home/node/.claude/`
- Additional mounts via `containerConfig` in group registration
- Container runs as unprivileged `node` user (uid 1000)

### Startup Sequence

1. Ensure container runtime running, kill orphaned containers
2. Initialize SQLite (migrate from JSON if exists)
3. Load state from SQLite (groups, sessions, router state)
4. Connect channels (loop registered, instantiate those with credentials)
5. Start scheduler loop, IPC watcher, message polling loop
6. Recover unprocessed messages from before shutdown

### Hal-Specific Extensions (Migration Plan)

**Phase 1: WhatsApp Parity**
- Wire WhatsApp channel (Baileys-based)
- Session management (main session, hook sessions)
- Message routing (DM → main, hooks → isolated)

**Phase 2: Hippocampus**
- Per-turn semantic search of MEMORY.md + memory/*.md + past session transcripts
- Auto-inject relevant memories into context (RECALL.md pattern)
- Episode extraction on session end

**Phase 3: Full Migration**
- CC hooks wired (webhook receiver → session dispatch)
- Cron/heartbeat support
- Cut over from OpenClaw to hal-runtime

### Security

- Container isolation: filesystem, network, process isolation
- Only registered groups processed, trigger word required
- Agents access only their mounted directories
- Main channel has elevated privileges (global memory, group management)
- Auth: Claude OAuth token or API key, extracted from `.env` to `data/env/env`, mounted into container
