# Simtricity Nexus

AI agent platform for energy community Operators. Every Operator gets Nexus first — before Flows, Flux, Spark, or Skyprospector.

## Architecture

Two Deno processes per Operator, deployed as a single Fly.io app:

- **Gateway** (`src/gateway/`) — HTTP server on port 3001. Public API (`/api/*`), internal worker API (`/work/*`), in-memory work queue, event log. Uses `Deno.serve()` bound to `::` (IPv6+IPv4 for Fly 6PN networking).
- **Worker** (`src/worker/`) — Polls gateway `/work/next` every 2s. Builds workspace from skills + knowledge + operator context. Calls Claude Agent SDK `query()`. Posts result back to gateway.

Console UI is a separate project: `simt-console-mock` (Deno Fresh 2.0).

## Key Files

| File | Purpose |
|------|---------|
| `src/gateway/server.ts` | HTTP handler, all routes, landing page |
| `src/gateway/queue.ts` | In-memory work queue |
| `src/gateway/event-log.ts` | Activity event circular buffer |
| `src/gateway/skills.ts` | Scan skills/ directory |
| `src/worker/agent.ts` | Agent SDK `query()` wrapper |
| `src/worker/workspace.ts` | Build CLAUDE.md + copy skills/knowledge into /tmp workspace |
| `src/worker/sessions.ts` | Session ID persistence (dev-data/sessions/) |
| `src/shared/config.ts` | All env vars, path constants |
| `src/shared/onecli.ts` | OneCLI Cloud vault integration |
| `src/shared/logger.ts` | Structured coloured logging |
| `src/gateway/channels.ts` | Channel registry (web-chat, discord) |
| `src/gateway/sessions.ts` | Session manager (conversation state) |
| `src/gateway/discord.ts` | Discord bot (discord.js) |
| `skills/` | SKILL.md files (baked into Docker image) |
| `knowledge/` | Knowledge markdown files (baked into Docker image) |

## Running Locally (Ymir)

The local dev instance is called **Ymir** (slug: `ymir`). It runs on localhost and has its own operator context, sessions, and conversations in `../nexus-data/operators/ymir/`.

```bash
# Set ANTHROPIC_API_KEY in .env (copy from .env.example)
deno task gateway   # Terminal 1
deno task worker    # Terminal 2
```

Gateway: http://localhost:3001, Console: http://localhost:8000 (separate project)

## Operator Data

Operator-specific data (context, config, team) lives in `../nexus-data/` (workspace sibling), NOT in this git repo. This ensures operator data is never pushed to GitHub and each deployed image contains only its target operator's data.

```
../nexus-data/
  operators/
    foundry/   config.json, context.md, team.json
    bec/       config.json, context.md, team.json
  sessions/    Agent SDK session persistence
```

Config resolves via `NEXUS_DATA_DIR` env var, defaulting to `../nexus-data`.

## Deploying to Fly.io

```bash
deno task deploy:mgf   # builds with foundry data only
deno task deploy:bec   # builds with bec data only
```

The deploy script (`scripts/deploy.sh`) stages only the target operator's data into `.build-data/` before `fly deploy`. Each image contains only one operator's data.

Operator identity set via Fly secrets: `OPERATOR_SLUG`, `OPERATOR_NAME`, `ANTHROPIC_API_KEY`, `ONECLI_API_KEY`, `GATEWAY_URL`.

Worker connects to gateway via Fly internal DNS: `http://gateway.process.<app>.internal:3001`

## Operators

| Operator | Fly App | Fly Org | Slug |
|---|---|---|---|
| Microgrid Foundry | `simt-nexus-mgf` | `microgridfoundry` | `foundry` |
| Bristol Energy | `simt-nexus-bec` | `bristolenergy` | `bec` |

## Deployment Issues Solved

- **IPv6 binding**: Gateway must bind to `::` not `0.0.0.0` for Fly 6PN internal networking
- **Non-root user**: Claude Code refuses `--dangerously-skip-permissions` as root. Dockerfile creates `nexus` user
- **Env passthrough**: Agent SDK needs `env: Deno.env.toObject()` in query options to pass ANTHROPIC_API_KEY to claude-code subprocess
- **Session cleanup**: Don't bake dev-data/sessions/ into Docker image — stale session IDs cause "No conversation found" errors
- **Single gateway**: In-memory work queue means only 1 gateway machine (scale `gateway=1 worker=1`)

## NanoClaw Heritage

Forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) (MIT). The `upstream-main` branch tracks upstream for reference. Old NanoClaw code remains in `src/` root, `src/channels/`, `.claude/skills/`, `container/`, `setup/`, `docs/` — kept as reference for channel patterns, skills, and SDK integration. New Nexus code lives in `src/shared/`, `src/gateway/`, `src/worker/`.

## OneCLI Integration

OneCLI Cloud (app.onecli.sh) manages service credentials. Anthropic API key is direct (not proxied). Discord, Resend, and future service keys will route through OneCLI proxy. Gateway connects at startup, status shown via `/api/status`.

## Skills and Knowledge

Skills (`skills/`) and knowledge (`knowledge/`) are baked into the Docker image. `OPERATOR_SLUG` selects which operator context to use. This ensures atomic deploys — code, skills, and knowledge always in sync.

## Development

```bash
deno task check    # Type-check
deno task fmt      # Format
deno task lint     # Lint
```
