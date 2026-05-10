# orchestrator-dispatch → spawn rework plan

> Status: APPROVED — pending execution on new branch `feat/orchestrator-spawn-rework`.
> Source: post-Phase-1-merge realignment conversation 2026-05-10 (after PR #80 merged at commit 3bcf601).
> Why this file exists: the conversation that produced this plan is large and likely to compact. This file is the durable record so a fresh context can pick up exactly where we left off.

## Context — what was just shipped and what we got wrong

Phase 1 of orchestrator-dispatch shipped via PR #80 (merge commit `3bcf601` on `davekim917/nanoclaw/main`). It works, all tests pass, but the **framing was wrong** for the user's actual use case.

### What the user actually wants
- **Self-orchestration**: one agent (e.g. Illie / Illysium group) gets a list of work, spawns N parallel sessions of itself — all in the same group, all sharing workspace / memory / channels / CLAUDE.md / container config.
- Each spawn is a parallel work-stream of the same agent, isolated only at the conversation/thread level (so you can chat with each in its own thread).
- Sibling spawns coordinate via shared workspace files, shared memory (mnemon), shared backlog/ship_log — NOT via direct sibling messaging APIs (parent-coordinated for explicit deps; future MCP tool only if real-time sibling comms become a felt pain).
- Plus a **board UI** (Multica-style: kanban + per-task drill-down + steer-from-one-place) — Phase 2 of the spec, deferred during build, now elevated to "headline feature, build next."

### What we built instead
Cross-group dispatch — orchestrator sends tasks to OTHER agent groups. Built target validation, wiring checks, cross-group orchestrator-targeting rejection, folder/name resolution. All of that is **wrong abstraction layer** for what the user wanted. Group is the wrong unit for "isolate this work" — session is.

### Why the framing miss happened
- The brief said *"orchestrator dispatches each task to a target agent group"*. I read "target agent group" as a different group; the user meant "the same group, just a different session of it."
- The early conversation explicitly rejected `create_agent` (heavyweight, creates permanent groups per pair). I translated that as "build dispatch_task targeting existing groups" rather than "build self-spawn within the existing group."
- The brief never said "self-orchestration" explicitly, but it ALSO never said "cross-group." Defaulting to cross-group was a guess I should have probed.
- I did not re-check intent when the build started.

## Approved rework plan

**New branch**: `feat/orchestrator-spawn-rework`
**Source branch**: `main` (now contains the Phase 1 merge)
**Estimated effort**: 1-2 hours focused work + tests + PR

### Locked decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Strip cross-group dispatch entirely** (not "relax with a feature flag") | User wants no dead code. If cross-group becomes a real use case at the admin level later, re-introduce explicitly. |
| 2 | **Rename `dispatch_task` → `spawn_task`** + matching renames for related tools/actions | "dispatch" carries cross-group connotation; "spawn" matches the actual semantic of "fork off another instance of myself." |
| 3 | **Drop `target_agent_group_id` column** (full migration, not soft-deprecate) | No real production data to preserve (Phase 1 hasn't been used for live dispatches yet). Soft-deprecate leaves a confusing dead column. |
| 4 | **Module folder rename: NO** | Leave `src/modules/orchestrator-dispatch/` folder + internal filenames as-is. Only rename the user/agent-facing surface (MCP tool names + system action names + the `dispatch_task_id` column → `spawn_task_id`). Keeps the diff readable; folder rename is a separate cosmetic PR if ever desired. |

### Specific code changes

**Strip cross-group**:
- `src/modules/orchestrator-dispatch/dispatch.ts` — remove `target_group` parameter from `applyDispatchTask` content schema; default to `callerSession.agent_group_id`. Remove admit step 4 (target validation: rejects-orchestrator-target, rejects-self, rejects-non-existent), step 5 (wiring check). Remove `_resolveAgentGroupId` helper (was added in QA E4 fix, now obsolete).
- `src/modules/orchestrator-dispatch/dispatch.test.ts` — remove tests `test_target_not_wired_rejects`, `test_admit_rejects_self_dispatch`, `test_admit_rejects_orchestrator_target`, `test_target_resolved_by_folder` (and similar). Keep happy-path with target=self.
- `src/modules/orchestrator-dispatch/integration.test.ts` — `test_e2e_threaded_happy_path`, `test_e2e_headless_happy_path` updated to use single-group setup.
- Container `dispatch.ts` (MCP tool) — drop `target_group` param from input schema.

**Rename surface**:
- MCP tool registrations: `dispatch_task` → `spawn_task`, `list_dispatched_tasks` → `list_spawned_tasks`, `dispatch_cancel` → `spawn_cancel`, child tools `dispatch_progress` → `spawn_progress`, `dispatch_complete` → `spawn_complete`, `dispatch_failed` → `spawn_failed`.
- `registerDeliveryAction` calls in `src/modules/orchestrator-dispatch/index.ts` — same renames for the 5 system actions.
- Watchdog reap notification action: `dispatch_task_watchdog_fail` → `spawn_task_watchdog_fail`.
- `_dispatch` envelope kind in formatter → `_spawn` (and `_dispatch_cancel` → `_spawn_cancel`).
- Update all test names, doc strings, log messages, error strings that include "dispatch."
- Migration 027 (NEW): rename `session_routing.dispatch_task_id` → `session_routing.spawn_task_id` in inbound.db schema; same for INBOUND_SCHEMA.
- Drop `target_agent_group_id` column from `tasks` (migration 028, separate from rename — keeps migration commits coherent).

**Spec docs revision**:
- `brief.md` + `design.md` — add a banner at the top: *"REVISION 2026-05-10: Phase 1 originally framed as cross-group dispatch; reframed to self-orchestration after live use revealed the design intent. Cross-group capability removed; renaming dispatch → spawn. See spawn-rework-plan.md for the full correction trail."*
- Update body text to use "spawn" terminology.
- Mark Phase 1 cross-group capability under an "Originally built but removed" subsection so the audit trail is preserved.
- `decisions.yaml` — append new entries for the strip + rename decisions.

### What STAYS (load-bearing parts of Phase 1, all preserved)
- `agent_group_capabilities` table + capability-grant flow (still need to mark a group as "may spawn")
- `tasks` table (minus `target_agent_group_id`)
- `session_routing.spawn_task_id` (renamed from `dispatch_task_id`) — still needed for child sessions to know their task identity
- All cycle-3 M17-M25 fixes
- Atomic admit (BEGIN IMMEDIATE) with idempotency replay precedes cap (M20)
- Status-CAS guards on every artifact UPDATE (M22)
- Completion lease + in-process Map (M23)
- M21 ordering (tasks UPDATE → routing → message → wake)
- `adapter_unavailable` early return (Codex #43 fix)
- Drain-first guard from `pending_terminal_dispatch_outbound_seen_at` (M24)
- Watchdog `decideTaskAction` with deadline-overrides-drain + last-signal triple fallback
- Reconciler on existing 60s sweep tick
- Slack `createThread` returns `{threadId: parentMessageId, messageId: reply.ts}` (M25)
- Cancellation 2-min hard-kill timer + `_spawn_cancel` envelope (renamed from `_dispatch_cancel`)
- `ChannelAdapter` interface widening with `postParent` + `createThread` (still needed for Slack thread anchoring)
- `assertChannelRoutingConsistency` runtime check
- Per-agent-projection allow-list extension for `tasks` (filtered by `parent_agent_group_id`) and `agent_group_capabilities`
- F2 cross-runtime contract for `deriveSpawnTaskId` (renamed from `deriveDispatchTaskId`) — length-prefix canonicalization stays

### Sibling-to-sibling communication (DEFERRED, not in this rework)
- Phase 1 + this rework rely on shared group state (workspace, memory, backlog) for sibling coordination
- Parent-coordinated dependency model is the recommended pattern (parent waits for A, reads result_summary, spawns B with A's output)
- Future MCP tool `wait_for_sibling(task_id)` or `read_sibling_progress(task_id)` only if direct real-time sibling comms become a felt pain
- Not building this now

### Phase 2 (board UI) — separate plan, follows this rework
- Once spawn rework is merged, run a fresh `/team-plan` for the dashboard
- Phase 2 spec already exists in `design.md` §7 — Vite+React SPA on existing webhook-server, owner-only auth via DM-token, SSE live updates via chokidar, kanban + task-detail + session-list views, jony-ive + impeccable audit
- Was scoped during Phase 1 build but deferred — now elevated to headline next-feature

## Order of operations for the spawn rework

1. `git checkout main && git pull` (verify on `3bcf601` or later)
2. `git checkout -b feat/orchestrator-spawn-rework`
3. Apply strip changes (~150-200 lines of removal)
4. Apply rename changes (mechanical sweep)
5. Add migration 027 (rename `dispatch_task_id` → `spawn_task_id` column)
6. Add migration 028 (drop `target_agent_group_id` column)
7. Update tests (remove cross-group, rename, verify all green)
8. Update brief.md / design.md / decisions.yaml with revision banner
9. Run `pnpm test --run` + `cd container/agent-runner && bun test` + `pnpm run build` + boot smoke
10. Commit (single feat commit + style commit if hook fires)
11. Push to fork: `git push -u origin feat/orchestrator-spawn-rework`
12. PR against `davekim917/nanoclaw/main` with title `feat(orchestrator-spawn): rework — strip cross-group, rename dispatch→spawn`
13. Self-merge via merge-commit (NOT squash — preserves topology, single-sha revert via `git revert -m 1`)
14. Sync local main, delete feature branch (local + remote)
15. Update CLAUDE.md / build-state if needed
16. THEN start Phase 2 (board UI) via fresh `/team-plan`

## Open questions for assistant after compaction (none right now — all locked)

If a fresh assistant picks this up after compaction:
- Read this file FIRST
- Read `docs/specs/orchestrator-dispatch/qa-report.md` for the K7-K11 known risks (still apply post-rework)
- Read `docs/specs/orchestrator-dispatch/decisions.yaml` for full constraint + auto_judgments history
- The user's intent is settled. Don't re-debate the strip vs relax decision; user explicitly chose strip.
- The rename decision is settled. Don't propose alternative names.
- The folder-rename-NO decision is settled. Don't propose folder rename in this rework.

## Audit trail of the framing correction

Posterity note: this is the second time on this feature where we caught a framing error after-the-fact. Cycle-3 of /team-review caught the M17 `dispatch_task_id` placement issue (was on central.db `sessions`, must be on inbound.db `session_routing`). This rework catches the cross-group-vs-self-orchestration framing. Both were caught after substantive work was done. Worth a /team-retro entry on "validate the user's mental model of the unit-of-isolation BEFORE locking the brief, not after."
