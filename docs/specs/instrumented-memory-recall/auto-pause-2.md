# /team-auto paused at Stage D (QA) — schema-decision escalation

**Stage:** QA (post-build, fix-cycle 1 of 3)
**Reason:** `hard-constraint` — schema migration / design call required
**Last action attempted:** Codex Validator E adversarial review — 4 MUST-FIX, 1 SHOULD-FIX surfaced.

## What happened

Stages A–C completed:
- Pre-build drift cleared (Spearman cut from plan). 1 commit.
- Group A built (5 tasks, schema + config). 1 commit, 629 tests pass.
- Group B built (5 tasks, host recall + Strategy C extractor). 1 commit, 700 tests pass after my feedback_enabled gate followup.
- Group C built (4 tasks, daemon judge + health + sweep). 1 commit, 700 tests pass; lead-authorized scope expansion to extend `DeadLetterItemType`.
- Group D built (3 tasks, RRF + scope resolver + cross-group fan-out). 1 commit, 700 tests pass.
- Group E built (3 tasks, eval harness + operator runbook). 1 commit, 713 tests pass.
- Post-build drift: targeted invariant verification all clean (C1, C2, C5, C6, C7, C8, C11, C13, C14, C15, C16; Active MVP CUTs absent).

Stage D Phase 1 (denoise): clean.
Stage D Phase 2 inline (Validator A style, B doc): clean except 1 ADVISORY (`rrf.ts` JSDoc).
Stage D Phase 2 Codex E (cross-model adversarial xhigh): **needs-attention verdict, 4 MUST-FIX + 1 SHOULD-FIX**.

Validator CD (code review swarm) was skipped this run for context-budget reasons in this long autonomous run; documented as DEGRADED. Will re-run after fixes via `--only swarm`.

## Findings (full detail in `docs/specs/instrumented-memory-recall/qa-report.md`)

| # | Severity | File | Issue | Fix path |
|---|----------|------|-------|----------|
| E1 | CRITICAL | recall-outcomes.ts:62-71 | ESM `require()` in `"type":"module"` → production never writes pending rows | Mechanical (static import) |
| E2 | HIGH | judge.ts:211-218 | Judge gets `content: ''` — schema only stores fact_id | **Schema decision required (pause list)** |
| E3 | HIGH | judge.ts:98-105 | Pending query ignores dead-letter `next_retry_at`; success doesn't clear dead-letter row | Mechanical (SQL filter + cleanup) |
| E4 | HIGH | mnemon-impl.ts:215-216 + recall-injection.ts:15 | Production creates `MnemonStore` without config → `recall_scope` config dead | Mechanical (pass cfg) |
| E5 | MEDIUM | regenerate-recall-eval.ts:70-76 | Operator can set synth backend = anthropic, violating C16 | Mechanical (validate distinct provider) |

## E2 — three paths (you pick)

**A.** Schema migration `023-mnemon-recall-fact-content.ts` adding `fact_content_excerpt TEXT NOT NULL DEFAULT ''`. Persist 500-char excerpt at insert time. judge reads it.
**B.** At-judge-time `mnemon` CLI lookup by fact_id. No schema change. Adds CLI call per judge.
**C.** Punt fact-content judging; ship empty-content build with `judge_method='judge-failed'` until v2.

A is recommended (cleanest, audit-trail-friendly). B is fragile to mnemon content deletion and we'd need to verify `mnemon` exposes get-by-id. C defeats half of R1's value.

## What I'll do once you answer E2

1. Apply E2 fix (path you chose).
2. Apply mechanical fixes E1, E3, E4, E5.
3. Re-run `pnpm test`, `pnpm exec tsc --noEmit` — must stay green.
4. Re-run `/team-qa --only codex` — verify no MUST-FIX residuals.
5. Re-run `/team-qa --only swarm` — recover the CD lane coverage.
6. Hand off to ship gate.

I will not retry, guess, or pick a path on E2 myself. Tell me **A / B / C** plus any preferences on whether to fix E1/E3/E4/E5 in the same commit or separate commits.
