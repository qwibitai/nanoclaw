# Subagent Catalog

Canonical catalog for parallel verification subagents used in Claude Code and Codex workflows.

Use with `docs/workflow/unified-codex-claude-loop.md`.

## Contract

Each subagent invocation must include:

1. Scope (`what to inspect`).
2. Input artifacts (files/tests/commits).
3. Expected output schema.
4. Handoff target.

Each subagent response must include:

1. `status`: pass/fail/warn.
2. File references with line numbers for findings.
3. Actionable next steps.
4. No merge authority.

## Catalog

| Subagent | Primary Goal | Typical Inputs | Required Output | Handoff |
|----------|--------------|----------------|-----------------|---------|
| `plan-architect` | Produce decision-complete execution plan before coding | ticket + constraints + invariants | scoped plan with acceptance criteria and risks | implementer |
| `feature-worker` | Implement bounded feature/bug fix | approved plan + touch-set | patch + impacted tests list | verifier |
| `verify-app` | Execute deterministic runtime and acceptance checks | build/test scripts + gate commands | pass/fail evidence with manifest path | reviewer/finalizer |
| `contract-auditor` | Check dispatch/security/role boundary invariants | contract docs + touched files | invariant compliance report | implementer |
| `incident-regression` | Detect recurrence risk for reliability fixes | incident history + traces + diff | recurrence risk report | finalizer |
| `code-simplifier` | Identify complexity/duplication slop | changed files | simplification opportunities ranked by impact | implementer |
| `docs-sync-checker` | Validate required docs/rules mirror updates | changed docs/rules list | sync pass/fail report | finalizer |

## Invocation Patterns

### Plan phase

- Run `plan-architect` once per task.

### Verify/review phase

- Run `verify-app` and `contract-auditor` always.
- Add `incident-regression` for reliability incidents.
- Add `code-simplifier` for larger patches (>3 files or >200 LOC changed).
- Run `docs-sync-checker` when workflow/contract/docs are touched.

## Anti-Slop Rules

1. Subagents never approve their own output.
2. Subagent conclusions without concrete file/line evidence are invalid.
3. High-risk failures from `verify-app` or `contract-auditor` block finalization.

## Implementation Map

Catalog roles map to 3 agent definition files in `.claude/agents/`:

| Catalog Role | Agent File | Model | Notes |
|---|---|---|---|
| `plan-architect` (research) | `scout.md` | haiku | Research/scan phase only; plan synthesis stays Opus |
| `feature-worker` | `implementer.md` | sonnet | Bounded execution with approved plan |
| `verify-app` | `verifier.md` | haiku | Deterministic gate execution |
| `contract-auditor` | `verifier.md` | haiku | Invariant compliance checks |
| `incident-regression` | — | opus | Requires cross-codepath judgment; not delegated |
| `code-simplifier` (discovery) | `scout.md` | haiku | Hotspot/duplication scanning only |
| `docs-sync-checker` (scan) | `scout.md` | haiku | Stale reference detection |

Routing details: `docs/operations/subagent-routing.md`
