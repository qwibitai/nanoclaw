# External Integrations

**Analysis Date:** 2026-02-27

## APIs & External Services

**Messaging Platforms:**
- **WhatsApp** - Primary messaging channel
  - SDK/Client: `@whiskeysockets/baileys` (reverse-engineered WhatsApp Web protocol)
  - Auth: QR code during setup, credentials stored in `store/auth/` (multi-file auth state)
  - Connection: `src/channels/whatsapp.ts` implements `Channel` interface
  - Status: Enabled by default unless `TELEGRAM_ONLY=true`

- **Telegram** - Secondary messaging channel
  - SDK/Client: `grammy` (Telegram Bot API wrapper)
  - Auth: `TELEGRAM_BOT_TOKEN` environment variable
  - Config: Optional pool of bot tokens for Agent Swarms via `TELEGRAM_BOT_POOL` env var
  - Connection: `src/channels/telegram.ts` implements `Channel` interface
  - Status: Requires `TELEGRAM_BOT_TOKEN` to be set
  - Features: HTML formatting, typing indicators, multi-bot support for swarms

**Web Access:**
- **Claude Agent SDK Built-in Tools**
  - WebSearch - Search the internet
  - WebFetch - Fetch and parse web content
  - Integrated via MCP protocol in container context

**Browser Automation:**
- **agent-browser** - Global npm package, Chromium-based
  - Executable path: `/usr/bin/chromium` in container (set via `AGENT_BROWSER_EXECUTABLE_PATH`)
  - Playwright backend: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env var
  - Features: Screenshots, PDFs, video recording, snapshot-based interaction with element references
  - Access: Available in `bash` command in containers

**GitHub Integration:**
- **GitHub CLI (`gh`)** - System binary in container
  - Available for Bash commands within containers
  - Enables: Repository operations, issue/PR management, release management

**Google Tasks:**
- **gtasks CLI** - System binary in container (version 0.12.0)
  - Binary location: `/usr/local/bin/gtasks`
  - Purpose: Command-line interface to Google Tasks
  - Access: Available for Bash commands within containers

## Data Storage

**Databases:**
- **SQLite** (embedded, file-based)
  - Location: `data/nanoclaw.db` (created at runtime)
  - Client: `better-sqlite3` 11.10.0 (synchronous)
  - Tables:
    - `chats` - Chat metadata (jid, name, last_message_time, channel, is_group flag)
    - `messages` - All messages from all chats (id, chat_jid, sender, content, timestamp, is_from_me, is_bot_message)
    - `scheduled_tasks` - Recurring/one-time tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status)
    - `task_run_logs` - Task execution history (task_id, run_at, duration_ms, status, result, error)
    - `router_state` - State persistence (key-value pairs: last_timestamp, last_agent_timestamp)
    - `sessions` - Claude session IDs per group folder (group_folder → session_id)
    - `registered_groups` - Group registration (jid → name, folder, trigger_pattern, containerConfig)

**File Storage:**
- **Local filesystem only**
  - Group folders: `groups/{name}/` for each registered group
  - Shared global folder: `groups/global/` for main-group-only shared memory
  - WhatsApp auth: `store/auth/` (multi-file credential storage from baileys)
  - IPC communication: `/workspace/ipc/` in containers (input, tasks, messages directories)

**Caching:**
- **None detected** - No external caching service, no Redis, no Memcached

## Authentication & Identity

**Auth Provider:**
- **Custom implementation** - No third-party auth service
  - WhatsApp: QR code authentication via `src/whatsapp-auth.ts`, credentials stored locally
  - Telegram: Bot token stored in `TELEGRAM_BOT_TOKEN` env var
  - Claude Agent SDK: Uses `sessionId` from database per group (auto-managed)

**Session Management:**
- Per-group Claude sessions stored in `sessions` table
- Session compaction handled by Claude Agent SDK automatically
- Sessions persist across container restarts via database

**Secrets Handling:**
- Environment variables loaded via `readEnvFile()` in `src/config.ts`
- Secrets NOT loaded at startup—only where needed (e.g., during container spawn)
- `.env` file never committed (in `.gitignore`)
- Mount security: `~/.config/nanoclaw/mount-allowlist.json` (outside project root, never mounted into containers)

## Monitoring & Observability

**Error Tracking:**
- Not detected - No Sentry, Rollbar, or equivalent
- Error logging via pino (structured JSON logs)

**Logs:**
- **Pino structured logging**
  - Format: JSON with context (group name, error details, message counts, etc.)
  - Pretty printing in terminal via `pino-pretty`
  - Rotation: Not configured (logs accumulate in `logs/` directory)
  - Log level: Configurable (debug, info, warn, error, fatal)

## CI/CD & Deployment

**Hosting:**
- Local macOS machine (primary)
  - Service management: launchd (`com.nanoclaw.plist`)
  - Alternative: Direct process execution via `ncm start` (node manager script)
- Potential Linux deployment (manual, not yet tested)

**CI Pipeline:**
- Not detected in codebase
- Minimal setup: `npm run build` compiles TypeScript
- Manual testing: `npm run test` runs vitest

**Container Build:**
- Docker (cross-platform)
  - Dockerfile: `container/Dockerfile`
  - Build script: `container/build.sh`
  - Image tag: `nanoclaw-agent:latest` (configurable via `CONTAINER_IMAGE` env var)
  - Build cache: Buildkit caches aggressively; `--no-cache` alone insufficient; requires `docker buildx prune`

## Environment Configuration

**Required env vars:**
- `ASSISTANT_NAME` - Trigger word prefix (default: "Nano")
- `TELEGRAM_BOT_TOKEN` - Telegram bot token (optional, disables Telegram if not set)
- `TELEGRAM_ONLY` - Skip WhatsApp, Telegram-only mode (default: false)

**Optional env vars:**
- `ASSISTANT_HAS_OWN_NUMBER` - Whether assistant has own phone number (boolean, default: false)
- `TELEGRAM_BOT_POOL` - Comma-separated bot tokens for Agent Swarms (optional)
- `CONTAINER_IMAGE` - Docker image name (default: "nanoclaw-agent:latest")
- `CONTAINER_TIMEOUT` - Agent execution timeout in ms (default: 1800000 = 30 min)
- `CONTAINER_MAX_OUTPUT_SIZE` - Max output size in bytes (default: 10485760 = 10 MB)
- `IDLE_TIMEOUT` - Keep container alive after last result in ms (default: 1800000 = 30 min)
- `MAX_CONCURRENT_CONTAINERS` - Max running agent containers (default: 5, min: 1)
- `POLL_INTERVAL` - Message loop poll interval in ms (default: 2000)
- `SCHEDULER_POLL_INTERVAL` - Task scheduler poll interval in ms (default: 60000)
- `IPC_POLL_INTERVAL` - IPC watcher poll interval in ms (default: 1000)
- `TZ` - Timezone for cron scheduling (system default if not set)

**Secrets location:**
- `.env` file (not committed, in `.gitignore`)
- `.env.example` exists (empty, reference only)
- Mount allowlist: `~/.config/nanoclaw/mount-allowlist.json` (outside project)

## Webhooks & Callbacks

**Incoming:**
- WhatsApp messages via baileys connection (polling, not webhooks)
- Telegram messages via grammy long-polling (not webhooks)
- IPC-based task scheduling (file system watchers, not webhooks)

**Outgoing:**
- Messages sent to registered groups via channels (WhatsApp or Telegram)
- Scheduled tasks can send messages back via `send_message` tool in container context
- No external webhook delivery

## MCP (Model Context Protocol) Servers

**Available in Container:**
- **nanoclaw MCP server** (custom, container-internal)
  - Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
  - Scope: Each container has isolated access to group-level tasks
  - Interface: IPC via `/workspace/ipc/` file system

**Global Tools (Claude Agent SDK built-in):**
- WebSearch
- WebFetch
- Bash (runs in container, safe due to OS-level isolation)

---

*Integration audit: 2026-02-27*
