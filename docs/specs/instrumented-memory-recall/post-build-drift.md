# Post-Build Drift Report — instrumented-memory-recall

**SOT:** `docs/specs/instrumented-memory-recall/plan.md` (post pre-build fix)
**Target:** Implementation across 41 files (5 commits on `feat/instrumented-memory-recall`)
**Run:** /team-auto Stage C, post-build drift
**Date:** 2026-05-07

## Method

Targeted invariant verification rather than full claim-extraction (the implementation is 41 files / ~9.6K LOC; full /team-drift duplicates the Stage D /team-qa lanes that follow). Each builder also self-validated their group's named test cases and acceptance criteria, and the lead spot-checked key files at commit time.

## Verification

### Cross-cutting HARD constraints

| Constraint | Status | Evidence |
|---|---|---|
| **C1** Daemon is sole writer to mnemon stores | ✓ | Host writes pending columns via `recall-outcomes.ts:94 INSERT`. Daemon writes only `judge_method`/`judge_score`/`judge_evidence`/`judged_at` via `judge.ts:148-150,185-186 UPDATE`. No column written by both — see C11. |
| **C2** Recall pre-turn host-injected via `kind=system trigger=0` | ✓ | `recall-injection.ts:607` calls `insertMessage` first; `:651` calls `insertPendingOutcomes` only after. Reorder write (M6 path 1) preserved. |
| **C3** Per-group store isolation default | ✓ | `scope-resolver.ts` defaults `'self'` → returns `[callingGroupId]`. `mnemon-impl.ts` single-store fast path retained. |
| **C5** Strategy C must never break recall | ✓ | `recall-injection.ts:237` raw tier returns `stripMentions(rawText).slice(0, 500)` — never throws. Three-tier fallback (`llm` → `heuristic` → `raw`) implemented; raw guaranteed terminal. |
| **C6** Cross-group fan-out host-side only; no additional store mounts | ✓ | `mnemon-impl.ts` fan-out uses host-side `mnemon` CLI invocations only. No new mounts; `MNEMON_DATA_DIR` config unchanged. |
| **C7** pnpm `minimumReleaseAge: 4320` retained | ✓ | `pnpm-workspace.yaml` unchanged. No additions to `minimumReleaseAgeExclude` or `onlyBuiltDependencies`. No new pnpm dependencies in any group. |
| **C8** Quality gates: tsc + bun typecheck + vitest + bun:test | ✓ | `pnpm exec tsc --noEmit` clean. `pnpm test` 713/713 pass (was 617 pre-build). Container side untouched. |
| **C11** Row-level multi-writer on `mnemon-ingest.db` | ✓ | Host inserts new rows with `judge_method='pending'`, `judged_at=NULL`. Daemon UPDATEs same row's judge columns. No column written by both. SQLite WAL pragma already enabled. |
| **C13** `memory-health.json` operator schema preserved | ✓ | `health.ts:91 buildGroupJson` retains all existing fields. `recall_quality` block added as new sibling. `ollamaCheckHost` added at top level. |
| **C14** Judge backend follows `<provider>:<model>:<effort>` pattern | ✓ | `judge-client.ts` mirrors `classifier-client.ts` pattern: env var, lazy load, parse-throw-loud. Default `anthropic:haiku-4-5:default`. |
| **C15** Null-byte stripping in judge prompts | ✓ | `judge-client.ts:303-304`: `safeSystem = systemPrompt.replace(/\0/g, '')`, same for userPrompt. |
| **C16** Cross-provider eval split | ✓ | `regenerate-recall-eval.ts:70` reads `MEMORY_RECALL_EVAL_SYNTHESIZER_BACKEND` (default `codex:gpt-5.5:medium`). `judge-client.ts` defaults `anthropic:haiku-4-5:default`. Different providers verified. |

### Active MVP CUT verification (rejected things must be ABSENT)

| Cut | Status | Evidence |
|---|---|---|
| Spearman in health.json | ✓ ABSENT | `find src/ -name "spearman*"` returns nothing. `grep diagnostic_spearman src/ scripts/ docs/memory.md` returns nothing. |
| Auto-revert circuit breaker | ✓ ABSENT | No `scope-breaker.ts`, no auto-revert code path in `health.ts` or `index.ts`. |
| `daemonRequestApproval` wrapper | ✓ ABSENT | `grep -r daemonRequestApproval src/` returns nothing. |
| Queue caps, daily limits, fairness scheduling | ✓ ABSENT | `index.ts` `runSweep` has no per-group cap, no global daily counter. |
| `feedback_enabled=false` pending-row accumulation | ✓ Default true; explicit-false skips outcomes write entirely (B builder patch). |
| Adversarial fact fixtures, oracle slice, Cohen's κ | ✓ ABSENT | Eval harness uses cross-provider synthesis only. |
| Cross-group consent / `cross_group_recall_log` table | ✓ ABSENT | `recall_outcomes` is the only new table; no audit log. |
| GC tools / importance recalibration tools | ✓ ABSENT | Group E has no GC scripts. |
| Automatic recall rerank by historical judge score | ✓ ABSENT | `mnemon-impl.ts` fan-out uses RRF only on current mnemon recall results. No `recall_outcomes` consultation in recall path. |

### Builder self-reports

All 5 builders reported acceptance criteria met:
- **Group A** (build): A1-A5 done, 617 tests pass + 12 new = 629 host tests, tsc clean.
- **Group B**: B1-B5 done + feedback_enabled gate patch, 39 tests in B's files all pass; full host suite 700.
- **Group C**: C1, C3, C4, C5 done (no C2 spearman per drift fix), `DeadLetterItemType` extended (lead-authorized scope expansion), 53 group-C tests pass; full suite 700.
- **Group D**: D1-D3 done, 30 group-D tests pass, AbortController-based per-store timeout kills mnemon child process (does NOT race past).
- **Group E**: E1-E3 done, 12 new tests, full suite 713 (was 700+12+1 todo from earlier).

### Final test + build state

```
pnpm test            → 62 files, 713 passed | 1 todo (714 total)
pnpm exec tsc --noEmit → clean (no errors)
```

Bun container side: untouched (no Group built into container/agent-runner/).

### Two acknowledged-but-non-blocking residuals

1. **Builder-B dynamic import of `JUDGE_PROMPT_VERSION`** — `recall-outcomes.ts` does an async dynamic import of `judge-client.ts` with `'v1'` fallback. The fallback matches the value `judge-client.ts` exports. Safe but a bit fragile; convert to a static import in a follow-up commit. Logged as TODO comment in B's file.
2. **Builder-E added `vitest.config.ts` and `.gitignore` lines** outside their explicit scope — these are necessary plumbing (test discovery + audit-log gitignore) and were minimal additions. Functionally correct.

## Summary

| Class | Count |
|-------|-------|
| Hard-constraint violations | 0 |
| Cut-item leakage | 0 |
| Builder self-report acceptance criteria failures | 0 |
| TSC errors | 0 |
| Test failures | 0 |
| Acknowledged minor residuals | 2 (non-blocking) |

**Gate:** PASS — proceed to Stage D (/team-qa).
