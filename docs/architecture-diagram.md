# NanoClaw Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              NanoClaw Host Process (Node.js)                        │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │                         src/index.ts — Orchestrator                          │   │
│  │                                                                              │   │
│  │  - Startup & initialization          - Message loop (poll every 2s)          │   │
│  │  - State management (cursors)        - Agent invocation                      │   │
│  │  - Health monitoring (heartbeat)     - Graceful shutdown                     │   │
│  └──────┬──────────┬──────────┬───────────────┬──────────┬──────────────────────┘   │
│         │          │          │               │          │                           │
│         ▼          ▼          ▼               ▼          ▼                           │
│  ┌───────────┐ ┌────────┐ ┌───────────┐ ┌─────────┐ ┌──────────────┐               │
│  │  Channel  │ │ Router │ │ GroupQueue │ │ Task    │ │ IPC Watcher  │               │
│  │  Layer    │ │        │ │           │ │Scheduler│ │              │               │
│  └───────────┘ └────────┘ └───────────┘ └─────────┘ └──────────────┘               │
│                                                                                     │
│  ┌───────────┐ ┌──────────────────┐ ┌────────────────┐ ┌───────────┐               │
│  │  SQLite   │ │ Container Runner │ │ Mount Security │ │  X (IPC)  │               │
│  │  (db.ts)  │ │                  │ │                │ │           │               │
│  └───────────┘ └──────────────────┘ └────────────────┘ └───────────┘               │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Component Detail

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  CHANNELS                                                                           │
│                                                                                     │
│  ┌──────────────────────┐   ┌──────────────────────┐                                │
│  │      Telegram         │   │    WhatsApp (skill)   │                               │
│  │  ┌────────────────┐   │   │  ┌────────────────┐   │                               │
│  │  │ grammY Bot API │   │   │  │ whatsapp-web.js│   │      Channel Interface:       │
│  │  └────────────────┘   │   │  └────────────────┘   │        connect()               │
│  │  - /chatid /ping      │   │  - QR auth             │        sendMessage()           │
│  │  - Photo download     │   │  - Media handling      │        ownsJid()               │
│  │  - HTML formatting    │   │  - Markdown format     │        setTyping()             │
│  │  - Bot pool (teams)   │   │                        │        disconnect()            │
│  │  - Polling watchdog   │   │                        │                                │
│  └──────────────────────┘   └──────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────┐
│  DATA LAYER                                                                         │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────┐               │
│  │                    SQLite (store/messages.db)                     │               │
│  │                                                                  │               │
│  │  chats            messages          scheduled_tasks               │               │
│  │  ┌──────────┐    ┌──────────────┐  ┌──────────────────┐          │               │
│  │  │ jid      │    │ id           │  │ id               │          │               │
│  │  │ name     │    │ chat_jid     │  │ group_folder     │          │               │
│  │  │ channel  │    │ sender       │  │ prompt           │          │               │
│  │  │ is_group │    │ content      │  │ schedule (cron)  │          │               │
│  │  └──────────┘    │ timestamp    │  │ context_mode     │          │               │
│  │                  │ image_path   │  └──────────────────┘          │               │
│  │                  └──────────────┘                                │               │
│  │  router_state       sessions          registered_groups          │               │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐       │               │
│  │  │ key → value  │  │ group →      │  │ jid              │       │               │
│  │  │ (cursors)    │  │  session_id  │  │ folder           │       │               │
│  │  └──────────────┘  └──────────────┘  │ trigger          │       │               │
│  │                                      └──────────────────┘       │               │
│  └──────────────────────────────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Message Flow

```
 User                Channel              Orchestrator           GroupQueue
  │                    │                      │                      │
  │  @Andy hello       │                      │                      │
  │───────────────────▶│                      │                      │
  │                    │  store in SQLite      │                      │
  │                    │─────────────────────▶ │                      │
  │                    │                      │  poll (2s)            │
  │                    │                      │  detect new messages  │
  │                    │                      │  format as XML        │
  │                    │                      │─────────────────────▶ │
  │                    │                      │                      │  check concurrency
  │                    │                      │                      │  (max 5 containers)
  │                    │                      │                      │
  │                    │                      │               ┌──────┴──────┐
  │                    │                      │               │             │
  │                    │                      │           has active    no active
  │                    │                      │           container?    container
  │                    │                      │               │             │
  │                    │                      │          pipe via       spawn new
  │                    │                      │           IPC file      container
  │                    │                      │               │             │
  │                    │                      │               └──────┬──────┘
  │                    │                      │                      │
```

## Container Execution

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Docker Container (nanoclaw-agent)                 │
│                    node:22-slim + Chromium                           │
│                                                                     │
│   STDIN ──────▶ ┌──────────────────────────────┐                    │
│   (secrets,     │     Agent Runner (index.ts)   │                    │
│    prompt,      │                                │                    │
│    session)     │  - Reads ContainerInput JSON   │                    │
│                 │  - Runs Claude Agent SDK        │                    │
│                 │  - Query loop (multi-turn)      │                    │
│                 │  - Polls IPC for follow-ups     │                    │
│                 │  - PreToolUse: strips secrets   │                    │
│                 └─────────┬──────────────────────┘                    │
│                           │                                          │
│              ┌────────────┼────────────────┐                         │
│              │            │                │                         │
│              ▼            ▼                ▼                         │
│   ┌──────────────┐ ┌───────────┐ ┌──────────────────┐               │
│   │  Claude SDK  │ │ MCP Server│ │  browser-agent    │               │
│   │  Tools       │ │ (IPC-MCP) │ │  (browser-use/CDP)│               │
│   │              │ │           │ │                    │               │
│   │  - Bash      │ │ Tools:    │ │  - AI-driven nav   │               │
│   │  - Read      │ │ send_msg  │ │  - Screenshots     │               │
│   │  - Write     │ │ sched_task│ │  - Form filling    │               │
│   │  - Glob      │ │ list_tasks│ │  - Navigation      │               │
│   │  - Grep      │ │ pause/    │ │                    │               │
│   │              │ │  resume   │ │                    │               │
│   └──────────────┘ │ register  │ └──────────────────┘               │
│                    │ x_scrape  │                                     │
│                    └─────┬─────┘                                     │
│                          │                                           │
│   STDOUT ◀── sentinel ───┘  writes JSON to /workspace/ipc/          │
│   markers                                                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                        Volume Mounts
                               │
     ┌─────────────────────────┼─────────────────────────────┐
     │                         │                             │
     ▼                         ▼                             ▼
┌──────────┐          ┌──────────────┐            ┌────────────────┐
│ Group    │          │   IPC Dir    │            │ Claude Session │
│ Folder   │          │              │            │     Dir        │
│ (rw)     │          │ messages/    │            │                │
│          │          │ tasks/       │            │  .claude/      │
│ CLAUDE.md│          │ input/       │            │  settings      │
│ logs/    │          │ x_results/   │            │  memory        │
│ patches/ │          │              │            │                │
└──────────┘          └──────────────┘            └────────────────┘
```

## IPC (Filesystem-Based)

```
Container writes                 Host reads
─────────────────               ─────────────────

/workspace/ipc/                  data/ipc/{group}/
    │                                │
    ├── messages/                     ├── messages/
    │   └── {uuid}.json  ──────────▶ │   └── (read & delete)
    │       { recipient,             │       → channel.sendMessage()
    │         content,               │
    │         images }               │
    │                                │
    ├── tasks/                       ├── tasks/
    │   └── {uuid}.json  ──────────▶ │   └── (read & delete)
    │       { action:                │       → db.createTask()
    │         "schedule_task",       │         db.pauseTask()
    │         ...params }            │         db.cancelTask()
    │                                │
    └── x_results/                   └── x_results/
        └── (tweet data)                 └── (tweet responses)


Host writes                      Container reads
─────────────────               ─────────────────

data/ipc/{group}/                /workspace/ipc/
    │                                │
    ├── input/                       ├── input/
    │   └── {uuid}.json  ──────────▶ │   └── (poll for follow-ups)
    │       (follow-up msg)          │       → stream.push(text)
    │                                │
    ├── current_tasks.json           ├── current_tasks.json
    │   (snapshot)       ──────────▶ │   (read on start)
    │                                │
    ├── available_groups.json        ├── available_groups.json
    │   (snapshot)       ──────────▶ │   (read on start)
    │                                │
    └── queue_status.json            └── queue_status.json
        (snapshot)       ──────────▶     (read on start)
```

## Concurrency Model (GroupQueue)

```
                    Global Container Pool (max 5)
          ┌─────────────────────────────────────────────┐
          │  slot 1   slot 2   slot 3   slot 4   slot 5 │
          └─────────────────────────────────────────────┘
                 ▲        ▲        ▲
                 │        │        │
    ┌────────────┴─┐  ┌───┴────────┴─┐
    │   Group A    │  │   Group B    │
    │              │  │              │
    │ ┌──────────┐ │  │ ┌──────────┐ │
    │ │ Message  │ │  │ │ Message  │ │      Messages > Tasks (priority)
    │ │  Lane    │ │  │ │  Lane    │ │
    │ │          │ │  │ │          │ │      Each lane: 1 active container
    │ │ queue[]  │ │  │ │ queue[]  │ │
    │ └──────────┘ │  │ └──────────┘ │      Follow-ups piped to active
    │              │  │              │       container via IPC
    │ ┌──────────┐ │  │ ┌──────────┐ │
    │ │  Task    │ │  │ │  Task    │ │      Idle message containers
    │ │  Lane    │ │  │ │  Lane    │ │       preempted for tasks
    │ │          │ │  │ │          │ │
    │ │ queue[]  │ │  │ │ queue[]  │ │
    │ └──────────┘ │  │ └──────────┘ │
    └──────────────┘  └──────────────┘
```

## Task Scheduling

```
    ┌──────────────────────────────────────────────┐
    │         Task Scheduler (60s poll loop)        │
    │                                              │
    │  for each due task:                          │
    │    1. Check schedule (cron / interval / once) │
    │    2. Enqueue via GroupQueue.enqueueTask()    │
    │    3. Spawn container with task prompt        │
    │    4. Log result to task_run_logs             │
    │    5. Update next_run timestamp               │
    └──────────────────────────────────────────────┘
                         │
           ┌─────────────┼─────────────┐
           │             │             │
           ▼             ▼             ▼
      ┌─────────┐  ┌──────────┐  ┌──────────┐
      │  Cron   │  │ Interval │  │   Once   │
      │         │  │          │  │          │
      │ "0 9 * │  │ every    │  │ ISO      │
      │  * *"   │  │ 3600000  │  │ datetime │
      │         │  │ ms       │  │          │
      └─────────┘  └──────────┘  └──────────┘
```

## Security Model

```
┌──────────────────────────────────────────────────────────────────┐
│                        Security Boundaries                       │
│                                                                  │
│  ┌────────────────────────────────┐                              │
│  │          Host Process          │                              │
│  │                                │                              │
│  │  ~/.config/nanoclaw/           │ ◀── Mount allowlist          │
│  │    mount-allowlist.json        │     (outside project root,   │
│  │                                │      inaccessible to agents) │
│  │  .env                          │ ◀── Secrets source           │
│  │    (read, passed via stdin)    │     (never on disk in        │
│  │                                │      container)              │
│  └────────────┬───────────────────┘                              │
│               │                                                  │
│       Docker isolation                                           │
│               │                                                  │
│  ┌────────────▼───────────────────┐                              │
│  │        Container (Agent)       │                              │
│  │                                │                              │
│  │  Mounts:                       │                              │
│  │   - group folder (rw)          │                              │
│  │   - project root (ro, main)    │                              │
│  │   - global CLAUDE.md (ro)      │                              │
│  │   - allowlisted dirs only      │                              │
│  │                                │                              │
│  │  Blocked:                      │                              │
│  │   - .ssh, .gnupg, .aws        │                              │
│  │   - credentials, private keys  │                              │
│  │   - symlink escape             │                              │
│  │                                │                              │
│  │  PreToolUse hook:              │                              │
│  │   - Strips secrets from Bash   │                              │
│  │     subprocess environment     │                              │
│  └────────────────────────────────┘                              │
│                                                                  │
│  Non-main group restrictions:                                    │
│   - Can only send to own chat                                    │
│   - Can only manage own tasks                                    │
│   - No project root access                                       │
│   - Allowlisted dirs read-only                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Filesystem Layout

```
nanoclaw/
├── src/                              # Host process
│   ├── index.ts                      # Orchestrator
│   ├── channels/
│   │   └── telegram.ts               # Telegram (grammY)
│   ├── config.ts                     # Constants
│   ├── env.ts                        # .env parser
│   ├── types.ts                      # Shared types
│   ├── router.ts                     # Message formatting
│   ├── db.ts                         # SQLite layer
│   ├── group-queue.ts                # Concurrency control
│   ├── container-runner.ts           # Container lifecycle
│   ├── container-runtime.ts          # Docker abstraction
│   ├── mount-security.ts             # Mount validation
│   ├── group-folder.ts               # Path validation
│   ├── ipc.ts                        # IPC watcher
│   ├── task-scheduler.ts             # Cron/interval runner
│   ├── x-ipc.ts                      # X integration
│   ├── x-tweet-cache.ts              # Tweet cache
│   └── logger.ts                     # Pino logger
│
├── container/                        # Agent container
│   ├── Dockerfile                    # node:22-slim + Chromium
│   ├── build.sh                      # Build script
│   └── agent-runner/
│       └── src/
│           ├── index.ts              # Agent runner (Claude SDK)
│           └── ipc-mcp-stdio.ts      # MCP server (tools)
│
├── groups/                           # Per-group filesystems
│   ├── global/CLAUDE.md              # Shared memory
│   ├── main/                         # Admin group
│   │   ├── CLAUDE.md                 # Group memory
│   │   ├── conversations/            # Archives
│   │   └── logs/                     # Execution logs
│   └── {group}/                      # Other groups
│
├── data/                             # Runtime (gitignored)
│   ├── ipc/{group}/                  # IPC directories
│   ├── sessions/{group}/             # Claude sessions
│   ├── media/                        # Downloaded images
│   └── x-tweet-cache.json            # Tweet cache
│
├── store/
│   └── messages.db                   # SQLite database
│
├── skills-engine/                    # Skill apply/merge
├── setup/                            # Installation scripts
└── docs/                             # Architecture docs
```

## End-to-End Flow Summary

```
┌────────┐     ┌───────────┐     ┌───────────┐     ┌────────────┐     ┌────────────┐
│  User  │────▶│  Telegram │────▶│  SQLite   │────▶│ Orchestrator│────▶│ GroupQueue │
│        │     │  Channel  │     │  (store)  │     │  (poll 2s) │     │ (concur.)  │
└────────┘     └───────────┘     └───────────┘     └────────────┘     └─────┬──────┘
                                                                           │
                                                        ┌──────────────────┘
                                                        ▼
┌────────┐     ┌───────────┐     ┌───────────┐     ┌────────────┐
│  User  │◀────│  Channel  │◀────│IPC Watcher│◀────│  Docker    │
│        │     │  send()   │     │ (poll 1s) │     │ Container  │
└────────┘     └───────────┘     └───────────┘     │            │
                                                   │ Claude SDK │
                                                   │ + MCP Tools│
                                                   │ + Browser  │
                                                   └────────────┘
```
