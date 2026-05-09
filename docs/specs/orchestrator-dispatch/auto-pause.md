# /team-auto paused at Stage A

**Stage:** Review
**Reason:** `cap-reached`
**Cycles consumed:** 3/3
**Last action attempted:** Re-invoked `/team-review` after applying the cycle-3 revision pass (8 MUST-FIX). `/team-review` Step 0 saw `decisions.yaml.review_cycles.length === 3` and refused to start a 4th cycle (per design — the cap exists precisely to surface designs that aren't converging through patching).

## Why I stopped

Three full review cycles ran. Each cycle confirmed the prior cycle's revisions DID close their target findings, but each cycle also surfaced NEW structural issues introduced by the revisions themselves. This is the convergence pattern the 3-cycle cap is designed to catch.

| Cycle | MUST-FIX in | What revision pass closed | What it newly surfaced |
|---|---|---|---|
| 1 | 16 | Spec-text errors (`undici→http`, `geist→@fontsource-variable/*`, `chokidar→SSE`), rough authorization shape, basic schema | Architectural fictions (per-session MCP mounting), state-machine crash holes, missing finalization markers, dashboard auth gaps |
| 2 | 9 | State-machine crash idempotency, MCP tool architecture pivot, finalization markers, cookie-based SSE auth, source-session binding | Cancelled-marker leakage, cap-promotion ambiguity, session-token mode without substrate, off-by-one cap, missing dependency check at promotion, sessions↔tasks binding integrity, dependent-list durability, adapter mid-call durability |
| 3 | 8 | All cycle-2 issues addressed (cancelled completed_at, neutral 'admitted' state, dropped session-token, < cap, dep check in promotion, binding trigger, dependents_unblocked_json, split adapter contract) | Cap reached — no further review run; cycle-3 fixes are unverified |

Reviewer B at cycle 3 explicitly endorsed the design as "build it" with only LOW-severity operational drifts. Reviewers A and C continued to find architectural precision gaps. The asymmetry is the cross-model diversity signal the multi-lens review is designed to surface — and it converged on a real conclusion: this design is on a sound pattern (durable execution + outbox finalization + atomic CAS claim + capability authorization) but has accumulated complexity that introduces precision errors with each revision pass.

## Findings still open (cycle 3 — unverified after cycle-3 revision pass)

All cycle-3 MUST-FIX from `docs/specs/orchestrator-dispatch/review.md` were addressed by inline revisions in commit just prior to this pause. The revisions are unverified because the next `/team-review` would have been cycle 4 (capped). Specifically:

| ID | Title | Status of cycle-3 revision |
|---|---|---|
| M3-1 | Cancelled internal-only marker leakage | `applyCancelTask` now sets `completed_at=now` alongside `cancelled_at=now`. Unverified. |
| M3-2 | Cap-promotion `dispatch_state` ambiguity | New neutral `'admitted'` state set inside the cap transaction; adapter resolution moved to step 5 outside the transaction. Unverified. |
| M3-3 | `dispatch_approval_mode='session-token'` had no substrate | DROPPED `'session-token'` from v1 entirely. v1 ships `'none'` (default) and `'per-dispatch'` only. `'session-token'` deferred to follow-up spec. Unverified. |
| M3-4 | Cap check off-by-one | `≤` → `<`. Unverified. |
| M3-5 | No dependency check in initial promotion | Cap-promotion transaction now also requires `NOT EXISTS (incomplete dependencies)`. Unverified. |
| M3-6 | sessions↔tasks binding integrity | Added `BEFORE UPDATE OF child_session_id ON tasks` trigger enforcing `sessions.dispatch_task_id == tasks.task_id`. Unverified. |
| M3-7 | Dependents_released list not durable | New column `tasks.dependents_unblocked_json TEXT`; step b sets both atomically; step d reads from it. Unverified. |
| M3-8 | Adapter `createThread` mid-call durability | Adapter contract split into `postParent` + `createThreadFromParent`; new `'parent_posted'` intermediate state; `parentPlatformMessageId` durable before thread call. Unverified. |

Plus 4 SHOULD-FIX addressed inline (S3-A through S3-D-G), 7 SHOULD-FIX still open from cycle-3 review.

## Owner decision required — `/team-review` cap-reached options

Per the cap-reached gate, the path forward requires the owner's call:

### Option 1 — Waive remaining MUST-FIX

Explicitly accept the 8 cycle-3 MUST-FIX as addressed (since the cycle-3 revision pass did apply concrete fixes for all 8) without a fresh validation cycle. The waiver is logged in `decisions.yaml.waivers` with a stated reason. **Risk**: the cycle-3 fixes are unverified; if any of them have the same "introduces new issue" pattern as cycles 1 and 2, those issues land in `/team-build` rather than being caught at design time.

**Recommendation if choosing this**: at minimum read the design.md sections most affected by the cycle-3 revisions:
- §Data model: new `dependents_unblocked_json` column, new `tasks_child_session_binding_check` trigger
- §Dispatch flow: `'admitted'` state, BEGIN IMMEDIATE cap+dep transaction, split `postParent` / `createThreadFromParent` flow
- §Reverse signal: cancelled-task skip on dependent fan-out, persist `dependents_unblocked_json` atomically with marker
- §Dispatch authorization scope: `'session-token'` removed from v1
- §`cancel_task`: `completed_at` set alongside `cancelled_at`

### Option 2 — Rework the design

Return to `/team-design` with the unresolved findings as new input. Honest interpretation of the trajectory: each cycle's revisions correctly close their target findings but introduce precision gaps because the design surface area is large. A fresh `/team-design` pass could simplify the surface (e.g. drop the dashboard from MVP, defer dependency-chain support, defer cancellation) and cycle through review again with a smaller blast radius.

### Option 3 — Escalate per finding

You make the call on each of the 8 cycle-3 MUST-FIX:
- For each, read the cycle-3 revision in `design.md` (commit just prior to this pause)
- Decide: accept the revision (mark `Addressed` in decisions.yaml.waivers), reject and rework, or escalate as a `[NEEDS SPEC]` carry-forward into `/team-plan`

This is the most rigorous path. Highest owner-time cost.

### Option 4 — Simplify the design (cut to MVP)

`/team-design` re-entry at the MVP scope boundary. Cuts to consider, in order of effort impact:
- **Drop the dashboard from v1 MVP** (~3-4 days saved; cycles 2 and 3 surfaced 4 dashboard-related findings: M3-3 partial, M2-G, M7, M9 elements). Slack-first workflow per brief R3 + R8 still works without it; owner steers via subthreads.
- **Defer `cancel_task` to v2** (~0.5 day saved; cycles 2 and 3 surfaced 3 cancel-related findings: M3-1, M2-B, M12 LLM-turn interruption complexity). For v1, owner stops a runaway by sending `kill <session>` via the existing admin command surface or letting the deadline expire.
- **Defer `task_progress` deadline extension to v2** (~0.5 day saved; cycle 3 found M3 deadline-extension formula edge cases). For v1, original deadline is the deadline.
- **Defer dependency chains to v2** (~1 day saved; cycles 2-3 surfaced multiple `task_dependencies` issues: cycle detection, cross-session enforcement, durability of release list). For v1, owner sequences manually — the orchestrator dispatches batch 1, waits, dispatches batch 2.

A "cut to MVP" pass that defers any TWO of these four would meaningfully reduce the design's surface area.

## What I would do next if I had answers

Read your selection and act:
- **Option 1** → `/team-auto` resumes Stage A by treating cycle-3 MUST as waived; proceeds to Stage B (`/team-plan`).
- **Option 2** → `/team-auto` exits cleanly; you re-enter via `/team-design`. The cycle-1, cycle-2, and cycle-3 review reports are kept in git as the input record.
- **Option 3** → I read each of the 8 cycle-3 MUST and present a per-finding accept/reject/escalate recommendation with grounding citations; you confirm each.
- **Option 4** → I draft the cut-to-MVP scope and propose specific deletions to design.md; you approve before I edit.
