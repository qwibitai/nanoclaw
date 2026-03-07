# Hal Runtime — Specification

_Forked from NanoClaw. A personal AI runtime with per-turn memory recall, multi-model routing, and deep integration with Command Center._

## Overview

Hal Runtime is a personal AI assistant runtime built on the Claude Agent SDK. It replaces OpenClaw as Hal's primary runtime, giving full control over the agent loop — critical for per-turn memory injection, custom context budgeting, and deep thinking sessions.

## Architecture

```
WhatsApp → SQLite queue → Message Loop → Container (Claude Agent SDK) → Response
                                ↑
                        Hippocampus API (per-turn memory recall)
                                ↑
                        CC Webhooks (task notifications)
```

Single Node.js process on host. Agents execute in isolated Linux containers via Apple Container or Docker. IPC via filesystem.

### Key Differences from NanoClaw

1. **Per-turn Hippocampus recall** — Before every agent invocation, query Hippocampus for relevant memories and inject into system prompt
2. **Multi-model routing** — Main session uses Opus, heartbeat/hooks use Sonnet
3. **CC integration** — Webhook receiver for task_notification, task_review_ready, task_failed events
4. **Existing tool ecosystem** — gog CLI, cc CLI, Twilio, Sentinel APIs
5. **Workspace mounting** — `~/.openclaw/workspace/` for SOUL.md, AGENTS.md, MEMORY.md, daily notes

## Components

### Message Loop (src/index.ts)

- Polls SQLite for new messages
- Resolves memory context via Hippocampus before agent invocation
- Routes to appropriate model based on session type
- Handles CC webhook events as system messages

### Hippocampus Middleware (src/hippocampus.ts) — NEW

- On each inbound message: extract query terms from message + recent context
- Call Hippocampus embedding API to find relevant memories
- Score and rank using 5-factor model (similarity, importance, recency, emotional, retrieval)
- Inject top-K memories into system prompt (budget: ~4K tokens)
- On session end: extract episodes for consolidation

### CC Webhook Receiver (src/cc-hooks.ts) — NEW

- HTTP endpoint for CC task lifecycle events
- Endpoint: `POST /hooks/cc`
- Validates `x-cc-webhook-token` / bearer token against runtime config
- Routes events to appropriate session (main vs hook)
- Events: task_notification, task_review_ready, task_failed, pipeline_stalled, release_closed
- `task_review_ready` / `task_failed` create synthetic system messages in the hook session and trigger agent review/investigation flow
- `pipeline_stalled` / `release_closed` send WhatsApp alerts/summaries to Adam

### Session Management

- **main** — Opus, Adam-facing, only wakes for DMs + critical events
- **heartbeat** — Sonnet, 30-min cron, read-only monitoring
- **hooks** — Sonnet, CC task reviews and deploy notifications

### Deep Thinking Sessions — NEW

- 2x daily scheduled tasks (10 AM, 6 PM PT)
- High reasoning effort (extended thinking)
- Seeded with: relevant memories, current task board state, recent decisions
- Output: proposals, task creation, MEMORY.md updates

## Configuration

No config files — code changes only (NanoClaw philosophy). Key constants in `src/config.ts`:

- `ASSISTANT_NAME` — "Hal"
- `NO_TRIGGER_REQUIRED_IN_DMS` — true (always respond in DMs, trigger still required in groups unless overridden)
- `TIMEZONE` — "America/Los_Angeles"
- `OPENCLAW_AUTH_DIR` — `~/.openclaw/store/auth` (reuse existing WhatsApp credentials)
- `HAL_WORKSPACE_DIR` — `~/.openclaw/workspace` (mount SOUL.md, AGENTS.md, MEMORY.md)
- `HAL_ALLOWED_WHATSAPP_SENDER` — `19493969849@s.whatsapp.net` (Adam allowlist)
- `HIPPOCAMPUS_BUDGET_TOKENS` — 4096
- `HIPPOCAMPUS_TOP_K` — 10
- `DEEP_THINKING_SCHEDULE` — ["10:00", "18:00"]
- `CC_WEBHOOK_TOKEN` — shared secret for Command Center webhook authentication
- `CC_WEBHOOK_URL` — full runtime URL for Command Center to post events (`.../hooks/cc`)
- `CC_HOOKS_GROUP_JID` — target group/session for synthetic hook messages
- `CC_HOOKS_MODEL` — `sonnet` for webhook-driven hook session execution
- `ADAM_WHATSAPP_JID` — Adam's WhatsApp JID for critical CC alerts

## Migration Plan

### Phase 1: WhatsApp Parity

- Wire WhatsApp channel with existing credentials
- Mount workspace for personality files
- Wire existing tools (exec, web, gog, cc)
- Run alongside OpenClaw (different trigger or hot-switchover)
- Reproducible runtime verification:
  - `npm run test:whatsapp-runtime` (boots WhatsApp channel test harness, verifies connect + inbound DM + response)

### Phase 2: Hippocampus Integration

- Build hippocampus.ts middleware
- Per-turn memory injection in agent loop
- Episode extraction on session boundaries

### Phase 3: Full Migration

- CC webhook integration
- Deep thinking sessions
- Multi-model routing
- Decommission OpenClaw

## Data

- **SQLite** — Message queue, session state, task schedules
- **Workspace** — `~/.openclaw/workspace/` (SOUL.md, AGENTS.md, MEMORY.md, memory/\*.md)
- **Hippocampus** — Embedding store + episode database (existing)
- **Groups dir** — Per-chat isolated filesystems

## Security

- Agents run in Linux containers (filesystem isolation)
- Only explicitly mounted directories are accessible
- Host tools (cc, gog, docker) available via mounted binaries or MCP
- WhatsApp sender allowlist for access control
