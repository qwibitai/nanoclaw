# Unified Codex + Claude Delivery Loop

Canonical anti-slop workflow for feature implementation and review, regardless of whether work is assigned to Claude Code or Codex.

This loop is mandatory for non-trivial feature, bug-fix, or reliability work.

## Objective

Deliver optimized, reliable code with deterministic verification and minimal rework.

Mission anchor: `docs/MISSION.md`.

## Core Principles

1. One issue = one worktree = one PR.
2. Plan first, then implement.
3. Verification evidence is mandatory; summaries are not evidence.
4. High-risk violations are blocked automatically.
5. `CLAUDE.md` remains canonical policy owner; `AGENTS.md` and `.codex/*` mirror it.

## Session Topology (Balanced Parallelism)

Use 3 worktrees for active delivery:

1. `wt/<ticket>-impl`: implementation lane.
2. `wt/<ticket>-verify`: deterministic verification lane.
3. `wt/<ticket>-review`: security/perf/reliability findings lane.

Do not edit architecture/contract invariants in parallel lanes.

## Phase 0: Preflight

1. `bash scripts/workflow/preflight.sh`
2. `bash scripts/workflow/plan-lock.sh --ticket <id> --goal "<goal>"`
3. If reliability/runtime issue exists: `bash scripts/jarvis-ops.sh incident list --status open`

## Phase 1: Plan Lock

Plan must explicitly capture:

1. Goal and scope.
2. Constraints and invariants.
3. Acceptance criteria.
4. Test and rollback strategy.

No implementation begins before plan lock.

## Phase 2: Scoped Implementation

1. Implement only mapped touch-set changes in `wt/<ticket>-impl`.
2. Keep docs/rules/code/tests synchronized in same change set.
3. Avoid speculative refactors outside scoped objective.

## Phase 3: Deterministic Verification

Run from verify lane:

```bash
bash scripts/workflow/verify.sh
```

For Andy user-facing reliability changes:

```bash
bash scripts/workflow/verify.sh --include-happiness --happiness-user-confirmation "<manual User POV runbook completed>"
```

Required evidence:

- `data/diagnostics/acceptance/acceptance-<timestamp>.json`

## Phase 4: Review Fanout

Review lane collects findings with file/line evidence:

1. Correctness + regression risk.
2. Security + boundary checks.
3. Reliability + incident recurrence risk.
4. Complexity/duplication opportunities.

Use subagent catalog in `docs/operations/subagent-catalog.md`.

## Phase 5: Finalization

Run:

```bash
bash scripts/workflow/finalize-pr.sh
```

This gate includes mirror sync checks and workflow contract checks before PR finalization.

## Risk-Tiered Enforcement

### Hard blocks

1. Acceptance gate failure.
2. Required verification evidence missing.
3. Incident resolution attempted without prevention + lesson references.
4. Contract-governance drift between canonical and mirror files.
5. Hook/subagent/built-in governance check failure (`bash scripts/check-tooling-governance.sh`).

### Auto-fix / warning

1. Format/style drift with safe auto-fix hooks.
2. Non-critical recommendations from review subagents.

## Tool Assignment Rule

Implementation and review can be assigned to either tool, but lifecycle is identical:

1. Claude Code: follows `.claude` settings/hooks + skill routing.
2. Codex: follows `.codex` role config + same workflow scripts.

See `docs/operations/claude-codex-adapter-matrix.md`.

## Exit Criteria

A task is done when all are true:

1. Verification manifest status is `pass`.
2. Review findings are resolved or explicitly accepted with rationale.
3. Workflow contract and mirror checks pass.
4. Incident state is updated with evidence (if incident involved).
