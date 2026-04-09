# Simtricity Nexus

AI agent platform for energy community Operators. Every Operator gets Nexus first — before Flows, Flux, Spark, or Skyprospector.

## Architecture

Three Deno processes per Operator, deployed as a single Fly.io app:

- **Gateway** (`src/gateway/`, port 3001) — Public HTTP server. Channels (Discord, web-chat), work queue, event log. Uses `Deno.serve()` bound to `::` (IPv6+IPv4 for Fly 6PN).
- **Agent** (`src/agent/`) — Polls gateway `/work/next`. Builds workspace, calls Claude Agent SDK `query()`, posts result back. No listening port.
- **Store** (`src/store/`, port 3002) — Persistence layer. Sessions, activity events, JSONL transcripts. Filesystem backend (Fly Volume in production, local dir in dev). Internal only — not publicly accessible.

Console UI is a separate project: `simt-console-mock` (Deno Fresh 2.0, Deno Deploy planned).

## Key Files

| File | Purpose |
|------|---------|
| `src/gateway/server.ts` | HTTP handler, all routes, landing page, /licenses |
| `src/gateway/queue.ts` | In-memory work queue + completion callbacks |
| `src/gateway/channels.ts` | Channel registry (web-chat, discord) |
| `src/gateway/sessions.ts` | Session manager (delegates to store) |
| `src/gateway/discord.ts` | Discord bot (discord.js, context prefix, images) |
| `src/gateway/event-log.ts` | Activity events (delegates to store) |
| `src/agent/agent.ts` | Agent SDK `query()` wrapper, additionalDirectories |
| `src/agent/workspace.ts` | Build CLAUDE.md once per session, reuse on follow-ups |
| `src/agent/sessions.ts` | Agent SDK session ID persistence (delegates to store) |
| `src/store/backend.ts` | StoreBackend interface + FilesystemBackend |
| `src/store/server.ts` | Store HTTP API (sessions, events, JSONL) |
| `src/shared/config.ts` | All env vars, path constants |
| `src/shared/store-client.ts` | HTTP client for gateway + agent to talk to store |
| `src/shared/onecli.ts` | OneCLI Cloud vault integration |
| `src/shared/landing.ts` | Shared landing page builder (DRY across processes) |
| `skills/` | SKILL.md files (baked into Docker image) |
| `knowledge/` | Knowledge markdown files (baked into Docker image) |

## Running Locally (Ymir)

The local dev instance is called **Ymir** (slug: `ymir`). It runs on localhost with its own operator context, sessions, and conversations in `../nexus-data/operators/ymir/`.

```bash
# Set ANTHROPIC_API_KEY in .env (copy from .env.example)
deno task dev     # Starts store + gateway + agent (all three)
deno task stop    # Stops all processes
```

Individual processes: `deno task gateway`, `deno task agent`, `deno task store`

| Process | Port | URL |
|---|---|---|
| Gateway | 3001 | http://localhost:3001 |
| Store | 3002 | http://localhost:3002 |
| Agent | — | polls gateway, no port |
| Console | 8000 | http://localhost:8000 (separate project) |

## Operator Data

Operator-specific data lives in `../nexus-data/` (workspace sibling), NOT in this git repo. Each operator has isolated sessions, conversations, and store data.

```
../nexus-data/
  operators/
    ymir/      config.json, context.md, team.json, sessions/, conversations/, store/
    foundry/   config.json, context.md, team.json, sessions/, conversations/
    bec/       config.json, context.md, team.json, sessions/, conversations/
```

Config resolves via `NEXUS_DATA_DIR` env var, defaulting to `../nexus-data`.

## Persistence (Store)

The store process owns all Nexus-specific persistence:

| Data | Storage | Survives restart? |
|---|---|---|
| Session metadata (channel, messages, agentSessionId) | `store.json` | Yes |
| Activity events (last 200) | `store.json` | Yes |
| JSONL transcripts (Agent SDK conversation history) | `jsonl/<sessionId>.jsonl` | Yes |
| Agent SDK session files (`~/.claude/projects/...`) | Synced to/from store | Yes (restored on startup) |
| Workspace (CLAUDE.md, attachments) | `/tmp/nexus-agent/workspaces/` | No (rebuilt on first message) |

JSONL sync optimisations:
- Agent skips download if JSONL exists locally (only restores after restart)
- Agent skips upload if file size unchanged (no new messages)

## Deploying to Fly.io

```bash
deno task deploy:mgf   # builds with foundry data only
deno task deploy:bec   # builds with bec data only
```

The deploy script (`scripts/deploy.sh`) stages only the target operator's data into `.build-data/` before `fly deploy`. Each image contains only one operator's data.

On Fly, three process groups: gateway (public), agent (internal), store (internal + Fly Volume).

Operator identity set via Fly secrets: `OPERATOR_SLUG`, `OPERATOR_NAME`, `ANTHROPIC_API_KEY`, `ONECLI_API_KEY`, `GATEWAY_URL`, `STORE_URL`, `DISCORD_BOT_TOKEN`.

## Operators

| Operator | Fly App | Fly Org | Slug |
|---|---|---|---|
| Ymir (local dev) | localhost | — | `ymir` |
| Microgrid Foundry | `simt-nexus-mgf` | `microgridfoundry` | `foundry` |
| Bristol Energy | `simt-nexus-bec` | `bristolenergy` | `bec` |

## Architectural Rules

1. **Gateway and agent must NOT share filesystem state.** All data flows through WorkItems (serialisable over HTTP). This mirrors Fly.io where they run on separate machines.
2. **WorkResults must be self-describing.** The agent returns `gatewaySessionId` and `channel` in every result so the gateway never relies on in-memory state.
3. **The store is the single source of truth** for anything that needs to survive a restart. In-memory state (queue, processing map) is ephemeral.
4. **Skills and knowledge are read from the project root** via `additionalDirectories`, not copied into workspaces. Only CLAUDE.md is built per session.

## Deployment Issues Solved

- **IPv6 binding**: Gateway and store bind to `::` for Fly 6PN internal networking
- **Non-root user**: Claude Code refuses `--dangerously-skip-permissions` as root. Dockerfile creates `nexus` user
- **Env passthrough**: Agent SDK needs `env: Deno.env.toObject()` in query options
- **Session cleanup**: Don't bake sessions into Docker image — stale session IDs cause errors
- **Single gateway**: In-memory work queue means `gateway=1 agent=1 store=1`
- **Deno task runner**: Can't parse shell redirects — use bash scripts for stop/deploy

## NanoClaw Heritage

Forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) (MIT). The `upstream-main` branch tracks upstream for reference. Old NanoClaw code remains in `src/` root, `src/channels/`, `.claude/skills/`, `container/`, `setup/`, `docs/` — kept as reference for channel and skill patterns.

## Development

```bash
deno task check    # Type-check (shared + gateway + agent + store)
deno task fmt      # Format
deno task lint     # Lint
```
