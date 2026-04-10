# Nexus Feature Roadmap

Features discussed, planned, or prototyped — listed without timelines or priority weighting.

## Channels & Messaging

- **Discord context tool** — MCP or custom tool for the agent to query Discord metadata on demand (channel list, member roles, message history, server info)
- **WhatsApp channel** — NanoClaw reference code exists. Baileys (QR pairing) for dev, Business API (webhooks) for production
- **Resend email channel** — Inbound/outbound email for supplier communications
- **Gmail channel** — Alternative email channel, developed alongside Resend
- **Channel-aware message formatting** — Strip `<internal>` tags, format differently per channel (Discord markdown, Slack mrkdwn, WhatsApp plain)
- **Bot message detection** — Track `is_bot_message` flag to prevent echo loops in group chats
- **Typing indicators** — Show typing state in channels while agent processes

## Agent Capabilities

- **Scheduled tasks (cron)** — Agents schedule recurring or one-time tasks. Script pre-check to decide whether to wake agent. NanoClaw `task-scheduler.ts` as reference
- **Message batching & cursor management** — Batch multiple messages per prompt, track per-chat cursor, rollback on error
- **Conversation archiving (pre-compact hook)** — Archive full transcript as markdown before Agent SDK compacts context
- **Agent-to-agent IPC** — Agents send messages to other channels, schedule tasks, manage groups via MCP tools
- **Sender allowlist** — Control who can trigger the agent per channel/group
- **XML-formatted message context** — Structured prompts with sender, timestamp, reply chains, quoted content

## Persistence & Infrastructure

- **Fly Volume for store** — Phase 2 of persistence: add `store` process group to fly.toml with Fly Volume
- **Tigris + Postgres backing** — Phase 3: swap store's FilesystemBackend for Tigris (blobs) + Postgres (queryable index)
- **Agent SDK session JSONL persistence** — Sync JSONL files to/from store so conversation history survives deploys
- **Session cleanup & stale detection** — Detect and clear stale Agent SDK sessions, periodic cleanup of old data
- **Task run logging** — Track scheduled task execution history (duration, status, result)

## Console

- **Conversation browser** — Browse archived conversation transcripts, filter by channel/date
- **Approvals page** — Human-gated outbound email: approve/reject/edit pending messages
- **Console chat improvements** — Session continuity indicator, message history across page reloads
- **Real-time activity** — SSE or WebSocket for live activity feed instead of page-refresh

## Skills & Knowledge

- **Email triage skill** — Categorise inbound email: supplier, spam, misdirected, enquiry
- **Polite rejection skill** — Draft "sorry, can't help" responses for misdirected mail
- **Supplier comms skill** — Handle ongoing supplier conversations
- **Axle invoice skill** — Process monthly battery payment invoices
- **Flux status skill** — Query Flux dispatch status, recent trades (when Flux provisioned)
- **Flows data skill** — Query Flows meter data, check data gaps (when Flows provisioned)
- **Spark broadcast skill** — Draft and queue customer broadcast emails (when Spark provisioned)

## Memory

Agent memory beyond session context — persistent, shared, decaying learnings across conversations.

### Research Completed
- Generative Agents (Stanford): three-factor scoring (recency × importance × relevance), 0.995^hours decay
- Ebbinghaus forgetting curve: exponential decay with recall reinforcement (spacing effect)
- MemGPT/Letta: structural forgetting (FIFO + recursive summarization)
- LangChain TimeWeighted: configurable half-life decay
- Mem0: LLM-driven ADD/UPDATE/DELETE/NOOP, graph memory
- Production consensus: `score = 0.5×similarity + 0.3×recency + 0.2×importance`, 30-day half-life default

### Service Evaluation (next session)
- **Mem0 vs Supermemory head-to-head** — both $19/mo hosted, need usage analysis per-operator
- Usage modelling: will per-operator Nexus instances fit within free/starter tiers?
- Self-hosted viability: Mem0 OSS on Fly.io with Deno, vs Supermemory Enterprise
- Feature gaps: which has better decay, importance scoring, privacy controls?
- TypeScript/Deno SDK quality comparison
- MCP server availability (Mem0 has one, does Supermemory?)

### Architecture Questions
- **Boundary**: What stays as baked-in image knowledge (ROM) vs what becomes memories?
  - Current skills/knowledge files could be broken into discrete memories loaded via a "training" process
  - ROM = instructions (how to behave). Memory = facts (what you've learned)
  - Training process: on deploy, load knowledge/*.md as seed memories into the memory service
- **Privacy model**: billing conversations marked private, never enter shared memory
- **Multi-channel memory**: agent learns something in Discord, recalls it in web-chat
- **Memory scoping**: operator-wide shared memory vs per-session private memory
- **Concurrency control**: group queue (NanoClaw pattern) needed before memory at scale

## Security & Credentials

- **OneCLI proxy for service channels** — Discord/Resend credentials routed through OneCLI Cloud proxy
- **Per-operator OneCLI agents** — Separate OneCLI agent identities for each operator
- **Mount security allowlist** — Validate additional data source access per group/agent

## Platform

- **Managed Agents migration path** — When Anthropic Managed Agents exits beta and supports file uploads, evaluate replacing the agent process
- **Trigger.dev integration** — Evaluate for scheduled tasks with checkpoint/resume and built-in retries
- **Claude Code channels compatibility** — Align with Claude Code channel pattern (MCP push model) when available for API auth
- **Multi-operator fleet dashboard** — Cross-operator health, version comparison, deployment status
- **Operator self-service onboarding** — Provision script for new operators (Fly app + Tigris + Discord bot)

## Developer Experience

- **Conversation replay** — Replay past sessions for debugging
- **Hot reload for skills/knowledge** — Detect changes to skills/ and knowledge/ without restart
- **Test framework** — Deno test suite for store, gateway, agent modules
- **CI/CD pipeline** — GitHub Actions for type-check, test, deploy to fleet
