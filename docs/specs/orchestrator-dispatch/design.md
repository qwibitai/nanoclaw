# Orchestrator Dispatch

**Status**: design — cycle 3 (revised against `/team-review` cycle 2 findings)
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
- **G4**: Reverse signal: child reports completion → orchestrator notified → dependent tasks unblock automatically (success path) or fail-propagate (terminal-non-success path).
- **G5**: Memory budget for the dashboard ≤ 150MB additional resident on the host. No new background services beyond the existing Node host.
- **G6**: Dispatch is retry-safe — a crash mid-flow leaves no orphaned platform threads under normal conditions; the residual orphan window (host crash between adapter call returning and DB commit, ~milliseconds) is logged and surfaced to the owner for manual cleanup.
- **G7**: Dispatch and completion are authenticated entirely on server-side identity; no auth data passes through the LLM context window where prompt injection could exfiltrate it.

## Non-goals

- **NG1**: No multi-user dashboards. One owner, local only.
- **NG2**: No autopilot agent picking up work without a human kicking it off — the orchestrator is initiated by the owner each time.
- **NG3**: No agent-to-agent dispatch by non-orchestrator agents. The dispatch capability is gated by an explicit role.
- **NG4**: No worktree/branch isolation manager in this design. Code-touching parallel work is the orchestrator's responsibility to sequence (via `blocked_on` chains). Worktree isolation is a separate future spec.
- **NG5**: No replacement for or merge with `agent-to-agent` / `create_agent`. Both stay as-is for the hierarchical-subagent pattern.
- **NG6**: Dashboard surfaces orchestrator-dispatched tasks only. Pre-existing `agent-to-agent` (`create_agent`) subagent sessions are not displayed.
- **NG7**: No analytics view, no cost/token ticker.
- **NG8**: No external access. Localhost-only; no public URL, no tunnel, no SSO.
- **NG9**: No mobile / phone surface for the dashboard. Slack already serves that role.

## Verified constraints

| # | Type | Source | Finding | Implication |
|---|---|---|---|---|
| C1 | **HARD** | `delivery.ts:358-364` + `session-manager.ts:340` | Outbound `msg.thread_id` passes straight to `deliveryAdapter.deliver(...)`. Synthetic thread_ids fail Slack/Discord delivery. | Child session with `messaging_group_id IS NOT NULL` MUST have a real platform thread_id. Synthetic IDs (`task-<id>`) only valid when `messaging_group_id IS NULL`. |
| C2 | **HARD** | `src/channels/adapter.ts` | Adapter contract has no `createThread` capability. | New adapter capability required, added as **optional** method (`createThread?:`) with a `supportsCreateThread: boolean` flag. |
| C3 | SOFT | Multica repo | Multica = Postgres+pgvector + Go + Next.js. ~400-700MB resident. | Multica is too heavy. Build a custom Vite SPA served from the existing Node host. |
| C4 | **HARD** (defense in depth) | `src/db/migrations/024-sessions-channel-root-unique.ts` | `UNIQUE(agent_group_id, messaging_group_id) WHERE thread_id IS NULL AND messaging_group_id IS NOT NULL`. | Documentation/invariant only. The dispatch flow's two paths (channel-surface = both fields non-null; fallback = `mg_id IS NULL`) cannot violate this constraint by construction. The active failure mode the cycle-1 review flagged is reconciler replay safety, addressed under "Dispatch flow" + "Reconciler" below. |
| C5 | **HARD** | CLAUDE.md | Host is sole inbound writer. Container is sole outbound writer. | Reverse signal's owner-facing chat write must NOT write to the child's outbound.db; instead, host calls `deliveryAdapter.deliver(...)` directly. |
| C6 | **HARD** | CLAUDE.md | One writer per session DB file; multi-reader within one process is fine. | Dashboard read access is allowed; no second writer anywhere. |
| C7 | **HARD** | Browser EventSource API | Native browser `EventSource` does not allow setting custom request headers. | Bearer token cannot authenticate SSE connections via header. Use a `HttpOnly` session cookie set after token entry; SSE authenticates via cookie. |

## Architecture

### Data model

Three new tables in the central DB (`data/v2.db`).

#### `agent_roles`

Mirrors the existing `user_roles` pattern. Owner-approved, set once. A single agent group can hold zero or more roles concurrently.

```sql
CREATE TABLE agent_roles (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  role           TEXT NOT NULL,           -- 'orchestrator' (extensible)
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, role)
);
```

#### `tasks`

The orchestration ledger. Source of truth — task state is durable.

```sql
CREATE TABLE tasks (
  task_id              TEXT PRIMARY KEY,
  idempotency_key      TEXT NOT NULL,       -- mandatory (host-generated if orchestrator omits)
  parent_session_id    TEXT NOT NULL REFERENCES sessions(id),
  parent_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  child_session_id     TEXT REFERENCES sessions(id),
  target_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  title                TEXT NOT NULL,
  prompt               TEXT NOT NULL,

  -- State machine (see Dispatch flow + Reverse signal)
  status               TEXT NOT NULL DEFAULT 'pending',
                       -- pending | dispatching | dispatched | running | complete | failed | cancelled
                       -- 'dispatching' is the new intermediate state covering
                       -- the multi-step dispatch flow; reconciler scans
                       -- ('dispatching','dispatched','running') for stuck
                       -- tasks. Concurrency caps count 'dispatching' as a slot.
                       -- (M10 cycle 2)
  dispatch_state       TEXT,
                       -- For status IN ('dispatching','dispatched'):
                       -- NULL | session_created | prompt_injected | wake_sent
                       --       | parent_posted | thread_created | dispatched
                       -- Note ordering: internal-only steps first
                       -- (session_created → prompt_injected → wake_sent), then
                       -- platform side effects (parent_posted → thread_created),
                       -- then terminal 'dispatched'. (M5 cycle 2 reorder.)
  external_thread_id   TEXT,                -- platform thread_id (Slack thread_ts, Discord thread channel id)
  external_message_id  TEXT,                -- platform parent message id

  -- Behavior knobs
  model                TEXT,
  effort               TEXT,
  file_scope           TEXT,                -- JSON; advisory only (NG4)

  deadline             TEXT NOT NULL,       -- mandatory; default 4h from spawn (S11 cycle 2)
  deadline_extensions  INTEGER NOT NULL DEFAULT 0,

  spawned_by_user_id   TEXT REFERENCES users(id),
  spawned_at           TEXT NOT NULL,
  started_at           TEXT,
  running_at           TEXT,
  completed_at         TEXT,
  result_summary       TEXT,
  failure_reason       TEXT,

  -- Parent-delivery state (separate from task status; M13 cycle 2)
  -- The task's terminal status (complete/failed/cancelled) is preserved;
  -- "orphaned" describes the failure to deliver the result to the parent
  -- session, not the task's own outcome.
  parent_delivery_state TEXT NOT NULL DEFAULT 'pending',
                       -- pending | delivered | orphaned
  orphaned_at          TEXT,
  owner_dm_sent_at     TEXT
);
CREATE UNIQUE INDEX idx_tasks_idempotency
  ON tasks(parent_session_id, idempotency_key);
CREATE INDEX idx_tasks_parent ON tasks(parent_session_id, status);
CREATE INDEX idx_tasks_child  ON tasks(child_session_id);
CREATE INDEX idx_tasks_status ON tasks(status, deadline);
CREATE INDEX idx_tasks_inflight
  ON tasks(dispatch_state, spawned_at)
  WHERE status IN ('dispatching','dispatched');  -- reconciler scan
CREATE INDEX idx_tasks_orphan_pending
  ON tasks(parent_delivery_state, completed_at)
  WHERE parent_delivery_state = 'pending' AND status IN ('complete','failed','cancelled');
```

Note on `completion_nonce`: cycle-2 review S3 surfaced that the cycle-1 nonce was passed through the LLM context (banner → child agent → MCP tool call), creating a prompt-injection vector that could exfiltrate it. The four server-side authorization checks (child_session_id match, target_agent_group_id match, status guard, single-call enforcement) are sufficient and don't depend on child-supplied data. **Nonce dropped.** G7 (auth on server-side identity only) reflects this.

#### `task_dependencies`

Edge table; one row per dependency edge.

```sql
CREATE TABLE task_dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  blocked_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  PRIMARY KEY (task_id, blocked_on_task_id),
  CHECK (task_id != blocked_on_task_id)
);
CREATE INDEX idx_task_deps_blocked_on ON task_dependencies(blocked_on_task_id);

-- Cross-parent-session linkage prevention (S5 cycle 2)
-- Cross-orchestrator-session dependencies are not allowed; would be a
-- tenant-isolation break. Enforced at the DB level so non-handler paths
-- (test fixtures, migrations, scripts) can't violate it.
CREATE TRIGGER task_deps_same_parent BEFORE INSERT ON task_dependencies
BEGIN
  SELECT RAISE(ABORT, 'cross-parent dependency forbidden')
  WHERE (SELECT parent_session_id FROM tasks WHERE task_id = NEW.task_id)
      != (SELECT parent_session_id FROM tasks WHERE task_id = NEW.blocked_on_task_id);
END;
```

### Dispatch flow

Multi-step procedure with mandatory idempotency, persistent dispatch_state, and **internal-side-effects-first ordering** (M5 cycle-2 reorder). External platform side effects happen LAST so a crash before them leaves zero external state. The residual orphan window is the time between adapter call returning and DB commit (~milliseconds — not zero, but bounded; see G6).

```
[1] Orchestrator container calls dispatch_task MCP tool with:
      target_group:     <folder name>
      title:            "XZO-54: redeploy UDTF_GET_DEPLETIONS_FORECAST"
      prompt:           <full task brief>
      idempotency_key:  <orchestrator-generated; mandatory>
      deadline:         <ISO timestamp; defaults to spawn_time + 4h if omitted>
      blocked_on:       <optional list of task_ids>
      model:            <optional; passed through to child container>
      effort:           <optional; 'low' | 'medium' | 'high'>
      file_scope:       <optional advisory globs — NG4>

[2] Container writes outbound system action `dispatch_task` to outbound.db.
    (Container is sole writer of outbound.db — invariant preserved.)

[3] Host's delivery.ts system-action dispatch routes to applyDispatchTask
    handler. Host validates:
      a. Source session's agent_group has 'orchestrator' role in agent_roles.
         RE-CHECKED PER DISPATCH (defense in depth — closes the role-revocation
         staleness window that container-side mounting can't close).
      b. target_group folder maps to an existing agent_groups row.
      c. blocked_on task_ids exist AND share the same parent_session_id
         (DB trigger enforces; handler validates first for better error
         message).
      d. (idempotency) If (parent_session_id, idempotency_key) already
         exists, return the existing task_id without inserting. Mandatory
         per G6.
      e. (credential pre-flight) Target agent group's OneCLI agent identity
         has secrets attached OR mode='all'. If mode='selective' with zero
         secrets, fail dispatch with structured error.
      f. (per-orchestrator-session pending-task cap, default 50 — S7 cycle 2)
         Count tasks for this parent_session_id with status='pending' OR
         status IN ('dispatching','dispatched','running'). If >= cap, fail
         dispatch with structured error. Distinct from the running cap;
         protects against runaway dispatch_task calls polluting the ledger.

[4] Insert tasks row with status='pending', dispatch_state=NULL,
    parent_delivery_state='pending'. Insert task_dependencies rows for
    blocked_on. Apply default deadline (now + 4h) if omitted.

[5] Schedule attempt. Re-checked at end of step 5 and by the watchdog
    pending scheduler:
      - All blocked_on prerequisites status='complete' (success path)?
      - Per-orchestrator-session running cap (default 6) under?
      - Per-target-group running cap (default 3) under?
    If any answer is no, leave at status='pending'; pending scheduler
    will pick up when conditions change.

[6] Internal-only steps first (no external side effects yet):
    Step 6a:
      - Transition status='dispatching' (visible to reconciler immediately).
    Step 6b — session_created:
      - resolveSession(target_agent_group_id, mg_id, thread_id_placeholder, mode):
          Channel surface (adapter.supportsCreateThread): mg_id = orchestrator_mg,
                                                          thread_id_placeholder = 'pending-<task_id>',
                                                          mode='per-thread'
          Fallback (no thread support):                   mg_id = NULL,
                                                          thread_id = 'task-<task_id>',
                                                          mode='per-thread'
        For the channel-surface case, thread_id is a temporary placeholder
        that will be replaced with the real platform thread_id at step 7
        (atomic update inside the same transaction). If a crash happens
        before step 7, the reconciler can detect the placeholder and either
        retry the platform post or mark the task failed.
      - Update tasks: child_session_id, dispatch_state='session_created'.
    Step 6c — prompt_injected:
      - writeSessionMessage(child) injects system banner + task prompt
        (see "Per-session MCP tool mounting" below for what the banner
        contains).
      - dispatch_state='prompt_injected'.
    Step 6d — wake_sent:
      - wakeContainer(child).
      - dispatch_state='wake_sent'.

[7] Platform side effects (only after internal steps committed):
    Step 7a — parent_posted (channel-surface only):
      - Post "Launched task <title>" parent message via
        adapter.deliver(...) using messaging_group_id from the orchestrator's
        session and the orchestrator's thread_id. Persist
        external_message_id atomically with dispatch_state='parent_posted'.
    Step 7b — thread_created (channel-surface only):
      - adapter.createThread(messagingGroupId, parentMessageId, title,
        firstMessage) returns { threadId, messageId }.
      - Update tasks: external_thread_id=<real>, sessions row's thread_id
        replaces the 'pending-<task_id>' placeholder atomically with
        dispatch_state='thread_created'.

[8] Final commit:
      - Update tasks: status='dispatched', started_at=now,
        dispatch_state='dispatched'.

[9] When the child container's first non-status outbound row appears, host
    transitions status='running' AND running_at=now.
```

**Reconciler (host-sweep)**: scans `idx_tasks_inflight` for rows past 60s without progress.
- `dispatch_state` IN (NULL, 'session_created', 'prompt_injected'): all internal; safe to retry from the last persisted step (resolveSession is a lookup; writeSessionMessage is idempotent on `(session_id, message_id)`).
- `dispatch_state='wake_sent'`: container received wake but did not start running; re-wake.
- `dispatch_state='parent_posted'`: the parent platform message exists but createThread didn't run. Retry createThread; if the adapter reports the thread already exists for the same parent message, reuse.
- `dispatch_state='thread_created'`: only the final commit (step 8) didn't happen. Just commit it.

**Residual orphan window**: a host crash between an adapter call returning successfully and DB write committing (~milliseconds). When the reconciler sees `dispatch_state` at the prior step but the adapter would report "already done," it recovers. When the adapter has no "already done" lookup (Slack threads addressed by `(channel, ts)` we never persisted), the reconciler logs `"untracked external thread possibly created"` and surfaces it to the dashboard for manual cleanup. G6 honestly admits this narrow window.

### Reverse signal

When the child finishes, completion writes happen across two surfaces (child subthread + parent system) without violating the two-DB invariant. Internal logic refactored into `_completeTaskCore` so the watchdog can reuse it without auth-bypass parameters (S6 cycle 2).

```
[1] Child container writes outbound system action `task_complete` with:
      task_id:        <from initial banner>
      status:         'complete' | 'failed'
      summary:        <markdown, owner-facing>
      failure_reason: <optional, machine-readable>

[2] Host's applyTaskComplete is a thin authorization wrapper:

    AUTHORIZATION (server-side identity; G7 — no nonce, no LLM-context data):
      Look up tasks row by task_id. Verify ALL of:
        - task exists
        - task.status IN ('dispatched','running')
        - task.child_session_id == source session id (host knows from the
          outbound.db's location on disk)
        - task.target_agent_group_id == source session's agent_group_id
      If any check fails: log security warning, drop, no update.

    Call _completeTaskCore(task, status, summary, reason).

[3] _completeTaskCore (called by both applyTaskComplete and watchdog):

    a. UPDATE tasks SET status, completed_at, result_summary, failure_reason
       WHERE task_id = ? AND status IN ('dispatched','running').
       (Status guard prevents double-complete races.)

    b. CHILD SUBTHREAD WRITE (M8 cycle 2 — does NOT violate two-DB invariant):
       If task has external_thread_id AND messaging_group_id (channel
       surface): host calls deliveryAdapter.deliver(channelType, platformId,
       external_thread_id, 'chat', summary) directly. Same path as the
       dispatch flow's parent message post. Bypasses any session DB.
       If fallback mode (no channel surface): skip. Dashboard is the only
       completion surface for those tasks.

    c. PARENT SYSTEM WRITE (S1 cycle 2 — explicit API):
       writeSessionMessage(parent_session.agent_group_id, parent_session_id, {
         kind: 'system', trigger: 1, channelType: null, platformId: null,
         threadId: null, content: <result summary system action>
       })
       The recall pipeline is no-op for kind='system'; this is the
       wake-the-orchestrator write.

    d. Update parent_delivery_state='delivered' if step c succeeded.

    e. DEPENDENCY FAN-OUT (M12 cycle 2 — propagate terminal-non-success):
       If status == 'complete':
         - SELECT task_id FROM task_dependencies WHERE blocked_on_task_id = ?
           For each: if all prerequisites are 'complete', re-attempt
           dispatch (re-enter step 5 of dispatch flow).
       If status IN ('failed','cancelled'):
         - SELECT task_id FROM task_dependencies WHERE blocked_on_task_id = ?
           For each: transition that task to 'failed' with
           failure_reason='blocked dependency <task_id> ' + status + ': ' + ?
           Recursively propagate (transitive closure, single transaction).

    f. wakeContainer(parent_session) so the orchestrator sees the new
       system row and can fan out further work.
```

### Watchdog (host-sweep extension)

Runs every 60s in `src/host-sweep.ts`. **Plus a startup pass** that runs immediately on `startHostSweep()` — covers the host-restart case so in-flight tasks don't wait up to 60s for resumption (S9 cycle 2). All scans inside one transaction.

1. **Stuck-dispatch reconciler** (`status IN ('dispatching','dispatched')` AND `dispatch_state` non-terminal AND `spawned_at < now-60s`): resume per dispatch flow's reconciler rules.
2. **Running-state detector** (`status='dispatched'` AND `dispatch_state='dispatched'` AND child has any non-status outbound row newer than `started_at`): transition `status='running'`, `running_at=now`.
3. **Pending-task scheduler** (M6 cycle 2): for each `tasks` row with `status='pending'` AND no unmet dependencies AND under both running caps AND under the per-orchestrator-session pending cap, re-enter dispatch flow at step 5.
4. **Deadline expiry — running tasks** (`status IN ('dispatching','dispatched','running')` AND `deadline < now` AND `deadline_extensions < MAX_EXTENSIONS`): call `_completeTaskCore(task, 'failed', '', 'timeout after N extensions')` — same code path as voluntary completion. Single completion code path; auth is handled by being host-emitted (no auth-bypass parameter needed because `_completeTaskCore` doesn't have auth).
5. **Deadline expiry — pending tasks**: `status='pending'` AND `deadline < now`: call `_completeTaskCore(task, 'failed', '', 'deadline expired before dispatch (blocked or capped)')`.
6. **Idle-child detector** (S11 cycle 2): for each `status='running'` task whose child session has had no outbound row for `IDLE_THRESHOLD` (default 30 minutes) AND `deadline > now+5min`, write a `kind='system'` inbound to the child session: "This task has been idle for N minutes. If complete, call `task_complete` now. Otherwise continue or call `extend_deadline`." Increments an `idle_pings` counter (cap 2) to prevent spam.
7. **Parent-orphan recovery** (M13 cycle 2 — does NOT overwrite status): rows where `parent_delivery_state='pending'` AND `status IN ('complete','failed','cancelled')` AND `parent_session` is no longer active. Set `parent_delivery_state='orphaned'`, `orphaned_at=now`. DM the owner via `user_dms` cache; set `owner_dm_sent_at=now`. Status remains the actual terminal outcome.
8. **Cancellation propagation**: `status='cancelled'` AND child container is running. Write a `kind='system'` inbound terminate to the child.

### Per-session MCP tool mounting (M2 cycle 2)

Without a host→container channel for tool gating, `dispatch_task`/`task_complete`/`extend_deadline`/`cancel_dispatched_task` would register globally for every session in every group. Fix: a per-session allowlist file written by the host at spawn time.

**Mechanism**:
- At `spawnContainer`, host writes `data/v2-sessions/<agent-group-id>/<session-id>/enabled_tools.json`:
  ```json
  {
    "orchestrator_dispatch": ["dispatch_task", "extend_deadline", "cancel_dispatched_task"],
    "task_completion": ["task_complete"]
  }
  ```
  Categories present iff the session qualifies:
  - `orchestrator_dispatch`: source session's agent group has `orchestrator` role in `agent_roles`.
  - `task_completion`: the session has a `tasks` row with `child_session_id = <this session>`.
- `container/agent-runner/src/mcp-tools/index.ts` reads this file at MCP server start. Tools opt in by category; if their category isn't in the allowlist, they don't register.
- Host re-writes the file on every wake (so role grants/revocations and task assignments take effect on next wake).
- Defense in depth: each handler still validates server-side (orchestrator role re-check on dispatch; task ownership check on completion). The allowlist is hint-level; the host-side checks are the boundary.

The first inbound message a dispatched child receives includes an explicit instruction: "When you finish this task, call `task_complete` with task_id=X and status=complete (or failed) and a summary."

### dispatch_task MCP tool (orchestrator-only)

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
      idempotency_key: { type: 'string', description: 'MANDATORY. Orchestrator generates one per logical task; second call returns existing task_id without re-firing.' },
      deadline: { type: 'string', format: 'date-time', description: 'Optional; defaults to spawn time + 4 hours' },
      blocked_on: { type: 'array', items: { type: 'string' }, description: 'task_ids that must complete before this dispatches' },
      model: { type: 'string', description: "Override target group's default model" },
      effort: { type: 'string', enum: ['low', 'medium', 'high'] },
      file_scope: { type: 'array', items: { type: 'string' }, description: 'Advisory glob patterns (NG4)' },
    },
    required: ['target_group', 'title', 'prompt', 'idempotency_key'],
  },
}
```

### task_complete MCP tool (child sessions, single-call)

Auto-mounted into any session whose `tasks.child_session_id` matches. Auto-unmounted after the first call.

```typescript
{
  name: 'task_complete',
  description: 'Signal completion of the task you were dispatched to do. Call this exactly once when finished, with status=complete and a summary, OR status=failed with a reason.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      status: { type: 'string', enum: ['complete', 'failed'] },
      summary: { type: 'string', maxLength: 8000 },
      failure_reason: { type: 'string' },
    },
    required: ['task_id', 'status', 'summary'],
  },
}
```

### extend_deadline MCP tool (child sessions)

Auto-mounted into any dispatched child session. Same authorization as `task_complete` (M9 cycle 2).

```typescript
{
  name: 'extend_deadline',
  description: 'Request an extension of your task deadline if you anticipate exceeding it.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      new_deadline: { type: 'string', format: 'date-time' },
      reason: { type: 'string' },
    },
    required: ['task_id', 'new_deadline'],
  },
}
```

Handler:
- Authorization: same as `task_complete` (`task.child_session_id == source` AND `task.target_agent_group_id == source.agent_group_id` AND task in non-terminal state).
- `deadline_extensions < MAX_EXTENSIONS` (default 3).
- `new_deadline > now`.
- Update tasks: `deadline = new_deadline`, `deadline_extensions += 1`.

### cancel_dispatched_task MCP tool (orchestrator-only)

Renamed from `cancel_task` to avoid collision with the existing `scheduling.ts:222` tool (M1 cycle 2). System action name `cancel_dispatched_task` to match.

```typescript
{
  name: 'cancel_dispatched_task',
  description: 'Cancel a task you previously dispatched. Sets task status to cancelled and notifies the child.',
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

Handler calls `_completeTaskCore(task, 'cancelled', '', reason)` and triggers the watchdog cancellation propagation step.

### model/effort precedence (M4 cycle 2)

`spawnContainer` looks up the task by `child_session_id` (single-session-id index lookup) and applies precedence:

```
task-level (tasks.model, tasks.effort) →
  wiring-level (messaging_group_agents.default_model/.default_effort) →
  agent-group-level (container.json) →
  host-level default
```

For fallback children (`messaging_group_id IS NULL`), the wiring-level skips and falls through directly to agent-group-level. For channel-surface children, the orchestrator's wiring is NOT consulted — task-level overrides take precedence; if absent, falls through to agent-group-level (skipping wiring intentionally — orchestrator's wiring isn't the dispatched child's preference).

## Phasing

Single MVP. **Slack-first by design** — non-thread channels degrade to internal-only sessions. Honest critical path: ~16-18 days now (cycle 2 added scope).

- Adapter `createThread` is an **optional** method on `ChannelAdapter` with a `supportsCreateThread: boolean` capability flag.
- Slack and Discord adapters live in trunk (`src/channels/slack.ts`, `src/channels/discord.ts`).

## Dashboard

Vite + React + TypeScript SPA, bundled and served from the existing Node host on `127.0.0.1:7457` via Node's built-in `http` module. Reads `data/v2.db` and per-session DBs directly via `better-sqlite3` — no new API service.

UI/UX specification: see [`./ui-design.md`](./ui-design.md).

### Auth

**Three layers, mandatory for mutating endpoints:**

1. **Bind** to `127.0.0.1` only.
2. **Token + cookie** (M11 cycle 2 — fixes the EventSource header limitation):
   - Random 32-byte token generated at host startup, written to `data/dashboard-token` (chmod 600), printed to setup output once. **Not in `logs/`** (M7 cycle 2).
   - On first dashboard load, the user enters the token via a setup endpoint. Server validates and issues an `HttpOnly`, `SameSite=Strict`, `Secure=false` (localhost) session cookie scoped to `/`. Cookie persists for the dashboard tab's lifetime.
   - **Mutating endpoints** accept either bearer token (CLI/curl path) OR session cookie (browser path).
   - **SSE connections** authenticate via the session cookie. (Browser `EventSource` API forbids custom headers — token-via-header doesn't work; cookie-via-Cookie does.)
3. **`Origin` header allowlist**: only `http://127.0.0.1:7457` accepted on mutating endpoints.
4. **`Host` header allowlist**: literal `127.0.0.1:7457` enforced on every request (defeats DNS rebinding).

Token rotation: regenerated on host restart. Old cookies become invalid; the dashboard prompts for the new token.

### Memory budget

| Component | Estimated runtime RSS |
|---|---|
| Node `http` server (built-in) + SSE handler | ~5MB (same event loop as host) |
| Vite production bundle (static, served from disk) | 0MB resident — kernel-mmap |
| In-process route + middleware (better-sqlite3 reads, owner-check) | ~10MB |
| Total **additional resident** on the host process | ~15-20MB |

G5 (≤150MB) satisfied with ~10x headroom.

**Install footprint** (S4 cycle 2 — separate from runtime budget): vite + esbuild + rollup add ~150-200MB to `node_modules` at install time. vite is a `devDependency`; production install via `--prod` or container builds skip it. The dashboard SPA is built once at install/upgrade time and served as static files at runtime.

### Real-time updates

Two emission points (M3 cycle 2):

1. **State changes** — `_completeTaskCore` and watchdog handlers emit events AFTER their DB transaction commits. Events: `task.created`, `task.dispatching`, `task.dispatched`, `task.running`, `task.completed`, `task.failed`, `task.cancelled`, `task.orphaned`.
2. **Transcript streaming** — a new `onDeliveredHook` in `delivery.ts:drainSession` fires after a chat row delivers. The hook checks `tasks.child_session_id = ?` for the row's session (single indexed lookup via `idx_tasks_child` — S10 cycle 2 filter); only emits `task.message` when the row exists. No firehose on non-task agent traffic.

The SSE bus is a new module (`src/dashboard/sse.ts`) holding a small subscriber registry. Subscribers are per-connection.

**Dashboard side** (S8 cycle 2 — handle reconnect race + backpressure):
- Single `EventSource` maintained. On each event, handler buffers the patch.
- On reconnect, dashboard re-queries authoritative `tasks` state via JSON endpoint. Buffered events are held until the requery resolves, then replayed through `queryClient.setQueryData(['tasks', ...], updater)`. Prevents the requery from clobbering live patches.
- Server-side: detect slow consumers via TCP write-buffer fullness. After threshold (e.g. 1MB buffered), close the SSE connection. Client reconnects with backoff (1s → 2s → 5s → 5s).
- Connection-loss UI per `ui-design.md` § 5.

### DB connection discipline

Dashboard opens session DBs on demand and closes after each query (mirrors `src/session-manager.ts:355`). No connection pool, no long-lived per-session handles. Closes cycle-1 S11.

## Implementation order

Single MVP. Honest critical path: ~16-18 focused days (cycle 2 added M2 mounting primitive, M3 SSE emission, M11 cookie session, M12 fail-propagation, M13 separate orphan column, S6 _completeTaskCore refactor, S11 idle-child detector — all genuine work).

| # | What | Where | Effort |
|---|---|---|---|
| 1 | `agent_roles` migration + helpers | `src/db/migrations/`, `src/db/agent-roles.ts` | 0.5 day |
| 2 | `tasks` + `task_dependencies` migrations + helpers (idempotency_key UNIQUE, dispatch_state, parent_delivery_state, model/effort, deadline default, same-parent trigger) | `src/db/migrations/`, `src/db/tasks.ts` | 1.5 days |
| 3 | Owner approval flow for granting orchestrator role | `src/modules/approvals/` | 0.5 day |
| 4 | `createThread?` capability — Slack adapter + chat-sdk-bridge | `src/channels/adapter.ts`, `src/channels/slack.ts`, `src/channels/chat-sdk-bridge.ts` | 1.5 days |
| 5 | `createThread?` capability — Discord adapter | `src/channels/discord.ts` | 1 day |
| 6 | Per-session MCP tool allowlist primitive (`enabled_tools.json` write at spawn; tool registration reads it) | `src/container-runner.ts`, `container/agent-runner/src/mcp-tools/index.ts` | 1 day |
| 7 | `dispatch_task` + `task_complete` + `cancel_dispatched_task` + `extend_deadline` MCP tools | `container/agent-runner/src/mcp-tools/` | 1.5 days |
| 8 | Host module `src/modules/orchestrator-dispatch/`: `applyDispatchTask` (state machine + reorder + idempotency + credential pre-flight + concurrency caps incl. pending), `_completeTaskCore` (status update + child subthread direct adapter delivery + parent system row + dependency fan-out incl. fail-propagation), `applyTaskComplete` (auth shim around _completeTaskCore), `applyExtendDeadline` (auth + cap + update), `applyCancelDispatchedTask` (cancel + propagation) | new module | 4 days |
| 9 | Watchdog: 8 scan steps + startup pass + idle-child detector | `src/host-sweep.ts` | 1 day |
| 10 | model/effort precedence in spawnContainer | `src/container-runner.ts` | 0.5 day |
| 11 | E2E + chaos test: 3-task dispatch with deps, owner steers via subthread, results route to subthread + parent, dependent fires; chaos test kills host between dispatch_state steps and verifies reconciler recovers; per-orchestrator and per-target-group caps verified | `src/modules/orchestrator-dispatch/*.test.ts` | 2 days |
| 12 | Dashboard server (Node `http`): bearer/cookie auth, Origin/Host allowlist, JSON endpoints, setup-token endpoint | `src/dashboard/server.ts` (new) | 2 days |
| 13 | SSE bus module + emission hooks at _completeTaskCore + delivery.ts onDeliveredHook + filter on tasks.child_session_id | `src/dashboard/sse.ts`, `src/delivery.ts` (hook) | 1.5 days |
| 14 | Dashboard SPA skeleton (Vite+React, Tasks view, TanStack Query SSE integration with reconnect buffering) | `src/dashboard/web/` (new) | 1.5 days |
| 15 | Dashboard Task Detail view: transcript, steer composer, ToolCallTicker, Inspector | `src/dashboard/web/` | 2 days |
| 16 | Dashboard Agents + Settings views, connection-loss state, 404 view, accessibility primitives | `src/dashboard/web/` | 1.5 days |

**Total: ~16-18 days focused.** One ship gate.

## Risks

- **R1**: Lazy host-side target lookup vs `agent_destinations` projection. Mitigation: orchestrator-dispatch is a separate module that doesn't touch `agent_destinations`.
- **R2**: Folder-name vs ID. Mitigation: handler resolves to ID immediately; folder is never persisted in any message column.
- **R3**: Orchestrator session disappears mid-task. Mitigation: explicit `parent_delivery_state='orphaned'` column (NOT a status overwrite); owner DM via `user_dms` cache.
- **R4**: Child session credential posture. Mitigation: pre-flight check fails dispatch with structured error.
- **R5**: Concurrency. TWO running caps + ONE pending cap apply: per-orchestrator-session running (default 6), per-target-group running (default 3), per-orchestrator-session pending (default 50). Excess running tasks stay pending; excess pending tasks fail dispatch with structured error.
- **R6**: Prompt injection getting an orchestrator agent to dispatch malicious tasks. Mitigation: orchestrator role grant is owner-approved (one-time); host re-checks role per dispatch (defense in depth); orchestrator's CLAUDE.md defines dispatch policy; pending cap (R5) bounds blast radius; G7 auth-via-server-side-identity means task_id leakage doesn't enable forgery.
- **R7**: Browser-based local attack via DNS rebinding/CSRF. Mitigation: bearer token + Origin allowlist + Host allowlist + cookie + 127.0.0.1 bind (4 layers).
- **R8**: Compromised agent forging task_complete. Mitigation: server-side identity checks (child_session_id, target_agent_group_id, status guard, single-call); G7 keeps auth out of LLM context.
- **R9**: Crash mid-dispatch. Mitigation: `dispatching` status visible to reconciler before any side effect; reorder so internal steps commit before external; reconciler resumes from last `dispatch_state`. Residual orphan window (host crash between adapter call returning and DB write) is logged and surfaced for manual cleanup; documented gap of G6.
- **R10**: Forgetful child agent doesn't call `task_complete`. Mitigation: deadline mandatory with 4h default; idle-child detector pings the agent at 30min; deadline-expiry path always fires within deadline + grace.
- **R11**: SSE reconnect race clobbers live state. Mitigation: client buffers events during requery, replays after.
- **R12**: SSE backpressure with slow client. Mitigation: server detects buffer fullness, closes connection; client reconnects.

## Open questions

Resolved in cycle 2:
- ~~OQ2~~ (model/effort): in MVP via `model`/`effort` parameters + precedence chain.
- ~~OQ3~~ (cancellation): in MVP via `cancel_dispatched_task` MCP tool.
- ~~completion_nonce~~: dropped per S3 — server-side identity is sufficient and avoids prompt-injection vector.

Still open:
- **OQ1**: `replyto` semantics for child→orchestrator follow-up dispatches. Default: no, only orchestrator-role agents can dispatch. Revisit if real workflow need surfaces.
- **OQ4**: Multi-orchestrator coordination. Out of scope for v1; assume single orchestrator practice. Same-`parent_session_id` constraint already enforces no cross-orchestrator deps.

## Appendix: alternatives considered

- **Multica**: rejected (memory cost, daemon model, ripping UI).
- **Beads as task ledger**: rejected (per-repo memory, not host orchestration ledger).
- **Reuse `agent-to-agent`**: rejected (wrong shape).
- **Slack-only orchestration without tasks table**: rejected (no resilience).
- **`undici` HTTP server**: rejected (client-only library; use Node `http`).
- **`geist` font npm package**: rejected (Next.js peer-dep; use `@fontsource-variable/geist`).
- **`chokidar` watching session DBs**: rejected (FSEvents on macOS unreliable for SQLite WAL; SSE from host's existing read path).
- **`blocked_on_task_ids` JSON array**: rejected (no FK, no index, no constraint enforcement; use `task_dependencies` join table).
- **WebSocket transport**: rejected (SSE simpler, matches LoadFlux reference architecture, works with `tanstack/query` userland pattern).
- **completion_nonce in banner/payload**: rejected cycle 2 (prompt-injection exfiltration vector; server-side identity is sufficient).
- **Bearer token in `logs/dashboard-token.log`**: rejected cycle 2 (logs are debug-share territory; use `data/dashboard-token` chmod 600).
- **Bearer-only SSE auth**: rejected cycle 2 (browser EventSource API forbids custom headers; use cookie set by setup endpoint).
- **Status overwrite to `orphaned`**: rejected cycle 2 (destroys terminal outcome; use separate `parent_delivery_state` column).
- **`completion_nonce` hash-stored**: rejected cycle 2 (only mitigates DB exfil, not the actual threat model of prompt-injection exfil; just drop the nonce).
