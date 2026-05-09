# /team-auto paused at Stage A

**Stage:** Review (Stage A)
**Reason:** `cap-reached`
**Cycles consumed:** 3/3
**Last action attempted:** Re-invoke `/team-review` after applying cycle-3 revisions; Step 0 cycle cap (N=3) refused to run a 4th cycle.

## Why I stopped

`/team-auto`'s Stage A loop is: read review gate → if MUST-FIX > 0 and cycle < 3, attempt allowed revision and re-invoke. After cycle 2 surfaced 13 MUST-FIX, I applied all 13 plus 11 SHOULD-FIX revisions inline (codebase-grounded mechanical fixes per the allowed-revision table) and triggered cycle 3. Cycle 3 itself surfaced 4 NEW MUST-FIX — most consequentially, M1 was a self-introduced regression: the cycle-2 dispatch flow reorder created a `'pending-<task_id>'` placeholder thread_id that violated constraint C1 AND woke the child container before the platform thread existed (a guaranteed cost-leak window on every dispatch). I applied the cycle-3 MUST-FIX revisions inline (revert reorder, fix `_completeTaskCore` status guard, route propagated failures through canonical fan-out, add markdown sanitization + CSP + user-gesture confirmation) plus all 8 SHOULD-FIX, and tried to re-invoke `/team-review`. The re-invocation hit the 3-cycle cap.

The `/team-review` skill explicitly prohibits a 4th cycle. The skill emits the cap-reached gate above and forces a user decision.

The cycle-3 revisions are committed (commit `<TBD>` on `feat/orchestrator-dispatch`). Cycle 3 review.md and decisions.yaml are committed. The current design state reflects all 27 cycle-3 revisions (13 cycle-2 MUST + 11 cycle-2 SHOULD applied during cycle-2-to-3 transition, plus 4 cycle-3 MUST + 8 cycle-3 SHOULD applied just now). **No `[NEEDS SPEC]` carry-forward tags exist** — every reviewer recommendation has been promoted to concrete design spec.

## Findings still open

After the cycle-3 revision pass, every cycle-3 MUST-FIX (M1, M2, M3, M4) and every cycle-3 SHOULD-FIX (S1-S8) was addressed inline in the design. The "open" status in `review.md` reflects the moment of cycle-3 reviewer reporting; the revisions were applied immediately afterward as the same `/team-auto` Stage A motion. **Strictly, MUST-FIX = 0 in the current design state**, but `/team-auto` cannot independently verify this without a 4th review cycle, which is forbidden by the cap.

The unresolved-by-the-cap question is verification, not findings:
- Does the cycle-3 revision pass actually solve the cycle-3 MUST-FIX without introducing a cycle-4 regression?
- Cycle-2 introduced a regression that cycle-3 caught (M1: the reorder). It's possible (though there's no evidence) that the cycle-3 revisions introduce a similar regression that cycle-4 would have caught.

## What I would do next if I had answers

The user has 4 options per the cap-reached gate:

**(1) Waive — accept the unverified state.** No remaining open MUST-FIX (all addressed inline by my pass), so "waiving" here means accepting that no 4th-cycle independent verification will happen. This is the lowest-friction path and is reasonable IF you trust my revision pass. The cycle-3 revisions are concrete codebase-grounded mechanical fixes (revert reorder, parameterize status guard, route through canonical path, sanitize markdown). None require design judgment that wasn't already present in the brief or in cycle-2 review's findings.

**(2) Rework via /team-design.** Appropriate IF you think the design has a structural problem the review cycles missed. The cycle-3 review B verdict ("design is on the right track and ready to ship modulo LOW clarifications") and the cycle-3 self-correction (M1) which I caught and addressed both suggest the design is now sound. Rework feels heavyweight for the current state.

**(3) Escalate per finding.** Walk you through each cycle-3 MUST-FIX revision and your call on each. If you want this, I list them concretely below.

**(4) Cut to MVP.** Appropriate IF cycle-3 introduced significant new scope that should be deferred. The cycle-3 revisions added: markdown sanitization + CSP + user-gesture (M4), setup-token rate limit (S2), 7-day idempotency TTL + 30-day archival (S5/S8), BFS fail-propagation refactor (S3). None of these are scope additions vs the brief — all are quality/security fixes. MVP scope is unchanged. Cut-to-MVP doesn't apply.

**My recommendation: option 1.** The cycle-3 revisions are mechanically grounded. The cycle-2 reorder regression that triggered cycle-3 was a specific kind of mistake (over-correction in response to cycle-1 M5/M7) that the cycle-3 reviewers caught explicitly. The cycle-3 revisions don't have the same "over-correction" shape — most are reverts (M1) or canonicalization (M2/M3) or standard security additions (M4). Trust the pass; proceed to `/team-plan`.

If I had your answer:
- **Option 1 chosen** → I close out the cap-reached escalation by appending a single waiver to decisions.yaml ("Cycle-4 verification waived; revisions accepted on faith of mechanical-fix shape and codebase grounding"), then `/team-auto` proceeds to Stage B (`/team-plan`).
- **Option 2 chosen** → I exit `/team-auto`. You re-engage with `/team-design` directly.
- **Option 3 chosen** → I list the 4 cycle-3 MUST-FIX with their resolutions and you accept/reject each.
- **Option 4 chosen** → Same as option 2 but with explicit MVP-scope-reset guidance.

## Cycle-3 MUST-FIX one-line resolutions (for option 3 reference)

1. **M1 (cycle-2 reorder regression)** — Reverted to external-first ordering (parent_post → createThread → resolveSession with real thread_id → writeSessionMessage → wakeContainer). Eliminates C1 violation and cost-leak window. Same residual ~ms orphan window the design admits in G6.
2. **M2 (`_completeTaskCore` status guard width)** — Added `allowed_source_states` parameter; callers pass appropriate sets (voluntary `['dispatched','running']`, watchdog timeout `['pending','dispatching','dispatched','running']`, cancel `['pending','dispatching','dispatched','running']`, propagation `['pending']`).
3. **M3 (propagated failures bypass fan-out)** — Every terminalization path now routes through `_completeTaskCore` which always emits parent system row + `parent_delivery_state` update + SSE. Transitive failures skip child subthread write to avoid notification storm; root failure does post chat.
4. **M4 (markdown XSS via cookie auth)** — Three layers: (1) allowlist-sanitized markdown rendering (rehype-sanitize with GitHub schema or stricter; no `dangerouslySetInnerHTML`); (2) strict CSP response header (`script-src 'self'`, no `'unsafe-inline'`); (3) user-gesture confirmation on cancel/retry/approve via `navigator.userActivation.isActive`.
