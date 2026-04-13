# NanoClaw Scope Expansion: From Personal Assistant to AI Agent Framework

**Date:** 2026-04-13
**Status:** Design approved, pending implementation planning

## Vision

Evolve NanoClaw from a reactive single-threaded personal assistant into an async multi-agent runtime with parallel execution, browser automation, graduated autonomy, proactive monitoring, verification discipline, and self-learning — while preserving the architectural strengths (container isolation, channel registry, single-process orchestrator, OneCLI vault) that make it work today.

**Product trajectory:** Dogfood the expanded capabilities for personal use, then extract the framework as a self-hosted personal AI agent product (open source, bring-your-own-key). No framework in the market combines container isolation + multi-channel messaging + always-on ambient operation + graduated autonomy.

## Market Context

### Competitive Landscape (verified April 2026)

| Framework | Stars | Multi-Channel | Container Isolation | Always-On | Trust/Autonomy |
|-----------|-------|:---:|:---:|:---:|:---:|
| n8n | 184K | Via webhooks | No | Event-driven | No |
| Browser Use | 87.6K | No (library) | No | No | No |
| Mem0 | 52.9K | No (library) | No | No | No |
| OpenHands | 71.1K | Slack/Jira/Linear | Yes (containers) | No | Partial |
| Khoj | 34.1K | WhatsApp, Web, Obsidian | No | Yes | No |
| Letta | 22K | No | No | No | No |
| ElizaOS | 18.2K | Discord, Telegram, Farcaster | No | Partial | Weak |
| ForgeAI | 8 | 8 channels | Docker sandbox | Yes | Static RBAC |
| CoWork-OS | 215 | 17 channels claimed | E2B optional | Yes | Approval workflows |
| **NanoClaw** | — | 6 channels + Gmail | **Per-group containers** | **Yes** | **Train-then-trust (planned)** |

### NanoClaw's Differentiation

1. **Per-group agent isolation** — entire agent sessions run in containers with dedicated filesystems, not just code sandboxing
2. **Train-then-trust autonomy** — no framework has adaptive permission escalation from approval patterns
3. **Outcome-based learning** — no memory system tracks what worked and adjusts behavior accordingly
4. **Claude Agent SDK native** — no other project runs the SDK inside containers with per-group isolation

### Closest Competitor: ForgeAI

ForgeAI (8 stars, single developer, 414 commits) is architecturally closest — TypeScript, 8 channels (including WhatsApp/Telegram/Discord/Slack via Baileys), Docker sandbox, multi-LLM. Key differences: ForgeAI sandboxes code execution; NanoClaw isolates entire agent sessions. ForgeAI uses static RBAC; NanoClaw plans adaptive trust. ForgeAI is ahead on dashboard UI and security features (prompt injection scanning, exfiltration prevention).

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Channels                          │
│  WhatsApp · Telegram · Signal · Slack · Discord ·   │
│  Gmail · (future: web UI, CLI, API)                 │
├─────────────────────────────────────────────────────┤
│              Message Router (async)                 │
│  Inbound dispatch · Outbound formatting · Priority  │
├──────────┬──────────────────────────────────────────┤
│ Executor │  Parallel container pool                 │
│ Pool     │  Long-lived browser sessions             │
│          │  Task queue with concurrency control     │
├──────────┼──────────────────────────────────────────┤
│ Trust    │  Action classification (read/write/risk) │
│ Engine   │  Per-domain autonomy levels              │
│          │  Approval routing · Audit log            │
├──────────┼──────────────────────────────────────────┤
│ Monitor  │  Event bus (email, calendar, services)   │
│ & Proact │  Proactive task generation               │
│          │  Scheduled + event-driven triggers       │
├──────────┼──────────────────────────────────────────┤
│ Verify   │  Source cross-referencing                │
│ Pipeline │  Confidence scoring · Uncertainty flags  │
│          │  "Check before asserting" discipline     │
├──────────┼──────────────────────────────────────────┤
│ Learning │  Global knowledge graph (cross-group)    │
│ System   │  Decision pattern tracking               │
│          │  Skill acquisition & replay              │
├──────────┴──────────────────────────────────────────┤
│              Foundation                             │
│  OneCLI Vault · Container Isolation · SQLite ·      │
│  Group/Context Model · Channel Registry             │
└─────────────────────────────────────────────────────┘
```

### What stays the same

- Channel registry pattern (self-registration, factory functions)
- Container isolation (OS-level, not application sandboxing)
- OneCLI credential vault
- Group model with per-group contexts
- Single Node.js process (the orchestrator), containers for execution
- Skill-based extensibility

### Key architectural shifts

- Message loop becomes async with a task queue (not blocking single-thread)
- Containers can be long-lived (browser sessions) or ephemeral (quick tasks)
- Memory expands from per-group CLAUDE.md to a queryable knowledge store, with CLAUDE.md remaining as the agent-facing interface
- New event bus replaces polling-only model
- Trust engine sits between "agent wants to do X" and "X actually happens"

## Layer 1: Parallel Execution Engine

### Problem

Single-threaded message loop. One container runs at a time. 5 messages = message 5 waits for 1-4 to complete.

### Design

```
Inbound messages
     │
     ▼
┌─────────────┐
│  Task Queue  │  Priority-ordered, per-group fairness
│  (in-memory) │  
└──────┬──────┘
       │
       ▼
┌──────────────────────────────────┐
│       Executor Pool              │
│  ┌─────┐ ┌─────┐ ┌─────┐       │
│  │ Slot │ │ Slot │ │ Slot │ ... │  Configurable concurrency (default: 3)
│  │  1   │ │  2   │ │  3   │     │
│  └──┬──┘ └──┬──┘ └──┬──┘       │
│     │       │       │           │
│  Container Container Container  │
└──────────────────────────────────┘
```

### Key behaviors

- **Concurrency limit** — configurable max simultaneous containers (default 3, tunable based on machine resources)
- **Per-group fairness** — one group can't starve others. Round-robin across groups when multiple are queued
- **Priority levels** — interactive messages > scheduled tasks > proactive tasks
- **Long-lived containers** — browser sessions and multi-turn tasks keep their container alive instead of cold-starting each time
- **Progress routing** — each slot streams progress messages back to the originating channel in real-time

### Codebase changes

- `src/index.ts` message loop becomes async dispatcher (enqueue, not execute)
- New `src/executor-pool.ts` manages container lifecycle and concurrency
- `src/container-runner.ts` gains support for persistent containers (not just ephemeral)
- Task queue is in-memory with SQLite persistence for crash recovery

## Layer 2: Browser Runtime

### Problem

NanoClaw can't interact with web services. Can't log into Alto, can't check health portals, can't automate anything that requires a browser.

### Design

Adopt **Browser Use** (87.6K stars) + **Playwright MCP** as proven libraries. Don't build browser automation from scratch.

```
Agent in Container ──▶ Browser Session (Playwright/Chromium)
  Claude SDK              - Persistent login
  + browser-use           - Cookie storage
  library                 - Screenshot capture
```

### Key design decisions

- **Browser sessions are long-lived, not per-invocation.** Login persists across agent invocations.
- **Per-group browser profiles.** Each group gets its own cookie jar and browser state — isolation extends to the browser.
- **Browser runs inside the container.** Not on the host. Maintains the security model.
- **Screenshot-based feedback.** Agent takes screenshots and uses vision to understand page state.
- **Cookie import from real browser.** For initial authentication, import cookies from Chrome session (existing `/setup-browser-cookies` skill pattern).

### Codebase changes

- Container image gains Chromium + Browser Use + Playwright
- New `container/skills/browser-session/` manages persistent browser profiles
- Browser profile storage in `groups/{name}/browser/` (persists across invocations)
- Container runner mounts browser profile directory into containers

## Layer 3: Trust & Autonomy Engine

### Problem

Every action requires user intervention. No adaptive autonomy. Static permission model.

### Design: Train-then-trust

1. **Cold start** — everything asks for approval
2. **Pattern recognition** — after N consecutive approvals of the same action class (configurable, default: 5), confidence crosses threshold
3. **Graduation** — agent stops asking, executes silently, logs to audit trail
4. **Decay** — denial drops confidence. Trust is easy to lose, slow to rebuild
5. **Revocation** — "stop doing X without asking" resets to cold start

### Action classification taxonomy

| Domain | Read (low risk) | Write (medium risk) | Transact (high risk) |
|--------|:---:|:---:|:---:|
| **Info** | Web search, check weather | — | — |
| **Comms** | Read email/messages | Send message, reply | — |
| **Health** | Check refill status | Request refill | — |
| **Finance** | Check balance | — | Transfer, pay bill |
| **Code** | Read files, search | Edit files, commit | Push, deploy |
| **Services** | Check account status | Change settings | Create/cancel account |

High-risk "transact" actions have a higher threshold (e.g., 20 approvals) or can be configured to never auto-execute.

### Data model

```sql
CREATE TABLE trust_actions (
  id INTEGER PRIMARY KEY,
  action_class TEXT,      -- 'health.read', 'comms.write', etc.
  domain TEXT,
  operation TEXT,
  description TEXT,       -- human-readable
  decision TEXT,          -- 'approved', 'denied', 'auto'
  outcome TEXT,           -- 'success', 'failure', null
  group_id TEXT,
  timestamp DATETIME
);

CREATE TABLE trust_levels (
  action_class TEXT PRIMARY KEY,
  approvals INTEGER,
  denials INTEGER,
  confidence REAL,        -- 0.0 to 1.0
  threshold REAL,         -- configurable per class
  auto_execute BOOLEAN,
  last_updated DATETIME
);
```

### Action classification mechanism

The agent self-classifies each tool use via system prompt instruction: "Before executing any tool, classify the action as {domain}.{operation} using the taxonomy above and include the classification in your tool call metadata." The orchestrator validates the classification against known tool-to-class mappings (e.g., `send_message` is always `comms.write`) and overrides if the agent misclassifies. No separate LLM call needed — the mapping table handles the common cases, the agent handles novel actions.

### User controls

- `@Andy trust status` — shows current trust levels per domain
- `@Andy never auto-execute [action class]` — permanent manual gate
- `@Andy reset trust` — cold start everything
- Denying any action immediately recalculates confidence

### Codebase changes

- New `src/trust-engine.ts` — classification, evaluation, confidence tracking
- New DB tables in `src/db.ts`
- Container agent's tool-use hooks route through trust evaluation before execution
- Approval prompts sent back through the originating channel

## Layer 4: Proactive Monitor & Event Bus

### Problem

NanoClaw is purely reactive. No ability to watch for events and initiate action.

### Design

```
Event Sources                    Event Bus                    Actions
┌──────────┐                  ┌──────────┐
│ Gmail SSE │──────────────▶  │          │──▶ Notify user
├──────────┤                  │  Event   │──▶ Spawn agent task
│ Calendar  │──────────────▶  │  Router  │──▶ Queue for approval
├──────────┤                  │          │     (via trust engine)
│ Browser   │──────────────▶  │          │
│ watchers  │                 └──────────┘
├──────────┤                       ▲
│ Scheduled │──────────────────────┘
│ checks    │
├──────────┤
│ Webhook   │
│ endpoint  │
└──────────┘
```

### Event sources

| Source | Status | What it watches |
|--------|--------|-----------------|
| Gmail SSE | Already built | New emails across 4 accounts |
| Calendar polling | New — poll Google Calendar API every 5 min | Upcoming meetings, changes |
| Browser watchers | New — scheduled browser sessions that diff page state | Alto refill status, any configured web service |
| Scheduled checks | Already built (task-scheduler) | Cron-based tasks |
| Webhook endpoint | New — HTTP endpoint accepting external events | GitHub webhooks, Notion changes, custom integrations |

### Event routing rules

Configurable per group in `groups/{name}/events.json`:

```json
{
  "rules": [
    {
      "source": "gmail",
      "match": { "from": "*@alto.com" },
      "action": "notify",
      "channel": "telegram",
      "priority": "high"
    },
    {
      "source": "calendar",
      "match": { "minutes_before": 30 },
      "action": "spawn_task",
      "prompt": "Prepare a briefing for this meeting: {event.summary}"
    },
    {
      "source": "browser_watcher",
      "match": { "watcher": "alto-refill" },
      "action": "notify_and_offer",
      "prompt": "Your {medication} refill is ready. Want me to reorder?"
    }
  ]
}
```

### Key design decisions

- Events are lightweight — the bus just routes. Heavy work is delegated to the executor pool.
- Events flow through the trust engine — proactive actions need approval until trust is earned.
- Budget ceiling applies — proactive tasks count against daily cost limit.
- Quiet hours — configurable "don't bother me" windows. Events queue and deliver as digest.
- Dedup — same event won't trigger twice.

### Codebase changes

- New `src/event-bus.ts` — event ingestion, matching, routing
- New `src/watchers/` — calendar poller, browser watcher, webhook server
- Existing `src/task-scheduler.ts` emits events into the bus
- Existing Gmail SSE feeds into the event bus
- Event rules stored per-group in `groups/{name}/events.json`

## Layer 5: Verification Pipeline

### Problem

Agent sometimes states guesses as facts. With more autonomy, wrong actions become costly.

### Design: Three verification stages, proportional to risk

**Stage 1 — Self-check (system prompt discipline, always runs, zero cost)**

Injected into agent system prompt: "Before stating any fact, classify it as KNOWN (from a tool result you just received), REMEMBERED (from memory/context), or INFERRED (your reasoning). Mark INFERRED claims explicitly."

**Stage 2 — Source cross-reference (runs for factual claims, minimal cost)**

Post-processing that compares the agent's output against raw tool results in the conversation. Catches misread data, hallucinated numbers, invented details.

**Stage 3 — Pre-action validation (runs before write/transact, ~$0.001 per check)**

A cheap, fast LLM call (Haiku) compares the user's request against the proposed action: "The user asked for X. You are about to do Y. Confirm these match." Catches wrong recipient, wrong amount, wrong account, action drift.

### Confidence signals in responses

```
✓ Verified: "Your Alto refill for Lisinopril is ready" 
  (source: browser check of alto.com, 2 min ago)

~ Unverified: "I think your next appointment is Thursday"
  (source: memory from last conversation, not confirmed)

? Unknown: "I'm not sure if MyChart supports automated refills"
  (no source available)
```

### Codebase changes

- Updated container agent system prompt with self-check discipline
- New `src/verification.ts` — source cross-reference, pre-action validation
- Pre-action validation hooks into trust engine
- Confidence markers added to response formatting in `src/router.ts`

## Layer 6: Learning System

### 6A: Compounding Memory

Three-tier architecture:

| Tier | What | Storage | Scope |
|------|------|---------|-------|
| **1. Hot Memory** | Per-group CLAUDE.md (existing) | Filesystem | Group |
| **2. Global Knowledge** | Cross-group facts, preferences, patterns | SQLite + Mem0 | All groups |
| **3. Outcome Store** | Action results, user feedback | SQLite | All groups |

- **Tier 1** stays as-is — per-group CLAUDE.md files
- **Tier 2** adopts **Mem0** as the recall engine. Extracts facts from conversations, stores queryable. Runs locally (SQLite-backed). Agent sessions query at startup.
- **Tier 3** is novel — the outcome store. Every action logged with result.

### 6B: Outcome Tracking

```sql
CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY,
  action_class TEXT,        -- 'health.read.alto_refill_check'
  action_description TEXT,
  method TEXT,              -- 'browser', 'api', 'tool'
  input_summary TEXT,
  result TEXT,              -- 'success', 'failure', 'partial'
  error TEXT,
  user_feedback TEXT,       -- 'positive', 'negative', 'neutral', null
  duration_ms INTEGER,
  cost_usd REAL,
  group_id TEXT,
  timestamp DATETIME
);
```

What feeds into outcomes:
- Trust engine logs every action decision
- Container runner logs success/failure
- User reactions parsed as implicit feedback
- Explicit feedback: `@Andy that was wrong` / `@Andy good job`

What outcomes feed into:
- **Trust engine** — success rate informs confidence. Failures reduce trust.
- **Method selection** — prefer methods with higher success rates
- **Proactive timing** — schedule actions at times with best success history

### 6C: Skill Acquisition

Learned procedures stored as replayable guidance:

```json
{
  "name": "alto_refill_reorder",
  "trigger": "user asks to reorder a prescription on Alto",
  "learned_from": "2026-04-13 conversation in telegram_main",
  "steps": [
    "Open browser session with Alto profile",
    "Navigate to alto.com/dashboard",
    "Click 'Medications' tab",
    "Find the requested medication",
    "Click 'Request Refill'",
    "Confirm the refill request",
    "Report result to user"
  ],
  "success_rate": "3/3",
  "last_used": "2026-04-15",
  "auto_execute": false
}
```

Key constraints:
- Procedures are **guidance, not macros** — agent adapts when pages change
- Procedures go through the **trust engine** — new procedures start as manual-approval
- Stored in `groups/{name}/procedures/` or `store/procedures/` (global)
- Agent suggests saving: "That worked well. Want me to remember how to do this?"

### Codebase changes

- Integrate Mem0 for Tier 2 memory
- New `src/memory/` directory — outcome store, memory query layer, procedure storage
- New DB tables in `src/db.ts` for outcomes and procedures
- Container agent system prompt updated to query Mem0 at session start and log outcomes at session end
- Procedure files in `store/procedures/` and `groups/{name}/procedures/`

## Build Order

| # | Layer | What it delivers | Depends on | Est. AI dev time |
|---|-------|-----------------|------------|-----------------|
| 1 | Parallel Execution | Multiple tasks simultaneously | — | 1-2 days |
| 2 | Browser Runtime | Universal web connector | Layer 1 (long-lived containers) | 1-2 days |
| 3 | Trust Engine | Graduated autonomy | — | 1-2 days |
| 4 | Proactive Monitor | Agent-initiated actions | Layers 1 + 3 | 2-3 days |
| 5 | Verification Pipeline | Anti-hallucination | — | 1 day |
| 6 | Learning System | Gets smarter over time | Layers 3 + 5 | 2-3 days |

**Total estimated AI dev time: 2-3 weeks**

## Product Positioning (for future extraction)

**Tagline:** "The personal AI agent that earns your trust."

**Value prop:** Self-hosted, multi-channel AI agent with real container isolation and graduated autonomy. Bring your own API key. Connect your messaging apps. Start supervised, earn autonomous.

**Differentiators vs. market:**
1. Per-group container isolation (vs. ForgeAI's code sandbox, vs. ElizaOS's no isolation)
2. Train-then-trust autonomy (vs. everyone else's static permissions)
3. Outcome-based learning (vs. Mem0/Letta's recall-only memory)
4. 6+ messaging channels with always-on ambient operation

**For extraction (later, not now):**
- Separate framework config from personal config
- Replace hardcoded `@Andy` trigger with configurable assistant name
- Replace personal Google account routing with generic OAuth framework
- Package as `npx create-nanoclaw` or Docker image
- Write getting-started docs, example configurations
