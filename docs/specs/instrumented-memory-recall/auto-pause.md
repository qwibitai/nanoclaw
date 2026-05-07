# /team-auto paused at Stage A (Review) — CAP-REACHED ESCALATION

**Stage:** Review
**Reason:** `cap-reached` (3-cycle limit hit) + `no-grounding` (3 of 7 cycle-3 MUST-FIX involve equally-grounded path choices)
**Cycles consumed:** 3/3
**Last action attempted:** Cycle 3 review — verifying that cycle 2 fixes resolved cycle 2's MUST-FIX issues.

## Why I stopped

Cycle 3 surfaced **7 MUST-FIX** findings — three are byproducts of cycle 2 fixes (cascading regressions), four are previously-missed semantic gaps. The cycle cap has been reached.

Honest assessment: **the workflow is finding real issues, but each revision is producing new ones.** This is a signal that:
1. The design has more inherent complexity than I've been able to capture cleanly.
2. Several decisions that I treated as mechanical fixes ("just specify X") have ripple effects I didn't surface to you.
3. Some MUST-FIX items in cycle 3 (M3-4 queue cap, M3-5 daily limit, M3-6 feedback semantics) reveal that the cycle-2 SHOULD-FIX revisions I applied were under-specified.

The full review reports for all three cycles are at `docs/specs/instrumented-memory-recall/review.md` (cycle 3 is the active one, but the bottom Revisions Log notes preserve cycle 1 and 2 history).

## Cycle 3 MUST-FIX — what's open

### Mechanically revisable (4 of 7) — would fix in a hypothetical cycle 4 if allowed

- **M3-1**: `daemonRequestApproval` references nonexistent `decided_at` column. Real schema uses `status`. Plus dedup needs `UNIQUE` constraint with `INSERT ... ON CONFLICT DO NOTHING` for atomicity.
- **M3-2**: M2-4 fix (host writes `ollamaCheckHost` to `memory-health.json`) introduced a write race with daemon's atomic-rewrite of the same file. Need separate `data/.host-ollama-status.json` with daemon merge on sweep.
- **M3-3**: `daemonRequestApproval` can't reuse `requestApproval` because that requires Session. Need to factor out a session-agnostic `requestApprovalCore` (~30 LOC change to primitive.ts) OR explicitly enumerate the reimplementation path.
- **M3-7**: design.md "Decision Record Updates" section still has stale D15/D16/D17 verbatim (cycle 2 update went to decisions.yaml only). Mechanical doc cleanup.

### Require user judgment (3 of 7) — equally-grounded path choices

- **M3-4 — Queue cap location.** §1.3 says "queue cap stops creating new judge work" but the **host** writes pending rows, not the daemon. Under load, pending rows grow unbounded. Two paths:
  1. **Cap at host insertion point.** Host queries `count_pending` before writing; if over threshold, writes terminal row instead (`judge_method='queue-cap-skipped'`). Adds DB read to host's recall hot path. Cleanest semantics.
  2. **Add `eligible_after` flag column.** Pending rows have a "queued for judging" flag. Doesn't prevent unbounded growth, just moves it to a column. Preserves all data for post-hoc analysis.

- **M3-5 — Daily judge limit fairness.** No global ordering specified across groups; noisy group can consume daily limit early, quiet groups starved. Two paths:
  1. **Per-group daily budgets.** `MEMORY_RECALL_JUDGE_DAILY_LIMIT / num_active_groups` per group. Simple but wastes budget on inactive groups.
  2. **Weighted round-robin.** Daemon iterates groups round-robin within each sweep. Fairness from rotation; daily limit is global pool.

- **M3-6 — `feedback_enabled=false` + pending-row semantics.** Default false on first release means every memory-enabled group accumulates pending rows from day 1 (they're never judged). Flipping to true 30 days later triggers backlog spike of thousands. Three paths:
  1. **Don't write pending rows when disabled.** Cleanest; loses retroactive visibility.
  2. **Write pending rows terminally when disabled.** `judge_method='feedback-disabled'`. Preserves audit; flip is clean.
  3. **Persist `feedback_enabled_at` timestamp.** Daemon only processes rows after that timestamp.

### Procedural gap (acknowledged)

- Cycle 3 Reviewer B was not spawned (lead oversight). Cycle 2 Reviewer B said "ship-ready as a design"; targeted cycle 2/3 changes likely don't change that verdict, but the cross-model diversity in cycle 3 was reduced.

## What I would do next if I had answers

Three options for you:

### Option 1: Quick path — answer M3-4/M3-5/M3-6, I'll handle M3-1/M3-2/M3-3/M3-7 as mechanical, then `/team-plan`

You pick one path each for M3-4, M3-5, M3-6. I revise the design one more time (the cycle cap is a `/team-review` invariant, not a `/team-design` constraint — I can revise without re-reviewing). Sample format:

```
M3-4: 1  (cap at host insertion point)
M3-5: 2  (weighted round-robin)
M3-6: 2  (write pending rows terminally when disabled)
```

Risk: we proceed to `/team-plan` without a final `/team-review` verifying the fixes. If implementation surfaces issues, we'd loop back to `/team-design`.

### Option 2: Reset to /team-design — accept the design has structural complexity that needs another design pass

The cycle 3 findings reveal that several pieces (queue cap semantics, feedback-enabled pending rows, daemonRequestApproval schema) need genuine design-stage thought, not just review-time patches. Going back to `/team-design` from scratch would:
- Re-do constraint analysis with the cycle 1-3 learnings folded in.
- Re-evaluate options with the schema/Session realities now known.
- Produce a design that's already accounted for the issues we found by patching.

Risk: significant time investment. Existing design.md isn't lost — it becomes the starting reference for the redesign.

### Option 3: Escalate to /team-brief — the cycle 3 findings reveal the brief was too ambitious for one feature

Some cycle 3 issues (feedback_enabled default + retroactive processing semantics, daemon-as-config-writer compromises) are brief-level decisions, not design-level. Going back to `/team-brief` would let us:
- Reconsider scope: maybe R1 (feedback loop) ships alone first; R2 + R3 follow as separate features.
- Defer R3 (cross-group fan-out) entirely until R1 is operational.
- Cut things like the circuit breaker entirely — operator-alert-only without auto-revert.

Risk: most aggressive scope reduction; effectively starts the workflow over for R2/R3.

## My recommendation

**Option 1** — the 7 MUST-FIX are concrete and addressable. The design's bones (Option C hybrid architecture; RRF; cross-provider eval split; ambiguity check; reorder writes) are all sound and survive cycle 3. The remaining issues are about specific schema details, cap semantics, and config-flag semantics — operator-judgment items that one more revision can close.

If you go Option 1: pick paths and I'll revise + write a cycle 3 addendum to the review report noting the resolutions, then proceed to `/team-plan`.

If you go Option 2 or 3: I exit team-auto, log the decision, and you re-enter the workflow at the chosen stage.

Tell me how to proceed — I will not retry, guess, or implement my own choices on the equally-grounded items.
