# Pre-Build Drift Report — instrumented-memory-recall

**SOT:** `docs/specs/instrumented-memory-recall/design.md` (post cycle-3 simplification)
**Target:** `docs/specs/instrumented-memory-recall/plan.md` (5 groups, 21 tasks)
**Run:** /team-auto Stage C, pre-build drift
**Date:** 2026-05-07

## Method

Two independent extractors ran in parallel:
- **Agent A:** Claude Sonnet (Task subagent) — extracted 125 claims
- **Agent B:** Codex GPT-5.5 xhigh — extracted 55 claims (cross-model verification)

Both agents were instructed that the **Active MVP Scope** section at design.md:14 supersedes earlier sections where contradictory, and that decisions D35-D40 supersede D15/D16/D17/D20/D27/D29/D30/D32.

## Findings (merged + reconciled)

### DIVERGED — 1 (blocking)

**[B1] Spearman diagnostic in health.json**

- **Source:** design.md Active MVP CUT line 58: *"Spearman diagnostic in health.json (raw `recall_outcomes` data is queryable; no need for derived metric)"*. Reinforced at line 45: *"operator can compute Spearman ρ vs judge_score from raw `recall_outcomes` rows when curious — not surfaced as a gate"*. Justification at line 72: *"Raw data is queryable; derived metric adds noise"*.
- **Target evidence:** plan.md Task C2 creates `src/memory-daemon/recall-judge/spearman.ts` (lines 956-1034). Task C4's `PerGroupState` interface adds `diagnostic_spearman_rho: number | null` and `diagnostic_spearman_rho_ci_lower: number | null` (lines 1177-1178). Task C4 ASSERT line 1200 invokes `computeSpearman()` from health builder.
- **Why it diverges:** Plan was written against design.md §1.3/§1.6 (lines 352-353, 461-462, 477) which describes Spearman as a diagnostic health field. The Active MVP CUT supersedes those sections. Plan did not propagate the cut.
- **Both extractors flagged this independently** (Agent A claim #102/#125; Agent B claim #34).

**Resolution: FIX THE PLAN (selected)**

The fix is mechanical and unambiguous from the SOT — there is no judgment call. Removing Spearman aligns with the user's cycle-3 simplification directive ("not over-engineering"). Acknowledgment was rejected because the divergence is not intentional; it's a planning oversight that the gate is designed to catch.

### MISSING — 1 (non-blocking after review)

**[B2] Cache-sharing optimization (extractor backend == judge backend)**

- **Source:** design.md §2.1 mentions "if extractor backend == judge backend, share lazy-load instance".
- **Target evidence:** B2 task (query-extractor.ts) does not document this optimization.
- **Severity:** Low. Optimization is a perf nice-to-have, not a correctness requirement. SOT's "Active MVP" framing does not list it as a blocking item.
- **Decision:** Log as non-blocking. Builder can apply during implementation; if not, it's a follow-up.

### PARTIAL — 5

**[B3] `extractRecallQueryText` vs `buildRecallQuery` naming**

- **Source:** design.md Active MVP says `extractRecallQueryText({query, strategy})`.
- **Target:** Plan uses `buildRecallQuery(rawSlice, currentMessage, strategy) → {query, strategyUsed}`.
- **Gap:** Function name and field-name (`strategy` vs `strategyUsed`) differ. Structure is equivalent.
- **Decision:** Non-blocking. Naming-level mismatch; semantics preserved. Note for builder: rename to `extractRecallQueryText` and `strategy` to match SOT exactly.

**[B4] `enabledCache` 60s TTL pattern for new MemoryConfig fields**

- **Source:** design.md §1.7 specifies the three new fields share the existing 60s `enabledCache` TTL.
- **Target:** Plan A4 introduces resolver functions but does not explicitly state TTL integration. D2 (scope-resolver) implements 60s cache.
- **Gap:** TTL pattern not propagated to all three resolvers explicitly.
- **Decision:** Non-blocking. Builder must wire all three through `enabledCache` per design — flag for builder reminder in spawn prompt.

**[B5] pnpm `minimumReleaseAge` constraint not explicit**

- **Source:** design.md C7 + brief: pnpm `minimumReleaseAge: 4320` retained; no `minimumReleaseAgeExclude` additions.
- **Target:** Plan B1/D3/E1 say "no new dependencies" implicitly. Constraint not stated as a global ASSERT.
- **Gap:** Indirect coverage only.
- **Decision:** Non-blocking. CLAUDE.md guards this. Add to integration checklist for clarity.

**[B6] R2/R3 ship-after-R1 measurement gate not explicit in plan dependency graph**

- **Source:** design.md C4: "Measurement before optimization — R2/R3 cannot ship until R1 is live."
- **Target:** Plan dependency graph runs B/C/D in parallel after A. No explicit ship-order gate; eval gate (E2) handles Strategy C decision.
- **Gap:** The measurement-gate is implicit (eval gate at E2 functions as it), not codified as a deferred ship.
- **Decision:** Non-blocking. The constraint applies at deploy/operator time (flip the per-group config), not at build time. Code can land in any order; operators flip per-group flags after R1 measurement is confirmed via eval gate. E3 docs covers operator workflow.

**[B7] Tests-must-not-depend-on-network policy implicit only**

- **Source:** design.md Test Seams: "Tests must NOT depend on Ollama, Anthropic API, or Codex CLI being available."
- **Target:** Test cases use stubs/spies (`setEmbedderForTest`, `setJudgeBackendForTest`); no global policy statement.
- **Gap:** Implicit via stub usage, not codified as ASSERT.
- **Decision:** Non-blocking. Test seams are the mechanism; their presence enforces the policy.

### CONFIRMED — 110+

All other claims confirmed. Highlights:
- All 13 explicit Active MVP CUTS verified absent (auto-revert, daemonRequestApproval, queue caps, daily limits, fairness scheduling, feedback_enabled=false complexity, adversarial fixtures, oracle slice, Cohen's κ, calibration script, cross-group consent, cross_group_recall_log table, GC tools, importance recalibration, automatic rerank by judge score)
- All 16 columns in `recall_outcomes` schema match between A1 and design §1.1
- C11 row-level multi-writer encoded correctly via host pending columns vs daemon judge columns
- C16 cross-provider eval split (Codex synth / Anthropic judge) correctly preserved
- Three-tier query fallback (LLM 800ms → heuristic ~80ch → raw 800ch) preserved with strategy field recording actual tier used
- RRF k=60 + recency multiplier formula explicit in D1
- Trigger correlation (thread_id/sent_at/sender_id) + ambiguity check via `idx_recall_outcomes_thread`

## Summary

| Class | Count |
|-------|-------|
| MISSING | 0 |
| DIVERGED (raw, pre-fix) | 1 |
| DIVERGED (effective, post-fix) | 0 |
| PARTIAL (non-blocking, carried as builder reminders) | 5 |
| CONFIRMED | 110+ |

## Resolution Applied

**Fix to plan.md committed inline (not via re-run drift):**
- Deleted Task C2 (spearman.ts) entirely from Group C
- Updated Group C from 5→4 tasks; total 21→20
- Removed `diagnostic_spearman_rho` and `diagnostic_spearman_rho_ci_lower` from `PerGroupState` interface in Task C4
- Removed `computeSpearman()` ASSERT and `test_diagnostic_spearman_null_on_low_n` test case from Task C4
- Removed `spearman.ts` and `spearman.test.ts` rows from File Ownership Map
- Updated Constraint Traceability "Rejected: Spearman diagnostic" row to reflect post-fix state
- Updated dependency graph label and pre-conditions in C3 / C4
- Acceptance criteria updated: "All 8 new recall_quality fields" (was 10), "All 7 test cases pass" (was 8)

**Verification:** `grep -i 'spearman\|computeSpearman\|diagnostic_spearman' docs/specs/instrumented-memory-recall/plan.md` returns only the rejection row in the Constraint Traceability section (which correctly notes the absence as evidence).

**Carried forward as builder-prompt reminders:**
- B3: rename to `extractRecallQueryText({query, strategy})` to match SOT signature
- B4: wire all three new MemoryConfig fields (`feedback_enabled`, `query_strategy`, `recall_scope`) through the existing 60s `enabledCache` TTL
- Integration checklist will include explicit "no new pnpm deps; `minimumReleaseAge: 4320` unchanged"

---
**Status:** RESOLVED — gate clear (MISSING=0, effective DIVERGED=0)
**Next:** Proceed to Step 3 (team creation) per /team-build.
