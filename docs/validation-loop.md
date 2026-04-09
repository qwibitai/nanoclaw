# Validation Loop

This is the deterministic validation loop for NanoClaw factory mode.

## Phase 1: Structural Integrity

Run:

```bash
npm run format:check
```

Goal: fail fast on formatting drift before deeper validation.

## Phase 2: Type Safety

Run:

```bash
npm run typecheck
```

Goal: keep TypeScript contracts stable across orchestrator, runtime, channels, and persistence code.

## Phase 3: Tests

Run:

```bash
npm test
```

Goal: keep unit/integration behavior stable and catch regressions.

## Phase 4: Functional Validation

Run functional-checker for user-visible behavior and runtime lifecycle checks:
- routing and trigger behavior
- session/command behavior
- container or host runtime path expectations
- channel response delivery

Record with:

```bash
python3 .codex/scripts/record_test_from_json.py --kind functional --input /tmp/functional-test.json
```

## One-Command Gate

Use this as the default end-to-end gate:

```bash
python3 .codex/scripts/validate_work.py
```

It runs deterministic verify, validates `.factory` testing/review artifacts, and marks the run PR-ready only when all gates pass.
