# Workflow Optimization Loop

Systematic process for improving NanoClaw development workflow using external expert research plus local evidence.

Use this when deciding how to evolve coding workflows, guardrails, and operating routines.

## Objective

Improve delivery quality and speed without increasing reliability incidents.

Mission anchor: `docs/MISSION.md`.

## Non-Negotiables

1. Research-informed changes are proposals, not automatic policy.
2. One workflow change is piloted at a time.
3. Adoption requires measurable improvement with no reliability regression.
4. Any accepted workflow change must be synchronized in docs/rules/scripts in the same change set.

## Cycle Cadence

1. Weekly (`45-90 min`): research scan + candidate shortlist.
2. Biweekly (`1 pilot/cycle`): run one controlled workflow experiment.
3. Monthly (`60 min`): governance review and baseline reset.

Weekly slop-pruning execution (docs/scripts/config/code) is defined in:

- `docs/workflow/strategy/weekly-slop-optimization-loop.md`

## Phase 1: Research Intake (Weekly)

Collect only high-signal sources:

1. Primary sources from expert practitioners and official engineering docs.
2. Source must include actionable workflow mechanics, not only opinions.
3. Source must be recent enough for current tool/runtime behavior.

Required weekly changelog scan for this repository:

1. Claude Code release notes / changelog
2. Claude Agent SDK release notes / changelog
3. OpenCode release notes / changelog

For each source, capture:

1. upstream change summary
2. NanoClaw subsystem fit (`main`, `andy-developer`, `jarvis-worker-*`, shared runtime)
3. candidate adoption or explicit `no-fit`
4. risk / operator-load impact

Record findings in `docs/research/` with:

1. What they do.
2. Why it works.
3. Preconditions.
4. Failure modes.

Before implementation discussion, open or update a GitHub Discussion in `SDK / Tooling Opportunities` and require both Claude and Codex to leave a decision comment (`accept`, `pilot`, `defer`, `reject`).

## Phase 2: Translation to NanoClaw Context

For each candidate practice, write a mission-fit translation:

1. Problem it solves in NanoClaw.
2. Expected gain (`quality`, `latency`, `throughput`, or `operator load`).
3. Risk to contracts/security/reliability.
4. Where it would be enforced (doc/rule/script/CI/skill).

Reject any idea that requires violating mission contracts or role boundaries.

## Phase 3: Pilot Design (One Change at a Time)

Define a pilot with fixed boundaries:

1. Scope: exact workflow change.
2. Duration: 1-2 weeks max.
3. Cohort: specific task type (feature, bug-fix, reliability).
4. Baseline period: previous 2-4 weeks.
5. Success metrics and failure thresholds.

Do not bundle multiple workflow changes in one pilot.

Do not promote a changelog-derived idea directly from local notes into implementation without the Discussion decision step, unless a human explicitly instructs otherwise.

## Phase 4: Execution + Evidence

Run pilot and collect objective evidence.

Recommended operational commands:

```bash
bash scripts/jarvis-ops.sh acceptance-gate
bash scripts/jarvis-ops.sh status
bash scripts/jarvis-ops.sh hotspots --window-hours 168
bash scripts/jarvis-ops.sh incident list --status open
bash scripts/check-tooling-governance.sh
```

Optional cycle-time snapshot:

```bash
sqlite3 store/messages.db "
SELECT
  COUNT(*) AS sample_size,
  ROUND(AVG((julianday(COALESCE(completed_at, started_at)) - julianday(started_at)) * 24 * 60), 2) AS avg_minutes
FROM worker_runs
WHERE started_at >= datetime('now', '-14 days');
"
```

## Phase 5: Decision Gate

Decide with thresholds:

### Adopt when all are true

1. Quality improved (`incident_open_rate` down or unchanged).
2. Reliability did not regress (`acceptance-gate` and connectivity outcomes stable or better).
3. Speed improved (`cycle_time` or first-pass success improved).
4. Operator burden did not increase materially.

### Reject when any is true

1. Incident opening rate increases by `>10%` during pilot.
2. Average open-incident age worsens by `>10%`.
3. Acceptance-gate pass rate drops below `85%`.
4. User-facing happiness quality regresses.

### Extend pilot (one extra cycle)

Only if results are mixed and risk is low.

## Core Metrics (Track Each Cycle)

1. `acceptance_gate_pass_rate` (`pass/total`).
2. `worker_connectivity_pass_rate` (from connectivity gate runs).
3. `incident_open_rate` (new incidents per week).
4. `incident_reopen_rate` (reopened / resolved).
5. `median_open_incident_age_days`.
6. `avg_worker_cycle_minutes` (started -> terminal).
7. `happiness_gate_pass_rate` for Andy-facing reliability work.

## Institutionalization (For Adopted Changes)

In the same change set:

1. Update `CLAUDE.md` trigger lines if retrieval path changes.
2. Update `AGENTS.md` mirror.
3. Update affected docs under `docs/workflow/*` and `docs/operations/*`.
4. Update relevant `.claude/rules/*` discipline files.
5. Add/adjust script or CI enforcement when possible.
6. Run `bash scripts/check-workflow-contracts.sh`.

## Artifact Standard

For every completed pilot, retain:

1. Pilot summary (`what changed`, `metrics`, `decision`).
2. Evidence paths (acceptance manifests, incident bundles, command outputs).
3. Final decision (`adopt`, `reject`, `extend`) and rationale.

## Anti-Patterns

1. Adopting workflow changes by intuition only.
2. Running multiple process experiments together.
3. Treating external expert workflow as universally transferable.
4. Updating runtime behavior without governance/doc synchronization.
5. Declaring success without measurable before/after evidence.
