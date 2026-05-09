# Orchestrator Dispatch

**Status**: design — cycle 2 (revised against `/team-review` cycle 1 findings)
**Author**: Dave + Claude (Opus 4.7) + Codex (review)
**Last updated**: 2026-05-09

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
- **G6**: Dispatch is retry-safe — a crash mid-flow leaves no orphaned platform threads, no duplicate child sessions, no tasks stuck in indeterminate state.
- **G7**: Dispatch and completion are authenticated — only orchestrator-role agents can dispatch; only the recorded child can mark its task complete.

## Non-goals

- **NG1**: No multi-user dashboards. One owner, local only.
- **NG2**: No autopilot agent picking up work without a human kicking it off — the orchestrator is initiated by the owner each time. (Future: time-based or event-triggered orchestrator runs.)
- **NG3**: No agent-to-agent dispatch by non-orchestrator agents. The dispatch capability is gated by an explicit role.
- **NG4**: No worktree/branch isolation manager in this design. Code-touching parallel work is the orchestrator's responsibility to sequence (via `blocked_on` chains). Worktree isolation is a separate future spec.
- **NG5**: No replacement for or merge with `agent-to-agent` / `create_agent`. Both stay as-is for the hierarchical-subagent pattern.
- **NG6**: Dashboard surfaces orchestrator-dispatched tasks only. Pre-existing `agent-to-agent` (`create_agent`) subagent sessions are not displayed — they remain visible via `agent_destinations` and the chat surface they were spawned from.
- **NG7**: No analytics view, no cost/token ticker. Use OneCLI dashboard or chat queries for cost questions.
- **NG8**: No external access. Localhost-only; no public URL, no tunnel, no SSO.
- **NG9**: No mobile / phone surface for the dashboard. Slack already serves that role.

## Verified constraints

| # | Type | Source | Finding | Implication |
|---|---|---|---|---|
| C1 | **HARD** | `delivery.ts:358-364` + `session-manager.ts:340` | Outbound `msg.thread_id` is passed straight to `deliveryAdapter.deliver(...)`. If the session has a synthetic thread_id, Slack/Discord posts will fail or land in the wrong place. | A child session with `messaging_group_id IS NOT NULL` MUST have a real platform thread_id. Synthetic IDs (`task-<id>`) only valid when `messaging_group_id IS NULL`. |
| C2 | **HARD** | `router.ts:288, 592` + `src/channels/adapter.ts` | Adapter contract has no `createThread` capability. | New adapter capability required, added as **optional** method (`createThread?:`) with a `supportsCreateThread: boolean` flag — mirrors existing optional-method conventions (`setTyping?`, `deleteMessage?`, `subscribe?`) so adapters without thread support compile unchanged. |
| C3 | SOFT | Multica repo | Multica = Postgres+pgvector + Go backend + Next.js frontend. ~400-700MB resident. | Multica is too heavy for the dashboard. Build a custom Vite SPA served from the existing Node host (~135MB). |
| C4 | **HARD** | `src/db/migrations/024-sessions-channel-root-unique.ts` | `UNIQUE(agent_group_id, messaging_group_id) WHERE thread_id IS NULL AND messaging_group_id IS NOT NULL`. | Dispatch must never insert a row with `thread_id IS NULL AND messaging_group_id IS NOT NULL` if a channel-root session already exists for that pair. The fallback path (synthetic thread_id) MUST set `messaging_group_id = NULL`; the primary path (real subthread) MUST set both fields non-null. No third option. |

## Architecture

### Data model

Three new tables in the central DB (`data/v2.db`).

#### `agent_roles`

Mirrors the existing `user_roles` pattern (privilege table, not a column on the parent). Owner-approved, set once. A single agent group can hold zero or more roles concurrently.

```sql
CREATE TABLE agent_roles (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  role           TEXT NOT NULL,           -- 'orchestrator' (extensible)
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, role)
);
```

Initial role: `orchestrator`. Granting requires owner-level user role; the grant flow reuses `requestApproval` (`src/modules/approvals/`).

#### `tasks`

The orchestration ledger. Source of truth — task state is durable, not in session memory.

```sql
CREATE TABLE tasks (
  task_id              TEXT PRIMARY KEY,
  idempotency_key      TEXT,                -- orchestrator-generated; UNIQUE per parent_session_id
  parent_session_id    TEXT NOT NULL REFERENCES sessions(id),  -- orchestrator's session
  parent_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  child_session_id     TEXT REFERENCES sessions(id),  -- null until session resolved
  target_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  title                TEXT NOT NULL,
  prompt               TEXT NOT NULL,

  -- State machine
  status               TEXT NOT NULL DEFAULT 'pending',
                       -- pending | dispatched | running | complete | failed | orphaned | cancelled
  dispatch_state       TEXT,
                       -- For status=dispatched: tracks resumable progress through
                       -- the multi-step dispatch flow.
                       -- NULL | thread_created | session_created | prompt_injected | wake_sent | dispatched
  external_thread_id   TEXT,                -- platform thread_id (Slack thread_ts, Discord thread channel id)
  external_message_id  TEXT,                -- platform parent message id (for thread context)

  -- Behavior knobs (see dispatch_task tool spec)
  model                TEXT,                -- e.g. 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5'
  effort               TEXT,                -- 'low' | 'medium' | 'high'
  file_scope           TEXT,                -- JSON array of glob patterns; advisory only (NG4)

  deadline             TEXT,                -- ISO timestamp; watchdog enforces
  deadline_extensions  INTEGER NOT NULL DEFAULT 0,  -- count of explicit extends, capped to prevent runaway

  spawned_by_user_id   TEXT REFERENCES users(id),
  spawned_at           TEXT NOT NULL,
  started_at           TEXT,                -- set when dispatch_state reaches 'wake_sent'
  running_at           TEXT,                -- set when child container first emits a non-status outbound row
  completed_at         TEXT,
  result_summary       TEXT,
  failure_reason       TEXT,

  -- Per-task completion nonce — generated by host at dispatch, included in the
  -- system banner injected as the child's first inbound, required in the
  -- child's task_complete payload (defense in depth on M5 authorization)
  completion_nonce     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_tasks_idempotency
  ON tasks(parent_session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_tasks_parent ON tasks(parent_session_id, status);
CREATE INDEX idx_tasks_child  ON tasks(child_session_id);
CREATE INDEX idx_tasks_status ON tasks(status, deadline);
CREATE INDEX idx_tasks_dispatch_state
  ON tasks(dispatch_state, spawned_at)
  WHERE status = 'dispatched';  -- watchdog scans for stuck mid-dispatch
```

#### `task_dependencies`

Edge table; one row per dependency edge. Replaces the JSON-array approach so SQLite indexes can serve the dependency-fanout query.

```sql
CREATE TABLE task_dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  blocked_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  PRIMARY KEY (task_id, blocked_on_task_id),
  CHECK (task_id != blocked_on_task_id)
);
CREATE INDEX idx_task_deps_blocked_on ON task_dependencies(blocked_on_task_id);
```

The `applyDispatchTask` handler enforces a same-`parent_session_id` constraint at insert time (cross-orchestrator-session dependencies are not allowed; would create cross-tenant linkage).

### Dispatch flow

Multi-step procedure with idempotency + persistent dispatch_state for crash recovery (G6).

```
[1] Orchestrator container calls dispatch_task MCP tool with:
      target_group:     <folder name>
      title:            "XZO-54: redeploy UDTF_GET_DEPLETIONS_FORECAST"
      prompt:           <full task brief>
      idempotency_key:  <orchestrator-generated, optional but recommended>
      deadline:         <optional ISO timestamp>
      blocked_on:       <optional list of task_ids>
      model:            <optional, e.g. 'claude-opus-4-7'>
      effort:           <optional, 'low' | 'medium' | 'high'>
      file_scope:       <optional, advisory only — NG4>

[2] Container writes outbound system action `dispatch_task` to outbound.db.
    (Container is sole writer of outbound.db — invariant preserved.)

[3] Host's delivery.ts system-action dispatch routes to applyDispatchTask
    handler in the new src/modules/orchestrator-dispatch/ module. Host validates:
      a. Source session's agent_group has 'orchestrator' role in agent_roles
         (re-checked PER DISPATCH, not cached at container wake — closes the
         role-revocation staleness window per /team-review S1).
      b. target_group folder maps to an existing agent_groups row.
      c. blocked_on task_ids exist AND share the same parent_session_id.
      d. deadline is well-formed if present.
      e. (idempotency) If idempotency_key provided AND
         (parent_session_id, idempotency_key) already exists, return the
         existing task_id without inserting — no double-fire.
      f. (credential pre-flight) Target agent group's OneCLI agent identity
         has secrets attached (or `mode='all'`). If `mode='selective'` and
         zero secrets, fail dispatch with a structured error so the
         orchestrator can surface the misconfig before launching a doomed
         task. Per /team-review S2.
      g. (concurrency) Per-orchestrator-session cap (default 6 concurrent
         dispatched/running) AND per-target-group cap (default 3
         concurrent containers in same group). Both apply. Either cap-hit
         keeps the task at status='pending' until a slot frees.

[4] Insert tasks row with status='pending', completion_nonce=<host-generated>,
    dispatch_state=NULL. Insert task_dependencies rows for blocked_on.

[5] If unblocked AND under both concurrency caps, host begins multi-step
    dispatch. Each step persists state before continuing — a crash between
    steps leaves a row whose dispatch_state names the last completed step,
    which the watchdog uses to resume.

    Step 5a (channel surface available — adapter.supportsCreateThread):
      - Post "Launched task <title>" parent message to orchestrator's
        messaging_group via adapter.deliver(...). Persist platform message_id.
      - Set dispatch_state='thread_created' is premature — this step has no
        durable side effect on the platform yet. Move to next.
    Step 5b:
      - Call adapter.createThread(messagingGroupId, parentMessageId, title,
        firstMessage) → { threadId, messageId }. Persist external_thread_id
        and external_message_id on the tasks row.
      - dispatch_state='thread_created'.
    Step 5c (channel surface unavailable — fallback):
      - external_thread_id stays NULL.
      - Child session will be created with messaging_group_id=NULL,
        thread_id='task-<task_id>'. C1 satisfied (no platform delivery
        attempted); C4 satisfied (mg_id IS NULL so partial-UNIQUE doesn't
        apply).
    Step 5d:
      - resolveSession(target_agent_group_id, mg_id, thread_id, mode):
          Channel surface:    mg_id = orchestrator_mg, thread_id = real_platform_id, mode='per-thread'
          Fallback (no chan): mg_id = NULL,            thread_id = 'task-<task_id>', mode='per-thread'
      - Update tasks row: child_session_id=<resolved>.
      - dispatch_state='session_created'.
    Step 5e:
      - writeSessionMessage(child) injects the system banner +
        task prompt as the child's first inbound chat message.
        Banner includes: task_id, completion_nonce, parent agent group,
        instruction "When you finish, call task_complete with task_id=X,
        completion_nonce=Y, status=complete|failed, summary=..."
      - dispatch_state='prompt_injected'.
    Step 5f:
      - wakeContainer(child).
      - dispatch_state='wake_sent'.
    Step 5g:
      - Update tasks row: status='dispatched', started_at=now,
        dispatch_state='dispatched'.

[6] When the child container's first non-status outbound row appears, host
    transitions status='running' AND running_at=now. (See watchdog for
    detection mechanism.)
```

**Reconciler (host-sweep extension)**: scans tasks where status='dispatched' AND dispatch_state IN ('thread_created','session_created','prompt_injected','wake_sent') for >60s. Resumes from the last persisted step (each step is idempotent — re-posting a parent message uses idempotency_key on the adapter, re-resolving a session is a lookup, etc.) OR marks the task `failed` with `failure_reason='dispatch stuck at <state>'` if resumption isn't safe (e.g. createThread step requires confirming whether the platform call succeeded; manual cleanup may be required).

### Reverse signal

When the child finishes, two writes happen — one for the owner's view (child subthread), one for the orchestrator's logic (parent system row). Closes /team-review M8.

```
[1] Child container writes outbound system action `task_complete` with:
      task_id:          <from initial banner>
      completion_nonce: <from initial banner; required for auth>
      status:           'complete' | 'failed'
      summary:          <markdown summary, owner-facing>
      failure_reason:   <optional, machine-readable>

[2] Host's applyTaskComplete handler:

    a. AUTHORIZATION (closes M5):
       Look up tasks row by task_id. Verify ALL of:
         - task exists
         - task.status IN ('dispatched','running')  -- not already terminal
         - task.child_session_id == source session id (the session that emitted
           the outbound row — host knows this from the outbound.db location)
         - task.target_agent_group_id == source session's agent_group_id
         - task.completion_nonce == payload.completion_nonce
       If any check fails: log a security-relevant warning, drop the message,
       do NOT update tasks. (No retry — the child shouldn't be able to
       complete a task it doesn't own.)

    b. UPDATE tasks SET status, completed_at, result_summary, failure_reason
       WHERE task_id = ? AND status IN ('dispatched','running').
       (Status guard prevents double-complete races.)

    c. CHILD SUBTHREAD WRITE (owner-facing closure):
       If task has external_thread_id AND messaging_group_id (i.e. channel
       surface exists): write an outbound chat message to the child session
       containing the summary text. This routes through normal delivery to
       the Slack/Discord subthread the owner has been watching.
       Closes M8 — owner sees the completion in the thread they opened.
       If fallback mode (no channel surface): skip this write; dashboard is
       the only completion surface for those tasks.

    d. PARENT SYSTEM WRITE (orchestrator wakes for fan-out):
       Direct-write a kind='system' inbound row into the orchestrator's
       session (parent_session_id) carrying the result summary. NOT
       channel_type='agent' — surgical bypass of the agent-to-agent ACL
       machinery; the orchestrator-dispatch module owns this codepath.

    e. DEPENDENCY FAN-OUT:
       SELECT task_id FROM task_dependencies WHERE blocked_on_task_id = ?
       Then for each: check if all that task's prerequisites are now
       complete (NOT EXISTS subquery). If so, transition that task from
       pending → dispatch attempt (re-enter step 5 of dispatch flow).

    f. wakeContainer(parent_session) so the orchestrator sees the new
       system row and can fan out further work.
```

Routing-by-`parent_session_id` is the right key: an orchestrator group can have many sessions concurrently (different chat threads, different times); only the originating session should hear the result.

### Watchdog (host-sweep extension)

Single scheduler loop in `src/host-sweep.ts`, runs every 60s, executes scans in one transaction:

1. **Stuck-dispatch reconciler** (G6): tasks where status='dispatched' AND dispatch_state IN non-terminal AND spawned_at < now-60s. Resume from last step, OR mark failed if resumption isn't safe.
2. **Running-state detector**: tasks where status='dispatched' AND dispatch_state='dispatched' AND child_session_id has any non-status outbound row newer than dispatched_at. Transition status='running', running_at=now. (Cheap query — uses idx_tasks_dispatch_state.)
3. **Deadline expiry — running tasks**: tasks where status IN ('dispatched','running') AND deadline IS NOT NULL AND deadline < now AND deadline_extensions < MAX_EXTENSIONS (default 3). Write a synthetic `task_complete` row (status='failed', failure_reason='timeout after N extensions'). Single completion code path — same as voluntary completion above but bypasses authorization (host-emitted).
4. **Deadline expiry — pending tasks**: tasks where status='pending' AND deadline IS NOT NULL AND deadline < now. Mark `failed`, failure_reason='deadline expired before dispatch (blocked or capped)'.
5. **Parent-orphan recovery**: tasks where status IN ('complete','failed') with completed_at recent AND parent_session is no longer active. Mark status='orphaned'. DM the owner via user_dms cache so the result isn't silently lost.
6. **Cancellation propagation**: tasks where status='cancelled' AND child_session_id IS NOT NULL AND child_session.container_status='running'. Write a system terminate to the child's inbound; child container's poll loop honors it.

`extend_deadline(task_id, new_deadline)` is exposed as a separate MCP tool (not part of `task_complete`) for use by the child if it knows it'll exceed its deadline. Increments deadline_extensions.

### dispatch_task MCP tool (container-side)

Mounted only when the agent group has the `orchestrator` role. Resolution happens at container wake (in `src/container-runner.ts:spawnContainer`). **Host re-checks the role per dispatch** (closes /team-review S1), so container-side mounting is a hint, not the security boundary.

```typescript
// container/agent-runner/src/mcp-tools/dispatch-task.ts
{
  name: 'dispatch_task',
  description: 'Dispatch a task to another agent group. Each call spawns a new session in the target group, runs the task there, and reports back via task_complete.',
  input_schema: {
    type: 'object',
    properties: {
      target_group: { type: 'string', description: 'Folder name of target agent group' },
      title: { type: 'string', maxLength: 120 },
      prompt: { type: 'string', maxLength: 16000 },
      idempotency_key: { type: 'string', description: 'Generate one per logical task; second call returns existing task_id without re-firing' },
      deadline: { type: 'string', format: 'date-time' },
      blocked_on: { type: 'array', items: { type: 'string' }, description: 'task_ids that must complete before this dispatches' },
      model: { type: 'string', description: "Override target group's default model (e.g. 'claude-opus-4-7', 'claude-haiku-4-5')" },
      effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Reasoning effort hint' },
      file_scope: { type: 'array', items: { type: 'string' }, description: 'Advisory glob patterns for code-touching tasks (NG4 — orchestrator must sequence overlaps)' },
    },
    required: ['target_group', 'title', 'prompt'],
  },
}
```

The tool response includes the assigned `task_id`. The orchestrator uses it to track the task and reference it in subsequent `dispatch_task` calls (for `blocked_on`).

### task_complete MCP tool (container-side, child sessions)

**Auto-mounted** into any session whose `tasks.child_session_id` matches the session id (host injects at container wake when the session was spawned by dispatch). Auto-unmounted after the first call. The first inbound message a dispatched child receives includes an explicit instruction to call this tool.

```typescript
// container/agent-runner/src/mcp-tools/task-complete.ts
{
  name: 'task_complete',
  description: 'Signal completion of the task you were dispatched to do. Call this exactly once when finished, with status=complete and a summary, OR status=failed with a reason.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      completion_nonce: { type: 'string', description: 'Required — copy from the task banner' },
      status: { type: 'string', enum: ['complete', 'failed'] },
      summary: { type: 'string', maxLength: 8000, description: 'Markdown summary of what you did and the outcome (visible to the owner)' },
      failure_reason: { type: 'string', description: 'Optional — short machine-readable reason if status=failed' },
    },
    required: ['task_id', 'completion_nonce', 'status', 'summary'],
  },
}
```

Falls back to host-side detection: if the child container exits without emitting `task_complete`, host-sweep marks the task `failed` with `failure_reason='child exited without completion signal'`.

### cancel_task MCP tool (container-side, orchestrator only)

Mirror of dispatch_task gating. Marks task `cancelled` and writes terminate signal to the child (handled by watchdog step 6).

```typescript
{
  name: 'cancel_task',
  description: 'Cancel an in-flight task you previously dispatched.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['task_id'],
  },
}
```

## Phasing

Single MVP. Slack-first by design — non-thread channels degrade to internal-only sessions (the fallback path described above in step 5c). Per /team-review S12, honest critical path is **14-16 days**, not 12.

- Adapter `createThread` is added as an **optional** method on `ChannelAdapter` with a `supportsCreateThread: boolean` capability flag (mirrors `setTyping?`, `deleteMessage?`, `subscribe?` convention). Adapters without thread support compile unchanged; channels-branch adapters opt in at their own pace.
- Slack and Discord adapters live **in trunk** (`src/channels/slack.ts`, `src/channels/discord.ts`) — implementation work happens there, not on the channels branch. The relevant chat-sdk surface is in `src/channels/chat-sdk-bridge.ts`.

Future spec (out of scope here): per-child git worktree manager. Until that ships, the orchestrator's job is to either constrain dispatch to disjoint file scopes or sequence code-touching tasks via `blocked_on` chains. The `file_scope` advisory field on dispatch_task supports this; conflict-checking is the orchestrator's responsibility.

## Dashboard

Vite + React + TypeScript SPA, bundled and served from the existing Node host on `127.0.0.1:7457` via Node's built-in `http` module (closes /team-review M1 — `undici` is client-only and would not work as a server). One SSE endpoint, ~8 JSON endpoints, and a static handler for the built bundle. Reads `data/v2.db` and per-session DBs directly via `better-sqlite3` — no new API service, no separate process.

UI/UX specification: see [`./ui-design.md`](./ui-design.md).

### Auth (closes /team-review M3)

Three layers, all required for mutating endpoints:

1. **Bind** to `127.0.0.1` only. Never `0.0.0.0`. Verified by an integration test.
2. **Bearer token**: random 32-byte token generated at host startup, written to `logs/dashboard-token.log` (visible in setup output). Required in `Authorization: Bearer <token>` header on every mutating request (POST/PATCH/DELETE) and on every SSE connection. Read endpoints (GET) can skip the bearer check for simplicity but still enforce Origin and Host below.
3. **`Origin` header allowlist**: only `http://127.0.0.1:7457` accepted on mutating endpoints. Defeats cross-origin POSTs from any other tab.
4. **`Host` header allowlist**: only literal `127.0.0.1:7457` accepted on every request. Defeats DNS rebinding attacks.

Token rotation: regenerated on host restart. The owner re-enters it in the dashboard's settings or refreshes the tab; old tabs prompt for the new token.

### Memory budget

| Component | Estimated RSS |
|---|---|
| Node `http` server (built-in) + SSE handler | ~5MB (negligible — same event loop as host) |
| Vite production bundle (static, served from disk) | 0MB resident — files are mmap'd by kernel as needed |
| In-process route + middleware (better-sqlite3 reads, owner-check) | ~10MB |
| React runtime in browser tab | not on host |
| Total **additional resident** on the host process | ~15-20MB |

The 150MB constraint (G5) is satisfied with ~10x headroom. Lower than the ~135MB previous estimate because there's no separate Node.js process for the dashboard — the SPA is a static bundle served from the existing host event loop. Verified by SC7 (`ps` snapshot).

### Real-time updates (closes /team-review M9)

**No file-watching, no chokidar, no fsevents.** The host process is already the sole reader of `outbound.db` (`src/delivery.ts` polls). Piggyback an SSE event emitter on that same code path — when the host's existing read loop ingests a new `messages_out` row that's relevant to a watched task, push the event over SSE to connected dashboard clients.

Single read code path → no second observer of the file system → no platform divergence (no FSEvents/inotify quirks) → no per-write CPU duplication. Closes both `M9` (chokidar/fsevents unreliable on macOS for SQLite WAL writes per anthropics/claude-code#16523) and the SSE-vs-WebSocket inconsistency (one transport: SSE).

Event types pushed: `task.created`, `task.dispatched`, `task.running`, `task.message` (new outbound row), `task.tool_started`, `task.tool_finished`, `task.completed`, `task.failed`, `approval.requested`.

Dashboard side uses TanStack Query's userland SSE pattern: a single `EventSource` maintains the connection; on each event, the handler calls `queryClient.setQueryData(['tasks', ...], updater)` to merge the patch. `useQuery` consumers re-render automatically. (No first-class `useSSEQuery` hook exists in TanStack Query — closes /team-review S6.)

Reconnection: 1s → 2s → 5s → 5s backoff. On reconnect, dashboard re-queries the `tasks` table and the in-flight `processing_ack` view to redraw from authoritative DB state (closes /team-review S7 — covers host restart). Connection-loss UI per `ui-design.md` § 5.

### DB connection discipline

Dashboard opens session DBs on demand and closes after each query (mirrors `src/session-manager.ts:355` "do not refactor to reuse a long-lived connection"). No connection pool, no long-lived per-session handles. Closes /team-review S11.

## Implementation order

Single MVP, **~14-16 focused days** on the critical path (closes /team-review S12). Steps grouped by dependency layer.

| # | What | Where | Effort |
|---|---|---|---|
| 1 | `agent_roles` migration + helpers | `src/db/migrations/`, `src/db/agent-roles.ts` | 0.5 day |
| 2 | `tasks` + `task_dependencies` migrations + helpers (incl. idempotency_key, dispatch_state, completion_nonce, model/effort/file_scope columns) | `src/db/migrations/`, `src/db/tasks.ts` | 1 day |
| 3 | Owner approval flow for granting orchestrator role | `src/modules/approvals/` | 0.5 day |
| 4 | `createThread?` capability — Slack adapter + chat-sdk-bridge integration | `src/channels/slack.ts`, `src/channels/chat-sdk-bridge.ts`, `src/channels/adapter.ts` (interface change) | 1.5 days |
| 5 | `createThread?` capability — Discord adapter | `src/channels/discord.ts` | 1 day |
| 6 | `dispatch_task` + `task_complete` + `cancel_task` MCP tools (container side) | `container/agent-runner/src/mcp-tools/` | 1.5 days |
| 7 | Host module `src/modules/orchestrator-dispatch/`: `applyDispatchTask` (with state machine + idempotency + credential pre-flight + concurrency caps), `applyTaskComplete` (with auth check + 2-write fan-out + dependency unblock), `extend_deadline` handler | new module | 3 days |
| 8 | Watchdog: stuck-dispatch reconciler + running-state detector + deadline expiry (running + pending) + parent-orphan + cancellation propagation | `src/host-sweep.ts` | 1 day |
| 9 | E2E test: orchestrator dispatches 3 Slack tasks (one with deps), owner steers one mid-flight via subthread, all complete, results route back to both subthread + parent, dependent task fires; chaos test — kill host mid-dispatch, restart, reconciler resumes | `src/modules/orchestrator-dispatch/*.test.ts` | 1.5 days |
| 10 | Dashboard server (Node `http`): bearer token auth, Origin/Host allowlist, owner check, JSON endpoints | `src/dashboard/server.ts` (new) | 1.5 days |
| 11 | Dashboard SSE event emitter on host's existing outbound read path | `src/dashboard/sse.ts`, hook into `src/delivery.ts` | 1 day |
| 12 | Dashboard SPA skeleton (Vite+React, Tasks view, TanStack Query SSE integration) | `src/dashboard/web/` (new) | 1.5 days |
| 13 | Dashboard Task Detail view: transcript, steer composer, ToolCallTicker, Inspector | `src/dashboard/web/` | 2 days |
| 14 | Dashboard Agents + Settings views, connection-loss state, 404 view, accessibility primitives | `src/dashboard/web/` | 1.5 days |

**Total: ~14-16 days focused.** One ship gate.

Sequencing notes:
- Steps 1–3 are independent and parallelizable.
- Steps 4–5 (adapter work in trunk) can run in parallel with 1–3.
- Steps 6–9 (dispatch + watchdog + tests) depend on 1–5.
- Steps 10–14 (dashboard) are independent of steps 6–9 for skeleton work but can't reach live data until step 7 lands. Plan for stubbed-data dashboard development through step 11; switch to live data after step 7.

## Risks

- **R1** (Codex H1, design): Ad-hoc destination resolution at dispatch time vs the existing `agent_destinations` projection model. **Mitigation**: orchestrator-dispatch is a totally separate module that doesn't touch `agent_destinations` or container-side `inbound.db.destinations`. Lazy host-side lookup of target by folder, scoped only to the dispatch_task action.
- **R2** (Codex M2, design): Folder names in `platform_id`. **Mitigation**: dispatch_task accepts a folder name (human-friendly) but the host immediately resolves it to an `agent_group_id` and uses the ID throughout. Folder is never persisted in any message column.
- **R3** (Codex H6, design): Orchestrator session disappears mid-task. **Mitigation**: explicit `orphaned` status in the watchdog. Owner is DM'd via user_dms cache so the result isn't silently lost.
- **R4** (review S2): Child session credential posture — children spawn in target groups whose OneCLI agents may have `selective` mode + zero secrets. **Mitigation**: dispatch flow step 3f pre-flights this and fails the dispatch with a structured error rather than launching a doomed task.
- **R5** (revised per review S4): Concurrency. 22 dispatched tasks = 22 containers; single host might thrash. **Mitigation**: TWO concurrency caps applied together: (a) per-orchestrator-session cap (default 6 concurrent dispatched/running) protects against multi-orchestrator misuse; (b) per-target-group cap (default 3 concurrent containers per group) protects the documented use case (parallel work in one group). Excess tasks stay `pending` and pick up as slots free.
- **R6**: Prompt injection getting an orchestrator agent to dispatch malicious tasks. **Mitigation**: `orchestrator` role grant is owner-approved (one-time), the role is on the agent group not on individual prompts, the orchestrator agent's CLAUDE.md explicitly defines its dispatch policy. Defense in depth: an optional per-dispatch approval gate (configurable on the orchestrator group), surfacing a click-approve card before any task fires.
- **R7** (review M3): Browser-based local attack on dashboard via DNS rebinding or drive-by CSRF. **Mitigation**: bearer token + Origin allowlist + Host allowlist, all required (see Dashboard § Auth).
- **R8** (review M5): Compromised or prompt-injected agent forging task_complete to corrupt task ledger. **Mitigation**: completion_nonce required in task_complete payload, plus server-side checks on child_session_id and target_agent_group_id matching the recorded task (Reverse signal step 2a).
- **R9** (review M7): Crash mid-dispatch leaves orphaned platform threads or unrecoverable task rows. **Mitigation**: idempotency_key + dispatch_state state machine + watchdog reconciler (Dispatch flow step 5 + Watchdog step 1).

## Open questions

Resolved in cycle 2 revision (closed inline above):
- ~~OQ2~~ — Per-task model/effort: now in MVP via `model` and `effort` parameters on dispatch_task (closes /team-review S5).
- ~~OQ3~~ — Cancellation: now in MVP via separate `cancel_task` MCP tool + watchdog step 6 (closes /team-review S9).

Still open:
- **OQ1**: Should `dispatch_task` support `replyto` semantics — i.e., can a non-orchestrator child agent dispatch a follow-up task back to the orchestrator? **Default**: no, only orchestrator-role agents can dispatch. Children report status via `task_complete`, period. Revisit if the workflow surfaces a real need.
- **OQ4**: Multi-orchestrator coordination. If two different orchestrator agent groups both dispatch to the same target — collisions on threads, on tasks ledger, on dependency chains? **Out of scope for v1**; assume single orchestrator practice. The `task_dependencies` same-`parent_session_id` constraint already enforces no cross-orchestrator deps; broader coordination (e.g. shared per-target-group cap) would need a follow-up spec.

## Appendix: alternatives considered

- **Multica as dispatch + dashboard**: rejected (memory cost ~400-700MB, daemon model fights ephemeral containers, ripping the UI is comparable cost to building from scratch).
- **Beads as task ledger**: rejected (Codex H7: task state must be durable host data; Beads is git-versioned per-repo and doesn't model the orchestration relationships we need; community UIs are passion projects with varying maintenance).
- **Reuse `agent-to-agent` and just add a "create subthread" flag**: rejected (the destinations ACL model and threading inheritance are wrong shapes — see Problem section).
- **Slack-only orchestration via threaded messages, no host-side tasks table**: rejected (no resilience to container crashes; no reverse-signal handling for dependency chains; no way to surface stale tasks beyond Slack's own thread UX).
- **`undici` HTTP server**: rejected — `undici` is a client-only library; there's no server export. Use Node's built-in `http` (already used in `src/webhook-server.ts`).
- **`geist` font npm package**: rejected — `geist@1.x` requires Next.js peer dep and imports `next/font/local` internally. Use `@fontsource-variable/geist` instead; works with any bundler.
- **`chokidar` watching session DBs for SSE push**: rejected — fsevents on macOS doesn't reliably fire on SQLite WAL writes (`anthropics/claude-code#16523`); duplicates work the host already does in `delivery.ts`. Emit SSE from the existing read path instead.
- **`blocked_on_task_ids` as JSON array on tasks**: rejected — SQLite indexes don't help with JSON containment, dependency-fanout query becomes full scan; no FK enforcement; same-parent-session constraint can't be enforced. Use `task_dependencies` join table.
- **WebSocket transport for dashboard**: rejected — SSE is sufficient (server→client only) and matches the simpler reconnection semantics; Node `http` doesn't ship WebSocket; matches LoadFlux reference architecture (T3 source from /best-practice-check).
