# NanoClaw — B2B Multi-Agent Framework

A self-hosted multi-agent AI framework for B2B project development, built on top of [NanoClaw](https://github.com/qwibitai/nanoclaw). Runs fully automated code review pipelines, PM workflows, and backend assistance through Discord — all inside isolated containers.

---

## What This Is

This fork extends NanoClaw's container infrastructure with a three-channel Discord setup and a multi-agent pipeline purpose-built for B2B software projects.

| Channel | Mode | Agents |
|---------|------|--------|
| `#frontend` | Fully automated (Tribunal Loop) | Owner → Reviewer → Arbiter |
| `#pm` | User-directed | PM Agent (Figma MCP) |
| `#backend` | User-directed | Backend Agent (OpenAPI spec injection) |

Each agent runs in its own isolated container with separate memory, context, and credentials. Discord messages are delivered through per-agent webhooks so each agent appears as a distinct user in threads.

---

## Key Features

### Tribunal Loop (`#frontend`)

A three-agent verification pipeline that runs without human intervention:

- **Owner** — writes or modifies code based on the task description
- **Reviewer** — reviews the output; flags issues and issues fix instructions
- **Arbiter** — makes the final call: approve (notifies user) or escalate

Multiple tasks can run in parallel — each Tribunal session is isolated via the host orchestrator, not Discord threads.

**Infinite-loop prevention** — escalates automatically when:
- Round count reaches 3
- The Reviewer flags the same keyword issue twice in a row

On escalation, a round summary is posted in the thread with a user @mention.

### Self-Healing

Stderr from code execution is passed directly to the Reviewer as part of the normal Tribunal round — no separate agent needed. Build failures and runtime errors are treated like any other code issue.

### Cron Scheduler

Tribunal tasks can be triggered automatically on a cron schedule. Each agent group stores its schedule as a JSON column in the DB. On the scheduled time, the host sweep auto-creates a Discord thread and wakes the Owner agent.

```json
{ "cron": "0 9 * * 1-5", "task": "Daily code review" }
```

### Context Injection

**Figma MCP (`#pm` + `#frontend` read injection)**
- Full read/write access to scoped Figma projects
- Inline Figma URLs in Discord messages trigger additional file parsing
- `#frontend` Owner gets design tokens and component structure injected at task start

**Spring OpenAPI (`#backend`)**
- Pulls live spec from `/v3/api-docs`, falls back to local `openapi.yaml` / `openapi.json`
- Injects endpoint list, request/response schemas (TypeScript types), and auth method

### Lightweight RAG Memory

SQLite FTS5 full-text search — no vector DB, no extra dependencies.

| Type | Content | When indexed |
|------|---------|--------------|
| `code` | Arbiter-approved code snippets + file path | On Arbiter approval |
| `decision` | Tribunal round summary (issue → resolution) | On approval or escalation |
| `domain` | Manually added domain knowledge | `/memory add <content>` command |

Relevant records are surfaced automatically at the start of each Owner task.

### Per-Agent Discord Identity

Each agent group has its own webhook identity in Discord — different username and avatar per agent. Configured via `groups/<folder>/webhook.json`.

```json
{
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "username": "🔨 Owner Agent",
  "avatarUrl": "https://..."
}
```

Agent sessions remain fully isolated; the webhook only affects how messages appear in Discord.

---

## Architecture

```
Discord
  ├── #frontend ─── Tribunal Loop (fully automated)
  │                  Owner → Reviewer → Arbiter
  │                  Self-Healing, Scheduler, RAG Memory
  │
  ├── #pm ──────────── User ↔ PM Agent (1:1)
  │                    Figma MCP (full read/write)
  │
  └── #backend ──────── User ↔ Backend Agent (collaborative)
                        Spring OpenAPI spec injection

NanoClaw Host (Node.js)
  ├── src/router.ts          — inbound routing → inbound.db → wake container
  ├── src/delivery.ts        — polls outbound.db → channel adapter (webhook)
  ├── src/host-sweep.ts      — 60s sweep: stale detection, cron triggers
  └── src/tribunal/
        ├── orchestrator.ts  — Tribunal state machine
        ├── loop-guard.ts    — infinite-loop prevention
        ├── scheduler.ts     — cron-based task triggers
        ├── context-injector.ts — Figma + OpenAPI injection
        └── memory/
              ├── store.ts   — FTS5 search
              └── indexer.ts — approval/decision indexing

Agent Containers (Bun + Claude Agent SDK)
  ├── frontend-owner    — inbound.db / outbound.db (isolated)
  ├── frontend-reviewer — inbound.db / outbound.db (isolated)
  ├── frontend-arbiter  — inbound.db / outbound.db (isolated)
  ├── pm                — inbound.db / outbound.db (isolated)
  └── backend           — inbound.db / outbound.db (isolated)
```

**Everything is a message.** The host and containers communicate only through SQLite files — no IPC, no stdin piping. Each session has two DBs: `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads). Exactly one writer per file.

---

## Requirements

- **macOS** (Apple Silicon recommended) or Linux
- **Node.js 22+** and **pnpm 10+**
- **Docker Desktop** (macOS) or Docker Engine (Linux) — or Apple Container (`/convert-to-apple-container`)
- **Claude Code** — for setup, skills, and ongoing customization
- **Anthropic API key** — managed via [OneCLI Agent Vault](https://github.com/onecli/onecli)
- **Discord bot** — one bot token with `Message Content Intent` enabled
- **Discord server** — three text channels: `#frontend`, `#pm`, `#backend`

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/HJinS/nanoclaw.git
cd nanoclaw
pnpm install
```

### 2. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. **Bot** tab → **Add Bot** → disable **Public Bot** → enable **Message Content Intent**
3. **OAuth2 → URL Generator** — scopes: `bot`, `applications.commands`; permissions: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Read Message History`, `Manage Webhooks`
4. Open the generated URL and invite the bot to your server

### 3. Create channel webhooks

In each Discord channel (Settings → Integrations → Webhooks → New Webhook → Copy URL):

- `#frontend` webhook URL
- `#pm` webhook URL
- `#backend` webhook URL

### 4. Configure credentials

Add to `.env`:

```bash
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=your-application-id
DISCORD_PUBLIC_KEY=your-public-key
```

Sync to container:

```bash
mkdir -p data/env && cp .env data/env/env
```

### 5. Configure agent webhook identities

Create `groups/<folder>/webhook.json` for each agent group:

```
groups/
  frontend-owner/webhook.json
  frontend-reviewer/webhook.json
  frontend-arbiter/webhook.json
  pm/webhook.json
  backend/webhook.json
```

Example (`groups/frontend-owner/webhook.json`):

```json
{
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "username": "🔨 Owner Agent",
  "avatarUrl": "https://..."
}
```

`frontend-owner`, `frontend-reviewer`, `frontend-arbiter` all use the `#frontend` webhook URL — they share the channel but have different usernames. `pm` and `backend` each use their own channel's webhook URL.

### 6. Register the service and wire channels

```bash
# Register as a launchd service (macOS)
/setup

# Bootstrap the first agent + set operator as owner
/init-first-agent

# Wire #frontend, #pm, #backend to their agent groups
/manage-channels
```

---

## Agent Groups

| Folder | Channel | Role |
|--------|---------|------|
| `frontend-owner` | `#frontend` | Writes code based on task |
| `frontend-reviewer` | `#frontend` | Reviews output, flags issues |
| `frontend-arbiter` | `#frontend` | Final approval or escalation |
| `pm` | `#pm` | Figma MCP — design to spec |
| `backend` | `#backend` | API integration, OpenAPI-aware |

Each group has its own filesystem at `groups/<folder>/`:

```
groups/<folder>/
  CLAUDE.md         — agent persona and instructions
  webhook.json      — Discord webhook identity
  skills/           — agent-specific skills
  container-config/ — apt/npm deps, MCP servers
```

---

## Development

```bash
# Host (Node + pnpm)
pnpm run dev          # hot reload
pnpm run build        # compile TypeScript
pnpm test             # run tests (vitest, 247 tests)

# Agent container (Bun)
cd container/agent-runner && bun install
cd container/agent-runner && bun test

# Rebuild container image
./container/build.sh
```

**Service management (macOS)**

```bash
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # restart
```

**Troubleshooting**

| What | Where |
|------|-------|
| Host logs | `logs/nanoclaw.error.log` (errors), `logs/nanoclaw.log` (full trace) |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` |
| Central DB | `data/v2.db` — agent groups, messaging groups, wiring, memory |

---

## DB Migrations

Custom migrations added on top of NanoClaw base:

| Migration | Purpose |
|-----------|---------|
| `014-tribunal-sessions` | Tribunal round state tracking |
| `015-tribunal-schedules` | Cron schedule JSON column on `agent_groups` |
| `016-tribunal-memory` | FTS5 full-text search (isolated per `agent_group_id`) |

---

## Based On

[NanoClaw](https://github.com/qwibitai/nanoclaw) — lightweight self-hosted AI assistant framework. This fork adds the Tribunal Loop, per-agent Discord webhook identity, RAG memory, context injection, and cron scheduling on top of NanoClaw's container infrastructure.

---

## License

MIT
