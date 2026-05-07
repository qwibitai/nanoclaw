# /team-auto paused at Stage D (QA) — fix-cycle cap reached

**Stage:** QA (post-build, fix-cycle 3 of 3)
**Reason:** `cap-reached` — Codex round 3 surfaced 1 new HIGH finding (E9 chained-overlap)
**Last action attempted:** Codex Validator E round 3 verification on commit `98faba9`

## Where we are

- Pre-build drift cleared.
- Stages A–C: 5 task groups built, 7 commits, 713 host tests pass at build end.
- Stage D fix-cycle 1: Codex round 1 found E1–E5 (4 MUST-FIX + 1 SHOULD-FIX). All 5 fixed in commit `fd15465`.
- Stage D fix-cycle 2: Codex round 2 found E6–E8 (2 MUST-FIX + 1 SHOULD-FIX). All 3 fixed in commit `98faba9`.
- Stage D fix-cycle 3: Codex round 3 found 1 new HIGH (E9). Tests still 719/719; tsc clean.

## Codex round 3 finding

**E9 — Chained overlap can escape ambiguous-correlation marking** (HIGH, confidence 0.88)

- **File:** `src/memory-daemon/recall-judge/judge.ts:166-190`
- **Scenario:** Same-thread chain A at t=0, B at t=55s, C at t=110s. A↔B overlap (within 60s window). B↔C overlap (within 60s). A↔C does NOT overlap directly (>60s).
- **What happens:** Loop processes A first → ambiguity check sees A+B overlap → terminally marks A and B as `ambiguous-correlation` (E6 fix). When loop reaches C → ambiguity query filters by `judged_at IS NULL`, B is now non-NULL, so C's overlap query sees only C → judge proceeds, scoring C against an ambiguous assistant response.
- **Impact:** Transitive same-thread chains where consecutive pairs each overlap silently produce judged rows that should have been ambiguous. `recall_quality` metrics become quietly noisy in busy threads.
- **Severity:** HIGH but narrow — requires 3+ recalls in same thread within 110s (rare in normal operator use; possible under bursty load).
- **Fix path:** Compute connected components from the pending snapshot before marking ANY event terminal. Build the ambiguity graph (same thread + within 60s) on the snapshot, mark whole components atomically.
- **Effort:** ~15-25 LOC + 1 chained-overlap regression test (~30 LOC). Mechanical.

## Why I'm escalating

Per team-auto Stage D rule: "MUST-FIX > 0 and fix-cycle == 3 → escalate `cap-reached`."

Beyond the strict rule, the diminishing-returns curve is informative:
- Round 1: 4 MUST-FIX (CRITICAL→HIGH) on core machinery.
- Round 2: 2 MUST-FIX (HIGH) on edge cases.
- Round 3: 1 MUST-FIX (HIGH, lower confidence 0.88) on a transitive-overlap edge case.

Codex finds real issues each round. They're getting narrower in blast radius and lower in confidence. We are approaching a practical floor.

## Three paths

**A. Apply the E9 fix and ship.**
- Build connected components in JS from the pending snapshot per `(agent_group_id, thread_id)`, walk same-thread events and union-find within 60s windows, mark whole components in one transaction.
- Adds ~25 LOC + 1 regression test.
- Risk: each fix cycle has surfaced a new issue. Round 4 may surface a round-3-style finding (probably even narrower). The cycle cap is the contract — if you want to keep going, you tell me.
- After fix: re-run `pnpm test` + `tsc`, re-run `/team-qa --only codex`. If clean → ship. If a new MUST-FIX appears → another decision point.

**B. Accept E9 as a documented edge case and ship.**
- Log a warning when an event has 3+ same-thread peers within 110s pre-judging. Operators see the warning and know recall_quality may be noisy in those windows.
- Add a known-issue note in `docs/memory.md` under the recall_quality section.
- Adds ~5 LOC + doc update.
- Pro: ship now with explicit acknowledgment. Honest tradeoff.
- Con: a real correctness gap shipped (narrow, but real).

**C. Defer to v2.**
- Land what we have. recall_quality metrics are best-effort under heavy concurrency.
- No code change.
- Pro: smallest scope. Move on.
- Con: lowest auditability story.

## My recommendation

**Path A** if the chained-overlap pattern is plausible in your traffic profile (multiple recalls per thread within 110s — does happen for active conversations in axis-labs / similar with recall_scope='all-groups').

**Path B** if your traffic is mostly DM/short-thread and chained overlap is exotic. The known-issue doc is honest and the warning gives operators a signal.

**Path C** if you want to ship now and revisit when v2 introduces feedback-loop closure (which would care more about score accuracy).

Tell me **A**, **B**, or **C**. If A, I apply the fix in one commit, re-run Codex, and either gate-pass or escalate again. If B, I add the warning + doc and gate-pass. If C, I gate-pass with the residual documented in `qa-report.md`.

I will not pick a path on my own — cycle 3 cap reached.
