# Orchestrator Dispatch

**Status**: design draft, pre-build (10 MUST-FIX from `/team-review` cycle 1 open)
**Author**: Dave + Claude (Opus 4.7) + Codex (review)
**Last updated**: 2026-05-09

## Brief Reference

This design implements the requirements set out in [`./brief.md`](./brief.md). Specifically: R1–R14 (orchestrator dispatch primitive, per-task chattable threads, durable ledger, dependency chains, reverse signal, visibility dashboard, steering, watchdog, model/effort selection, cancellation, retry-safety, dispatch authorization, completion authorization). Constraints C1–C14 from `decisions.yaml` are the binding contract.

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

## Constraint Analysis

Reproduces the binding constraints (full text in `decisions.yaml`). Type column closes review finding S3.

| # | Type | Source | Finding | Implication |
|---|---|---|---|---|
| C1 | HARD | `delivery.ts:358-364` + `session-manager.ts:340` | Outbound `msg.thread_id` is passed straight to `deliveryAdapter.deliver(...)`. If the session has a synthetic thread_id, Slack/Discord posts will fail or land in the wrong place. | A child session with `messaging_group_id` set MUST have a real platform thread_id. Synthetic IDs only valid when `messaging_group_id IS NULL`. |
| C2 | HARD (per-platform — closes S6) | `router.ts:288, 592` + `src/channels/adapter.ts` | Adapter contract has no `createThread` or `getThreadId` capability. | **HARD** for thread-platform adapters (Slack, Discord) — MVP cannot ship without them implementing both new methods. **SOFT-fallback** for non-thread platforms (Telegram, iMessage, email) — no implementation required; orchestrator-dispatch routes those to internal-only mode. Both are **optional** with `supportsCreateThread` capability flag (mirrors existing `setTyping?` / `deleteMessage?` / `subscribe?` convention) so non-thread adapters compile unchanged. |
| C3 | SOFT | Multica repo | Multica = Postgres+pgvector + Go backend + Next.js frontend. ~400-700MB resident. | Too heavy for the dashboard budget (≤150MB). Build a custom Vite SPA. Reversible if budget changes. |
| C4 | HARD | `src/db/migrations/024-sessions-channel-root-unique.ts` (review M4) | `UNIQUE(agent_group_id, messaging_group_id) WHERE thread_id IS NULL AND messaging_group_id IS NOT NULL`. | Dispatch must never create a thread_id=NULL child with a non-NULL mg if a channel-root session already exists. Per-branch tuple discipline in §Phasing. |
| C5 | HARD | CLAUDE.md (two-DB invariant) | Host is sole inbound writer; container is sole outbound writer. | All inbound writes for child sessions go through host's `applyDispatchTask` / `applyTaskComplete`. Children only emit outbound system actions. **Existing controlled bypass**: `session-manager.ts:writeOutboundDirect` permits host-initiated outbound writes for system messages (already used for router acks; orchestrator-dispatch's M8 two-write reverse signal also uses this path — closes M5). |
| C6 | HARD | CLAUDE.md (single-writer-per-DB) | One writer per session DB file. Read-only opens from additional readers in the same process are allowed. | Dashboard reads `outbound.db`; must not introduce a second writer. |
| C7 | HARD | brief | Single owner. No multi-user dashboards. No multi-tenant authorization. | Auth model simplifies to localhost+token (C8). |
| C8 | HARD | brief (review M3 + C7) | Localhost-only dashboard. Bind to `127.0.0.1`. Owner bearer token (random, generated at host startup) on every API request. `Origin` allowlist on mutating endpoints. `Host` allowlist to defeat DNS rebinding. | Three-layer auth, not just port binding. |
| C9 | HARD | brief | ≤150MB additional RSS for the dashboard. | No PostgreSQL, no separate Go backend; Vite SPA + Node `http` only. |
| C10 | HARD | brief | No new long-running services. Dashboard runs in the existing Node host process. | HTTP server is `http`-module on the existing event loop. |
| C11 | HARD | brief | Slack-first owner workflow for child interaction. | Native Slack/Discord subthread is the primary surface; dashboard secondary. |
| C12 | HARD | brief | Existing `agent-to-agent` module untouched. Orchestrator-dispatch is a new sibling module at `src/modules/orchestrator-dispatch/`. | No refactor or merge of the hierarchical-subagent primitive. |
| C13 | SOFT | brief | Concurrency caps: 6 per orchestrator session AND 3 per target group. | Both apply; configurable per agent group. |
| C14 | SOFT | brief | Linear / Raycast / Arc lineage for the dashboard taste. | Documented in `ui-design.md`. |

### Flagged constraints

None — all 14 constraints validated as stated. No HARD/SOFT mismatches surfaced by review.

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
  idempotency_key      TEXT NOT NULL,
  parent_session_id    TEXT NOT NULL REFERENCES sessions(id),    -- orchestrator's session
  parent_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  child_session_id     TEXT REFERENCES sessions(id),             -- null until session resolved; bidirectional with sessions.dispatch_task_id (cycle-2 M2-A)
  child_thread_id      TEXT,                                     -- real platform thread id from adapter.createThread; null on internal-only fallback
  parent_platform_message_id TEXT,                               -- cycle-2 M2-D: persisted platform-side parent message id, used by reconciler for createThread idempotency
  target_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  title                TEXT NOT NULL,
  prompt               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
                       -- pending | dispatched | running | complete | failed | orphaned | cancelled
                       -- (cycle-2 M2-C: 'dispatched' is set ATOMICALLY by the cap-aware promoter
                       -- before any side effect, so cap counts include in-flight dispatching tasks
                       -- and authorize accepts fast completions before heartbeat)
  dispatch_state       TEXT NOT NULL DEFAULT 'pending',
                       -- pending | admitted | parent_posted | thread_created | session_created | prompt_injected | wake_sent | running
                       -- (cycle-3 M3-2: cap-promotion sets 'admitted' regardless of phase;
                       -- step 5 branches on adapter capability outside the cap transaction)
                       -- (cycle-3 M3-8: parent_posted is a NEW intermediate state — adapter contract
                       -- now has postParent() + createThreadFromParent() so the platform parent id
                       -- is durable before the thread call)
  dispatch_state_updated_at TEXT NOT NULL,
  dispatch_retry_count INTEGER NOT NULL DEFAULT 0,
  -- Completion finalization markers (cycle-1 M3 + cycle-2 M2-F refinements):
  dependents_released_at  TEXT,    -- fan-out to task_dependencies; written FIRST so parent message contains the final list
  dependents_unblocked_json TEXT,  -- cycle-3 M3-7: persists the released list itself (JSON array of task_ids); read by step d to populate parent message; survives crashes
  child_summary_posted_at TEXT,    -- user-visible summary posted to child subthread; for internal-only tasks (child_thread_id IS NULL) set to completed_at at terminal-status time (not-applicable marker)
  parent_notified_at      TEXT,    -- system row written to parent's session; written LAST and contains the final dependents_unblocked list
  parent_woken_at         TEXT,    -- cycle-2 M2-F: separate marker for wakeContainer(parent), so failed wakes are retried
  -- Cancellation
  cancelled_at         TEXT,                                     -- cycle-2 M2-B: set by applyCancelTask alongside status='cancelled'; watchdog hard-kill timer reads this
  -- Other
  deadline             TEXT,                                     -- ISO timestamp; watchdog enforces
  original_deadline    TEXT,                                     -- set at insert, never mutated. NULL → task_progress deadline_extension_seconds is rejected (cycle-2 M2-I).
  model                TEXT,
  effort               TEXT,
  spawned_by_user_id   TEXT REFERENCES users(id),
  spawned_at           TEXT NOT NULL,
  started_at           TEXT,
  completed_at         TEXT,
  result_summary       TEXT,
  failure_reason       TEXT,
  UNIQUE(parent_session_id, idempotency_key)
);
CREATE INDEX idx_tasks_parent ON tasks(parent_session_id, status);
CREATE INDEX idx_tasks_child  ON tasks(child_session_id);
CREATE INDEX idx_tasks_status ON tasks(status, deadline);
CREATE INDEX idx_tasks_dispatch_state ON tasks(dispatch_state, dispatch_state_updated_at) WHERE dispatch_state != 'running';
CREATE INDEX idx_tasks_finalization ON tasks(status)
  WHERE status IN ('complete','failed','cancelled')
    AND (parent_notified_at IS NULL
         OR (child_thread_id IS NOT NULL AND child_summary_posted_at IS NULL)
         OR dependents_released_at IS NULL
         OR parent_woken_at IS NULL);

-- Bidirectional binding: closes cycle-2 M2-A. sessions.dispatch_task_id makes
-- dispatched sessions invisible to findSessionByAgentGroup (which adds
-- AND dispatch_task_id IS NULL to its WHERE) and gives the reconciler a
-- durable lookup key for createDispatchedSession idempotency.
ALTER TABLE sessions ADD COLUMN dispatch_task_id TEXT UNIQUE REFERENCES tasks(task_id);
CREATE INDEX idx_sessions_dispatch_task ON sessions(dispatch_task_id) WHERE dispatch_task_id IS NOT NULL;

-- Dependencies as a join table (cycle-1 S8 / cycle-1 M14 / cycle-2 S2-B trigger).
CREATE TABLE task_dependencies (
  task_id              TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  blocked_on_task_id   TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  parent_session_id    TEXT NOT NULL,
  PRIMARY KEY (task_id, blocked_on_task_id),
  CHECK (task_id != blocked_on_task_id)
);
CREATE INDEX idx_task_deps_blocked_on ON task_dependencies(blocked_on_task_id);
CREATE INDEX idx_task_deps_parent ON task_dependencies(parent_session_id);

-- DB-level enforcement of same-parent-session (cycle-2 S2-B). SQLite cannot reference other tables in CHECK,
-- but BEFORE INSERT triggers can. This makes the invariant self-defending — any direct INSERT path
-- (migration backfill, scripts/q.ts ad-hoc, future code) is rejected at the database layer.
CREATE TRIGGER task_deps_same_parent_session_task
BEFORE INSERT ON task_dependencies
WHEN (SELECT parent_session_id FROM tasks WHERE task_id = NEW.task_id) != NEW.parent_session_id
BEGIN
  SELECT RAISE(ABORT, 'task_dependencies.task_id parent_session_id mismatch');
END;
CREATE TRIGGER task_deps_same_parent_session_blocked
BEFORE INSERT ON task_dependencies
WHEN (SELECT parent_session_id FROM tasks WHERE task_id = NEW.blocked_on_task_id) != NEW.parent_session_id
BEGIN
  SELECT RAISE(ABORT, 'task_dependencies.blocked_on_task_id parent_session_id mismatch');
END;

-- Cycle-3 M3-6: bind tasks.child_session_id to sessions.dispatch_task_id symmetrically.
-- Authorization via source-session capability requires this invariant to hold; without
-- the trigger, a stale UPDATE could leave them out of sync and authorize the wrong agent.
CREATE TRIGGER tasks_child_session_binding_check
BEFORE UPDATE OF child_session_id ON tasks
WHEN NEW.child_session_id IS NOT NULL
 AND (SELECT dispatch_task_id FROM sessions WHERE id = NEW.child_session_id) != NEW.task_id
BEGIN
  SELECT RAISE(ABORT, 'tasks.child_session_id binding mismatch with sessions.dispatch_task_id');
END;

-- Insert helper still exists in src/db/task-dependencies.ts for ergonomics, but the trigger is the boundary.

-- Roles catalog (cycle-1 S5).
CREATE TABLE roles_catalog (
  role        TEXT PRIMARY KEY,
  description TEXT
);
INSERT INTO roles_catalog (role, description) VALUES
  ('orchestrator', 'Can dispatch tasks to other agent groups via dispatch_task MCP tool');
-- agent_roles.role TEXT NOT NULL REFERENCES roles_catalog(role) (in migration)

-- Retention policy (cycle-2 S2-F): document only, deferred to v2 ops.
-- Recommended cron purge: tasks WHERE status='complete' AND completed_at < now - 30 days
--                         tasks WHERE status IN ('failed','cancelled','orphaned') AND completed_at < now - 90 days
-- (FK ON DELETE CASCADE on task_dependencies handles dep cleanup automatically.)
```

### Dispatch flow

Multi-step state machine with persisted `dispatch_state` per step. Each transition is **persist-intent → side-effect → persist-completion**, so a host crash leaves a recoverable row in a state the reconciler knows how to resume idempotently. Side effects use deterministic IDs so retries are PK-protected against duplicates.

```
[1] Orchestrator container calls dispatch_task MCP tool with:
      target_group:    <folder name>
      title:           "XZO-54: redeploy UDTF_GET_DEPLETIONS_FORECAST"
      prompt:          <full task brief>
      deadline:        <optional ISO timestamp>
      blocked_on:      <optional list of task_ids in the SAME parent_session_id>
      idempotency_key: <orchestrator-supplied UUID; required, NOT NULL>
      model, effort:   <optional, per-task overrides>

[2] Container writes outbound system action `dispatch_task` to outbound.db.
    (Container is sole writer of outbound.db — invariant preserved.)

[3] Host's delivery.ts:280 (system-action dispatch) routes to
    `applyDispatchTask`. Host validates:
      - source agent group has 'orchestrator' role in agent_roles
        (host re-checks regardless of MCP-tool presence — defense in depth)
      - target_group folder maps to an existing agent_groups row
      - blocked_on task_ids exist AND share this parent_session_id
        (cross-session deps rejected — closes M14)
      - deadline is well-formed
      - idempotency_key not already used in this parent_session_id
        (UNIQUE constraint); duplicate → return existing task_id, skip insert

[4] Host INSERTs tasks row with:
      status='pending', dispatch_state='pending', dispatch_state_updated_at=now,
      original_deadline=deadline,
      spawned_by_user_id=<orchestrator session's most-recent user inbound>.
    Populates task_dependencies via insertTaskDependency() helper
    (DB-level trigger enforces same-parent-session — cycle-2 S2-B).

    No completion_nonce is generated. Source-session authorization is
    sufficient because sessions.dispatch_task_id UNIQUE makes the
    (task_id, child_session_id) binding 1:1 (cycle-2 M2-E simplification).

[CAP + DEPENDENCY CHECK + atomic 'dispatched' transition]
    Cycle-3 fixes folded in: M3-2 introduces neutral 'admitted' state to
    decouple cap admission from dispatch-path selection; M3-4 fixes off-by-one
    (< not ≤); M3-5 adds dependency-complete check; S3-C requires BEGIN IMMEDIATE.
    Before advancing to step 5, host runs ONE transaction (BEGIN IMMEDIATE so
    write-lock is acquired upfront, avoiding mid-transaction SQLITE_BUSY):

      BEGIN IMMEDIATE;
      -- Cap checks (M3-4: strict less-than)
      SELECT COUNT(*) FROM tasks
       WHERE parent_session_id = ?
         AND status IN ('dispatched','running')
         FOR resulting count to be < 6;
      SELECT COUNT(*) FROM tasks
       WHERE target_agent_group_id = ?
         AND status IN ('dispatched','running')
         FOR resulting count to be < 3 (configurable per agent_group);
      -- Dependency check (M3-5)
      NOT EXISTS (
        SELECT 1 FROM task_dependencies td JOIN tasks t ON t.task_id = td.blocked_on_task_id
         WHERE td.task_id = ? AND t.status != 'complete'
      );
      -- All three pass:
      UPDATE tasks SET status='dispatched',
                       dispatch_state='admitted',                  -- M3-2: neutral
                       dispatch_state_updated_at=now
       WHERE task_id = ? AND status='pending';
      COMMIT;

    The 'admitted' state means cap-reserved but adapter capability not yet
    resolved. Step 5 reads agent_groups → messaging_groups → adapter and
    branches between thread-supporting and non-thread-fallback paths,
    transitioning 'admitted' → 'parent_posted' (or 'session_created' for
    fallback). Initial dispatch and watchdog responsibility 4 BOTH use
    this same transaction (one code path).
    If any check fails: status stays 'pending'; promotion happens via
    §Watchdog responsibility 4 on next sweep tick.

[5] After atomic promotion to status='dispatched', advance through side
    effects. For every transition: UPDATE tasks SET dispatch_state=<next>,
    dispatch_state_updated_at=now BEFORE attempting the next side effect.
    Where the side effect must precede the persist (Slack/Discord platform
    posts), use the "creating_X" intent state set in the cap-promotion
    transaction so the reconciler detects partial completion.

      a. (When phase has thread surface — adapter.supportsCreateThread === true)
         Cycle-3 M3-8 splits this into two staged sub-steps; each persists
         the durable platform ID immediately on return so a mid-call crash
         is recoverable.

         a1. Transition: UPDATE tasks SET dispatch_state='admitted' →
             'creating_thread' (intent persisted), dispatch_state_updated_at=now.
             Call `adapter.postParent(messagingGroupId, localParentMessageId, title)`
             where localParentMessageId = `dispatch-parent-${task_id}` (PK-protected
             via writeSessionMessage's INSERT OR IGNORE).
             Adapter: posts platform parent message, returns { parentPlatformMessageId, messageId }.
             IMMEDIATELY persist:
             UPDATE tasks SET parent_platform_message_id=<...>,
                              dispatch_state='parent_posted',
                              dispatch_state_updated_at=now.

             Reconciler from 'creating_thread': if `parent_platform_message_id IS NULL`,
             retry adapter.postParent (PK-protected on local message id; safe).

         a2. Transition: dispatch_state='parent_posted' (already persisted).
             Call `adapter.createThreadFromParent(messagingGroupId,
             parent_platform_message_id, firstMessage)`. Adapter creates thread
             from existing parent, returns { threadId }.
             IMMEDIATELY persist:
             UPDATE tasks SET child_thread_id=<...>,
                              dispatch_state='thread_created',
                              dispatch_state_updated_at=now.

             Reconciler from 'parent_posted': call
             `adapter.getThreadId(parent_platform_message_id)` first (cheap, idempotent).
             If it returns a thread id (Slack: parent.thread_ts == parent.ts AND
             reply_count > 0; Discord: Message#thread !== null), adopt it. If null,
             re-call createThreadFromParent (idempotent on the platform side because
             the parent already exists; second call posts a duplicate first-reply
             which is benign — the thread is the same thread).

      b. createDispatchedSession(task_id, target_agent_group_id, effective_mg_id,
         effective_thread_id, session_mode='per-thread')
         — closes M10 + cycle-2 M2-A. Insert-or-select on sessions.dispatch_task_id
         (UNIQUE column added in §Data model). On a fresh task, INSERT new
         sessions row with dispatch_task_id=task_id; on reconciler retry,
         SELECT existing row by dispatch_task_id and reuse. The UNIQUE
         constraint makes this safe under concurrent retries.
         UPDATE tasks SET child_session_id=<id>,
                          dispatch_state='session_created',
                          dispatch_state_updated_at=now.
         findSessionByAgentGroup adds `AND dispatch_task_id IS NULL` to its
         WHERE — dispatched sessions are invisible to a2a coalescence,
         closing the contamination vector A1.

      c. writeSessionMessage(child) injects the task prompt as an inbound
         **kind='system' banner** with deterministic message id
         `dispatch-banner-${task_id}` (PK-protected on retry). The banner
         contains task_id and target_agent_group only — no nonce, no secret.
         Formatter renders kind='system' rows in the agent's prompt context
         but NEVER delivers them to the chat platform (closes the
         M16-style chat-history exposure for the task_id itself, which
         while not a secret would still be noise). The banner instructs:
         "Task <task_id> has been dispatched to you. When you finish, call
         task_complete with task_id=<...>."
         UPDATE tasks SET dispatch_state='prompt_injected',
                          dispatch_state_updated_at=now,
                          started_at=now.

      d. wakeContainer(child). UPDATE tasks SET dispatch_state='wake_sent',
         dispatch_state_updated_at=now.

      e. On first heartbeat: dispatch_state='running' (status remains
         'dispatched' until then; cap counts always include 'dispatched').
         If no heartbeat within 30s, reconciler resumes per §Watchdog
         responsibility 1.
```

The (mg_id, thread_id, mode) tuple in step 5b depends on the phase — see [Phasing](#phasing).

**Authorization model (cycle-2 M2-E simplification):** a child session has at most one dispatched task (enforced by `sessions.dispatch_task_id UNIQUE`); a task has exactly one child session (enforced by application logic + the UNIQUE column). The pair (task_id ↔ child_session_id) is the capability. `task_complete` authorization is `task_id = ? AND child_session_id = <source session of outbound row> AND target_agent_group_id = <source agent group>` — no nonce required. The source-session of an outbound row is implicit in the row itself (host knows which session emitted the system action), so a forged claim from a non-dispatched session fails the binding check immediately.

**Adapter idempotency contract (cycle-3 M3-8 — split from cycle-2 M2-D's combined call):** the `ChannelAdapter` interface gains three optional methods:
- `postParent?(messagingGroupId, localParentMessageId, title): Promise<{ parentPlatformMessageId: string; messageId: string }>` — posts the platform parent message; idempotent on `localParentMessageId` (PK-protected via `writeSessionMessage` on NanoClaw's local row).
- `createThreadFromParent?(messagingGroupId, parentPlatformMessageId, firstMessage): Promise<{ threadId: string }>` — creates the thread from an already-posted parent. On Slack, this means posting the first child reply with `thread_ts=parentPlatformMessageId`. On Discord, calls `Message#startThread`.
- `getThreadId?(messagingGroupId, parentPlatformMessageId): Promise<string | null>` — reconciler crash-recovery probe. Slack: returns threadId if and only if `parent.thread_ts == parent.ts` AND `parent.reply_count > 0`. Discord: returns thread id if `Message#thread !== null`.

The adapter capability flag `supportsCreateThread` (true if both `postParent` AND `createThreadFromParent` are implemented) is what the dispatch flow consults.

### Reverse signal

Completion is an idempotent state machine, not an atomic operation. The host's `applyTaskComplete` separates **authorize** from **finalize**. The finalize path persists per-side-effect markers (`dependents_released_at`, `child_summary_posted_at`, `parent_notified_at`, `parent_woken_at`) so a host crash mid-finalize is resumable by the watchdog. The **order of finalize steps is load-bearing** (cycle-2 M2-F closes Codex C6): dependents are computed and released BEFORE the parent system row is written, so the parent message contains the final, accurate `dependents_unblocked` list.

Two writes per completion: user-visible chat into the **child's own subthread** so the owner sees closure where they were watching, and a `kind='system'` row into the **parent session** so the orchestrator can fan out dependents.

```
[1] Child container writes outbound system action `task_complete` with:
      task_id:           <from the dispatch banner — not a secret, just identification>
      status:            'complete' | 'failed'
      summary:           <markdown summary>
      failure_reason:    <optional>

[2] Host's applyTaskComplete = authorizeChildCompletion() + finalizeTaskCompletion()

      authorizeChildCompletion(outbound_row):
        Cycle-2 M2-E: nonce removed; source-session binding is the capability.
        SELECT * FROM tasks
         WHERE task_id = ?
           AND child_session_id = <source session of outbound row>
           AND target_agent_group_id = <source agent group of outbound row>
           AND status IN ('dispatched','running')
        If row not found, log + drop. The (task_id, child_session_id) pair is
        unforgeable: sessions.dispatch_task_id UNIQUE makes the binding 1:1,
        and the source session of an outbound row is determined by the host,
        not declared by the agent.
        Watchdog/cancel skip authorize and call finalizeTaskCompletion directly
        with explicit host authority (closes M4).

      finalizeTaskCompletion(task_id, status, summary, failure_reason?):
        Idempotent state machine. Steps in this exact order; each guarded by
        a persisted marker.

        a. **Set terminal status** (no-op if already set):
           UPDATE tasks SET status, completed_at, result_summary, failure_reason
            WHERE task_id = ? AND status IN ('dispatched','running').

        b. **Compute, PERSIST, and release dependents** (cycle-3 M3-7: persist the
           list itself, not just the marker — survives a crash between b and d):
           **Skip this step if status='cancelled'** (cycle-3 S3-D-G: cancelled
           tasks did not produce work, so they should NOT unblock dependents).
             SELECT t.task_id FROM task_dependencies td JOIN tasks t ON t.task_id = td.task_id
              WHERE td.blocked_on_task_id = <completed task_id> AND t.status = 'pending';
           For each, check if all of its dependencies are now complete; collect
           into the "dependents_unblocked" list. Mark each unblocked task as
           eligible (no status change yet — they remain 'pending'; §Watchdog
           responsibility 4 promotes per cap budget).
           Persist BOTH the list and the marker in one UPDATE:
           UPDATE tasks SET dependents_released_at=now,
                            dependents_unblocked_json='[...task_ids...]'
                       WHERE task_id=? AND dependents_released_at IS NULL.

        c. **Write 1 (user-visible child summary)** — only if
           child_thread_id IS NOT NULL (child has a platform surface):
             use session-manager.ts:writeOutboundDirect (existing host-side
             bypass for system writes, see C5 in §Constraint Analysis).
             Deterministic message id `task-complete-${task_id}` (PK-protected).
             Body = summary markdown.
             UPDATE tasks SET child_summary_posted_at=now WHERE task_id=?
                              AND child_summary_posted_at IS NULL.
           For internal-only tasks (child_thread_id IS NULL — closes Codex C5):
             UPDATE tasks SET child_summary_posted_at=completed_at
              WHERE task_id=? AND child_summary_posted_at IS NULL
              AND child_thread_id IS NULL.
           Setting it to completed_at marks "not applicable, finalized" so
           the watchdog finalization scan doesn't loop on it.

        d. **Write 2 (parent system row)** — now contains the final
           dependents_unblocked list because step b ran first.
           Direct-write a kind='system' inbound row to parent_session_id.
           Wire format (formatter.ts:307-317):
             {
               action: 'task_complete',
               status: 'complete' | 'failed' | 'cancelled',
               result: {
                 task_id,
                 target_agent_group: <folder name>,
                 summary_markdown:   <truncated to 8KB>,
                 failure_reason:     <optional>,
                 completed_at:       <ISO 8601>,
                 dependents_unblocked: [<task_id>, ...]   // read from tasks.dependents_unblocked_json — durable across crashes (cycle-3 M3-7)
               }
             }
           Deterministic message id `task-complete-system-${task_id}`.
           The orchestrator's CLAUDE.md must instruct: "Look for
           <system_response action='task_complete'> elements."
           UPDATE tasks SET parent_notified_at=now WHERE task_id=?
                            AND parent_notified_at IS NULL.

        e. **Wake parent** — separate persisted marker (cycle-2 M2-F /
           closes A6) so a wake failure is retried by the watchdog.
           wakeContainer(parent_session_id).
           UPDATE tasks SET parent_woken_at=now WHERE task_id=?
                            AND parent_woken_at IS NULL.
           If wake fails (parent stopped, container won't start), leave
           parent_woken_at NULL; watchdog responsibility 3 retries.
```

Completion routing is keyed on `parent_session_id`, not on `parent_agent_group_id`. An orchestrator group can have many sessions concurrently (different chat threads, different users, different times); only the originating session should hear the result.

### Dispatch authorization scope

Codex C9 (cycle 2) noted that giving an agent group the `orchestrator` role makes any prompt that reaches that group able to dispatch real work — a stale or prompt-injected orchestrator session can fan out to other groups without per-dispatch owner intent. The brief's R13 ("role grant requires owner approval — one-time per orchestrator group") accepts this risk for low-exposure orchestrator sessions, but it shouldn't be the only mode.

**Cycle-3 M3-3 scope reduction (A-3-3 + Codex C-3-6 merged)**: the cycle-2 design proposed three modes including a `'session-token'` default with run-token semantics, but that mode has no implementable substrate in the current codebase — `src/modules/approvals/primitive.ts:188` `requestApproval` is fire-and-forget and has no token-issuance surface. **v1 ships TWO modes only**, and the `'session-token'` feature defers to a follow-up spec where the run-token storage table, the consumeDispatchToken helper, and a dedicated approval handler can be designed properly.

New column: `agent_groups.dispatch_approval_mode TEXT NOT NULL DEFAULT 'none' CHECK (dispatch_approval_mode IN ('none','per-dispatch'))`.

| Mode | Behavior | Use case |
|---|---|---|
| `'none'` (default) | Role grant alone authorizes any dispatch. Matches brief R13 — owner already approved the role at grant time. | Default for orchestrator groups; sufficient for low-exposure orchestrators. |
| `'per-dispatch'` | Every `dispatch_task` call surfaces a per-task approval card via `requestApproval`. | High-stakes orchestrator groups where every dispatch needs eyes-on. |

`applyDispatchTask` checks the mode: `'none'` proceeds; `'per-dispatch'` opens an approval card via the existing `requestApproval` flow with `action='dispatch_task'` and the dispatch payload — a registered approval handler (`applyDispatchTaskApproval`) replays the actual dispatch on approve.

**Deferred (out of v1)**: `'session-token'` mode. When ready, follow-up spec adds:
- `dispatch_run_tokens(token_id, parent_session_id, agent_group_id, dispatches_remaining, expires_at, granted_by)` table + migration
- `consumeDispatchToken()` helper (atomic decrement + expiry check)
- A registered approval handler that issues tokens on owner approve
- Updates to `applyDispatchTask` to validate the token in the cap-promotion transaction.

### MCP tools (architecture: always-present, host-authorized)

Closes M2: NanoClaw's container architecture registers MCP tools unconditionally at container boot via `container/agent-runner/src/mcp-tools/index.ts` (verified). There is no per-session mounting hook. The "auto-mounted/auto-unmounted" framing of the prior cycle was architecturally fictional. Resolution: **all four orchestrator-dispatch MCP tools (`dispatch_task`, `task_complete`, `task_progress`, `cancel_task`) are always present in every container; correctness is purely the host-side authorization check.** Tool descriptions set agent expectations; the host is the sole authority.

#### `task_complete` MCP tool

```typescript
// container/agent-runner/src/mcp-tools/task-complete.ts — registered unconditionally
{
  name: 'task_complete',
  description: 'Signal completion of a dispatched task this session is working on. Read your task_id from the dispatch banner (a system message at the start of your session). Call this once when the task is done (status=complete) or definitively cannot proceed (status=failed). The host validates that this session is bound to this task_id (sessions.dispatch_task_id); calls from non-dispatched sessions are dropped.',
  input_schema: {
    type: 'object',
    properties: {
      task_id:        { type: 'string', description: 'From the dispatch banner.' },
      status:         { type: 'string', enum: ['complete', 'failed'] },
      summary:        { type: 'string', description: 'Markdown summary of work done. Posted to your subthread for the owner.' },
      failure_reason: { type: 'string', description: 'Required when status=failed. One-line first cause (HTTP code + endpoint, exception class + message, exit code + command).' },
    },
    required: ['task_id', 'status', 'summary'],
  },
}
```

The host enforces all gating in `applyTaskComplete` via `authorizeChildCompletion()` (see §Reverse signal). The (task_id, source-session) binding is the capability — `sessions.dispatch_task_id UNIQUE` makes it 1:1, and the source session of an outbound row is determined by the host. No nonce required (cycle-2 M2-E simplification).

**Fallback detection**: if the child container exits without emitting `task_complete`, host-sweep marks the task `failed` with `failure_reason='child exited without completion signal'`. Catches crashes, agent runaway, and prompt-injection refusals.

#### `task_progress` MCP tool

```typescript
// container/agent-runner/src/mcp-tools/task-progress.ts — registered unconditionally
{
  name: 'task_progress',
  description: 'Optional. Use to signal progress on a long-running task or to request a deadline extension. Extension is bounded: you cannot extend a task past 4× its original deadline. Tasks dispatched without a deadline (no original_deadline set) cannot be extended.',
  input_schema: {
    type: 'object',
    properties: {
      task_id:          { type: 'string' },
      progress_message: { type: 'string', description: 'Optional one-line status. Surfaced in dashboard.' },
      deadline_extension_seconds: { type: 'integer', description: 'Optional. New deadline = max(current_deadline, now + this). Capped at original_deadline × 4. Rejected with error if original_deadline is NULL.' },
    },
    required: ['task_id'],
  },
}
```

Host's `applyTaskProgress` shares `authorizeChildCompletion`'s session-binding identity check (no nonce). Extension request:
- If `tasks.original_deadline IS NULL`: reject with error `original_deadline_required` (closes cycle-2 M2-I).
- Else: compute `max_allowed = original_deadline + 4 × (original_deadline - spawned_at)`; new_deadline = min(now + requested, max_allowed); UPDATEs `tasks.deadline`.

Emits a `task.progress` SSE event to the dashboard. (The dashboard SSE event name `task.progress` is intentionally distinct from any `task_progress` system-action terminology — they're at different layers.)

#### `cancel_task` MCP tool (closes review S9 / cycle-2 M12)

```typescript
{
  name: 'cancel_task',
  description: 'Cancel a dispatched task. Best-effort: a marker is written into the child session and the agent should exit gracefully on its next poll between turns. If the agent does not check the marker within 2 minutes, the host kills the container.',
  input_schema: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id'],
  },
}
```

Host's `applyCancelTask` (closes cycle-1 M12 + cycle-2 M2-B — soft+hard pattern with `cancelled_at` properly tracked):

1. Validate caller has `orchestrator` role on the calling session's agent_group. (Matches `dispatch_task` gating.)
2. UPDATE tasks SET status='cancelled', cancelled_at=now, completed_at=now WHERE task_id=? AND status IN ('pending','dispatched','running'). The `cancelled_at` column (cycle-2 M2-B) is what the watchdog hard-kill timer reads. **`completed_at` is also set** (cycle-3 M3-1) so internal-only cancelled tasks don't leak `child_summary_posted_at = NULL` permanently — §Reverse signal step c reads `completed_at` for the not-applicable marker.
3. Write a `kind='system'` inbound row into the child's session: `{ action: 'cancel', task_id }`. Wake the child.
4. Child agent — instructed via dispatch banner: *"If you receive a system action with action='cancel' for your task_id, exit gracefully without calling task_complete."* Best-effort soft cancellation; the agent might still be mid-LLM-call when the system row arrives.
5. Watchdog enforces hard kill: if `tasks.status='cancelled'` AND `dispatch_state IN ('prompt_injected','wake_sent','running')` AND `cancelled_at < now - 120s`, host calls `killContainer(child_session)`. (`killContainer` already exists in `src/container-runner.ts`.)
6. After kill or graceful exit, `finalizeTaskCompletion(status='cancelled', summary='Task cancelled by orchestrator', failure_reason=null)` runs through the same idempotent state machine as completion. The `cancelled` status is included in finalization-resume index (see `idx_tasks_finalization` in §Data model).

LLM-turn interruption is fundamentally hard in NanoClaw's polling model — there's no signal that stops an in-flight Claude call mid-stream. The 2-minute grace + SIGKILL is the established NanoClaw pattern (see `container-runner.ts:killContainer`). Document the limitation: cancellation is asynchronous-soft within 2 min, hard at 2 min.

#### `dispatch_task` MCP tool (orchestrator-side)

(Schema unchanged from prior section; correctness via host's `applyDispatchTask` validating the caller's session has the `orchestrator` role.)

```typescript
{
  name: 'dispatch_task',
  description: 'Dispatch a task to another agent group. Each call spawns a new session in the target group. The host validates that your session has the orchestrator role; calls from non-orchestrator sessions are rejected.',
  input_schema: {
    type: 'object',
    properties: {
      target_group:    { type: 'string', description: 'Folder name of target agent group' },
      title:           { type: 'string', maxLength: 120 },
      prompt:          { type: 'string', maxLength: 16000 },
      deadline:        { type: 'string', format: 'date-time', description: 'Optional. Watchdog enforces. Child can request extensions via task_progress (capped at 4× original).' },
      blocked_on:      { type: 'array',  items: { type: 'string' }, description: 'Optional list of task_ids that must complete first. Must share parent_session_id with the new task.' },
      idempotency_key: { type: 'string', description: 'Required, NOT NULL. UUIDv4. Re-calling with the same key returns the existing task_id (closes M13).' },
      model:           { type: 'string', description: 'Optional per-task model override.' },
      effort:          { type: 'string', enum: ['low','medium','high'], description: 'Optional per-task effort override.' },
    },
    required: ['target_group', 'title', 'prompt', 'idempotency_key'],
  },
}
```

### Watchdog and reconciler

Extension to `src/host-sweep.ts`. Single 60s sweep, **five** responsibilities. Stuck-detection uses `dispatch_state_updated_at` (NOT `spawned_at` — closes M15) so legitimately-paused tasks aren't false-flagged.

1. **Stuck dispatch reconciler** (closes M1, M15): scan tasks where `dispatch_state IN ('creating_thread', 'thread_created', 'session_created', 'prompt_injected', 'wake_sent')` AND `dispatch_state_updated_at < now - 60s` AND `dispatch_retry_count < 3`. For each:
   - `creating_thread`: call `adapter.getThreadId(messagingGroupId, parent_message_id)` — if a thread exists, adopt it (`UPDATE child_thread_id, dispatch_state='thread_created'`); else re-call `createThread`.
   - `thread_created`: idempotent — re-run step 5b (`createDispatchedSession` is naturally PK-protected on the child session row).
   - `session_created`: re-run step 5c (banner is PK-protected via deterministic message id).
   - `prompt_injected`: re-run step 5d (`wakeContainer` is idempotent).
   - `wake_sent`: re-run step 5d.
   Each retry: `UPDATE tasks SET dispatch_retry_count = dispatch_retry_count + 1, dispatch_state_updated_at = now`. After 3 retries: `status='failed'`, `failure_reason='dispatch stalled at <state>'`, then `finalizeTaskCompletion()`.

2. **Deadline expiry** (closes M4): scan tasks where `status IN ('dispatched', 'running')` AND `deadline IS NOT NULL` AND `deadline < now`. For each, call `finalizeTaskCompletion(task_id, status='failed', summary='Task exceeded deadline.', failure_reason='timeout')` directly with host authority. **No synthetic `task_complete` outbound** — that would require `completion_nonce` validation which the host doesn't legitimately possess in the watchdog context. The factored authorize/finalize separation makes this clean.

3. **Completion-finalization resume** (closes M3 + cycle-2 M2-F): scan tasks where `status IN ('complete','failed','cancelled')` AND (`dependents_released_at IS NULL` OR `(child_thread_id IS NOT NULL AND child_summary_posted_at IS NULL)` OR `parent_notified_at IS NULL` OR `parent_woken_at IS NULL`). Note the `child_thread_id IS NOT NULL` predicate — internal-only tasks have `child_summary_posted_at` set to `completed_at` at terminal-status time (a "not applicable" marker), so they do not loop here. For each remaining row, re-attempt the missing finalize step in the documented order (b → c → d → e per §Reverse signal). Each step is PK-protected and marker-guarded so retries are idempotent.

4. **Cap-aware promotion** (closes M9): scan tasks where `status='pending'` AND all dependencies in `task_dependencies` are complete (`SELECT 1 FROM task_dependencies td JOIN tasks t ON t.task_id = td.blocked_on_task_id WHERE td.task_id = pending.task_id AND t.status != 'complete' LIMIT 1` returns no rows). For each (FIFO by `spawned_at`):
     - per-orchestrator-cap check: `COUNT(*) FROM tasks WHERE parent_session_id = ? AND status IN ('dispatched','running')` ≤ 6
     - per-target-cap check: `COUNT(*) FROM tasks WHERE target_agent_group_id = ? AND status IN ('dispatched','running')` ≤ 3 (configurable per agent group)
     - if both pass: enter §Dispatch flow step 5a-5e
     - if either fails: skip; next sweep retries
   This is the only path that promotes pending → dispatched. §Reverse signal step 2d does NOT directly dispatch dependents; it merely marks them eligible.

5. **Orphan recovery**: scan tasks where `status IN ('complete','failed','cancelled')` AND `parent_notified_at IS NOT NULL` AND `parent_session_id` references a session no longer active (status='archived' or row deleted). Mark `status='orphaned'`. DM the `spawned_by_user_id` user (closes S1 — populated at dispatch) via the `user_dms` cache with the result summary.

**Deadline extension** mechanism (closes M11): see `task_progress` MCP tool above. Child emits the system action; host's `applyTaskProgress` updates `tasks.deadline` (capped at `original_deadline + 4 × (original_deadline - spawned_at)`). The original deadline is in `tasks.original_deadline`, immutable, set at insert.

_(`dispatch_task` schema and authorization are documented in §MCP tools above.)_

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

Same dispatch flow, but step 5a is skipped because `adapter.supportsCreateThread === false`. Host switches to internal-only mode at step 5b:

- Call **`createDispatchedSession`** (a new helper in `src/modules/orchestrator-dispatch/`, NOT the standard `resolveSession`) — closes M10. The standard `resolveSession` would coalesce into the target group's `agent-shared` session if one exists, fanning all dispatched tasks into a single shared session. `createDispatchedSession` always creates a fresh `sessions` row with explicit `session_mode='per-thread'` and `messaging_group_id=NULL`, `thread_id='task-<task_id>'`. The synthetic `thread_id` is safe because no platform delivery happens (the host's `deliverMessage` skips channel delivery when `messaging_group_id IS NULL`).
- Owner cannot click into a child thread for these channels — child interaction is via the dashboard only.
- Orchestrator still receives `task_complete` (Write 2 only — Write 1 is skipped because there's no platform thread to post to).

Most NanoClaw use is Slack/Discord, so this fallback path is rare-but-correct rather than the default experience.

### Future — code-touching tasks (out of scope, separate spec)

Per-child git worktree manager. Codex's repo-corruption concern (22 parallel agents on `xzo-analytics` = trash). Until this ships as its own spec, the orchestrator's job is to either constrain dispatch to disjoint file scopes or sequence code-touching tasks via `blocked_on` chains.

## Dashboard

Vite + React + TypeScript SPA, bundled and served from the existing Node host on `127.0.0.1:7457`. The host runs a small Node `http` server (closes review M1 — `undici` is a client-only library, the codebase already uses Node `http` in `src/webhook-server.ts:93` and `src/channels/chat-sdk-bridge.ts:841`) with one SSE endpoint, ~8 JSON endpoints, plus a static handler for the built bundle. Reads `data/v2.db` and per-session DBs directly via `better-sqlite3` — no new API service, no separate process.

**Auth (closes M3 + cycle-1 M6/M7 + cycle-2 M2-G)**: three layers with one explicit unauthenticated entry point.

1. Bind the listener to `127.0.0.1` only (not `0.0.0.0`).
2. Random bearer token generated at host startup, printed once to setup logs and stored at `data/dashboard-token`. The bearer token is the entry to the auth model.
3. **Single unauthenticated endpoint**: `POST /api/login` accepts `{ token }`; on match, returns 204 with a `Set-Cookie` header issuing a session cookie (`HttpOnly`, `Secure=false` since localhost, `SameSite=Strict`, `Domain=127.0.0.1`, `Path=/`). On mismatch, returns 401. **No other endpoint is unauthenticated** beyond static asset serving (the SPA bundle JS/CSS — no data exposed). Closes cycle-2 M2-G's missing login exception.
4. **All other API endpoints AND the SSE endpoint** require either the session cookie OR an `Authorization: Bearer <token>` header. The bearer is accepted for non-browser clients (curl, scripts); browsers use the cookie set at login. Native `EventSource` carries the cookie automatically — closes cycle-1 M7.
5. **`Origin` header allowlist** (`http://127.0.0.1:7457` only) enforced on **mutating methods** (POST/PUT/PATCH/DELETE) — closes cycle-2 M2-G's SSE handling (browsers may omit Origin on same-origin GET, so requiring it on GET/SSE breaks legitimate flows).
6. **`Host` header allowlist** (`127.0.0.1:7457` only) enforced on **every** request — defeats DNS rebinding.

Combined with `SameSite=Strict` cookie, this satisfies OWASP CSRF prevention defense-in-depth (T1 source: OWASP CSRF cheat sheet).

UI/UX specification: see [`./ui-design.md`](./ui-design.md) (separate file, generated via /impeccable design pass and hardened by a /jony-ive audit).

**Fonts (closes review M2)**: `@fontsource-variable/geist` and `@fontsource-variable/jetbrains-mono` self-hosted via Vite's asset pipeline. Do **not** use the `geist` npm package — it has a `next` peerDep and Vite cannot resolve `next/font/local`.

Memory budget:

| Component | Estimated RSS |
|---|---|
| Vite production SPA bundle (loaded in browser) | client-side, not host RSS |
| Node `http` server + SSE handler in existing Node process | ~10–20 MB on top of host baseline |
| `better-sqlite3` read connections, opened-on-demand-and-closed (closes review S11) | ~5 MB |
| Total additional host RSS | ≤ 30 MB |

Comfortably under the 150 MB budget (constraint C9). Compare to Multica's 400–700 MB.

**Real-time updates (closes review M9)**: Server-Sent Events from the host. Drop the chokidar/fsevents file watcher entirely — `anthropics/claude-code#16523` documents that fsevents on macOS does not reliably fire on SQLite WAL writes, and Dave develops on macOS. Instead, the host's existing `delivery.ts` outbound-poll path (which is already the sole reader of `outbound.db`) emits SSE events on the same code path that reads new `messages_out` rows. One read code path, one notification path, no second observer of the file system, no platform divergence.

SSE event types pushed to the dashboard:
- `task.started` / `task.progress` / `task.tool_started` / `task.tool_finished` / `task.message` / `task.completed` / `task.failed`
- `approval.requested`

Client integration: a single `EventSource` on the dashboard side; on each event, the handler calls `queryClient.setQueryData(['tasks', ...], updater)` (closes review S6 — `tanstack/query` has no first-class SSE primitive, the integration is userland). `useQuery` consumers re-render automatically. Reconnection backoff handled by the EventSource client (1s → 2s → 5s → 5s).

**Concurrency caps**: per-orchestrator-session cap (default 6 dispatched/running) AND per-target-group container cap (default 3, configurable per agent group — closes review S4). Both apply.

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
- **OQ2**: Per-task model selection (lifted into MUST-have-in-MVP per review S5). `dispatch_task` accepts optional `model` and `effort` arguments; pass-through to child container's runtime config.
- **OQ3**: Cancellation surface (lifted into MUST-have-in-MVP per review S9). Separate `cancel_task` MCP tool, mirrors existing scheduled-task cancellation (`scheduling.ts:174`); flips `tasks.status` and writes a terminate signal to the child.
- **OQ4**: Multi-orchestrator coordination. If two different orchestrator agent groups both dispatch to the same target — collisions on threads, on tasks ledger, on dependency chains? Out of scope for v1; assume single orchestrator practice.

## Assumptions Log

Mirrors the assumptions tracked in `decisions.yaml`. Each assumption has a stated impact-if-wrong and a validation method; validation is recorded as `validated: true|false` in the YAML.

| # | Assumption | Impact if wrong | How to validate |
|---|---|---|---|
| A1 | Orchestrator-spawned child sessions can chat with the owner directly through Slack/Discord subthreads, leveraging existing NanoClaw thread plumbing. | High (R3 / C11 not deliverable; product reverts to dashboard-only operation). | Spike during MVP build before relying: confirm Slack `chat.postMessage` with `thread_ts` works for a parent message we just posted; confirm Discord `Message#startThread` produces a thread we can post into and receive from via the existing inbound webhook. |
| A2 | Single owner, single host, ≤22 concurrent tasks, ≤11 agent groups is the operational scale envelope. | Medium (some choices, e.g. dependencies-as-JSON per S8, would need re-shape at higher scale). Validation already complete: 22-XZO-triage explicitly cited by user. |
| A3 | Slack subthreads are the primary surface for owner-chat-with-child; non-thread channels (Telegram, iMessage, email) accept dashboard-only as the fallback. | Low (already user-confirmed). Re-validate if a non-Slack channel becomes a top use case. |
| A4 | The host's existing `delivery.ts` outbound-poll path is the natural place to emit SSE events (per review M9). Dashboard does not need a separate file watcher. | Medium (if outbound-poll cadence is too slow for sub-second update target, we'd need to introduce an in-process event emitter). Validate during dashboard build: measure end-to-end latency from a `messages_out` insert to a dashboard pixel update; target <1000ms (per SC4). |
| A5 | Slack and Discord adapter `createThread` capability can be implemented in 1 day each (per implementation order). | Low (estimate slips by a day are tolerable; doesn't change architecture). |

## Appendix: alternatives considered

- **Multica as dispatch + dashboard**: rejected (memory cost ~400-700MB, daemon model fights ephemeral containers, ripping the UI is comparable cost to building from scratch).
- **Beads as task ledger**: rejected (Codex H7: task state must be durable host data; Beads is git-versioned per-repo and doesn't model the orchestration relationships we need; community UIs are passion projects with varying maintenance).
- **Reuse `agent-to-agent` and just add a "create subthread" flag**: rejected (the destinations ACL model and threading inheritance are wrong shapes — see Problem section).
- **Slack-only orchestration via threaded messages, no host-side tasks table**: rejected (no resilience to container crashes; no reverse-signal handling for dependency chains; no way to surface stale tasks beyond Slack's own thread UX).
