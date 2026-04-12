# NanoClaw Specification

A personal Claude assistant with multi-channel support, persistent memory per conversation, scheduled jobs, and container-isolated agent execution.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Architecture: Channel System](#architecture-channel-system)
3. [Folder Structure](#folder-structure)
4. [Configuration](#configuration)
5. [Memory System](#memory-system)
6. [Session Management](#session-management)
7. [Message Flow](#message-flow)
8. [Commands](#commands)
9. [Scheduled Jobs](#scheduled-jobs)
10. [MCP Servers](#mcp-servers)
11. [Deployment](#deployment)
12. [Security Considerations](#security-considerations)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS / Linux)                           │
│                     (Main Node.js Process)                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────┐                  ┌────────────────────┐        │
│  │ Channels         │─────────────────▶│   SQLite Database  │        │
│  │ (self-register   │◀────────────────│   (messages.db)    │        │
│  │  at startup)     │  store/send      └─────────┬──────────┘        │
│  └──────────────────┘                            │                   │
│                                                   │                   │
│         ┌─────────────────────────────────────────┘                   │
│         │                                                             │
│         ▼                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐   │
│  │  Message Loop    │    │  Scheduler Loop  │    │  IPC Watcher  │   │
│  │  (polls SQLite)  │    │  (checks tasks)  │    │  (file-based) │   │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘   │
│           │                       │                                   │
│           └───────────┬───────────┘                                   │
│                       │ spawns container                              │
│                       ▼                                               │
├──────────────────────────────────────────────────────────────────────┤
│                     CONTAINER (Linux VM)                               │
├──────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    AGENT RUNNER                               │    │
│  │                                                                │    │
│  │  Working directory: /workspace/group (mounted from host)       │    │
│  │  Volume mounts:                                                │    │
│  │    • groups/{name}/ → /workspace/group                         │    │
│  │    • groups/global/ → /workspace/global/ (non-main only)       │    │
│  │    • data/sessions/{group}/.claude/ → /home/node/.claude/      │    │
│  │    • Additional dirs → /workspace/extra/*                      │    │
│  │                                                                │    │
│  │  Tools (all groups):                                           │    │
│  │    • Bash (safe - sandboxed in container!)                     │    │
│  │    • Read, Write, Edit, Glob, Grep (file operations)           │    │
│  │    • WebSearch, WebFetch (internet access)                     │    │
│  │    • agent-browser (browser automation)                        │    │
│  │    • mcp__nanoclaw__* (scheduler tools via IPC)                │    │
│  │                                                                │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Channel System | Channel registry (`src/channels/registry.ts`) | Channels self-register at startup |
| Message Storage | SQLite (better-sqlite3) | Store messages for polling |
| Container Runtime | Containers (Linux VMs) | Isolated environments for agent execution |
| Agent | @anthropic-ai/claude-agent-sdk (0.2.97) | Run Claude with tools and MCP servers |
| Browser Automation | agent-browser + Chromium | Web interaction and screenshots |
| Runtime | Node.js 20+ | Host process for routing and scheduling |

---

## Architecture: Channel System

The core ships with no channels built in — each channel (WhatsApp, Telegram, Slack, Discord, Gmail) is installed as a [Claude Code skill](https://code.claude.com/docs/en/skills) that adds the channel code to your fork. Channels self-register at startup; installed channels with missing credentials emit a WARN log and are skipped.

### System Diagram

```mermaid
graph LR
    subgraph Channels["Channels"]
        WA[WhatsApp]
        TG[Telegram]
        SL[Slack]
        DC[Discord]
        New["Other Channel (Signal, Gmail...)"]
    end

    subgraph Orchestrator["Orchestrator — index.ts"]
        ML[Message Loop]
        GQ[Group Queue]
        RT[Router]
        TS[Task Scheduler]
        DB[(SQLite)]
    end

    subgraph Execution["Container Execution"]
        CR[Container Runner]
        LC["Linux Container"]
        IPC[IPC Watcher]
    end

    %% Flow
    WA & TG & SL & DC & New -->|onMessage| ML
    ML --> GQ
    GQ -->|concurrency| CR
    CR --> LC
    LC -->|filesystem IPC| IPC
    IPC -->|tasks & messages| RT
    RT -->|Channel.sendMessage| Channels
    TS -->|due tasks| CR

    %% DB Connections
    DB <--> ML
    DB <--> TS

    %% Styling for the dynamic channel
    style New stroke-dasharray: 5 5,stroke-width:2px
```

### Channel Registry

The channel system is built on a factory registry in `src/channels/registry.ts`:

```typescript
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
```

Each factory receives `ChannelOpts` (callbacks for `onMessage`, `onChatMetadata`, and `registeredGroups`) and returns either a `Channel` instance or `null` if that channel's credentials are not configured.

### Channel Interface

Every channel implements this interface (defined in `src/core/types.ts`):

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

### Self-Registration Pattern

Channels self-register using a barrel-import pattern:

1. Each channel skill adds a file to `src/channels/` (e.g. `whatsapp.ts`, `telegram.ts`) that calls `registerChannel()` at module load time:

   ```typescript
   // src/channels/whatsapp.ts
   import { registerChannel, ChannelOpts } from './registry.js';

   export class WhatsAppChannel implements Channel { /* ... */ }

   registerChannel('whatsapp', (opts: ChannelOpts) => {
     // Return null if credentials are missing
     if (!existsSync(authPath)) return null;
     return new WhatsAppChannel(opts);
   });
   ```

2. The barrel file `src/channels/index.ts` imports all channel modules, triggering registration:

   ```typescript
   import './whatsapp.js';
   import './telegram.js';
   // ... each skill adds its import here
   ```

3. At startup, the orchestrator (`src/index.ts`) loops through registered channels and connects whichever ones return a valid instance:

   ```typescript
   for (const name of getRegisteredChannelNames()) {
     const factory = getChannelFactory(name);
     const channel = factory?.(channelOpts);
     if (channel) {
       await channel.connect();
       channels.push(channel);
     }
   }
   ```

### Key Files

| File | Purpose |
|------|---------|
| `src/channels/registry.ts` | Channel factory registry |
| `src/channels/index.ts` | Barrel imports that trigger channel self-registration |
| `src/core/types.ts` | `Channel` interface, `ChannelOpts`, message types |
| `src/index.ts` | Orchestrator — instantiates channels, runs message loop |
| `src/messaging/router.ts` | Finds the owning channel for a JID, formats messages |

### Adding a New Channel

To add a new channel, contribute a skill to `.claude/skills/add-<name>/` that:

1. Adds a `src/channels/<name>.ts` file implementing the `Channel` interface
2. Calls `registerChannel(name, factory)` at module load
3. Returns `null` from the factory if credentials are missing
4. Adds an import line to `src/channels/index.ts`

See existing skills (`/add-whatsapp`, `/add-telegram`, `/add-slack`, `/add-discord`, `/add-gmail`) for the pattern.

---

## Folder Structure

```
nanoclaw/
├── CLAUDE.md                      # Project context for Claude Code
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   └── SECURITY.md                # Security model
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .mcp.json                      # MCP server configuration (reference)
├── .gitignore
│
├── src/
│   ├── index.ts                   # Orchestrator: state, message loop, agent invocation
│   ├── channels/
│   │   ├── registry.ts            # Channel factory registry
│   │   └── index.ts               # Barrel imports for channel self-registration
│   ├── ipc.ts                     # IPC watcher and scheduler job processing
│   ├── router.ts                  # Message formatting and outbound routing
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces (includes Channel)
│   ├── logger.ts                  # Pino logger setup
│   ├── db.ts                      # SQLite database initialization and queries
│   ├── group-queue.ts             # Per-group queue with global concurrency limit
│   ├── mount-security.ts          # Mount allowlist validation for containers
│   ├── whatsapp-auth.ts           # Standalone WhatsApp authentication
│   ├── task-scheduler.ts          # Runs scheduled jobs when due
│   └── container-runner.ts        # Spawns agents in containers
│
├── container/
│   ├── Dockerfile                 # Container image (runs as 'node' user, includes Claude Code CLI)
│   ├── build.sh                   # Build script for container image
│   ├── agent-runner/              # Code that runs inside the container
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Entry point (query loop, IPC polling, session resume)
│   │       └── ipc-mcp-stdio.ts   # Stdio-based MCP server for host communication
│   └── skills/
│       └── agent-browser.md       # Browser automation skill
│
├── dist/                          # Compiled JavaScript (gitignored)
│
├── .claude/
│   └── skills/
│       ├── setup/SKILL.md              # /setup - First-time installation
│       ├── customize/SKILL.md          # /customize - Add capabilities
│       ├── debug/SKILL.md              # /debug - Container debugging
│       ├── add-telegram/SKILL.md       # /add-telegram - Telegram channel
│       ├── add-gmail/SKILL.md          # /add-gmail - Gmail integration
│       ├── add-voice-transcription/    # /add-voice-transcription - Whisper
│       ├── x-integration/SKILL.md      # /x-integration - X/Twitter
│       ├── convert-to-apple-container/  # /convert-to-apple-container - Apple Container runtime
│       └── add-parallel/SKILL.md       # /add-parallel - Parallel agents
│
├── groups/
│   ├── CLAUDE.md                  # Global memory (all groups read this)
│   ├── {channel}_main/             # Main control channel (e.g., whatsapp_main/)
│   │   ├── CLAUDE.md              # Main channel memory
│   │   └── logs/                  # Task execution logs
│   └── {channel}_{group-name}/    # Per-group folders (created on registration)
│       ├── CLAUDE.md              # Group-specific memory
│       ├── logs/                  # Task logs for this group
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   ├── auth/                      # WhatsApp authentication state
│   └── messages.db                # SQLite database (messages, chats, jobs, job_runs, job_events, registered_groups, sessions, router_state)
│
├── data/                          # Application state (gitignored)
│   ├── sessions/                  # Per-group session data (.claude/ dirs with JSONL transcripts)
│   ├── env/env                    # Copy of .env for container mounting
│   └── ipc/                       # Container IPC (messages/, tasks/)
│
├── logs/                          # Runtime logs (gitignored)
│   ├── nanoclaw.log               # Host stdout
│   └── nanoclaw.error.log         # Host stderr
│   # Note: Per-container logs are in groups/{folder}/logs/container-*.log
│
└── launchd/
    └── com.nanoclaw.plist         # macOS service configuration
```

---

## Configuration

Configuration constants are in `src/core/config.ts`:

```typescript
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Paths are absolute (required for container mounts)
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Container configuration
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const AGENT_RUNTIME = process.env.AGENT_RUNTIME || 'container'; // strict: host | container
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10); // 30min default
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min — keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
```

**Note:** Paths must be absolute for container volume mounts to work correctly.

### Container Configuration

Groups can have additional directories mounted via `containerConfig` in the SQLite `registered_groups` table (stored as JSON in the `container_config` column). Example registration:

```typescript
setRegisteredGroup("1234567890@g.us", {
  name: "Dev Team",
  folder: "whatsapp_dev-team",
  trigger: "@Andy",
  added_at: new Date().toISOString(),
  containerConfig: {
    model: "opus",
    additionalMounts: [
      {
        hostPath: "~/projects/webapp",
        containerPath: "webapp",
        readonly: false,
      },
    ],
    timeout: 600000,
  },
});
```

Folder names follow the convention `{channel}_{group-name}` (e.g., `whatsapp_family-chat`, `telegram_dev-team`). The main group has `isMain: true` set during registration.

Additional mounts appear at `/workspace/extra/{containerPath}` inside the container.

Model precedence is:

1. `group.containerConfig.model`
2. `ANTHROPIC_MODEL`

Use `/model` in a group session to switch the live model (`/model`, `/model <alias-or-name>`, `/model default`).

**Mount syntax note:** Read-write mounts use `-v host:container`, but readonly mounts require `--mount "type=bind,source=...,target=...,readonly"` (the `:ro` suffix may not work on all runtimes).

### Claude Authentication

Configure authentication in a `.env` file in the project root. Two options:

**Option 1: Claude Subscription (OAuth token)**
```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```
The token can be extracted from `~/.claude/.credentials.json` if you're logged in to Claude Code.

**Option 2: Pay-per-use API Key**
```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Only the authentication variables (`CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`) are extracted from `.env` and written to `data/env/env`, then mounted into the container at `/workspace/env-dir/env` and sourced by the entrypoint script. This ensures other environment variables in `.env` are not exposed to the agent. This workaround is needed because some container runtimes lose `-e` environment variables when using `-i` (interactive mode with piped stdin).

### Changing the Assistant Name

Set the `ASSISTANT_NAME` environment variable:

```bash
ASSISTANT_NAME=Bot npm start
```

Or edit the default in `src/core/config.ts`. This changes:
- The trigger pattern (messages must start with `@YourName`)
- The response prefix (`YourName:` added automatically)

### Placeholder Values in launchd

Files with `{{PLACEHOLDER}}` values need to be configured:
- `{{PROJECT_ROOT}}` - Absolute path to your nanoclaw installation
- `{{NODE_PATH}}` - Path to node binary (detected via `which node`)
- `{{HOME}}` - User's home directory

---

## Memory System

NanoClaw has two memory layers: a file-based layer (CLAUDE.md) that the Claude Agent SDK loads automatically, and a structured memory store (SQLite + vector embeddings) exposed via MCP tools. Both work together.

### Memory Hierarchy (File Layer)

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/CLAUDE.md` | All groups | Main only | Preferences, facts, context shared across all conversations |
| **Group** | `groups/{name}/CLAUDE.md` | That group | That group | Group-specific context, conversation memory |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents created during conversation |

### How File-Based Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `groups/{group-name}/`
   - Claude Agent SDK with `settingSources: ['project']` automatically loads:
     - `../CLAUDE.md` (parent directory = global memory)
     - `./CLAUDE.md` (current directory = group memory)

2. **Writing Memory**
   - When user says "remember this", agent writes to `./CLAUDE.md`
   - When user says "remember this globally" (main channel only), agent writes to `../CLAUDE.md`
   - Agent can create files like `notes.md`, `research.md` in the group folder

3. **Main Channel Privileges**
   - Only the "main" group (self-chat) can write to global memory
   - Main can manage registered groups and schedule jobs for any group
   - Main can configure additional directory mounts for any group
   - All groups have Bash access (safe because it runs inside container)

### Structured Memory Store

The structured memory store provides semantic search, versioned facts, and learned procedures. It runs on SQLite with sqlite-vec for vector search.

#### Storage Backend

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Facts & procedures** | SQLite (`memory_items`, `memory_procedures`) | Key-value structured memory with scoping, confidence, versioning |
| **Chunks** | SQLite (`memory_chunks`) | Chunked text from ingested source files |
| **Lexical search** | FTS5 (`memory_chunks_fts`) | BM25 keyword search with unicode61 tokenization |
| **Vector search** | sqlite-vec (`memory_chunks_vec`) | Semantic similarity search on embeddings |
| **Audit log** | SQLite (`memory_events`) | All memory operations logged for debugging |

Default database path: `store/memory.db`

#### MCP Tools (Exposed to Agents)

Agents interact with memory via MCP tools over IPC:

| Tool | Purpose |
|------|---------|
| `memory_save` | Save a fact, preference, correction, or context item |
| `memory_search` | Hybrid lexical + vector search across chunks and items |
| `memory_patch` | Update an existing item (optimistic concurrency via version) |
| `procedure_save` | Save a reusable multi-step procedure |
| `procedure_patch` | Update an existing procedure |

#### Memory Scoping

Three-tier scope model with strict isolation:

| Scope | Write Access | Read Access | Use Case |
|-------|-------------|-------------|----------|
| `global` | Main only | All groups | Cross-group preferences, shared facts |
| `group` | That group | That group | Group-specific knowledge |
| `user` | That group | That group | Per-user facts within a group |

Default scope is controlled by `MEMORY_SCOPE_POLICY` (default: `group`).

#### Search Architecture (Hybrid Retrieval)

Search combines two channels using Reciprocal Rank Fusion (K=60):

1. **Lexical (BM25)**: FTS5 with unicode61 tokenization, NFKC normalization. Score: `1 / (1 + bm25_rank)`
2. **Vector (Semantic)**: OpenAI embeddings (text-embedding-3-large, 3072 dims). Score: `1 / (1 + distance)`
3. **Fusion**: RRF merges both ranked lists. For each result at rank i: `score += 1 / (K + i + 1)`. Top-K returned.

#### Source Ingestion

On each message or scheduled task, NanoClaw auto-ingests group source files into the chunk store:

| Source | Path | Source Type |
|--------|------|-------------|
| CLAUDE.md | `groups/{name}/CLAUDE.md` | `claude_md` |
| Memory directory | `groups/{name}/memory/**/*.md` | `local_doc` |

**Chunking**: Sliding window (default 1400 chars, 240 overlap). Chunks < 30 chars are filtered. Deduplication via SHA256 hash of `scope:group:source_type:source_id:text`.

**Embedding**: Batch embedding via OpenAI API (default batch size 16). Only new chunks (not matching existing hashes) are embedded.

**Retention**: Chunks older than `MEMORY_CHUNK_RETENTION_DAYS` (default 120) are pruned. Max `MEMORY_MAX_CHUNKS_PER_GROUP` (default 6000) per group.

#### Reflection (Auto-Capture)

After each agent turn, the system can extract facts from the conversation:
- Detects preferences, corrections, conventions via regex patterns
- Stores with reflection-derived confidence scores (preferences: 0.82, corrections: 0.8, conventions: 0.78)
- Filters sensitive material (API keys, tokens, passwords)
- Controlled by `MEMORY_REFLECTION_MIN_CONFIDENCE` (default 0.7) and `MEMORY_REFLECTION_MAX_FACTS_PER_TURN` (default 5)

### Memory Providers

NanoClaw supports two memory provider backends, set via `MEMORY_PROVIDER`:

#### `sqlite` (Default)

Standard SQLite backend. All data lives in `MEMORY_SQLITE_PATH` (default: `store/memory.db`).

- Simple, single-file storage
- No external dependencies beyond sqlite-vec
- Good for most deployments

#### `qmd` (Durable Markdown Mirror)

QMD wraps the SQLite provider and mirrors every write to a filesystem tree at `AGENT_MEMORY_ROOT`. The SQLite database still handles all reads and search. The markdown mirror provides:

- **Human-readable audit trail** — every memory item and procedure is a markdown file
- **Git-friendly durability** — the memory root can be committed to version control
- **Journal logging** — all operations (saves, patches, lifecycle events) appended to daily journal files
- **Session archiving** — compacted/stale sessions archived as dated markdown files

**Required config**: `AGENT_MEMORY_ROOT` must be set to an absolute path.

**Filesystem layout**:

```
{AGENT_MEMORY_ROOT}/
├── profile/          # Memory items as markdown (one file per item)
│   ├── mem-1712345678-a1b2.md
│   └── mem-1712345679-c3d4.md
├── procedures/       # Learned procedures as markdown
│   └── proc-1712345680-e5f6.md
├── journal/          # Daily audit log of all memory operations
│   └── 2026/
│       └── 04/
│           └── 2026-04-11.md
├── sessions/         # Archived session transcripts
│   └── 2026/
│       └── 04/
│           └── 2026-04-11/
│               └── 143022-stale-session-auth-fix.md
├── knowledge/        # Reserved for future use
├── .raw/             # Raw data storage
└── .cache/
    └── memory.db     # SQLite database (search index)
```

**How QMD writes work**:

1. Agent calls `memory_save` → SQLite insert (same as `sqlite` provider)
2. QMD wrapper also writes `profile/{sanitized-id}.md` with full metadata + value
3. QMD appends a journal entry: timestamp, action, scope, key, file path
4. All filesystem writes are atomic (write to `.tmp`, then rename)

**How QMD reads work**: Identical to `sqlite` provider. All search hits the SQLite database, not the filesystem. The markdown files are for durability and human review only.

**When to use QMD**:
- You want a git-committable audit trail of what the agent remembers
- You need to inspect memory contents without querying SQLite
- You want session transcripts preserved as readable files
- You're debugging memory behavior and need a journal

**When `sqlite` is sufficient**:
- Standard deployments where SQLite durability is enough
- You don't need human-readable memory files
- You want minimal disk I/O overhead

### Memory Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_PROVIDER` | `sqlite` | Backend: `sqlite` or `qmd` |
| `MEMORY_SQLITE_PATH` | `store/memory.db` | Path to SQLite database |
| `AGENT_MEMORY_ROOT` | (empty) | Filesystem root for QMD mirror (required if provider is `qmd`) |
| `MEMORY_EMBED_PROVIDER` | `openai` | Embedding provider |
| `MEMORY_EMBED_MODEL` | `text-embedding-3-large` | Embedding model |
| `MEMORY_VECTOR_DIMENSIONS` | `3072` | Vector dimensions (must match model output) |
| `MEMORY_EMBED_BATCH_SIZE` | `16` | Texts per embedding API call |
| `MEMORY_CHUNK_SIZE` | `1400` | Characters per chunk |
| `MEMORY_CHUNK_OVERLAP` | `240` | Overlap between chunks |
| `MEMORY_RETRIEVAL_LIMIT` | `8` | Default results per search |
| `MEMORY_SCOPE_POLICY` | `group` | Default scope for new items |
| `MEMORY_REFLECTION_MIN_CONFIDENCE` | `0.7` | Min confidence for auto-captured facts |
| `MEMORY_REFLECTION_MAX_FACTS_PER_TURN` | `5` | Max facts extracted per turn |
| `MEMORY_MAX_CHUNKS_PER_GROUP` | `6000` | Chunk cap per group |
| `MEMORY_CHUNK_RETENTION_DAYS` | `120` | Days before chunks are pruned |
| `MEMORY_MAX_EVENTS` | `20000` | Max audit log entries |
| `MEMORY_MAX_PROCEDURES_PER_GROUP` | `500` | Procedure cap per group |

---

## Session Management

Sessions enable conversation continuity - Claude remembers what you talked about.

### How Sessions Work

1. Each group has a session ID stored in SQLite (`sessions` table, keyed by `group_folder`)
2. Session ID is passed to Claude Agent SDK's `resume` option
3. Claude continues the conversation with full context
4. Session transcripts are stored as JSONL files in `data/sessions/{group}/.claude/`

---

## Message Flow

### Incoming Message Flow

```
1. User sends a message via any connected channel
   │
   ▼
2. Channel receives message (e.g. Baileys for WhatsApp, Bot API for Telegram)
   │
   ▼
3. Message stored in SQLite (store/messages.db)
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Router checks:
   ├── Is chat_jid in registered groups (SQLite)? → No: ignore
   └── Does message match trigger pattern? → No: store but don't process
   │
   ▼
6. Router catches up conversation:
   ├── Fetch all messages since last agent interaction
   ├── Format with timestamp and sender name
   └── Build prompt with full conversation context
   │
   ▼
7. Router invokes Claude Agent SDK:
   ├── cwd: groups/{group-name}/
   ├── prompt: conversation history + current message
   ├── resume: session_id (for continuity)
   └── mcpServers: nanoclaw (scheduler)
   │
   ▼
8. Claude processes message:
   ├── Reads CLAUDE.md files for context
   └── Uses tools as needed (search, email, etc.)
   │
   ▼
9. Router prefixes response with assistant name and sends via the owning channel
   │
   ▼
10. Router updates last agent timestamp and saves session ID
```

### Trigger Word Matching

Messages must start with the trigger pattern (default: `@Andy`):
- `@Andy what's the weather?` → ✅ Triggers Claude
- `@andy help me` → ✅ Triggers (case insensitive)
- `Hey @Andy` → ❌ Ignored (trigger not at start)
- `What's up?` → ❌ Ignored (no trigger)

### Conversation Catch-Up

When a triggered message arrives, the agent receives all messages since its last interaction in that chat. Each message is formatted with timestamp and sender name:

```
[Jan 31 2:32 PM] John: hey everyone, should we do pizza tonight?
[Jan 31 2:33 PM] Sarah: sounds good to me
[Jan 31 2:35 PM] John: @Andy what toppings do you recommend?
```

This allows the agent to understand the conversation context even if it wasn't mentioned in every message.

---

## Commands

### Commands Available in Any Group

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant [message]` | `@Andy what's the weather?` | Talk to Claude |

### Commands Available in Main Channel Only

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant add group "Name"` | `@Andy add group "Family Chat"` | Register a new group |
| `@Assistant remove group "Name"` | `@Andy remove group "Work Team"` | Unregister a group |
| `@Assistant list groups` | `@Andy list groups` | Show registered groups |
| `@Assistant remember [fact]` | `@Andy remember I prefer dark mode` | Add to global memory |

---

## Scheduled Jobs

NanoClaw has a built-in scheduler that runs jobs as full agents in their group's context.

### How Scheduling Works

1. **Group Context**: Jobs created in a group run with that group's working directory and memory
2. **Full Agent Capabilities**: Scheduled jobs have access to all tools (WebSearch, file operations, etc.)
3. **Optional Messaging**: Jobs can send messages to their group using the `send_message` tool, or complete silently
4. **Main Channel Privileges**: The main channel can schedule jobs for any group and view all jobs

### Schedule Types

| Type | Value Format | Example |
|------|--------------|---------|
| `cron` | Cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | ISO timestamp | `2024-12-25T09:00:00Z` |

### Creating a Job

```
User: @Andy remind me every Monday at 9am to review the weekly metrics

Claude: [calls mcp__nanoclaw__scheduler_upsert_job]
        {
          "name": "weekly-metrics-reminder",
          "prompt": "Send a reminder to review weekly metrics. Be encouraging!",
          "schedule_type": "cron",
          "schedule_value": "0 9 * * 1",
          "linked_sessions": ["<current_chat_jid>"]
        }

Claude: Done! I'll remind you every Monday at 9am.
```

### One-Time Jobs

```
User: @Andy at 5pm today, send me a summary of today's emails

Claude: [calls mcp__nanoclaw__scheduler_upsert_job]
        {
          "name": "today-email-summary",
          "prompt": "Search for today's emails, summarize the important ones, and send the summary to the group.",
          "schedule_type": "once",
          "schedule_value": "2024-01-31T17:00:00Z",
          "linked_sessions": ["<current_chat_jid>"]
        }
```

### Managing Jobs

From any group:
- `@Andy list my scheduled jobs` - View jobs for this group
- `@Andy pause job [id]` - Pause a job
- `@Andy resume job [id]` - Resume a paused job
- `@Andy delete job [id]` - Delete a job

From main channel:
- `@Andy list all jobs` - View jobs from all groups
- `@Andy schedule job for "Family Chat": [prompt]` - Schedule for another group

---

## MCP Servers

### NanoClaw MCP (built-in)

The `nanoclaw` MCP server is created dynamically per agent call with the current group's context.

**Available Tools:**
| Tool | Purpose |
|------|---------|
| `scheduler_upsert_job` | Create or update a scheduler job |
| `scheduler_get_job` | Get job details |
| `scheduler_list_jobs` | List jobs |
| `scheduler_update_job` | Modify job prompt/schedule/policy |
| `scheduler_delete_job` | Delete a job |
| `scheduler_pause_job` | Pause a job |
| `scheduler_resume_job` | Resume a paused job |
| `scheduler_trigger_job` | Trigger immediate job run |
| `scheduler_list_runs` | List job run history |
| `scheduler_get_dead_letter` | List dead-lettered runs |
| `send_message` | Send a message to the group via its channel |

---

## Deployment

NanoClaw runs as a single macOS launchd service.

### Startup Sequence

When NanoClaw starts, it:
1. **Runs runtime preflight for `AGENT_RUNTIME`** - validates strict mode (`host|container`) and emits actionable fix steps on failure
2. **Host mode only**: auto-builds `container/agent-runner` artifacts and fails startup if build fails
3. **Container mode only**: validates container runtime health and cleans up orphaned NanoClaw containers
4. Initializes the SQLite database (migrates from JSON files if they exist)
5. Loads state from SQLite (registered groups, sessions, router state)
6. **Connects channels** — loops through registered channels, instantiates those with credentials, calls `connect()` on each
7. Once at least one channel is connected:
   - Starts the scheduler loop
   - Starts the IPC watcher for container messages
   - Sets up the per-group queue with `processGroupMessages`
   - Recovers any unprocessed messages from before shutdown
   - Starts the message polling loop

### Service: com.nanoclaw

**launchd/com.nanoclaw.plist:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{PROJECT_ROOT}}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{HOME}}/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>ASSISTANT_NAME</key>
        <string>Andy</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.error.log</string>
</dict>
</plist>
```

### Managing the Service

```bash
# Install service
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/

# Start service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Check status
launchctl list | grep nanoclaw

# View logs
tail -f logs/nanoclaw.log
```

---

## Security Considerations

### Runtime Isolation

`AGENT_RUNTIME=container` is the default and recommended mode for security boundaries.

`AGENT_RUNTIME=host` is high-trust mode for host-level capabilities and intentionally bypasses container isolation.

### Container Isolation (`AGENT_RUNTIME=container`)

All agents run inside containers (lightweight Linux VMs), providing:
- **Filesystem isolation**: Agents can only access mounted directories
- **Safe Bash access**: Commands run inside the container, not on your Mac
- **Network isolation**: Can be configured per-container if needed
- **Process isolation**: Container processes can't affect the host
- **Non-root user**: Container runs as unprivileged `node` user (uid 1000)

### Prompt Injection Risk

WhatsApp messages could contain malicious instructions attempting to manipulate Claude's behavior.

**Mitigations:**
- Container isolation limits blast radius
- Only registered groups are processed
- Trigger word required (reduces accidental processing)
- Agents can only access their group's mounted directories
- Main can configure additional directories per group
- Claude's built-in safety training

**Recommendations:**
- Only register trusted groups
- Review additional directory mounts carefully
- Review scheduled jobs periodically
- Monitor logs for unusual activity

### Credential Storage

| Credential | Storage Location | Notes |
|------------|------------------|-------|
| Claude CLI Auth | data/sessions/{group}/.claude/ | Per-group isolation, mounted to /home/node/.claude/ |
| WhatsApp Session | store/auth/ | Auto-created, persists ~20 days |

### File Permissions

The groups/ folder contains personal memory and should be protected:
```bash
chmod 700 groups/
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list | grep nanoclaw` |
| Startup fails at runtime preflight | Invalid `AGENT_RUNTIME` value | Set `AGENT_RUNTIME=host` or `AGENT_RUNTIME=container` |
| Startup fails at runtime preflight | Container runtime unavailable in container mode | Start runtime and run `docker info` |
| Startup fails at runtime preflight | Host runner artifacts missing/build failed in host mode | Run `npm --prefix container/agent-runner run build` |
| "Claude Code process exited with code 1" | Session mount path wrong | Ensure mount is to `/home/node/.claude/` not `/root/.claude/` |
| Session not continuing | Session ID not saved | Check SQLite: `sqlite3 store/messages.db "SELECT * FROM sessions"` |
| Session not continuing | Mount path mismatch | Container user is `node` with HOME=/home/node; sessions must be at `/home/node/.claude/` |
| "QR code expired" | WhatsApp session expired | Delete store/auth/ and restart |
| "No groups registered" | Haven't added groups | Use `@Andy add group "Name"` in main |

### Log Location

- `logs/nanoclaw.log` - stdout
- `logs/nanoclaw.error.log` - stderr

### Debug Mode

Run manually for verbose output:
```bash
npm run dev:container
npm run dev:host
npm run start:container
npm run start:host
```
