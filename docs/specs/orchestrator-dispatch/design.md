# Orchestrator Dispatch

**Status**: design draft, pre-build
**Author**: Dave + Claude (Opus 4.7) + Codex (review)
**Last updated**: 2026-05-08

## Problem

NanoClaw today is purely reactive: each session exists because someone messaged a thread on a chat platform. The owner currently coordinates parallel work across 11 agent groups by manually opening threads — slow, fragmented, easy to lose track of half-baked work (verified: `scripts/lookback.ts` surfaces 4 outstanding items in the last 7 days, only one of which the owner consciously remembered).

Two related needs:

1. **Dispatch parallel work**: drop a list of N tasks (e.g. the 22-item XZO triage) and have an orchestrator agent farm them out to existing agent groups, each task running in its own session.
2. **Visibility**: a single dashboard showing every in-flight task, live status, and a path to chat with each task individually.

The existing `agent-to-agent` module is structurally wrong for this. It's a hierarchical *subagent-spawning* primitive (`create_agent` produces a permanent child group, ACL via per-pair `agent_destinations` rows, agents reference each other by parent-scoped local names, and `routeAgentMessage` inherits the caller's threading so children collapse into one session per parent thread). What we need is *flat dispatch* into existing groups with a fresh thread per task.

## Goals

- **G1**: Orchestrator can dispatch N tasks → N sessions in N target agent groups, each addressable independently.
- **G2**: Owner can read live progress and steer any in-flight task from a single dashboard.
- **G3**: Tasks have durable host-side state (status, dependencies, parent linkage, deadlines) that survives container crashes and host restarts.
- **G4**: Reverse signal: child reports completion → orchestrator notified → dependent tasks unblock automatically.
- **G5**: Memory budget for the dashboard ≤ 150MB additional resident on the host. No new background services beyond the existing Node host.

## Non-goals

- **NG1**: No multi-user dashboards. One owner, local only.
- **NG2**: No autopilot agent picking up work without a human kicking it off — the orchestrator is initiated by the owner each time. (Future: time-based or event-triggered orchestrator runs.)
- **NG3**: No agent-to-agent dispatch by non-orchestrator agents. The dispatch capability is gated by an explicit role.
- **NG4**: No worktree/branch isolation manager in this design. Code-touching parallel work is out of scope; either constrain dispatch to disjoint file scopes (orchestrator's job) or sequence such tasks. Worktree isolation is a separate future spec.
- **NG5**: No replacement for or merge with `agent-to-agent` / `create_agent`. Both stay as-is for the hierarchical-subagent pattern.

## Verified constraints

Before defining the architecture, two findings from reading the code (`src/delivery.ts`, `src/session-manager.ts`, `src/router.ts`, `src/modules/agent-to-agent/`) and one from the Multica repo:

| # | Source | Finding | Implication |
|---|---|---|---|
| C1 | `delivery.ts:358-364` + `session-manager.ts:340` | Outbound `msg.thread_id` is passed straight to `deliveryAdapter.deliver(...)`. If the session has a synthetic thread_id, Slack/Discord posts will fail or land in the wrong place. | A child session with `messaging_group_id` set MUST have a real platform thread_id. Synthetic IDs only valid when `messaging_group_id IS NULL`. |
| C2 | `router.ts:288, 592` | Adapter contract has no `createThread` capability. Adapters can deliver into existing threads but not create new ones. | Phase 2 (real platform subthreads) requires a new adapter API method. |
| C3 | Multica repo | Multica = Postgres+pgvector + Go backend + Next.js frontend. ~400-700MB resident. | Multica is too heavy for the dashboard. Build a custom Next.js page ~100-150MB instead. |

## Architecture

### Data model

Two new tables in the central DB (`data/v2.db`), one schema migration each.

#### `agent_roles`

Mirrors the existing `user_roles` pattern (privilege table, not a column on the parent). Owner-approved, set once. A single agent group can hold zero or more roles concurrently.

```sql
CREATE TABLE agent_roles (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  role           TEXT NOT NULL,           -- 'orchestrator'  (extensible)
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, role)
);
```

Initial role: `orchestrator`. Granting requires owner-level user role; the grant flow reuses `requestApproval` (`src/modules/approvals/`).

#### `tasks`

The orchestration ledger. Source of truth — task state is durable, not in session memory and not in Beads.

```sql
CREATE TABLE tasks (
  task_id              TEXT PRIMARY KEY,
  parent_session_id    TEXT NOT NULL REFERENCES sessions(id),  -- orchestrator's session
  parent_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  child_session_id     TEXT REFERENCES sessions(id),  -- null until session resolved
  target_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  title                TEXT NOT NULL,
  prompt               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
                       -- pending | dispatched | running | complete | failed | orphaned | cancelled
  blocked_on_task_ids  TEXT,  -- JSON array of task_ids that must complete first
  deadline             TEXT,  -- ISO timestamp; watchdog enforces
  spawned_by_user_id   TEXT REFERENCES users(id),
  spawned_at           TEXT NOT NULL,
  started_at           TEXT,
  completed_at         TEXT,
  result_summary       TEXT,
  failure_reason       TEXT
);
CREATE INDEX idx_tasks_parent ON tasks(parent_session_id, status);
CREATE INDEX idx_tasks_child  ON tasks(child_session_id);
CREATE INDEX idx_tasks_status ON tasks(status, deadline);
```

### Dispatch flow

```
[1] Orchestrator container calls dispatch_task MCP tool with:
      target_group: <folder name>
      title:        "XZO-54: redeploy UDTF_GET_DEPLETIONS_FORECAST"
      prompt:       <full task brief>
      deadline:     <optional ISO timestamp>
      blocked_on:   <optional list of task_ids>

[2] Container writes outbound system action `dispatch_task` to outbound.db.
    (Container is sole writer of outbound.db — invariant preserved.)

[3] Host's delivery.ts:280 (system-action dispatch) routes to a new
    handler `applyDispatchTask` registered by the orchestrator-dispatch
    module. Host validates:
      - source agent group has 'orchestrator' role in agent_roles
      - target_group folder maps to an existing agent_groups row
      - blocked_on task_ids exist
      - deadline is well-formed

[4] Host inserts tasks row with status='pending'. If blocked_on is set
    and any prerequisite task is not yet complete, status stays 'pending'
    — host-sweep will pick it up when the prerequisites complete.

[5] If unblocked, host immediately:
      a. resolveSession(target_group_id, mg_id, thread_id, mode) →
         creates a child session row.
      b. writeSessionMessage(child) injects the task prompt as an inbound
         chat message with a system banner ("Dispatched by orchestrator
         <X>, task <task_id>").
      c. Updates tasks row: child_session_id, status='dispatched',
         started_at=now.
      d. wakeContainer(child) — agent runs.
```

The (mg_id, thread_id, mode) tuple in step 5a depends on the phase — see [Phasing](#phasing).

### Reverse signal

When the child finishes:

```
[1] Child container writes outbound system action `task_complete` with:
      task_id:        <from initial banner>
      status:         'complete' | 'failed'
      summary:        <markdown summary>
      failure_reason: <optional>

[2] Host's `applyTaskComplete` handler:
      a. UPDATE tasks SET status, completed_at, result_summary,
         failure_reason WHERE task_id = ?
      b. Fan out to dependents: any task with this task_id in blocked_on
         and all other prerequisites complete → triggers their dispatch.
      c. Direct-write a kind='system' inbound row into the orchestrator's
         session (parent_session_id) carrying the result summary. NOT a
         channel_type='agent' message — that drags in agent-to-agent ACL
         assumptions we don't want here.
      d. wakeContainer(parent) so the orchestrator processes the result.
```

Codex flagged this: completion routing is keyed on `parent_session_id`, not on `parent_agent_group_id`. An orchestrator group can have many sessions concurrently (different chat threads, different users, different times); only the originating session should hear the result.

### Watchdog

Extension to `src/host-sweep.ts`:

- Every 60s, scan tasks where `status IN ('dispatched', 'running')` AND `deadline IS NOT NULL` AND `deadline < now`.
- For each: write a synthetic `task_complete` system-action row into the parent's inbound (status=`failed`, failure_reason=`timeout`). Mark the tasks row `status='failed'`.
- Separate scan: tasks where `status='complete'/'failed'` but `parent_session_id` is no longer active (parent session deleted, channel disconnected). Mark `status='orphaned'`, log, optionally DM the owner via the user_dms cache.

### dispatch_task MCP tool (container-side)

Mounted only when the agent group has the `orchestrator` role. Resolution happens at container wake (in `src/container-runner.ts:spawnContainer`); if the role is granted/revoked while a session is running, the change takes effect on next wake.

```typescript
// container/agent-runner/src/mcp-tools/dispatch-task.ts
{
  name: 'dispatch_task',
  description: 'Dispatch a task to another agent group. Each call spawns a new session in the target group...',
  input_schema: {
    type: 'object',
    properties: {
      target_group: { type: 'string', description: 'Folder name of target agent group' },
      title: { type: 'string', maxLength: 120 },
      prompt: { type: 'string', maxLength: 16000 },
      deadline: { type: 'string', format: 'date-time' },
      blocked_on: { type: 'array', items: { type: 'string' } },
    },
    required: ['target_group', 'title', 'prompt'],
  },
}
```

The tool response includes the assigned `task_id`, which the orchestrator uses to track the task and reference it in subsequent `dispatch_task` calls (for `blocked_on`).

## Phasing

### MVP — orchestrator dispatch + real Slack/Discord subthreads + dashboard

Single shipping unit. Slack-first by design — non-thread channels degrade to internal-only sessions (the fallback path described below).

**Dispatch flow with channel surface (Slack, Discord, any adapter exposing `createThread`):**

1. Orchestrator calls `dispatch_task` with target_group + title + prompt.
2. Host validates orchestrator role + target group + dependencies.
3. Host posts "Launched task <title>" as a parent message in the orchestrator's `messaging_group`.
4. Host calls `adapter.createThread(messagingGroupId, parentMessageId, title, firstMessage) → { threadId, messageId }`. New adapter capability — see C2.
5. Real `thread_id` returned by the adapter is recorded on the child session row. `messaging_group_id` is the orchestrator's mg.
6. `resolveSession(target_agent_group_id, mg_id, real_thread_id, 'per-thread')` creates the child session. Constraint C1 is satisfied — `thread_id` is a real platform identifier so subsequent outbound delivery works.
7. `writeSessionMessage` injects the task prompt as the child's first inbound (with a system banner "Dispatched by orchestrator <X>, task <task_id>").
8. `wakeContainer(child)` — child agent runs.

Owner clicks into the Slack/Discord subthread to chat with that specific child task. Normal NanoClaw flow takes over (the subthread is just a thread to NanoClaw — same plumbing as any other thread). Each task = its own chattable thread, exactly the workflow you described.

**Fallback path — non-thread channels (Telegram, iMessage, email):**

Same dispatch flow, but at step 4 the adapter has no `createThread` method. Host detects this and switches to internal-only mode:

- `messaging_group_id = NULL` on the child session row
- `thread_id = task-<id>` (synthetic, but safe because no platform delivery happens — host's `deliverMessage` skips channel delivery when `messaging_group_id IS NULL`)
- Owner cannot click into a child thread for these channels — child interaction is via the dashboard only
- Orchestrator still receives `task_complete` and posts milestone updates in its own thread

Most NanoClaw use is Slack/Discord, so this fallback path is rare-but-correct rather than the default experience.

### Future — code-touching tasks (out of scope, separate spec)

Per-child git worktree manager. Codex's repo-corruption concern (22 parallel agents on `xzo-analytics` = trash). Until this ships as its own spec, the orchestrator's job is to either constrain dispatch to disjoint file scopes or sequence code-touching tasks via `blocked_on` chains.

## Dashboard

Vite + React + TypeScript SPA, bundled and served from the existing Node host on `127.0.0.1:7457`. The host runs a small `undici`-based HTTP server (one SSE endpoint, ~8 JSON endpoints, plus a static handler for the built bundle). Reads `data/v2.db` and per-session DBs directly via `better-sqlite3` — no new API service, no separate process. Owner-only auth: localhost-bound + a single owner check (same security posture as the rest of NanoClaw).

UI/UX specification: see [`./ui-design.md`](./ui-design.md) (separate file, generated via /impeccable design pass).

Memory budget:

| Component | Estimated RSS |
|---|---|
| Next.js node process (production build) | ~120MB |
| WebSocket handler (chokidar watching session DBs) | ~15MB |
| Total | ~135MB |

Compare to Multica: ~400-700MB (Postgres+pgvector + Go backend + Next.js).

Real-time updates: WebSocket from host → dashboard. Triggers:

- New task row inserted/updated → push tasks-list patch
- New row in any session's `outbound.db` → push transcript patch for that task
- Pending approval inserted → push approvals-list patch

Implementation: `chokidar` watches `data/v2-sessions/*/*/outbound.db` (file mtime changes trigger a query for new rows). Lightweight; no schema changes needed.

## Implementation order

Single MVP, ~12 focused days. Steps grouped by dependency layer.

| # | What | Where | Effort |
|---|---|---|---|
| 1 | `agent_roles` migration + helpers | `src/db/migrations/`, `src/db/agent-roles.ts` | 0.5 day |
| 2 | `tasks` migration + helpers | `src/db/migrations/`, `src/db/tasks.ts` | 0.5 day |
| 3 | Owner approval flow for granting orchestrator role | `src/modules/approvals/` | 0.5 day |
| 4 | `createThread` adapter capability — Slack | `channels` branch, slack adapter | 1 day |
| 5 | `createThread` adapter capability — Discord | `channels` branch, discord adapter | 1 day |
| 6 | `dispatch_task` MCP tool + container wiring (orchestrator-only) | `container/agent-runner/src/mcp-tools/` | 1 day |
| 7 | Host module `src/modules/orchestrator-dispatch/`: `applyDispatchTask` (with createThread call + non-thread fallback), `applyTaskComplete`, dependency resolution | new module | 2 days |
| 8 | Watchdog: stale `dispatched`/`running` task detection + parent-orphan recovery | `src/host-sweep.ts` | 0.5 day |
| 9 | E2E test: orchestrator dispatches 3 Slack tasks, owner steers one mid-flight via subthread, all complete, results route back, dependent task fires | `src/modules/orchestrator-dispatch/*.test.ts` | 1 day |
| 10 | Dashboard skeleton (Vite+React, owner check, Tasks view) | `src/dashboard/` (new) | 1.5 days |
| 11 | Dashboard Task Detail view: transcript, steer composer, ToolCallTicker, Inspector | `src/dashboard/` | 2 days |
| 12 | Dashboard Agents + Settings views, SSE live updates, connection-loss state | `src/dashboard/` | 1.5 days |

Total: ~12 days focused. One ship gate.

Sequencing notes:
- Steps 1–3 are independent and parallelizable.
- Steps 4–5 (adapter work on the `channels` branch) can run in parallel with 1–3.
- Steps 6–9 (dispatch + watchdog + tests) depend on 1–5.
- Steps 10–12 (dashboard) can start as soon as the `tasks` table exists (after step 2) — they read it, the dispatch module writes to it. The dashboard ships with stubbed data first, then live data once the dispatch module is in place.

## Risks

- **R1 (Codex H1)**: Ad-hoc destination resolution at dispatch time vs the existing `agent_destinations` projection model. Mitigation: orchestrator-dispatch is a totally separate module that doesn't touch `agent_destinations` or container-side `inbound.db.destinations`. Lazy host-side lookup of target by folder, scoped only to the dispatch_task action.
- **R2 (Codex M2)**: Folder names in `platform_id`. Mitigation: dispatch_task accepts a folder name (human-friendly) but the host immediately resolves it to an `agent_group_id` and uses the ID throughout. Folder is never persisted in any message column.
- **R3 (Codex H6)**: Orchestrator session disappears mid-task. Mitigation: explicit `orphaned` status in the watchdog. Owner is DM'd via user_dms cache so the result isn't silently lost.
- **R4**: Non-thread channel children (Telegram/iMessage/email fallback path) have no channel surface = owner can only inspect/steer them via the dashboard. Mitigation: dashboard ships in the same MVP (steps 10–12).
- **R5**: Concurrency cap. 22 dispatched tasks = 22 containers. Single host might thrash. Mitigation: orchestrator dispatch handler enforces a configurable cap (default 6 concurrent `dispatched`/`running` tasks per orchestrator session); excess stay `pending` and pick up as slots free.
- **R6**: Prompt injection in a chat thread getting an orchestrator agent to dispatch malicious tasks to other groups. Mitigation: `orchestrator` role grant is owner-approved (one-time), and the role is on the agent group, not on individual prompts. The orchestrator agent's CLAUDE.md explicitly defines its dispatch policy. Defense-in-depth: an optional per-dispatch approval gate (configurable on the orchestrator group), surfacing a click-approve card before any task fires.

## Open questions

- **OQ1**: Should `dispatch_task` support `replyto` semantics — i.e., can a non-orchestrator child agent dispatch a follow-up task back to the orchestrator? Default: no, only orchestrator-role agents can dispatch. Children report status via `task_complete`, period.
- **OQ2**: Per-task model selection. The orchestrator might want to say "dispatch this to xzo with model=opus, effort=high." Should `dispatch_task` accept `model` and `effort`? Probably yes — pass-through to the child session's container config. Add to schema if Phase 1 use exposes the need.
- **OQ3**: Cancellation. `dispatch_task` cancellation = host marks task `cancelled` + writes a system-action terminate to the child. Should cancellation be exposed as a separate MCP tool (`cancel_task`) or via a status update on an existing task row? Recommend: separate MCP tool, mirrors existing `cancel_task` for scheduled tasks (`scheduling.ts:174`).
- **OQ4**: Multi-orchestrator coordination. If two different orchestrator agent groups both dispatch to the same target — collisions on threads, on tasks ledger, on dependency chains? Out of scope for v1; assume single orchestrator practice.

## Appendix: alternatives considered

- **Multica as dispatch + dashboard**: rejected (memory cost ~400-700MB, daemon model fights ephemeral containers, ripping the UI is comparable cost to building from scratch).
- **Beads as task ledger**: rejected (Codex H7: task state must be durable host data; Beads is git-versioned per-repo and doesn't model the orchestration relationships we need; community UIs are passion projects with varying maintenance).
- **Reuse `agent-to-agent` and just add a "create subthread" flag**: rejected (the destinations ACL model and threading inheritance are wrong shapes — see Problem section).
- **Slack-only orchestration via threaded messages, no host-side tasks table**: rejected (no resilience to container crashes; no reverse-signal handling for dependency chains; no way to surface stale tasks beyond Slack's own thread UX).
