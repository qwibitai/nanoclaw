# NanoClaw — Source Tree Analysis

## Repository Structure

```
nanoclaw/                              # Project root (Node.js 22, TypeScript ESM)
│
├── src/                               # [PART: orchestrator] Main process source
│   ├── index.ts                       # ★ ENTRY POINT — state machine, message loop, agent dispatch
│   ├── config.ts                      # Constants: timeouts, intervals, trigger patterns
│   ├── types.ts                       # TypeScript interfaces shared across orchestrator
│   ├── db.ts                          # SQLite layer — schema, CRUD, migrations
│   ├── env.ts                         # .env parsing and validation
│   ├── logger.ts                      # Pino logger + global error handlers
│   ├── container-runner.ts            # Spawns Docker/Apple Container, manages I/O protocol
│   ├── container-runtime.ts           # Runtime abstraction (docker vs container binary)
│   ├── ipc.ts                         # IPC watcher — processes files written by containers
│   ├── router.ts                      # Message formatting (XML) and outbound routing
│   ├── task-scheduler.ts              # Scheduled task polling loop
│   ├── group-queue.ts                 # Per-group concurrency, retry, message queuing
│   ├── mount-security.ts              # Allowlist-based volume mount validation
│   ├── group-folder.ts                # Path security — resolves group filesystem paths
│   └── channels/
│       └── whatsapp.ts                # WhatsApp channel — Baileys connection, auth, send/recv
│
├── container/                         # [PART: agent-runner] Container image
│   ├── Dockerfile                     # ★ node:22-slim + Chromium + Claude Code + agent-runner
│   ├── build.sh                       # Build script for Docker image
│   └── agent-runner/                  # Node.js package compiled into the container
│       ├── package.json               # @anthropic-ai/claude-agent-sdk, @modelcontextprotocol/sdk
│       ├── tsconfig.json              # TypeScript compiler config for agent runner
│       └── src/
│           ├── index.ts               # ★ ENTRY POINT — reads stdin, runs SDK query loop, writes stdout
│           └── ipc-mcp-stdio.ts       # MCP stdio server — exposes send_message, schedule_task, etc.
│
├── groups/                            # [RUNTIME] Per-group isolated filesystems (git-ignored)
│   └── {name}/                        # e.g. main/, family-chat/
│       ├── CLAUDE.md                  # Per-group agent memory (loaded by Claude Code)
│       ├── logs/                      # Container run logs (container-{timestamp}.log)
│       └── conversations/             # Archived transcripts (from pre-compact hook)
│
├── store/                             # [RUNTIME] Persistent runtime data (git-ignored)
│   ├── messages.db                    # ★ SQLite database — all persistent state
│   └── auth/                          # Baileys WhatsApp auth files (creds.json, keys/)
│
├── data/                              # [RUNTIME] IPC and snapshot files (git-ignored)
│   ├── ipc/
│   │   └── {groupFolder}/
│   │       ├── messages/              # Outbound message requests from containers
│   │       ├── tasks/                 # Task management requests from containers
│   │       └── input/                 # Inbound follow-up messages for live containers
│   ├── tasks-{groupFolder}.json       # Scheduled tasks snapshot (read by containers)
│   └── groups.json                    # Registered groups snapshot (read by containers)
│
├── setup/                             # Setup wizard scripts
│   └── index.ts                       # CLI setup steps (environment, auth, groups, etc.)
│
├── skills-engine/                     # Skills management system
│   └── ...                            # Handles installable .claude/skills/
│
├── docs/                              # ★ Project documentation (this directory)
│   ├── index.md                       # Master documentation index
│   ├── REQUIREMENTS.md                # Philosophy and architecture decisions
│   ├── SECURITY.md                    # Security model
│   ├── SPEC.md                        # Detailed specification
│   └── ...                            # Generated docs (see index.md)
│
├── .github/
│   └── workflows/
│       └── test.yml                   # CI: typecheck + vitest on PR to main
│
├── .env                               # [RUNTIME] ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
├── .env.example                       # Template for .env
├── package.json                       # nanoclaw v1.1.0 — npm scripts, dependencies
├── tsconfig.json                      # TypeScript config (ESM, Node22, strict)
├── CLAUDE.md                          # Project instructions for Claude Code (this repo)
└── README.md                          # User-facing documentation
```

---

## Critical Directories

| Directory | Purpose | Notes |
|-----------|---------|-------|
| `src/` | Orchestrator source | Compiled to `dist/` for production |
| `container/agent-runner/src/` | Agent runner source | Compiled at container startup to `/tmp/dist/` |
| `container/` | Docker image definition | Rebuilt with `./container/build.sh` |
| `groups/{name}/` | Per-group filesystem | Mounted as `/workspace` in containers |
| `store/` | Runtime data | `.db` + auth — never committed |
| `data/ipc/` | IPC bridge | Volatile — files consumed after processing |
| `docs/` | Project knowledge | Primary AI context source |

---

## Entry Points

| Entry Point | Command | Description |
|-------------|---------|-------------|
| `src/index.ts` | `npm run dev` / `npm start` | Main orchestrator process |
| `container/agent-runner/src/index.ts` | (container entrypoint) | Agent runner inside container |
| `setup/index.ts` | `npm run setup` | Interactive setup wizard |
| `src/whatsapp-auth.ts` | `npm run auth` | WhatsApp QR/pairing auth only |

---

## Integration Points Between Parts

```
[Orchestrator: src/]
    │
    │  1. Spawns container with JSON on stdin
    │  2. Reads OUTPUT_START/END_MARKER from stdout
    ▼
[Agent Runner: container/agent-runner/src/]
    │
    │  3. Agent calls MCP tools → writes IPC JSON files
    │  4. Orchestrator IPC watcher reads files → executes actions
    ▼
[IPC bridge: data/ipc/{group}/]
    │
    │  5. Follow-up messages fed back into running container
    ▼
[WhatsApp: src/channels/whatsapp.ts]
```

The `groups/{name}/` directory is **bidirectional**:
- Orchestrator writes `data/tasks-{group}.json` and `data/groups.json` before container start
- Container reads these snapshots, and reads/writes `groups/{name}/CLAUDE.md` for memory

---

## Key File Relationships

```
src/index.ts
  → imports: db.ts, config.ts, channels/whatsapp.ts, container-runner.ts,
             ipc.ts, task-scheduler.ts, group-queue.ts, logger.ts

src/container-runner.ts
  → imports: container-runtime.ts, mount-security.ts, group-folder.ts, db.ts, config.ts

src/ipc.ts
  → imports: db.ts, router.ts, group-folder.ts, config.ts

container/agent-runner/src/index.ts
  → imports: ipc-mcp-stdio.ts (starts MCP server on stdio subprocess)
```
