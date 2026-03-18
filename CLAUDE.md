# ThagomizerClaw

Enterprise Claude assistant forked from NanoClaw, migrated to Cloudflare Workers.
See [README.md](README.md) for philosophy. See [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md) for deployment.

## Quick Context

Two deployment modes:
1. **Cloudflare Workers** (`worker/`) — Serverless, globally distributed, enterprise-grade. PRIMARY target.
2. **Self-hosted Node.js** (`src/`) — Original NanoClaw architecture, Docker-based. Preserved as reference.

The Workers mode replaces Docker containers with direct Claude API calls, filesystem with R2/KV/D1, and polling loops with Queues + Cron Triggers.

## Repository Structure

```
thagomizer_claw/
├── worker/                     # Cloudflare Workers implementation (PRIMARY)
│   ├── src/
│   │   ├── index.ts            # Worker entry: webhooks, queue consumer, cron
│   │   ├── types.ts            # TypeScript types + Cloudflare env bindings
│   │   ├── db.ts               # D1 database adapter (async SQLite)
│   │   ├── storage.ts          # R2 + KV storage adapter
│   │   ├── agent.ts            # Claude API + Workers AI integration
│   │   ├── router.ts           # Message formatting and routing
│   │   ├── channels/
│   │   │   ├── telegram.ts     # Telegram Bot API webhook handler
│   │   │   ├── discord.ts      # Discord Interactions webhook (Ed25519)
│   │   │   └── slack.ts        # Slack Events API webhook (HMAC-SHA256)
│   │   └── durable-objects/
│   │       └── GroupSession.ts # Per-group state, queue, cursor, lock
│   ├── package.json
│   └── tsconfig.json
├── src/                        # Node.js reference implementation (PRESERVED)
│   ├── index.ts                # Orchestrator: state, message loop, agent invocation
│   ├── config.ts               # Configuration (paths → ~/.config/thagomizer_claw/)
│   ├── db.ts                   # SQLite operations (better-sqlite3, synchronous)
│   ├── container-runner.ts     # Spawns Docker containers (THAGOMIZER_OUTPUT_* markers)
│   ├── container-runtime.ts    # Docker/Apple Container runtime management
│   ├── ipc.ts                  # Filesystem IPC watcher and task processing
│   ├── router.ts               # Message formatting (XML) and outbound routing
│   ├── credential-proxy.ts     # API credential isolation (containers never see real keys)
│   ├── channels/registry.ts    # Self-registering channel factory
│   └── types.ts                # Shared TypeScript interfaces
├── container/                  # Agent container image (Node.js mode only)
│   ├── agent-runner/src/       # Claude Agent SDK wrapper (THAGOMIZER_OUTPUT_* protocol)
│   ├── Dockerfile
│   └── build.sh                # Builds thagomizer-agent:latest
├── migrations/
│   └── 0001_initial.sql        # D1 schema (mirrors SQLite schema from src/db.ts)
├── wrangler.toml               # Cloudflare bindings, cron triggers, env vars
├── .dev.vars.example           # Local dev secrets template → copy to .dev.vars
├── groups/                     # Per-group memory (Node.js mode)
│   ├── main/CLAUDE.md          # Main group system prompt
│   └── global/CLAUDE.md        # Shared read-only global memory
├── docs/
│   ├── CLOUDFLARE_SETUP.md     # Full deployment guide
│   ├── CLOUDFLARE_SECRETS.md   # Secret management guide
│   ├── SECURITY.md             # Security architecture
│   └── REQUIREMENTS.md         # Architecture decisions
└── .claude/skills/             # Claude Code skills for customization
```

## Cloudflare Workers Architecture

### Data Flow
```
Telegram / Discord / Slack
        │
        ▼ HTTP POST (webhook, cryptographic signature verified)
worker/src/index.ts — fetch() handler
        │
   ┌────▼────────┐
   │  D1 (store) │ ← storeMessage()
   └────┬────────┘
        │
        ▼ MESSAGE_QUEUE.send() — async, response < 3s to platform
Cloudflare Queue (thagomizer-messages)
        │
        ▼ queue() consumer — runs agent asynchronously
processMessages() → runAgent() → Claude API (primary) / Workers AI (fallback)
        │
        ▼
Channel API (sendTelegramMessage / sendDiscordMessage / sendSlackMessage)
```

### Cloudflare Bindings (`wrangler.toml`)

| Binding | Type | Purpose |
|---------|------|---------|
| `env.DB` | D1 Database | Messages, groups, tasks, sessions |
| `env.STORAGE` | R2 Bucket | Group CLAUDE.md, logs, session data |
| `env.STATE` | KV Namespace | Hot state: cursors, session IDs |
| `env.MESSAGE_QUEUE` | Queue | Async message processing |
| `env.AI` | Workers AI | Llama/Mistral fallback inference |
| `env.GROUP_SESSION` | Durable Object | Per-group state, lock, queue |
| `env.RATE_LIMITER` | Durable Object | Per-group rate limiting |

### Secrets (NEVER in code — use `wrangler secret put`)

| Secret | Required | Purpose |
|--------|----------|---------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API access |
| `WEBHOOK_SECRET` | ✅ | Telegram webhook URL path + admin API Bearer auth |
| `TELEGRAM_BOT_TOKEN` | Telegram | Bot authentication |
| `DISCORD_BOT_TOKEN` | Discord | Bot authentication |
| `DISCORD_PUBLIC_KEY` | Discord | Ed25519 signature verification |
| `SLACK_BOT_TOKEN` | Slack | Bot OAuth token |
| `SLACK_SIGNING_SECRET` | Slack | HMAC-SHA256 request verification |

### Durable Objects

**GroupSessionDO** (`GROUP_SESSION`):
- One instance per group (keyed by `groupFolder`)
- Stores: session ID, message cursor, processing lock, queued messages
- Alarm API triggers queue drain after 100ms
- Prevents concurrent agent execution per group

**RateLimiterDO** (`RATE_LIMITER`):
- Sliding window rate limiting per group
- Prevents message flooding and cost overruns

### Security Model

1. **Webhook auth**: Ed25519 (Discord), HMAC-SHA256 (Slack), URL secret token (Telegram)
2. **Admin API**: `Authorization: Bearer {WEBHOOK_SECRET}`
3. **Secrets**: Cloudflare-encrypted, never logged, never in code
4. **Worker sandbox**: V8 isolate (no filesystem, no shell)
5. **Input validation**: All webhook bodies parsed + type-checked before DB writes

### HTTP Endpoints

| Path | Method | Auth | Purpose |
|------|--------|------|---------|
| `/` or `/health` | GET | None | Health check |
| `/webhook/telegram/{WEBHOOK_SECRET}` | POST | URL token | Telegram updates |
| `/webhook/discord` | POST | Ed25519 sig | Discord interactions |
| `/webhook/slack` | POST | HMAC-SHA256 | Slack events |
| `/admin/groups` | GET/POST | Bearer | List/register groups |
| `/admin/tasks` | GET | Bearer | List scheduled tasks |
| `/admin/send` | POST | Bearer | Send message to JID |
| `/admin/health` | GET | Bearer | Detailed health check |

## Node.js Reference Mode

### Key Differences from Cloudflare Workers

| Concern | Node.js mode | Workers mode |
|---------|-------------|--------------|
| Agent execution | Docker containers (Claude Agent SDK) | Direct Claude API calls |
| Database | SQLite (better-sqlite3, sync) | D1 (async, globally replicated) |
| File storage | Local filesystem (`groups/`, `data/`) | R2 (object storage) + KV |
| State | In-memory + SQLite | Durable Objects + KV |
| Polling | `setInterval` loop (2s) | Cloudflare Queue consumers |
| Scheduling | In-process scheduler | Cron Triggers → Queue |
| Secrets | `.env` file + credential proxy | Cloudflare Secrets |
| Output markers | `---THAGOMIZER_OUTPUT_START---` | N/A (direct API response) |
| Config path | `~/.config/thagomizer_claw/` | wrangler.toml `[vars]` |

## Development

### Cloudflare Workers (Primary)

```bash
# First time setup
cp .dev.vars.example .dev.vars  # fill in real secrets
cd worker && npm install

# Local dev server
cd worker && npm run dev         # runs at http://localhost:8787

# Deploy to Cloudflare
cd worker && npm run deploy

# Database migrations
cd worker && npm run db:migrate:local   # local D1
cd worker && npm run db:migrate:remote  # production D1

# Secrets management
wrangler secret put ANTHROPIC_API_KEY
wrangler secret list

# Live log tailing
cd worker && npm run tail
```

### Node.js Reference

```bash
npm run dev          # Run with hot reload (tsx watch)
npm run build        # Compile TypeScript → dist/
./container/build.sh # Rebuild thagomizer-agent:latest Docker image
npm test             # Run vitest tests
npm run typecheck    # TypeScript type checking
```

### Service Management (Node.js)

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Key Conventions

### Naming (this fork renames nanoclaw → thagomizer_claw)
- Config dir: `~/.config/thagomizer_claw/`
- Container image: `thagomizer-agent:latest`
- Container name prefix: `thagomizer-{group}-{timestamp}`
- Output markers: `THAGOMIZER_OUTPUT_START/END`
- npm package: `thagomizer_claw`
- Cloudflare Worker name: `thagomizer-claw`

### JID Format (platform-specific identifiers)
- Telegram: `tg:{chatId}`
- Discord: `dc:{guildId}:{channelId}` or `dc:dm:{channelId}`
- Slack: `sl:{teamId}:{channelId}`
- WhatsApp: `{number}@s.whatsapp.net` or `{id}@g.us`

### Message XML Format (agent context prompt)
```xml
<context timezone="UTC" />
<messages>
  <message sender="Alice" time="2024-01-01 10:00:00">Hello!</message>
  <message sender="Bob" time="2024-01-01 10:00:01">@Andy what is 2+2?</message>
</messages>
```

### Agent Trigger
- Groups: require `@{ASSISTANT_NAME}` prefix (configurable per group)
- Main group: no trigger required (processes all messages)
- Solo chats: `requiresTrigger: false` by default

## Database Schema

Both D1 and SQLite use the same schema (see `migrations/0001_initial.sql`):

```sql
chats              -- jid, name, last_message_time, channel, is_group
messages           -- id, chat_jid, sender, content, timestamp, is_from_me, is_bot_message
registered_groups  -- jid, name, folder, trigger_pattern, agent_config, is_main
sessions           -- group_folder, session_id, updated_at
scheduled_tasks    -- id, group_folder, schedule_type, schedule_value, status, next_run
task_run_logs      -- task_id, run_at, duration_ms, status, result, error
```

Key D1 difference: `agent_config` (JSON, replaces `container_config`) holds `{model, timeout, maxTokens, useWorkersAI}`.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation (Node.js mode) |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting (Node.js mode) |
| `/update-nanoclaw` | Bring upstream NanoClaw updates |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues |
| `/get-qodo-rules` | Load org- and repo-level coding rules |

## Troubleshooting

**Workers: Webhook signature failing**
- Discord: verify `DISCORD_PUBLIC_KEY` matches exactly (no whitespace)
- Slack: check `SLACK_SIGNING_SECRET` and ensure timestamp < 5min old
- Telegram: URL path must match `WEBHOOK_SECRET` exactly

**Workers: Messages not processed**
- Check Cloudflare dashboard → Workers → Queues → thagomizer-messages
- Check DLQ: thagomizer-messages-dlq for failed messages
- Test: `GET /admin/health` (requires Bearer auth)

**Workers: Agent not responding**
- Verify `ANTHROPIC_API_KEY` is set: `wrangler secret list`
- Check `env.AI` binding for Workers AI fallback availability
- Check D1 has group registered: `GET /admin/groups`

**Node.js: Container build stale files**
The buildkit caches aggressively. `--no-cache` alone doesn't fix COPY steps.
To force a clean rebuild: prune the builder cache first, then run `./container/build.sh`.

**Node.js: Config path migration from nanoclaw**
Old path: `~/.config/nanoclaw/` → New path: `~/.config/thagomizer_claw/`
Copy existing config files: `cp -r ~/.config/nanoclaw/* ~/.config/thagomizer_claw/`
