# Unified Codex + Claude Delivery Loop

Canonical anti-slop workflow for feature implementation and review when execution is intentionally split across Claude Code and Codex lanes.

Select this loop for non-trivial feature, bug-fix, or reliability work only when execution is intentionally split across tools, parallel worktrees, or review fanout.

## Precedence

1. Use this loop when work is intentionally split across Claude/Codex lanes, parallel worktrees, or review fanout.
2. For single-lane delivery without cross-tool topology, use `docs/workflow/delivery/nanoclaw-development-loop.md`.
3. Once selected for a task, this loop supersedes the default development loop phases.

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

### Codex Default Lane Policy

When Codex is the primary orchestrator for this repo:

1. Main lane defaults to `gpt-5.3-codex` with `high` reasoning effort.
2. `explorer` and `monitor` are lower-cost helper lanes for read-heavy and deterministic work.
3. `worker` is the only write-enabled helper lane and must stay scoped to the approved touch-set.
4. `reviewer` handles correctness, regression, and contract-risk analysis with file/line evidence.
5. `gpt-5.4` at `xhigh` is an escalation-only profile for cross-system ambiguity, giant-context synthesis, or repeated failed loops.
6. Claude consult remains an escalation lane, not a routine second-review default.

### Delegation Payoff Rule

Codex should not use subagents for their own sake.

Delegate only when at least one is true:

1. The main lane has parallel work to do while the helper lane runs.
2. The helper lane will return a materially better artifact than a direct main-lane pass.
3. The task is long-running or noisy enough that isolating it improves focus in the main lane.

If none of those are true, keep the work in the main lane.

## Exit Criteria

A task is done when all are true:

1. Verification manifest status is `pass`.
2. Review findings are resolved or explicitly accepted with rationale.
3. Workflow contract and mirror checks pass.
4. Incident state is updated with evidence (if incident involved).
