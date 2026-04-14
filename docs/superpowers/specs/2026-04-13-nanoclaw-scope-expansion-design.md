# NanoClaw Scope Expansion: From Personal Assistant to AI Agent Framework

**Date:** 2026-04-13
**Status:** Revised after CEO review. Pending eng review + implementation planning.
**CEO Review:** SCOPE EXPANSION mode. 9 proposals, 8 accepted, 1 deferred (LLM abstraction).

## Vision

Evolve NanoClaw from a reactive single-threaded personal assistant into an event-driven multi-agent runtime with parallel execution, browser automation, graduated autonomy, proactive monitoring, verification discipline, and self-learning — while preserving the architectural strengths (container isolation, channel registry, single-process orchestrator, OneCLI vault) that make it work today.

**Product trajectory:** Dogfood the expanded capabilities for personal use, then extract the framework as a self-hosted personal AI agent product (open source, bring-your-own-key). No framework in the market combines container isolation + multi-channel messaging + always-on ambient operation + graduated autonomy.

**The 10x vision:** A personal AI that runs your digital life. Not just reactive + proactive, but an integrated intelligence that maintains a complete mental model of your world. It surfaces a daily brief: "Here's what matters today, here's what I've already handled, here's what needs your decision."

## Market Context

NanoClaw's differentiation (verified via live GitHub data, April 2026):

1. **Per-group agent isolation** — entire agent sessions run in containers with dedicated filesystems, not just code sandboxing
2. **Train-then-trust autonomy** — no framework has adaptive permission escalation from approval patterns
3. **Outcome-based learning** — no memory system tracks what worked and adjusts behavior accordingly
4. **Claude Agent SDK native** — no other project runs the SDK inside containers with per-group isolation

Closest competitor: **ForgeAI** (8 stars, 8 channels, Docker sandbox, multi-LLM). Key difference: ForgeAI sandboxes code execution; NanoClaw isolates entire agent sessions. ForgeAI uses static RBAC; NanoClaw implements adaptive trust.

Full competitive analysis: see CEO plan at `~/.gstack/projects/topcoder1-nanoclaw/ceo-plans/2026-04-13-scope-expansion.md`.

## Architecture Overview

### Event-Driven Core (CEO review decision)

The event bus is the system backbone, not a monitoring layer. All inter-layer communication flows through events. This provides clean layer separation, testability (mock events), and extensibility (new layers subscribe without modifying existing code).

```
                    ┌─────────────────────┐
                    │   Event Bus (core)   │
                    │   Node EventEmitter  │
                    └──────────┬──────────┘
                               │
        ┌──────────┬──────────┼──────────┬──────────┐
        ▼          ▼          ▼          ▼          ▼
   ┌─────────┐ ┌────────┐ ┌───────┐ ┌────────┐ ┌────────┐
   │Channels │ │Executor│ │ Trust │ │Verify  │ │Learning│
   │Registry │ │ Pool   │ │Engine │ │Pipeline│ │System  │
   └────┬────┘ └───┬────┘ └───┬───┘ └───┬────┘ └───┬────┘
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
   message.*   task.*    trust.*    verify.*   learn.*
   (inbound,   (queued,  (request,  (check,    (outcome,
    outbound)   started,  approved,  passed,    procedure,
               complete)  denied)    failed)    feedback)
```

**Internal event schema:**

```typescript
interface NanoClawEvent {
  type: string;           // e.g., 'message.inbound', 'trust.request', 'task.complete'
  source: string;         // layer that emitted: 'channel', 'executor', 'trust', etc.
  groupId?: string;       // which group context
  timestamp: number;
  payload: Record<string, unknown>;
}
```

**Migration strategy:** Build in a worktree branch. Write comprehensive tests against old behavior (GroupQueue, polling loop). Rewrite to events. Verify new implementation matches old behavior. Swap. The migration is ~500 LOC, ~1 day of AI dev.

### What stays the same

- Channel registry pattern (self-registration, factory functions)
- Container isolation (OS-level, not application sandboxing)
- OneCLI credential vault
- Group model with per-group contexts
- Single Node.js process (the orchestrator), containers for execution
- Skill-based extensibility

### Key architectural shifts

- Polling loop + GroupQueue replaced by event-driven dispatcher
- Containers can be long-lived (browser sessions) or ephemeral (quick tasks)
- Memory expands from per-group CLAUDE.md to a queryable knowledge store
- Trust engine intercepts write/transact actions via MCP gateway
- Browser runs as a sidecar container, not inside agent containers

## Layer 0: Event Bus (Foundation)

The event bus is built first. All subsequent layers emit and consume events.

**Implementation:** Node.js `EventEmitter` with typed event names. Synchronous within the single process. Each layer registers handlers at startup.

**Event flow for a typical message:**

```
message.inbound → executor.task.queued → executor.task.started
    → trust.request (if write/transact tool called via MCP)
    → trust.approved / trust.denied
    → verify.pre_action (if write/transact)
    → verify.passed / verify.failed
    → executor.task.complete
    → learn.outcome (logged)
    → message.outbound (response sent to channel)
```

**Error handling:** Event handlers that throw are caught, logged with full context, and do not crash the bus. The bus emits a `system.error` event for observability.

**Codebase changes:**
- New `src/event-bus.ts` — typed EventEmitter wrapper with error boundary
- `src/index.ts` refactored: polling loop → event-driven dispatcher
- `src/group-queue.ts` → replaced by event-based task queue in executor pool

## Layer 1: Parallel Execution Engine

### Problem

Single-threaded message loop. One container runs at a time.

### Design

```
message.inbound event
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
│  │ Slot │ │ Slot │ │ Slot │      │  Configurable concurrency (default: 3)
│  │  1   │ │  2   │ │  3   │      │
│  └──┬──┘ └──┬──┘ └──┬──┘       │
│     │       │       │           │
│  Container Container Container  │
└──────────────────────────────────┘
```

### Key behaviors

- **Concurrency limit** — configurable max simultaneous containers (default 3, tunable)
- **Per-group fairness** — strict round-robin within each priority level when multiple groups are queued. Interactive messages always preempt scheduled/proactive tasks regardless of group.
- **Priority levels** — interactive messages > scheduled tasks > proactive tasks
- **Warm pool** — 1-2 pre-started idle containers ready to accept tasks instantly (eliminates cold start). Idle timeout: configurable (default 10 min). Auto-recreated when used. Resource budget: max 2 warm containers, each ~200MB RAM.
- **Progress routing** — each slot streams progress messages back to the originating channel in real-time

### Codebase changes

- `src/index.ts` refactored to event-driven dispatcher
- New `src/executor-pool.ts` manages container lifecycle, warm pool, and concurrency
- `src/container-runner.ts` gains support for persistent and warm containers
- Task queue is in-memory with SQLite persistence for crash recovery

## Layer 2: Browser Runtime

### Problem

NanoClaw can't interact with web services.

### Design: Browser Sidecar via CDP (CEO review decision)

Agent containers stay lightweight. A separate Chromium container runs as a sidecar. Agent containers connect via Chrome DevTools Protocol (CDP).

```
┌─────────────────┐     CDP      ┌──────────────────┐
│ Agent Container  │────────────▶│ Browser Sidecar   │
│                  │             │                    │
│ Claude SDK       │             │ Chromium           │
│ + browser-use    │             │ Per-group contexts │
│ + playwright     │             │ (cookie isolation) │
└─────────────────┘             └──────────────────┘
         │                               │
         ▼                               ▼
  groups/{name}/                  Shared container,
  (agent workspace)               separate browser
                                  contexts per group
```

### Key design decisions

- **Sidecar architecture** — one shared Chromium container, separate browser contexts (profiles) per group. Docker Compose orchestrates networking.
- **Browser sessions are long-lived.** Login persists across agent invocations via per-group browser contexts.
- **Per-group isolation maintained** — each group gets its own browser context (cookie jar, local storage). No cross-group data leakage.
- **Browser profile encryption at rest** — AES-256 encryption of profile directories. OneCLI vault stores the encryption key. Decrypted only when mounted into the browser sidecar. Protects authenticated sessions for health/finance portals.
- **Screenshot-based feedback** — agent takes screenshots and uses vision to understand page state.
- **Cookie import from real browser** — for initial authentication, import cookies from Chrome session (existing `/setup-browser-cookies` skill pattern).
- **Resource limits** — max 3 concurrent browser contexts active. Chromium sidecar ~400MB RAM.

### Codebase changes

- New `docker-compose.yml` (or extend existing) with browser sidecar service
- Agent container image stays lightweight (no Chromium)
- New `container/skills/browser-session/` manages CDP connections and browser contexts
- Browser profile storage in `groups/{name}/browser/` (encrypted at rest)
- Container runner connects agent containers to browser sidecar network

## Layer 3: Trust & Autonomy Engine

### Problem

Every action requires user intervention. No adaptive autonomy.

### Design: Train-then-trust

1. **Cold start** — everything asks for approval
2. **Pattern recognition** — after N consecutive approvals of the same action class (configurable, default 5), confidence crosses threshold
3. **Graduation** — agent stops asking, executes silently, logs to audit trail
4. **Decay** — denial drops confidence. Trust is easy to lose, slow to rebuild
5. **Revocation** — "stop doing X without asking" resets to cold start

### MCP Trust Gateway (CEO review decision)

The nanoclaw MCP server (already on the host, already provides `send_message`, `schedule_task`) is extended to be the trust gateway. All "write" and "transact" tools are hosted on the orchestrator side via MCP. The container agent calls these tools through MCP, the orchestrator intercepts, checks trust level, and either auto-executes or asks the user for approval.

```
Container Agent                  Host Orchestrator
┌──────────────┐                ┌──────────────────┐
│ Claude SDK   │   MCP call     │ Nanoclaw MCP     │
│              │───────────────▶│ Server           │
│ "send_message│                │                  │
│  to Signal"  │                │ ┌──────────────┐ │
│              │                │ │ Trust Engine  │ │
│              │                │ │ classify →    │ │
│              │◀───────────────│ │ evaluate →    │ │
│ (result or   │  approval or   │ │ approve/ask   │ │
│  approval    │  execution     │ └──────────────┘ │
│  request)    │  result        │                  │
└──────────────┘                └──────────────────┘

Read tools (web_search, file read) stay inside the container — no trust check needed.
```

### Approval timeout

When the trust engine asks "approve this action?" and the user doesn't respond within 30 minutes, the action is cancelled with a notification: "Timed out waiting for approval on [action]. Ask me again if you still want this."

### Action classification

Two-layer classification:
1. **Static mapping table** — known tools mapped to action classes (e.g., `send_message` → `comms.write`, `schedule_task` → `services.write`). Covers all standard tools.
2. **Agent self-classification** — for novel/dynamic actions, the agent classifies via system prompt. The orchestrator validates.
3. **Default for unmapped actions** — defaults to highest risk level (transact), requiring approval. Better to over-ask than to auto-execute an unclassified action.

### Confidence formula

```
confidence = approvals / (approvals + denials + 1)
```

The `+1` prevents immediate graduation on first approval. Time decay: confidence reduces by 0.01 per day without activity in that action class, minimum 0.0. This prevents stale trust from persisting indefinitely.

### Action classification taxonomy

| Domain | Read (low risk) | Write (medium risk) | Transact (high risk) |
|--------|:---:|:---:|:---:|
| **Info** | Web search, check weather | — | — |
| **Comms** | Read email/messages | Send message, reply | — |
| **Health** | Check refill status | Request refill | — |
| **Finance** | Check balance | — | Transfer, pay bill |
| **Code** | Read files, search | Edit files, commit | Push, deploy |
| **Services** | Check account status | Change settings | Create/cancel account |

Default thresholds: read = 0.7 (3 approvals), write = 0.8 (5 approvals), transact = 0.95 (20 approvals or never-auto configurable).

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

### User controls

- `@Andy trust status` — shows current trust levels per domain
- `@Andy never auto-execute [action class]` — permanent manual gate
- `@Andy reset trust` — cold start everything
- Denying any action immediately recalculates confidence

### Codebase changes

- New `src/trust-engine.ts` — classification, evaluation, confidence tracking
- Extend `src/ipc.ts` (nanoclaw MCP server) with trust gateway for write/transact tools
- New DB tables in `src/db.ts`
- Trust events: `trust.request`, `trust.approved`, `trust.denied`, `trust.graduated`

## Layer 4: Proactive Monitor

### Problem

NanoClaw is purely reactive. No ability to watch for events and initiate action.

### Design

External event sources feed into the event bus. The bus already exists (Layer 0). This layer adds event sources and routing rules.

### Event sources

| Source | Status | What it watches |
|--------|--------|-----------------|
| Gmail SSE | Already built | New emails across 4 accounts |
| Calendar polling | New — poll Google Calendar API every 5 min | Upcoming meetings, changes |
| Browser watchers | New — scheduled browser visits that extract specific values via CSS selectors, then compare against previous values | Alto refill status, any configured web service |
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

### Daily Digest (CEO expansion #1)

A scheduled event (configurable time, default 8:00 AM PT) that:
1. Queries overnight events from the event bus log
2. Queries pending trust approvals
3. Queries upcoming calendar events (next 12 hours)
4. Queries outcome store for completed proactive tasks
5. Synthesizes into a prioritized brief via a lightweight agent task
6. Sends to primary channel (Telegram)

Format:
```
Morning brief (Apr 14):
Handled: Alto refill reordered (auto-approved)
Handled: Replied to Alexandre re: payout numbers
Needs you: Dmitrii asked about API change in signal_quarterly_release
Upcoming: WhoisXML team sync at 2:00 PM PT
Flag: Gmail dev token expired again (4th time this month)
```

### "What did I miss?" (CEO expansion #2)

On-demand command. When the user says "what did I miss?" or similar:
1. Determine time since last user message
2. Query event bus log, outcome store, and trust actions for that period
3. Prioritize by: actions taken > approvals pending > events received > informational
4. Deliver as a concise summary

### Key design decisions

- Events are lightweight — the bus just routes. Heavy work is delegated to the executor pool.
- Events flow through the trust engine — proactive actions need approval until trust is earned.
- Budget ceiling applies — proactive tasks count against daily cost limit.
- Quiet hours — configurable "don't bother me" windows. Events queue and deliver as digest.
- Dedup — same event won't trigger twice (keyed on source + event ID + 1-hour window).

### Codebase changes

- New `src/watchers/` — calendar poller, browser watcher, webhook server
- Existing `src/task-scheduler.ts` emits events into the bus
- Existing `src/email-sse.ts` feeds into the event bus
- Event rules stored per-group in `groups/{name}/events.json`
- Daily digest as a built-in scheduled event in the task scheduler

## Layer 5: Verification Pipeline

### Problem

Agent sometimes states guesses as facts. With more autonomy, wrong actions become costly.

### Design: Three verification stages, proportional to risk

**Stage 1 — Self-check (system prompt discipline, always runs, zero cost)**

Injected into agent system prompt: "Before stating any fact, classify it as KNOWN (from a tool result you just received), REMEMBERED (from memory/context), or INFERRED (your reasoning). Mark INFERRED claims explicitly."

**Stage 2 — Source cross-reference (runs for factual claims, minimal cost)**

Post-processing that compares the agent's output against raw tool results in the conversation. Catches misread data, hallucinated numbers, invented details.

**Stage 3 — Pre-action validation (runs before write/transact, ~$0.001 per check)**

A cheap, fast LLM call (Haiku) compares the user's request against the proposed action: "The user asked for X. You are about to do Y. Confirm these match." Runs inside the MCP trust gateway (same interception point as trust checks).

### Confidence signals in responses

```
Verified: "Your Alto refill for Lisinopril is ready" 
  (source: browser check of alto.com, 2 min ago)

Unverified: "I think your next appointment is Thursday"
  (source: memory from last conversation, not confirmed)

Unknown: "I'm not sure if MyChart supports automated refills"
  (no source available)
```

### Confidence calibration (CEO expansion #7)

Track accuracy per confidence level over time:

```sql
-- Added to outcomes table
confidence_level TEXT,   -- 'verified', 'unverified', 'unknown'
was_correct BOOLEAN      -- determined from user feedback or subsequent verification
```

Accumulate accuracy stats: `SELECT confidence_level, AVG(was_correct) FROM outcomes WHERE confidence_level IS NOT NULL GROUP BY confidence_level`. When accuracy diverges from expected (e.g., "verified" claims are only 70% correct), adjust the system prompt thresholds for what qualifies as "verified."

### Codebase changes

- Updated container agent system prompt with self-check discipline
- New `src/verification.ts` — source cross-reference, pre-action validation
- Pre-action validation integrated into MCP trust gateway (same interception point)
- Confidence markers added to response formatting in `src/router.ts`
- Confidence calibration fields added to outcomes table

## Layer 6: Learning System

### 6A: Compounding Memory

Three-tier architecture:

| Tier | What | Storage | Scope |
|------|------|---------|-------|
| **1. Hot Memory** | Per-group CLAUDE.md (existing) | Filesystem | Group |
| **2. Global Memory** | Cross-group facts, preferences, patterns | SQLite + Mem0 (local mode) | All groups |
| **3. Outcome Store** | Action results, user feedback | SQLite | All groups |

- **Tier 1** stays as-is — per-group CLAUDE.md files
- **Tier 2** adopts **Mem0** (52.9K stars) as the recall engine. Configuration: local mode, SQLite backend, small ONNX embedding model (~100MB) for semantic search. Runs in-process. Agent sessions query at startup: "What do I know about this user's [relevant domain]?"
- **Tier 3** is novel — the outcome store.

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
  confidence_level TEXT,    -- 'verified', 'unverified', 'unknown'
  was_correct BOOLEAN,      -- for confidence calibration
  duration_ms INTEGER,
  cost_usd REAL,
  group_id TEXT,
  timestamp DATETIME
);
```

What feeds into outcomes:
- Trust engine logs every action decision
- Container runner logs success/failure and cost
- User reactions parsed as implicit feedback
- Explicit feedback: `@Andy that was wrong` / `@Andy good job`

What outcomes feed into:
- **Trust engine** — success rate informs confidence. Failures reduce trust.
- **Method selection** — prefer methods with higher success rates
- **Proactive timing** — schedule actions at times with best success history
- **Cost dashboard** — aggregate cost_usd per group, per layer, per day

### Cost Dashboard (CEO expansion #4)

On-demand via `@Andy cost report` and included in daily digest:

```
Cost report (last 7 days):
Interactive: $4.20 (62 tasks)
Proactive:   $1.15 (23 tasks)  
Scheduled:   $0.80 (12 tasks)
Learning:    $0.30 (embeddings)
─────────────────────
Total:       $6.45
Budget:      $10.00/day ($70.00/week)
```

Queries the outcomes table: `SELECT SUM(cost_usd), source_type, DATE(timestamp) FROM outcomes GROUP BY source_type, DATE(timestamp)`.

### 6C: Skill Acquisition

**Two acquisition paths:**

**Path 1: Autonomous discovery** — agent completes a novel multi-step task and suggests saving it as a procedure.

**Path 2: Teach mode (CEO expansion #5)** — human-guided procedure recording.

Teach mode interaction:
1. User says: `@Andy teach: how to reorder Alto refills`
2. Agent opens browser session, says "I'm watching. Walk me through the steps."
3. User narrates: "Go to alto.com. Click Medications. Find Lisinopril. Click Request Refill."
4. Agent records each step, maps to browser actions (selectors, URLs, click targets)
5. Agent confirms: "Got it. Here's what I recorded: [procedure]. Want me to save this?"
6. User approves, procedure is saved
7. Next time: agent replays the procedure as guidance (adapts to page changes)

Teach mode is the primary acquisition path. Autonomous discovery is secondary (requires successful task completion + user approval to save).

Learned procedures stored as replayable guidance:

```json
{
  "name": "alto_refill_reorder",
  "trigger": "user asks to reorder a prescription on Alto",
  "learned_from": "2026-04-13 teach mode in telegram_main",
  "acquisition": "teach",
  "steps": [
    { "action": "navigate", "url": "https://alto.com/dashboard" },
    { "action": "click", "selector": "[data-tab='medications']", "description": "Click Medications tab" },
    { "action": "find", "text": "{medication_name}", "description": "Find the requested medication" },
    { "action": "click", "selector": ".request-refill-btn", "description": "Click Request Refill" },
    { "action": "click", "selector": ".confirm-btn", "description": "Confirm the refill request" }
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

### Codebase changes

- Integrate Mem0 (local mode, SQLite backend, ONNX embeddings ~100MB)
- New `src/memory/` directory — outcome store, memory query layer, procedure storage
- New DB tables in `src/db.ts` for outcomes and procedures
- Container agent system prompt updated to query Mem0 at session start and log outcomes at session end
- Procedure files in `store/procedures/` and `groups/{name}/procedures/`
- Teach mode as a container skill in `container/skills/teach-mode/`

## Cross-Channel Relay (CEO expansion #6)

**Main-channel-only privilege** (consistent with existing privilege model where main channel can write global memory and manage all-group tasks).

Command: `@Andy send that to [channel/group name]` or `@Andy forward this to [channel/group name]`

Routes through the orchestrator (not container-to-container). The main channel agent calls a `relay_message` MCP tool, which the orchestrator processes using the channel registry to format and deliver.

Channel-specific formatting handled by existing `src/router.ts` formatting logic.

## Build Order

| # | Layer | What it delivers | Depends on | Est. AI dev time |
|---|-------|-----------------|------------|-----------------|
| 0 | Event Bus | System backbone, event-driven architecture | — | 1-2 days |
| 1 | Parallel Execution | Concurrent tasks, warm pool | Layer 0 | 2-3 days |
| 2 | Browser Sidecar | Universal web connector | Layer 1 | 2-3 days |
| 3 | Trust Engine | Graduated autonomy, MCP gateway | Layer 0 | 2-3 days |
| 4 | Proactive Monitor | Event sources, daily digest, "what did I miss?" | Layers 0 + 1 + 3 | 3-4 days |
| 5 | Verification Pipeline | Anti-hallucination, confidence calibration | Layer 3 (shares MCP gateway) | 1-2 days |
| 6 | Learning System | Memory, outcomes, teach mode, cost dashboard | Layers 3 + 5 | 3-4 days |
| 7 | Cross-channel relay | Content forwarding between channels | Layer 0 | 0.5 day |
| — | Integration testing | Cross-layer flows, end-to-end tests | All layers | 3-5 days |

**Total estimated AI dev time: 4-6 weeks** (includes integration testing)

Note: Layers 0+1 and 3 can be built in parallel (no dependencies between them). Layers 5 and 6 can partially overlap. Practical calendar time with parallel AI dev: ~3-4 weeks.

## Deferred

- **LLM abstraction layer** — the container runs `claude-code` (the CLI), which is the agent framework, tool protocol, and session management, not just an LLM API call. True multi-LLM support requires building a second agent runtime. Deferred to the product extraction phase. (CEO review finding: this was originally estimated as M effort but is actually XL.)

## Product Positioning (reference only — separate from implementation)

**Tagline:** "The personal AI agent that earns your trust."

**Differentiators:**
1. Per-group container isolation (vs. ForgeAI's code sandbox)
2. Train-then-trust autonomy (vs. everyone's static permissions)
3. Outcome-based learning (vs. Mem0/Letta's recall-only memory)
4. 6+ messaging channels with always-on ambient operation

**For extraction (later):** Separate framework from personal config, configurable assistant name, generic OAuth framework, `npx create-nanoclaw` packaging, getting-started docs.
