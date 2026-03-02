# NanoClaw — System Overview

> Current as of 2026-03-02

---

## What It Is

A single Node.js process that connects to WhatsApp, routes messages to Claude agents running in isolated Docker containers, and runs scheduled tasks. No microservices. No config sprawl.

```
WhatsApp (baileys) → SQLite → Polling loop → Container (Claude Agent SDK) → Response
```

---

## Directory Structure

```
nanoclaw/
├── src/                      # Host process (TypeScript)
│   ├── index.ts              # Orchestrator: message loop, agent invocation
│   ├── channels/whatsapp.ts  # WhatsApp connection and auth (Baileys)
│   ├── ipc.ts                # Watches /data/ipc/ for container output
│   ├── router.ts             # Formats messages as XML for agents
│   ├── config.ts             # Env vars: trigger, timeouts, paths
│   ├── container-runner.ts   # Spawns Docker/Apple Container with mounts
│   ├── container-runtime.ts  # Runtime abstraction (Docker vs Apple Container)
│   ├── task-scheduler.ts     # Runs due cron/interval/once tasks
│   ├── db.ts                 # SQLite: messages, groups, sessions, tasks
│   ├── group-queue.ts        # Per-group FIFO queue, global concurrency cap
│   ├── group-folder.ts       # Resolves & validates group folder paths
│   └── mount-security.ts     # Validates mounts against allowlist
│
├── container/
│   ├── Dockerfile            # node:22-slim + Chromium + agent-browser
│   ├── build.sh              # Build script
│   ├── agent-runner/         # Runs inside the container
│   │   └── src/index.ts      # Reads stdin JSON → Claude Agent SDK → stdout
│   └── skills/agent-browser/ # Browser automation (Playwright + Chromium)
│
├── groups/
│   ├── global/CLAUDE.md      # Read by all groups (writable by main only)
│   ├── main/CLAUDE.md        # Admin group memory (self-chat)
│   └── {name}/               # Per-group workspace + CLAUDE.md
│
├── docs/                     # Architecture docs
├── .claude/skills/           # Claude Code skills (/setup, /add-telegram, etc.)
└── setup/                    # Setup scripts invoked by /setup skill
```

---

## How a Message Gets Processed

1. **Receive** — WhatsApp sends a message; Baileys stores it in SQLite.
2. **Poll** — `index.ts` polls every 2s. New messages for registered groups get enqueued in `GroupQueue`.
3. **Dequeue** — `processGroupMessages()` respects the global concurrency cap (default 5 containers).
4. **Format** — `router.ts` wraps messages as XML and attaches conversation history.
5. **Spawn** — `container-runner.ts` starts a container, mounts group folder + global folder, passes secrets via stdin.
6. **Agent runs** — Inside the container, `agent-runner/src/index.ts` feeds the prompt to the Claude Agent SDK. The agent has Bash, WebSearch, WebFetch, agent-browser, and MCP tools.
7. **Output** — Results stream back to the host via stdout (between sentinel markers). Each chunk is forwarded to WhatsApp in real time.
8. **IPC** — If the agent calls `send_message` or `schedule_task`, it writes JSON files to `/data/ipc/{group}/`. The `ipc.ts` watcher processes them: schedules tasks in SQLite or sends additional messages.

---

## How Scheduled Tasks Work

- Any agent can call `schedule_task` (cron, interval, or one-time).
- `task-scheduler.ts` polls SQLite every 60s for due tasks.
- Due tasks spawn containers exactly like regular messages, then optionally send a message back via `send_message`.
- Run history (duration, status, result) is logged to `task_run_logs`.

---

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Filesystem isolation | Agents run in containers; only explicitly mounted paths are visible |
| Mount allowlist | Extra mounts validated against `~/.config/nanoclaw/mount-allowlist.json` |
| Read-only source | Project root mounted read-only for main group |
| Per-group IPC | Each group can only write to its own `/data/ipc/{group}/` directory |
| Secrets | Passed via stdin JSON, never written to disk |
| Non-root user | Container runs without root privileges |

---

## Key Config (`.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ASSISTANT_NAME` | `Andy` | Trigger prefix (`@Andy`) |
| `POLL_INTERVAL` | 2000ms | Message loop interval |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | Task check interval |
| `CONTAINER_TIMEOUT` | 30min | Hard container kill timeout |
| `IDLE_TIMEOUT` | 30min | Keep-alive after last result |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Global concurrency cap |

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `messages` | Full conversation history per chat |
| `chats` | Chat metadata (JID, name, channel) |
| `registered_groups` | Group config: folder, trigger, containerConfig |
| `sessions` | Claude Agent SDK session ID per group |
| `scheduled_tasks` | Task definitions (schedule, status, next_run) |
| `task_run_logs` | Execution history (duration, result, error) |
| `router_state` | Persistent state (last processed timestamp) |

---

## Verification Against Original Goals

| Original Goal | Status | Notes |
|---------------|--------|-------|
| Small enough to understand | **Yes** | ~15 source files, one process |
| Security via true OS isolation | **Yes** | Docker/Apple Container with explicit mounts; not application-level ACLs |
| Per-group isolated filesystem and memory | **Yes** | Each group has its own folder, CLAUDE.md, and container mounts |
| WhatsApp as primary I/O | **Yes** | Baileys-based, QR auth, auto-reconnect |
| Persistent per-group memory | **Yes** | CLAUDE.md files per group + global |
| Scheduled tasks that can message back | **Yes** | Cron/interval/once via SQLite + IPC |
| Web access | **Yes** | WebSearch + WebFetch built into Agent SDK |
| Browser automation | **Yes** | agent-browser (Playwright + Chromium inside container) |
| No config sprawl | **Yes** | Trigger word in env; everything else is code |
| AI-native setup | **Yes** | `/setup`, `/debug`, `/customize` skills |
| Skills over features | **Yes** | Add-ons contributed as skill files, not merged into core |
| Agent Swarms | **Yes** | Telegram swarm support added as optional skill |

### What's Not in Core (by design)

- Telegram, Slack, Discord, Gmail — available via skills (`/add-telegram`, `/add-slack`, `/add-gmail`)
- Monitoring dashboard — ask Claude Code instead
- Installation wizard — `/setup` skill handles it

---

## Answering "Can I Run It On X?"

NanoClaw requires:
- A **persistent process** (not serverless/edge functions)
- **Node.js 20+**
- **Docker** (Linux/macOS) or **Apple Container** (macOS)
- Outbound internet (WhatsApp + Claude API)

Works on: any Linux VPS, macOS (local or server), WSL2.
Does **not** work on: Supabase, Vercel, Cloudflare Workers, Railway (serverless tiers), or any platform without persistent container support.
