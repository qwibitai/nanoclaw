# /team-auto paused at Stage A

**Stage:** Review
**Reason:** `cap-reached`
**Cycles consumed:** 3/3
**Last action attempted:** Cycle 3 review surfaced 9 new MUST-FIX (concentrated in two areas: dispatch_task_id propagation mechanism, and §4 race conditions) plus 9 SHOULD-FIX. Cycle 2 fixes (M9-M16) all closed cleanly, but the M12 mechanism choice (read `sessions.dispatch_task_id` from central.db) cannot work because the container has only a per-agent projection of central.db that excludes that table. The /team-review cap is 3 — the next /team-review invocation refuses to run a 4th cycle.

---

## Why I stopped

`/team-auto` cannot run a 4th /team-review cycle. Per the cycle cap rule in `team-review` Step 0, the skill emits the cap-reached gate when `review_cycles` already has 3 entries.

The design is *almost* there. Reviewer A's cycle-3 verdict is explicit: "Cycle-2 fixes M9, M10, M11, M13, M14, M15, M16 all hold. M12 has the right architectural intent but a wrong implementation mechanism. F4 and F5 are textual/operational risks that should be addressed before /team-plan but are not architectural blockers." Reviewer B's cycle-3 verdict: "The cycle-3 design is structurally sound and faithful to the canonical patterns it cites." Reviewer C surfaces 7 race/correctness gaps that are all fixable inline with focused revision.

The user must now choose between four paths. /team-auto cannot pick between them — they involve scope, risk-acceptance, and timeline judgments that are user calls, not engineering judgments.

---

## Findings still open (cycle 3)

**MUST-FIX (9):** see `docs/specs/orchestrator-dispatch/review.md` for full detail with file:line evidence.

- **M17** — Container central.db is a per-agent projection; `sessions`, `agent_group_capabilities`, `tasks` not in allow-list. M12 mechanism cannot work as designed. **Fix path is well-bounded** (move dispatch_task_id to inbound.db's session_routing).
  - Evidence: `src/db/per-agent-projections.ts:128-131,142` allow-list = `{'backlog_items', 'ship_log'}` only.
- **M18** — `'task-'` vs `'dispatch-'` prefix discrepancy at design.md:301. One-line fix.
- **M19** — `completeDispatchSideEffects(taskRow)` needs full row but `INSERT ... RETURNING` returns only task_id, request_hash. Text fix.
- **M20** — Idempotency replay should precede concurrency cap check (Stripe canonical pattern). Reorder.
- **M21** — Child container is woken before `tasks.child_session_id` written; race produces rejected progress / lost completion. Reorder writes.
- **M22** — Step-8 artifact UPDATEs not status-guarded; cancel/watchdog can race with completion. Add CAS guards.
- **M23** — `setImmediate` job and 60s reconciler can run `completeDispatchSideEffects` concurrently → duplicate Slack/Discord parent message without host crash. Need in-process map + durable lease column.
- **M24** — Drain-first grace measured against progress timestamps not against pending-terminal-outbound timestamp. Quiet long-running tasks can be killed even with completion in queue. Different timestamp source.
- **M25** — Slack `createThread` should return `{threadId: parentMessageId, messageId: reply_ts}`; current spec returns reply_ts as threadId, which would route subsequent posts wrong.

**SHOULD-FIX (9):** S18-S26 in `review.md`. Spans cross-DB transaction notify-failure, fanout vs adapter rate limits, SQL precedence + scan cost, doc drift, request_hash colon-collision, capability check granularity, surface_mode persistence, dispatch_cancel_request container protocol.

---

## What I would do next if I had answers

Three viable paths the user can choose:

### Path 1 — **Waive non-blocking SHOULD-FIX, fix all 9 MUST-FIX in a final design revision (no more /team-review), proceed to /team-plan**

This is the path most aligned with what the cycle-3 reviewers actually said. Reviewer A's verdict explicitly hints at it: *"If F1+F2 collapse to 'use inbound.db, not central.db' in cycle-3 revision, this design is structurally sound and ready for /team-plan."* The 9 MUST-FIX have a clear, bounded fix surface:

- 7 of 9 are 1-3 line text/SQL fixes (M18, M19, M20, M21, M22, M24, M25)
- M17 is a mechanism swap (1 column-relocation, ~20 lines of design body — already specified by reviewer A's recommendation)
- M23 needs a new column + ~30 lines of in-process guard logic — the only finding requiring meaningful new design

User explicitly says "don't run /team-review again, proceed with my judgment." /team-auto can't auto-apply because the mechanism swap (M17) is a real architectural choice between three options Reviewer A presented (inbound.db column, sibling table, first-inbound only).

### Path 2 — **`/team-design` re-entry from Step 6c MVP cut**

Restart at the MVP scope boundary: drop the dashboard (Phase 2) entirely from this brief, ship Phase 1 dispatch primitive only. This collapses the surface enough that the remaining MUST-FIX shrink to maybe 5-6 (dashboard-specific findings drop). Resets the /team-review cap counter.

Cost: real time and cycles already spent on the dashboard work; you'd ship Phase 1 alone first and revisit dashboard in a follow-up brief.

### Path 3 — **Waive all 9 MUST-FIX with stated reasons, proceed to /team-plan**

Document each MUST-FIX as `[NEEDS SPEC]` carry-forward in `review.md` (already done in the report's `Carry-forward to /team-plan` section). /team-plan gets the unresolved spec items as explicit work-to-resolve; the planner produces a plan that schedules these spec resolutions before the build.

This is procedurally allowed but the cycle-3 review report flagged 9 MUST-FIX precisely because /team-plan can't proceed without these resolutions. Likely produces a planner that blocks immediately on M17.

### Path 4 — **Manual override: write the cycle-4 revision myself, then proceed**

User-initiated, outside /team-auto. User edits the design directly OR delegates to me with explicit instructions, then says "proceed to /team-plan" without re-running /team-review.

This is a valid escape hatch when the user has high confidence the remaining issues are bounded — Reviewer A's recommendation suggests they are.

---

## My recommendation (engineering call only — user decides scope/timeline)

**Path 1 with my offer to apply all 9 MUST-FIX as a single revision pass before invoking /team-plan.**

The 9 MUST-FIX are concrete, bounded, and have clear fix paths in the review report. The architectural intent is correct (Reviewer A + B both confirm). Path 2 (MVP cut) wastes prior cycles' work; Path 3 (waive all) just defers the same work to /team-plan with worse context; Path 4 (manual override) is fine but requires user attention. Path 1 keeps the design intent intact, applies bounded textual + 1-mechanism-swap revisions, and lets /team-plan operate on a clean spec.

If user agrees: /team-auto would NOT re-run /team-review (cap-reached); user's explicit acknowledgment that the cycle-3 findings are addressed serves as the green-light to /team-plan.

Tell me which path you want — I will not retry or guess.
