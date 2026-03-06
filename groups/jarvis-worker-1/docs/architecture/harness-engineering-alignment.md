# Harness Engineering Alignment

Reference article: https://openai.com/index/harness-engineering/

This repository applies that approach as follows.

## Principle Mapping

| Harness Principle | NanoClaw Implementation |
|-------------------|-------------------------|
| Humans steer, agents execute | Andy-Developer plans/reviews; Jarvis workers execute bounded tasks |
| Repository docs are system of record | `docs/` contains architecture, contracts, and runtime references |
| Keep always-on instructions small | Root `CLAUDE.md` is a trigger index, not a monolithic manual |
| Make agent work legible and enforceable | Dispatch/completion contracts in `src/dispatch-validator.ts` gate state transitions |
| Build feedback loops | Worker runs persist audit fields in `worker_runs`; retries are explicit and bounded |

## Engineering Implications

1. Add structure before adding autonomy.
2. Encode constraints in code-level validators, not prompt prose alone.
3. Keep docs split by topic and link from CLAUDE trigger lines.
4. Prefer deterministic checks (`npm run build`, `npm test`, acceptance commands) before review.
5. Prune stale docs to reduce context noise for both humans and agents.

## Current Contract-Centric Artifacts

- Architecture source: `docs/architecture/nanoclaw-jarvis.md`
- Dispatch contract: `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`
- Worker runtime: `docs/workflow/nanoclaw-jarvis-worker-runtime.md`
- Operational validation: `docs/workflow/nanoclaw-jarvis-acceptance-checklist.md`
