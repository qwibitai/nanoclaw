# Migration Research: OpenClaw → NanoClaw

## TL;DR

OpenClaw is a **gateway-driven orchestration platform** with a persistent heartbeat loop, multi-model subagent spawning, a structured task/initiative lifecycle, and application-level security. NanoClaw is a **messaging assistant** built around container-isolated agent runs, SQLite-backed scheduling, per-group memory, and true OS-level isolation. The conceptual overlap is real but the execution models are fundamentally different. Migrating is not a one-to-one port — it's a re-architecture.

---

## 1. OpenClaw — This Installation

### What It Is

An autonomous 24/7 AI orchestration system acting as Vinny's research partner, strategic analyst, and technical co-pilot. It runs **Homie** (orchestrator) on a 15-minute heartbeat, which plans work and spawns worker subagents to execute it.

### Objectives

1. **ProjectCal (CEQA SaaS)** — Lead generation, GTM, code improvements for `dirtsignals/`
2. **Robotics (Gecko Feeder)** — Embodied AI / VLA research (currently no active initiative)
3. **AI Writing (Blog)** — Research, ideation, structure (no ghostwriting)
4. **North Star (Career)** — OpenAI/Anthropic positioning

### Runtime Configuration (`~/.openclaw/openclaw.json`)

| Setting | Value |
|---------|-------|
| Model | `minimax/MiniMax-M2.5` (via Anthropic-compatible base URL) |
| Thinking | `high` |
| Heartbeat interval | `5 minutes` |
| Max concurrent subagents | 8 |
| Session compaction | `safeguard` |
| Channel | **Discord** (single guild + channel allowlist) |
| Tools denied | `browser` |
| Filesystem access | unrestricted (`workspaceOnly: false`) |
| Hooks | `inject-worker-context` (enabled) |

### Architecture: Orchestrator → Worker Flow

```
OpenClaw Gateway (cron/heartbeat every 5 min)
  └── Homie session (reads HEARTBEAT.md → ORCHESTRATOR.md tick loop)
        1. Read all tasks + initiatives + lock + activity log + USER.md
        2. Handle running worker (timeout, wrap-up, kill)
        3. Verify completed work
        4. Select next ready task
        5. Write lock.json → sessions_spawn(worker) → update lock → terminate self
              └── Worker subagent (context injected via agent:bootstrap hook)
                    Executes task → writes outputs → updates task via mc → clears lock
```

**Key invariants:**
- At most **one worker at a time** (lock.json)
- Homie **never executes task work** — only routes and verifies
- Workers **cannot create tasks** — only Homie does
- Lock must be written **before** spawning (bootstrap hook reads it at spawn time)
- Homie **self-terminates** after spawning a worker

### Three-Tier Planning Model

| Tier | Storage | Format |
|------|---------|--------|
| Vision | `workspace/USER.md` | Markdown |
| Initiatives | `workspace/mission-control/initiatives/I-<TITLE>.md` | YAML frontmatter |
| Tasks | `workspace/mission-control/tasks/<ID>.md` | YAML frontmatter |

Task lifecycle: `backlog → ready → in_progress → done → verified` (or `cancelled / blocked / failed`)

### Worker Route Config (`routing.json`)

All 6 routes (coding, research, writing, long, ops, admin) currently use the same settings:
- Model: `minimax/MiniMax-M2.5`
- Timeout: 60 min + 15 min grace

### Context Injection Hook (`inject-worker-context`)

Fires on `agent:bootstrap` for subagent sessions only. Reads `lock.json` → finds `task_id` → appends `WORKERS.md` + task file + `RESUME-<task_id>.md` (if any) to the subagent's in-memory AGENTS.md. Nothing written to disk.

### Key Identity Files

| File | Role |
|------|------|
| `workspace/SOUL.md` | Homie's personality (direct, opinionated, resourceful) |
| `workspace/USER.md` | Vinny's persona + 4 objectives |
| `workspace/MEMORY.md` | Long-term curated learnings (currently sparse) |
| `workspace/HEARTBEAT.md` | Points Homie at ORCHESTRATOR.md |
| `workspace/mission-control/ORCHESTRATOR.md` | Full tick loop contract |
| `workspace/workers/WORKERS.md` | Worker execution contract |

### External Integrations

- **Discord**: Notifications for daily briefings, blocked tasks, failures
- **MiniMax M2.5**: All model calls (via Anthropic-compatible API)
- **Web Search** (Brave API key configured)
- **Web Fetch**: enabled
- **Code repo**: `~/Documents/dev/dirtsignals/` (workers use git worktrees)

### `mc` Skill

CLI tool at `workspace/bin/mc.ts` (run via `bun`). Handles all task/initiative mutations — writes YAML frontmatter, appends to activity log, manages timestamps. Workers and Homie never write task files directly.

---

## 2. NanoClaw — The Target

### What It Is

A lightweight personal Claude assistant. Single Node.js process. Agents run inside **Linux containers** (Apple Container or Docker) with filesystem isolation. Messages flow from channels (WhatsApp, Telegram, Discord, etc.) through SQLite → poll loop → container → IPC → response.

### Architecture

```
Channel → SQLite → Poll loop (2s) → GroupQueue → Container (Claude Agent SDK) → IPC → Response
```

### Key Abstractions

**Groups** — Each channel group (WhatsApp chat, Telegram group, Discord channel, etc.) maps to:
- A folder under `groups/{name}/` with its own `CLAUDE.md` (memory)
- An isolated container at runtime
- A per-group SQLite session record
- A per-group queue with global concurrency limit (default: 5 containers)

**Containers** — Each agent invocation spawns a fresh container. Mounts:
- `groups/{folder}/` → `/workspace/group` (read-write)
- `groups/global/` → `/workspace/global` (read-only, non-main)
- `data/sessions/{group}/.claude/` → `/home/node/.claude` (session state, read-write)
- `data/ipc/{group}/` → `/workspace/ipc` (IPC, read-write)
- Additional mounts → `/workspace/extra/{name}` (allowlist-controlled)

**Main Group** — The "self-chat" / admin channel. Can write global memory, manage all groups and tasks, register new groups.

**IPC** — Filesystem-based bidirectional communication:
- Agent → host: JSON files in `data/ipc/{group}/messages/` and `data/ipc/{group}/tasks/`
- Host → agent: JSON files in `data/ipc/{group}/input/` (follow-up messages while container runs)

**Scheduled Tasks** — SQLite table `scheduled_tasks`. Schedule types: cron, interval, once. Tasks run as full agents in their group's container context. Managed via `schedule_task` / `pause_task` / `cancel_task` MCP tools inside the container.

**Memory** — Two-level `CLAUDE.md` hierarchy:
- `groups/CLAUDE.md` — global, read-only to non-main groups
- `groups/{name}/CLAUDE.md` — per-group, read-write

**Skills** — Claude Code skill files (`.claude/skills/{name}/SKILL.md`) that transform the NanoClaw installation. Skills like `/add-discord`, `/add-telegram`, `/add-gmail` add channels. No application configuration files — customization = code changes.

**Channels** — Self-registering. Each channel skill drops a file in `src/channels/` that calls `registerChannel()` at startup. Only channels with credentials present are activated.

### What NanoClaw Does NOT Have

- A persistent orchestrator loop (no heartbeat equivalent out of the box)
- A multi-tier task/initiative planning model
- Worker-type routing (no model-per-worker-type config)
- A single-worker lock (it supports up to 5 concurrent containers)
- Bootstrap hook context injection
- An activity log / audit trail
- RESUME files (session continuity is via Claude Agent SDK session state)

---

## 3. Concept Mapping

| OpenClaw Concept | NanoClaw Equivalent | Notes |
|---|---|---|
| **Gateway + Heartbeat** | Scheduled task (interval/cron) | Closest mechanism. A scheduled task can run Homie-like logic recurrently. Architecture is different: no persistent session between ticks; each run is a fresh container. |
| **Homie (orchestrator session)** | Scheduled task agent in a dedicated group | Could create a `homie` group whose scheduled task fires every 15 min. |
| **`sessions_spawn` (spawn subagent)** | No direct equivalent | NanoClaw has no agent-to-agent spawning from inside a container. Would need host-side orchestration or IPC-triggered container runs. |
| **Worker subagents** | Containerized agents (via scheduler or IPC) | Workers become scheduled tasks or IPC-triggered container runs. Isolation is stronger (container-level vs. application-level). |
| **`lock.json` (single-worker lock)** | Not built-in; manual implementation needed | Could be a file in a group folder. The Planner must decide if this invariant is needed or if NanoClaw's concurrency model suffices. |
| **Tasks (`tasks/*.md` YAML)** | SQLite `scheduled_tasks` table | Fundamental model mismatch. OpenClaw tasks are strategic work units; NanoClaw tasks are scheduled agent runs. New task management infrastructure needed. |
| **Initiatives (`initiatives/*.md`)** | No equivalent | Needs to be built. Could live in `groups/{homie}/CLAUDE.md` or as markdown files in the group folder. |
| **`mc` skill (task CLI)** | No equivalent | Needs to be built or replaced. Could be a script in the homie group folder or a NanoClaw skill. |
| **`SOUL.md` / `USER.md`** | `groups/CLAUDE.md` (global memory) | Global CLAUDE.md is the system prompt equivalent. All three files (SOUL, USER, MEMORY) can be consolidated into it or kept as separate files mounted into the homie group. |
| **`MEMORY.md`** | `groups/CLAUDE.md` or group-specific `CLAUDE.md` | Same as above. |
| **`WORKERS.md`** | CLAUDE.md in worker groups | Each worker "type" could be a separate group with its own memory/instructions. |
| **`inject-worker-context` hook** | Not available | NanoClaw has no bootstrap hook system. Task context must be passed via the prompt (the `schedule_task` prompt field) or via CLAUDE.md in the group folder. |
| **`RESUME-<task_id>.md`** | Group `CLAUDE.md` or session continuity | Claude Agent SDK maintains session transcripts in `data/sessions/{group}/.claude/`. Per-group CLAUDE.md can hold handoff notes. |
| **`routing.json` (model per route)** | `CONTAINER_IMAGE`, `CONTAINER_TIMEOUT` env | No per-task-type routing. Same container image for all. Model is determined by the API key. MiniMax M2.5 via Anthropic-compatible API can be configured via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`. |
| **Activity log (`activity.log.ndjson`)** | `task_run_logs` (SQLite) + container logs | NanoClaw logs runs to SQLite; detailed logs per run in `groups/{name}/logs/`. No append-only structured audit trail equivalent. |
| **Discord channel** | `/add-discord` skill | NanoClaw supports Discord as a channel. The homie group could use Discord as its I/O surface (same guild/channel). |
| **Daily briefing (8 AM cron)** | Scheduled task (cron `0 8 * * *`) | Direct equivalent via NanoClaw's scheduler. |
| **Exec-approvals / tool deny** | Container isolation + mount allowlist | Security model is fundamentally different (and stronger). No exec-approvals needed; Bash is safe inside the container. |
| **Web search (Brave API)** | Built-in WebSearch + WebFetch | NanoClaw agents have these tools natively inside containers. |
| **Git worktrees for code changes** | Same pattern inside container | Container mounts the repo (additional mount); worker uses `git worktree` inside. |
| **`dirtsignals/` repo access** | Additional mount via `containerConfig` | Add to `~/.config/nanoclaw/mount-allowlist.json` and configure in the homie group's `containerConfig`. |
| **Obsidian Vault access** | Additional mount (same mechanism) | Same — add to allowlist and mount config. |

---

## 4. Critical Gaps for the Planner

### Gap 1: Continuous Orchestrator Loop
**Hardest problem.** OpenClaw's heartbeat gives Homie a persistent 5-min tick with session history and the ability to send Discord messages. NanoClaw's scheduled tasks are stateless container runs — each tick starts fresh with no memory of the previous run beyond what's in the group's CLAUDE.md and SQLite.

**Options:**
- a) Implement the orchestrator as a NanoClaw scheduled task (cron every 5–15 min) in a dedicated group. State passes through the group's CLAUDE.md and task files in the group folder (not SQLite).
- b) Re-use OpenClaw's heartbeat for orchestration while using NanoClaw only for messaging. (Hybrid, not a full migration.)

### Gap 2: Task/Initiative Lifecycle
NanoClaw's `scheduled_tasks` SQLite table is for scheduling agent runs — not for tracking strategic work with statuses, dependencies, priorities, and retry counts. The entire `mission-control/` directory (tasks, initiatives, lock, activity log, `mc` tool) has no NanoClaw equivalent and must be ported or rebuilt.

**Options:**
- a) Port `mission-control/` as-is into the homie group folder. Recreate a `mc`-like CLI tool that runs inside the container. This preserves the YAML file–based model.
- b) Design a new lightweight task store (SQLite or JSON) integrated with NanoClaw's existing DB.

### Gap 3: Worker Subagent Spawning
In OpenClaw, Homie calls `sessions_spawn` to create a worker subagent in a separate session. NanoClaw has no agent-to-agent spawning from inside a container. Workers would need to be triggered differently — either as additional scheduled tasks created by the orchestrator (via IPC `schedule_task`) or by a host-side process watching for IPC signals.

**Most viable path:** Orchestrator writes an IPC `schedule_task` file with `schedule: once` to immediately trigger a worker container run. This is the NanoClaw-native pattern.

### Gap 4: Context Injection (Bootstrap Hook)
The `inject-worker-context` hook is deeply tied to OpenClaw's hook system. In NanoClaw, the agent's full context must be passed in the `schedule_task` prompt or be present in the group's `CLAUDE.md`. The Planner must design how worker task context (task file content, WORKERS.md equivalent, RESUME) gets into the container prompt.

### Gap 5: Model Configuration
Currently using MiniMax M2.5 via Anthropic-compatible base URL. NanoClaw supports this via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in `.env`, but there's no per-route model selection. All groups/tasks would use the same model unless code changes are made.

---

## 5. What Migrates Easily

- **Memory files** (SOUL.md, USER.md, MEMORY.md) → consolidate into `groups/global/CLAUDE.md`
- **Daily briefing** → scheduled task with cron `0 8 * * *`
- **Discord channel** → run `/add-discord` skill with same guild/channel config
- **Web search/fetch** → built-in, no changes needed
- **Code repo access** (`dirtsignals/`) → additional mount + allowlist entry
- **Obsidian Vault access** → same mechanism
- **No-browser policy** → not needed; browser inside container is safe, or just don't install it
- **Git worktree pattern** → same pattern works inside containers
- **SOUL.md / USER.md persona** → lives in global CLAUDE.md

---

## 6. File / Directory Mapping Reference

| OpenClaw path | NanoClaw equivalent |
|---|---|
| `~/.openclaw/workspace/` | `groups/{homie}/` (homie group folder) |
| `workspace/SOUL.md` | `groups/global/CLAUDE.md` (merged in) |
| `workspace/USER.md` | `groups/global/CLAUDE.md` (merged in) |
| `workspace/MEMORY.md` | `groups/global/CLAUDE.md` (merged in) |
| `workspace/HEARTBEAT.md` | Scheduled task prompt |
| `workspace/mission-control/ORCHESTRATOR.md` | `groups/{homie}/CLAUDE.md` or mounted file |
| `workspace/mission-control/tasks/*.md` | Port into `groups/{homie}/mission-control/tasks/` |
| `workspace/mission-control/initiatives/*.md` | Port into `groups/{homie}/mission-control/initiatives/` |
| `workspace/mission-control/lock.json` | `groups/{homie}/mission-control/lock.json` |
| `workspace/mission-control/activity.log.ndjson` | `groups/{homie}/mission-control/activity.log.ndjson` |
| `workspace/mission-control/routing.json` | Embed in CLAUDE.md or prompt (no config file equivalent) |
| `workspace/mission-control/outputs/` | `groups/{homie}/outputs/` |
| `workspace/workers/WORKERS.md` | Per-worker-group CLAUDE.md or embedded in task prompt |
| `workspace/hooks/inject-worker-context/` | No equivalent; context via prompt or CLAUDE.md |
| `workspace/bin/mc.ts` | Rebuild as script in `groups/{homie}/bin/` or as NanoClaw skill |
| `~/.openclaw/openclaw.json` (Discord config) | `.env` + `/add-discord` skill |
| `~/.openclaw/openclaw.json` (MiniMax model) | `.env` `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| `~/.openclaw/cron/` | NanoClaw SQLite `scheduled_tasks` |
