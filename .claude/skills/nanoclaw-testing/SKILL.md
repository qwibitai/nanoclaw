---
name: nanoclaw-testing
description: "Use when validating NanoClaw feature changes with feature-mapped tests, reliability-focused verification, and fail-fast evidence. Load after nanoclaw-implementation or whenever you need targeted test commands for a feature id/query."
---

# NanoClaw Testing

Feature-aware testing that pulls test scope from the feature catalog.

## Workflow

### 1. Ensure catalog is fresh

```bash
npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts
npx tsx .claude/skills/feature-tracking/scripts/validate-feature-catalog.ts
```

### 2. Run feature-scoped verification

```bash
npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>"
```

### 3. Live reliability verification (required for incident/reliability fixes)

```bash
npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>" --live
```

This enables runtime checks from `scripts/jarvis-ops.sh`. For Andy-facing reliability features it also runs `happiness-gate`.

### 4. Optional full-suite confirmation

```bash
npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>" --full
```

## Reliability Rules

- Always run `npm run typecheck`.
- For high-risk features (dispatch/container/worker lifecycle), run mapped tests and at least one integration-adjacent test where applicable.
- Fail fast: stop at first broken command, fix, rerun from top.
- For incident fixes, run with `--live` so ops verification from `scripts/jarvis-ops.sh` is included.
- For Andy user-facing reliability fixes, `--live` must include `bash scripts/jarvis-ops.sh happiness-gate`.
- `happiness-gate` pass is not sufficient by itself; also complete manual user POV runbook in `docs/workflow/nanoclaw-andy-user-happiness-gate.md`.

## Evidence Format

`run-feature-tests.ts` prints a machine-readable JSON summary with:

- resolved feature id/name
- commands executed
- pass/fail per command
- manual checks required (when applicable)

Optional JSON artifact output:

```bash
npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>" --live --json-out .claude/progress/test-report.json
```

Use that JSON in commit/PR notes to prove validation scope.
