# GitHub Offload Boundary Loop

Canonical decision workflow for placing automation between:

1. GitHub-native control plane (Actions/rulesets/environments/security features)
2. Local Andy/Codex/Claude execution lanes (stateful reasoning + runtime operations)

Mission anchor: `docs/MISSION.md`.

## Objective

Maximize delivery reliability and throughput by offloading deterministic governance to GitHub while keeping context-heavy and runtime-local work in NanoClaw lanes.

## Core Rule

Offload to GitHub when the task is:

1. Event-driven (`pull_request`, `push`, `merge_group`, `schedule`).
2. Deterministic and auditable (pass/fail checks, policy enforcement).
3. Repository-scoped and stateless enough to run without local session memory.

Keep local when the task requires:

1. Long-lived conversational/session context.
2. Cross-channel runtime state (WhatsApp/Jarvis worker behavior).
3. Incident triage and adaptive debugging decisions.
4. Human confirmation gates tied to operator/user intent.

## Placement Matrix

| Workflow Concern | Primary Plane | Why |
|------------------|---------------|-----|
| PR CI (`build`, `typecheck`, tests, lint) | GitHub | Deterministic, required-status friendly, branch-protection compatible |
| CI failure summarization on PRs | GitHub | Event-driven, deterministic metadata extraction from workflow jobs/logs |
| Contract/governance script checks | GitHub | Objective and enforceable as required checks |
| Branch merge policy (rulesets, required checks, merge queue) | GitHub | Centralized merge gate, prevents broken default branch |
| CODEOWNERS + required reviews | GitHub | Native ownership enforcement on protected branches |
| Security scanning (dependency review, code scanning, secret scanning) | GitHub | Native security posture with standardized alerts and policy hooks |
| Dependabot update cadence | GitHub | Automated dependency hygiene with auditable PR flow |
| Release/tag/changelog automation | GitHub | Repeatable repository lifecycle automation |
| Scheduled deterministic maintenance | GitHub | Stable cron-like execution with logs/artifacts |
| Session-aware architecture/debug reasoning | Local lanes | Requires resumed context and iterative thinking |
| Incident RCA and runtime recovery loops | Local lanes | Needs live runtime state, probes, and adaptive investigation |
| User-facing happiness sign-off | Local lanes | Requires explicit user/operator confirmation path |

## Hybrid Pattern (Default for Complex Work)

1. Local lane decides strategy and implementation path.
2. GitHub enforces merge/deploy invariants with deterministic gates.
3. Local lane handles ambiguous failures and incident prevention updates.
4. Do not merge based on model summary alone; merge only on passing required checks.

## Operator Load Policy (Auto-Correct First)

This workflow is designed to reduce operator burden, not add manual friction.

### Hard-block only for critical invariants

Keep required blocking checks limited to:

1. Build/typecheck/test failures.
2. Contract/governance script failures required by policy.
3. High-severity security or explicit compliance gates.
4. Required code-owner/reviewer approvals.

### Auto-correct by default for non-critical drift

Prefer automation that opens corrective PRs or commits for:

1. Formatting/style drift.
2. Generated metadata drift (badges/token counts/docs artifacts).
3. Skill drift and similar mechanical synchronization tasks.
4. Routine dependency update PRs.

### Advisory (non-blocking) for optimization signals

Keep these as warnings/telemetry unless promoted by policy:

1. Flake/failure trend indicators.
2. Performance/cost regressions without contract impact.
3. Low-severity hygiene findings.

### Blocking budget

Maintain a small required-check set per protected branch.
Promote a check to blocking only when evidence shows it prevents real regressions.

## Future-State Roadmap

Adopt incrementally with measured reliability impact.

### Phase 1: Governance Baseline

1. Ensure branch/ruleset requires CI checks and review requirements.
2. Keep required checks minimal but sufficient (no redundant duplicates).
3. Ensure control-plane scripts are part of required checks.

### Phase 2: Throughput and Safety

1. Enable merge queue for protected branches.
2. Add `merge_group` triggers to required CI workflows.
3. Tighten `GITHUB_TOKEN` job permissions to least privilege.

### Phase 3: Standardization

1. Extract shared checks into reusable workflows (`workflow_call`).
2. Centralize org/repo policy through rulesets.
3. Use environments with required reviewers for deployment gates.

### Phase 4: Continuous Optimization

1. Track queue latency, rerun rates, and flaky-check frequency.
2. Keep only high-signal required checks; demote noisy/non-blocking checks.
3. Review offload boundaries monthly via `docs/workflow/workflow-optimization-loop.md`.

## Repository Application Guidance

For this repository, keep:

1. `scripts/jarvis-ops.sh` runtime/incident/happiness gates in local lanes.
2. `scripts/jarvis-ops.sh consult` as local consult lane (resumed Claude context).

Offload and enforce on GitHub:

1. CI plus workflow/mirror/tooling governance checks as required checks.
2. Sticky PR failure summarization via `workflow_run` after `CI` failures, with model analysis remaining opt-in.
3. Skill and policy validation workflows for PR gating where applicable.
4. Security and dependency review workflows as policy checks.

Important caveat:

1. `workflow_run` automation only activates once the workflow file exists on the default branch, so bootstrap PRs cannot rely on a newly added `workflow_run` workflow to summarize that same PR's failures before merge.

## Decision Checklist (Before Offloading a Task)

1. Can it run purely from repo/event context with no session memory?
2. Is pass/fail deterministic and objectively testable?
3. Will required-check enforcement improve reliability without excessive queue delay?
4. Are secrets/permissions bounded and auditable in GitHub?
5. Is rollback straightforward if false positives or delays spike?

If any answer is no, keep task local or run as hybrid (local reasoning + GitHub enforcement).

## Metrics and Gate

Adopt or expand GitHub offload only if all remain healthy:

1. Default branch red-rate does not regress.
2. Acceptance gate and incident metrics remain stable or improve.
3. Merge throughput does not degrade materially.
4. Operator burden decreases or stays neutral.

Use `docs/workflow/workflow-optimization-loop.md` decision gate for pilot/adopt/reject outcomes.

## Anti-Patterns

1. Offloading context-dependent debugging to pure CI.
2. Making non-deterministic AI summaries required merge checks.
3. Enabling merge queue without `merge_group` CI coverage.
4. Expanding required checks without measuring latency/noise impact.
5. Auto-merging GitHub App-generated workflow PRs without reconciling them against the repository's curated control-plane policy.
