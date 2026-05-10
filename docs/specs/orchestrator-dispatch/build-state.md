# Build State — orchestrator-dispatch

> Lead's persistent memory across context compression. Updated after each group completion.

## Build Header

- **Feature:** orchestrator-dispatch
- **Branch:** feat/orchestrator-dispatch (no worktree — already isolated)
- **Working dir:** `/home/ubuntu/nanoclaw-v2` (host filesystem, persistent)
- **Team:** `orchestrator-dispatch-build` (created 2026-05-09)
- **Plan:** `docs/specs/orchestrator-dispatch/plan.md` (1507 lines, post-revision-1)
- **Plan revision history:** revision 1 applied during pre-build drift triage (B3 adapter_unavailable + D5 _dispatch_cancel) — recorded in `decisions.yaml` `plan_revisions[]`
- **Pre-build drift gate:** ✅ PASS (MISSING=0, effective DIVERGED=0; 1 entry acked in `drift-acks.json` for bifurcated mounting Phase 1 simplification)

## Builder Assignments

| Builder | Group | Files Owned | Status |
|---------|-------|-------------|--------|
| builder-A | A | 14 (schema, migrations 025/026, agent_group_capabilities + tasks CRUD, runtime assertion) | in_progress (started 21:00 UTC; ACK verified) |
| (pending) | B | 14 (host dispatch handlers + reconciler) | pending — blocked by A |
| (pending) | C | 4 (watchdog) | pending — blocked by B |
| (pending) | D | 11 (container MCP tools + formatter) | pending — blocked by A |
| (pending) | E | 7 (adapter interface + Slack/Discord createThread) | pending — blocked by A |
| (pending) | F | 3 (integration + contract tests) | pending — blocked by B+C+D+E |

## Dependency Graph

```
A → (B || D || E) → C → F
```

Once A completes, spawn B + D + E in parallel.

## Carry-forward Risks (from cycle-3 review.md + pre-build drift)

- **K1** rare-host-crash duplicate platform message — validated in /team-tdd via in-process map + durable lease (B6/B7 ASSERTs)
- **K2** adapter rate-limit blowback under fanout — validated in /team-tdd as load-shedding test (S19)
- **K3** per-agent-projection allow-list extension — intentional schema-design choice in A2, NOT drift
- **K4** memory budget for Phase 2 dashboard — deferred to separate /team-plan after Phase 1 ships
- **K5** cycle-3 cap-reached escape via Path 1 — user-approved 2026-05-09; design revision applied all 9 MUST-FIX inline
- **K6** (NEW from drift triage) self-dispatch validation — plan B2 doesn't reject target=caller's group; FK enforces target exists; defer to builder discretion
- **B1 ack** bifurcated mounting mutual-exclusion — Phase 1 simplification per design line 313 ("not Phase 1 use case but schema supports it")

## Pre-build Findings Folded into Builder Acceptance

These were Codex PARTIALs that were folded into builder acceptance criteria, not blockers:

- **P9** Container parent_session_id source (NANOCLAW_SESSION_ID vs session-routing) — builder-D verifies at build time
- **P10** target validation completeness — builder-B adds defensive existence + self-dispatch checks at B2
- **P11** wakeContainer(callerSession) after admit notification — builder-B adds this in B2

## Validation Log (per-group, populated as groups complete)

### Group A — COMPLETED (iteration 3 of 3 cleared, FINAL)
- Iteration 3: builder-A applied scope expansion + COALESCE pattern. Lead validated: 84 tests pass across 8 files; build clean.
- Lazy migration via `migrateSessionRoutingTable` keeps backward compat with pre-026 inbound DBs without requiring a separate migration runner
- `INBOUND_SCHEMA` session_routing now includes both `dispatch_task_id` and `session_id`; `writeSessionRouting` writes `session_id: sessionId`; COALESCE preserves dispatch_task_id across routine wake-time writes
- Result: D's `getSessionId()` will now return the actual session_id; `list_dispatched_tasks` works end-to-end
- Final fix-loop usage: 3/3 (capped)

### Group A — completed (fix-loop iteration 2 of 3 cleared) [stale — see iteration 3 above]
- ACK received: ✓ (matches assignment exactly)
- Files claimed: ✓ (14 files, exclusive)
- Iteration 1 (21:39 UTC): Builder reported done; lead validation **REJECTED** with one defect (per-agent-projection allow-list extension non-functional end-to-end). See SendMessage in this file's history.
- Iteration 2 (21:51 UTC): Builder applied 3 surgical fixes (Fix A: FK off on dst, Fix B: filterColumnByTable map, Fix C: tightened catch regex) + created `src/db/per-agent-projections.test.ts` with 4 named tests. Lead re-validated: ALL PASS.
- Final validation: ✓
  - 43 tests pass across 6 Group A test files (39 original + 4 new projection tests)
  - `pnpm run build` clean
  - Full-suite regression: 8 failures verified pre-existing on origin/main (`scripts/q.test.ts`, `src/memory-daemon/index.test.ts` — both unmodified by Group A)
  - Empirical end-to-end proof: builder ran the same fixture I used; dst now has 1 task row + 1 capability row (was 0 + 0 in iteration 1)
  - All A1-A5 ASSERTs verified
  - Per-agent-projection extension functional (orchestrator sees own dispatched tasks via `parent_agent_group_id` filter; capability rows visible)
  - Stage 1 (spec compliance): clear
  - Stage 2 (code quality): clear (Result-pattern revoke, FK off well-commented, catch regex tightened to suppress only intended case)
- Task #1 status: COMPLETED at 21:53 UTC

### Group B — completed (validated 22:28 UTC)
- 15 files (14 owned + tests/fixtures/dispatch-task-id-vectors.json)
- 66 tests pass across 6 own files + 2 Group A test files re-verified
- All ASSERTs verified with test name citations
- Build clean (TypeScript fixed: `'allow'` → `'public'` for UnknownSenderPolicy)
- Empirically verified: B3's `test_adapter_unavailable_marks_failed_immediately` asserts `dispatch_completion_attempts === 0` (Codex #43 fix)
- B uses raw SQL to write `dispatch_task_id` to inbound.db session_routing — bypasses upsertSessionRouting (note for A's iteration 3)
- Builder-B's adapter signature note carried forward to Group E spec (E already followed it)

### Group D — completed (validated 22:11 UTC)
- 11 files
- 70 new tests pass; 239 total in container suite
- All ASSERTs verified, M17/S24/S25/S26/M21/M25 implemented
- D's getSessionId currently returns null (no session_id column in schema yet — Group A iteration 3 will add it; D's reader stays as-is)
- F2 fixture verified: 4 vectors bit-identical between host (Node) and container (Bun)

### Group E — completed (validated 22:12 UTC)
- 7 files
- 37 tests pass (slack 9 + discord 28)
- M25 verified: Slack createThread returns `{threadId: parentMessageId, messageId: reply.ts}` (NOT reply.ts as threadId)
- Bridge wrapper strips channelType (existing setTyping/deleteMessage pattern)
- Channels source files were already on `feat/orchestrator-dispatch` (no checkout needed)

### Group C — completed (validated 22:44 UTC)
- 4 files
- 51 tests pass (23 watchdog + 28 host-sweep)
- Sweep order verified: sweepSession (171) → runReconcilerSweep (179) → sweepTaskWatchdog (183) → next-tick reschedule
- C20 (deadline overrides drain), M24 (drain grace from terminalOutboundSeenAt), C21 (last_signal triple fallback) all asserted
- C2 false-positive avoidance verified: `test_excludes_false_positive_match` correctly excludes `action: 'dispatch_complete_other'`

### Group F — completed (validated 22:58, fix-loop iteration 1 cleared at 23:02)
- 2 files (integration.test.ts + derive-task-id-contract.test.ts) + reads B's fixture
- Iteration 1 fix: F preemptively updated `test_e2e_watchdog_terminates_no_progress` assertion to canonical `'no_progress_timeout'` after C's spec-compliance fix
- 8 F1 e2e tests pass (admit, threaded, headless, idempotency, replay-at-cap, cancellation, complete-after-cancel CAS, watchdog reap, orphan recovery)
- 7 F2 cross-runtime contract tests pass (container deriveDispatchTaskId bit-identical to host)

### Group C — completed (fix-loop iteration 1 cleared at 23:01)
- Iteration 1 trigger: F's tests revealed C produced non-canonical `fail_reason` values (`'no-progress'` vs design's `'no_progress_timeout'`)
- C added `ACTION_TO_FAIL_REASON` map + warn-on-unknown defensive logic + 4 new parameterized canonical-value tests
- 32 host-sweep tests pass (was 28; +4 new)
- All 4 reasons correctly mapped: deadline_exceeded, no_progress_timeout, container_exit, spawn_deadline

## Final group status
- Group A: ✓ (3 fix iterations / 3 cap)
- Group B: ✓ (no fix iterations)
- Group C: ✓ (1 fix iteration / 3 cap)
- Group D: ✓ (no fix iterations)
- Group E: ✓ (no fix iterations)
- Group F: ✓ (1 fix iteration / 3 cap, coordinated with C)

## Ready for /team-build Step 6 (shutdown) → Step 7 (post-build drift) → Step 8 (gate)

### Group B — pending
### Group C — pending
### Group D — pending
### Group E — pending
### Group F — pending

## Two-Stage Implementation Review (per group, populated at validation)

| Group | Stage 1 (spec compliance) | Stage 2 (code quality) | Net |
|-------|--------------------------|-----------------------|-----|
| A | (pending) | (pending) | — |
| B | — | — | — |
| C | — | — | — |
| D | — | — | — |
| E | — | — | — |
| F | — | — | — |

## Fix Loop Tracking (per criterion, capped at 3)

(none yet)

## Build-relevant CLAUDE.md excerpts

- Host: Node + pnpm. ESM only — never `require()`. `pnpm test` runs vitest. `pnpm run build` typechecks. `pnpm run dev` starts host with hot reload.
- Container: Bun (separate package tree at `container/agent-runner/`). `cd container/agent-runner && bun test`. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root for container typecheck.
- Two-DB invariant: `inbound.db` (host writes, container reads), `outbound.db` (container writes, host reads). Single writer per file.
- Container build: `./container/build.sh` after Dockerfile or container-runner edits.
- Restart: `sudo systemctl restart nanoclaw-v2` (host runs Linux, system-level service).
- gitnexus: run `gitnexus_impact` before edits to functions/classes; `gitnexus_detect_changes` before commits.
