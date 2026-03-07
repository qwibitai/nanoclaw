# Jarvis Dispatch Contract Discipline

Applies when changing worker dispatch flow, worker CLAUDE docs, or `src/dispatch-validator.ts`.

## Non-Negotiables

1. `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md` is the only field-level source of truth for dispatch and completion requirements.
2. Worker dispatch and completion remain strict JSON; no plain-text fallback.
3. `src/dispatch-validator.ts`, caller behavior, docs, and tests must change together.
4. Do not create partial field mirrors in helper docs or worker lane docs.

## Edit Protocol

When contract fields change:

1. Update `src/dispatch-validator.ts`
2. Update caller/consumer behavior in `src/index.ts`
3. Update persistence fields in `src/db.ts` (if artifact set changed)
4. Update tests in `src/jarvis-worker-dispatch.test.ts`
5. Update docs: `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md`

Do not update only one layer.

## Verification

Run:

- `npm run build`
- `npm test`
- `bash scripts/check-workflow-contracts.sh`

before considering contract changes complete.
