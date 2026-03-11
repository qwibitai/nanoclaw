---
name: nanoclaw-orchestrator
description: "Use when coordinating NanoClaw feature delivery end-to-end with explicit state tracking: feature-tracking -> nanoclaw-implementation -> nanoclaw-testing. Load to keep work scoped, auditable, and resistant to code slop/duplication."
---

# NanoClaw Orchestrator

Project-level orchestration skill for disciplined feature delivery.

Execution state is now expected to live primarily in Linear.
The local `.claude/archive/legacy-work-items.json` store is legacy migration support and must not become a co-equal tracker.

## Pipeline

1. Feature-tracking
2. Implementation
3. Testing
4. Work-item closure

## Issue Pipeline (runtime/reliability incidents)

1. Docs-first incident workflow: `docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md` + `.claude/progress/incident.json`
2. `/debug` for runtime/container/auth root-cause
3. `feature-tracking` to map fix ownership
4. `nanoclaw-implementation` for minimal fix
5. `nanoclaw-testing` for targeted regression checks
6. Work-item closure with incident proof

## Workflow

### 1. Build and validate feature map

```bash
npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts
npx tsx .claude/skills/feature-tracking/scripts/validate-feature-catalog.ts
```

### 2. Resolve target feature

```bash
npx tsx .claude/skills/feature-tracking/scripts/locate-feature.ts "<request>"
```

### 3. Create local legacy work item only when explicitly needed for migration support

```bash
npx tsx .claude/skills/nanoclaw-orchestrator/scripts/work-item.ts create \
  --feature "<feature-id>" \
  --title "<short-title>" \
  --request "<original-request>"
```

### 4. Move to implementation

```bash
npx tsx .claude/skills/nanoclaw-orchestrator/scripts/work-item.ts update \
  --id "<work-id>" --status implementing
```

Apply `nanoclaw-implementation` workflow.

### 5. Move to testing

```bash
npx tsx .claude/skills/nanoclaw-orchestrator/scripts/work-item.ts update \
  --id "<work-id>" --status testing
```

Apply `nanoclaw-testing` workflow.

For reliability/user-facing features, run:

```bash
npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>" --live --json-out data/diagnostics/tests/test-report.json
```

### 6. Close item

```bash
npx tsx .claude/skills/nanoclaw-orchestrator/scripts/work-item.ts update \
  --id "<work-id>" --status done --evidence "data/diagnostics/tests/test-report.json" --note "typecheck + mapped tests passed"
```

## Rules

- Never skip the feature map phase.
- If feature resolution fails, update seed catalog before coding.
- Use `blocked` status for unresolved dependencies or failed validations.
- Keep authoritative work history in Linear. Use `.claude/archive/legacy-work-items.json` only for legacy migration support when a local artifact is still required by an older workflow.
- For runtime incidents, run docs-first incident workflow before implementation and keep incident id in work-item notes.
- `done` requires explicit evidence (`--evidence`) for testability/auditability.
