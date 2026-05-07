# QA Report — instrumented-memory-recall

**Branch:** `feat/instrumented-memory-recall` (5 commits ahead of main, ready for ship gate after fixes)
**Run:** /team-auto Stage D — first QA cycle
**Date:** 2026-05-07

## Pipeline summary

| Lane | Findings | Status |
|------|----------|--------|
| Denoise | 0 | ✓ clean (CLI script `console.log` is intentional operator output) |
| A: Style | 0 introduced | ✓ all imports use `.js` ESM extensions; naming/structure conform |
| B: Doc freshness | 1 ADVISORY | `rrf.ts:mergeAndRerank` could use a JSDoc (minor) |
| CD: Code review swarm | — | ⚠ SKIPPED this run — context-budget management in long autonomous run; relying on Codex for cross-cutting code review |
| E: Codex adversarial | **4 MUST-FIX, 1 SHOULD-FIX** | needs-attention verdict |

⚠ **COVERAGE DEGRADED:** Code review swarm (Validator CD) skipped this run. MUST-FIX total below excludes findings that lane would produce. After applying the Codex-flagged fixes, re-run `/team-qa --only swarm` to recover coverage before ship.

## Codex findings (Validator E)

### MUST-FIX

**E1 — Production outcome writes fall through (CRITICAL, confidence 0.90)**

- **File:** `src/modules/memory/recall-outcomes.ts:62-71`
- **Body:** `getDb()` uses CommonJS `require()` inside an ESM package (`"type": "module"`). In built ESM `require` is undefined; the `try/catch` returns null silently. Production never writes any pending rows. Tests inject DB so the production path is effectively untested.
- **Impact:** No pending rows → no daemon judging → `recall_quality` empty forever, while recall itself appears to work.
- **Recommendation:** Replace `require(...)` with static `import { openMnemonIngestDb, runMnemonIngestMigrations } from '../../db/migrations/019-mnemon-ingest-db.js'` at module top. Add an integration test that calls `insertPendingOutcomes` without `setIngestDbForTest` (i.e., production path).
- **Classification:** Mechanical fix, ~10 LOC, ~5 min.

**E2 — Judge prompt receives empty fact content (HIGH, confidence 0.96)**

- **File:** `src/memory-daemon/recall-judge/judge.ts:211-218`
- **Body:** `candidate_facts.map((r) => ({ fact_id: r.fact_id, content: '' }))` — fact content is hardcoded empty. The schema persists only `fact_id`. The LLM judge has no actual fact text to grade against the agent response.
- **Impact:** Judge will score mostly 0 or fabricate evidence. `useful_fact_rate_7d`, `load_bearing_event_rate_7d`, and any Strategy C eval-gate decisions are unreliable.
- **Recommendation:** Three paths (require user input — see escalation below).
- **Classification:** **Schema/design change — on user's explicit pause list ("Schema migration ordering or modifications"). ESCALATE.**

**E3 — Dead-letter backoff is ignored on retry (HIGH, confidence 0.88)**

- **File:** `src/memory-daemon/recall-judge/judge.ts:98-105`
- **Body:** Pending-rows query filters only by `agent_group_id` and `judged_at IS NULL`. It does NOT join against `dead_letters` to honor `next_retry_at`. A long-running turn with no archived assistant response after the 60s grace will be retried every daemon sweep (~60s) and can poison far earlier than the intended 60/300/900s window. Successful judging also does not call any cleanup on the dead-letter row → stale telemetry.
- **Recommendation:** Before judging an event with an existing `recall-judge` dead_letter, skip it until `next_retry_at <= now()`. After successful judge update, call `deleteAfterSuccess` (or equivalent) for `recall-judge:<event_id>`. Add 60/300s backoff test + success-after-retry cleanup test.
- **Classification:** Mechanical fix, ~30 LOC, ~30 min including tests.

**E4 — `recall_scope` config is not wired into production recall (HIGH, confidence 0.95)**

- **File:** `src/modules/memory/mnemon-impl.ts:215-216` (`MnemonStore.recall`); production wiring is in `src/modules/memory/recall-injection.ts:15` (`let store: MnemonStore = new MnemonStore();`)
- **Body:** `MnemonStore.recall` resolves scope from `this.memoryConfig`. Production creates `MnemonStore` with no `memoryConfig`. `maybeInjectRecall` never passes the group's resolved `recall_scope` into `store.recall`. So `getRecallScope(undefined)` defaults to `'self'` always; setting `memory.recall_scope: 'all-groups'` in `container.json` has no effect outside tests.
- **Impact:** R3 (cross-group recall) is dead in production. The eval workflow (E3) tells operators to flip `recall_scope` for axis-labs but the flip won't take effect.
- **Recommendation:** Either resolve `recall_scope` inside `MnemonStore.recall` from the `agentGroupId` (lookup container.json), OR pass the cached group `MemoryConfig` / scope through `recall(opts)` from `maybeInjectRecall`. Add a production-path test using container.json config rather than constructor injection.
- **Classification:** Mechanical fix, ~20 LOC, ~15 min including tests. Two implementation paths (constructor-injection vs per-call opts) — slight design call but well-bounded.

### SHOULD-FIX

**E5 — C16 cross-provider eval split is not enforced (MEDIUM, confidence 0.86)**

- **File:** `scripts/regenerate-recall-eval.ts:70-76`
- **Body:** Operator can set `MEMORY_RECALL_EVAL_SYNTHESIZER_BACKEND=anthropic:...`, silently violating C16 hard constraint (synth must use a different provider than judge). The script accepts whatever is configured.
- **Recommendation:** Parse the judge backend provider, fail fast when `synthesizer.provider === judge.provider`. Add a same-provider rejection test.
- **Classification:** Mechanical fix, ~15 LOC, ~10 min including test.

## Escalation — Required user decisions

### E2 (judge prompt empty fact content) — three paths

The judge cannot meaningfully score 0/1/2 without fact content. The persistence schema (Migration 021) only stores `fact_id`, not fact text. Three paths:

**Path A — Schema migration (023-mnemon-recall-fact-content)**
- Add a new migration `023-mnemon-recall-fact-content.ts` adding column `fact_content_excerpt TEXT NOT NULL DEFAULT ''` to `recall_outcomes`.
- `recall-outcomes.ts:insertPendingOutcomes` accepts a `factContentExcerpt` field (truncated, e.g., 500 chars) and persists it.
- `recall-injection.ts` passes fact content (it already has it from the recall result).
- `judge.ts` reads `fact_content_excerpt` and includes it in `candidate_facts`.
- **Pros:** Self-contained per recall event. Resilient to fact rotation/deletion in mnemon. Audit trail.
- **Cons:** Schema migration on top of just-shipped 021. Storage cost (~500 bytes × 5 facts × N events).

**Path B — At-judge-time mnemon lookup**
- `judge.ts` calls `mnemon` CLI to fetch fact content by ID (likely `mnemon get <id>` or similar).
- No schema change.
- **Pros:** Always fresh content. No new storage.
- **Cons:** Adds a CLI invocation per judge call (latency + failure mode). If a fact is later deleted from mnemon, we can't judge stale events. mnemon may not actually expose `get-by-id` — needs verification.

**Path C — Defer measurement until v2; ship recall_outcomes write substrate only**
- Accept that the judge can't grade meaningfully right now.
- Daemon writes `judge_method='judge-failed'` for now, or skips judging entirely.
- `recall_quality` block exposes only what's measurable: pending count, judge_failure_rate.
- Cross-provider eval (E2 script) still runs against fresh recall results, doesn't depend on judge.
- **Pros:** Smallest scope, no schema change, ship now.
- **Cons:** Half the value of R1 deferred. Defeats the "instrumented-memory" goal.

**Recommendation:** Path A is the cleanest semantically (matches design intent) and aligns with the audit-trail framing of `recall_outcomes`. Path B is fragile to mnemon content deletion and adds CLI overhead. Path C punts on the original deliverable.

### Other findings — fix path

If user picks any path for E2, the remaining four findings (E1, E3, E4, E5) are mechanical. I propose applying them in a single follow-up commit on `feat/instrumented-memory-recall` after E2 is resolved.

## Recommendation

**Pick a path for E2** (A / B / C above). I'll then:
1. Apply E2 fix per chosen path (~30-90 min depending on path).
2. Apply E1, E3, E4, E5 mechanical fixes (~60 min).
3. Re-run `pnpm test`, `pnpm exec tsc --noEmit`.
4. Re-run `/team-qa --only codex` to verify Codex finds no MUST-FIX residuals.
5. Re-run `/team-qa --only swarm` to recover code-review coverage that was skipped this run.
6. Hand off to ship gate.

Total elapsed effort: ~2-3 hours including QA re-runs, depending on path.

---

**Status:** ESCALATED to user
**Reason:** E2 schema decision is on the user's explicit /team-auto pause list ("Schema migration ordering or modifications"); other findings depend on or co-exist with the E2 fix path.
