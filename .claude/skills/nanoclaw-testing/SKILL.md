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

### 3. Optional full-suite confirmation

```bash
npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>" --full
```

## Reliability Rules

- Always run `npm run typecheck`.
- For high-risk features (dispatch/container/worker lifecycle), run mapped tests and at least one integration-adjacent test where applicable.
- Fail fast: stop at first broken command, fix, rerun from top.
- For incident fixes, add ops verification from `scripts/jarvis-ops.sh` (`preflight`, `status`, `trace`) alongside mapped tests.

## Evidence Format

`run-feature-tests.ts` prints a machine-readable JSON summary with:

- resolved feature id/name
- commands executed
- pass/fail per command

Use that JSON in commit/PR notes to prove validation scope.
