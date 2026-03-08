# GitHub Multi-Agent Collaboration Loop

Reusable operating workflow for projects where multiple agents contribute to the same codebase.

Use this to eliminate siloed execution by making GitHub the shared planning, ownership, and governance layer.

For ongoing day-to-day agent use of the configured Discussions/Issues/Project surfaces in this repository, use `docs/workflow/github/github-agent-collaboration-loop.md`.

Mission anchor: `docs/MISSION.md`.

## Owns

This document owns the reusable setup shape for a multi-agent GitHub collaboration stack:

1. what GitHub surfaces should exist
2. what baseline schema and workflow assets they need
3. what a portable rollout checklist looks like for this repo or another repo

## Does Not Own

This document does not own:

1. day-to-day usage of Discussions, Issues, and Project items after the system exists
2. GitHub-hosted workflow auth, review policy, or merge policy details
3. the decision of whether a concern belongs on GitHub or should stay local

Use instead:

1. `docs/workflow/github/github-agent-collaboration-loop.md` for daily operation
2. `docs/workflow/github/nanoclaw-github-control-plane.md` for governance workflows and auth
3. `docs/workflow/github/github-offload-boundary-loop.md` for GitHub-vs-local placement decisions

## Objective

Coordinate many agents with high throughput and low operator overhead by:

1. Centralizing work state in GitHub Issues/Projects.
2. Enforcing deterministic merge and security invariants in GitHub.
3. Keeping context-heavy runtime/debug tasks in local agent lanes.

## Applicability

Use when any of these are true:

1. More than one agent contributes in parallel.
2. Work items are frequently blocked by hidden cross-agent dependencies.
3. PR review quality is inconsistent because ownership is unclear.
4. Operators spend time manually reconciling status across tools.

Do not use this as the primary day-to-day operating reference once the board and categories already exist; use `docs/workflow/github/github-agent-collaboration-loop.md` for that.

## Core Principle

GitHub is the system of record for work coordination.
Agent memory is transient; Issue/Project state is durable.

This principle is about setup intent. For operational rules like promotion, ownership, or Project status handling, defer to `docs/workflow/github/github-agent-collaboration-loop.md`.

## Collaboration Stack Shape

Use GitHub with a strict separation of purpose:

1. Discussions for exploration, research, workflow debate, upstream evaluation, and Claude/Codex collaboration ideas.
2. Issues for committed work with scope, owner, and deterministic acceptance criteria.
3. Project for execution state only.

Baseline Project rule:

1. Use Issue cards only.
2. Do not add PRs as first-class Project cards.
3. Use the built-in `Linked pull requests` field to expose PR progress from the Issue card.

## Capability Model

### Coordination Plane

1. Issues + sub-issues + dependencies.
2. Projects (v2) with required fields and status flow.
3. Discussions for non-actionable exploration and RFC-style debates.

### Governance Plane

1. Rulesets / branch protection.
2. Required checks and merge policy.
3. CODEOWNERS and review ownership.
4. Security checks (dependency review, code scanning, secret scanning, Dependabot).

### Execution Plane

1. Agents implement from Issue context and link PRs back to Issues.
2. Auto-correct lanes (metadata drift, generated artifacts) run as bot PRs.
3. Runtime/stateful recovery and incident loops stay in local lanes.

## Rollout Workflow

### Phase 1: Exploration and Intake

1. Start with a Discussion for non-actionable collaboration:
   - workflow/process ideas
   - feature ideas
   - upstream NanoClaw adoption candidates
   - Claude/Codex collaboration patterns
   - SDK/tooling opportunities
2. Promote a Discussion to an Issue only when there is a concrete next action with acceptance criteria.
3. Create Issue using an issue form (problem, scope, acceptance, risks).
4. Add labels: `lane:*`, `priority:*`, `risk:*`, optional `agent:*`.
5. If large, create sub-issues and link dependencies (`blocked-by`).

### Phase 2: Board and Schema Setup

1. Add each Issue to Project v2.
2. Set required fields:
   - `Status`: Backlog/Ready/In Progress/Review/Blocked/Done
   - `Agent`
   - `Lane`
   - `Priority`
   - `Risk`
   - `Target`
   - `Source`
   - `Review Lane`
3. Keep only one active owner per Issue.

### Phase 3: Repo Workflow Setup

1. Ensure issue forms and PR templates exist.
2. Ensure label taxonomy exists.
3. Ensure intake and Project sync workflows exist.
4. Ensure the repo can support an Issue-first board before agents begin using it.

### Phase 4: Governance Integration

1. Rulesets require PR + required checks + conversation resolution.
2. CODEOWNERS required for critical paths.
3. Use auto-merge for compliant PRs.
4. Use merge queue when parallel PR pressure rises.

### Phase 5: Handoff to Day-to-Day Operation

1. Once the board, fields, templates, and workflows exist, switch day-to-day usage to `docs/workflow/github/github-agent-collaboration-loop.md`.
2. Keep this doc as the setup and portability reference, not the active operator playbook.

## Discussion Taxonomy

Recommended long-term category set:

1. `Workflow / Operating Model`
2. `Feature Ideas`
3. `Upstream NanoClaw Sync`
4. `Claude/Codex Collaboration`
5. `SDK / Tooling Opportunities`

GitHub currently manages Discussion categories outside the repository. This repository therefore ships form templates for the default categories (`General`, `Ideas`, `Q&A`) as the portable scaffold, and category renaming remains a one-time GitHub UI admin step.

## Auto-Correct-First Policy

Keep operator load low with this split:

### Hard blocking

1. Build/type/test failures.
2. Policy/ruleset violations.
3. High-severity security findings.
4. Missing required review ownership.

### Auto-correct (non-blocking)

1. Version metadata updates.
2. Token/badge/doc generated artifact drift.
3. Routine dependency update PRs.
4. Mechanical template/schema drift.

### Advisory only

1. Performance trend warnings.
2. Low-severity hygiene findings.
3. Non-critical optimization recommendations.

## Required Repository Baseline

1. `main` protected by ruleset or branch protection.
2. Required status checks configured.
3. Auto-merge enabled.
4. Squash merge enabled (recommended for linear history).
5. Issue templates and PR template present.
6. CODEOWNERS present for critical paths.

## Portability Checklist (For Other Projects)

Copy this workflow by applying:

1. New Project board with standard fields/statuses.
2. Shared label taxonomy (`lane:*`, `priority:*`, `risk:*`, `agent:*`).
3. Ruleset baseline with minimal required checks.
4. Security baseline workflows (dependency review, code scanning, secret scanning, Dependabot).
5. Reusable workflow modules (`workflow_call`) for common checks.
6. CLAUDE/AGENTS trigger line to this workflow doc in each target repo.

## Implementation Assets (This Repository)

Use these assets as the standard starter pack for this and future repositories:

1. `.github/ISSUE_TEMPLATE/agent-work-item.yml`
2. `.github/ISSUE_TEMPLATE/incident-report.yml`
3. `.github/PULL_REQUEST_TEMPLATE.md` (issue-link contract)
4. `.github/labels.json` (portable label taxonomy)
5. `.github/workflows/multi-agent-governance.yml` (auto-label + issue-link enforcement)
6. `.github/workflows/project-intake-sync.yml` (auto-add Issues to Project board and initialize execution fields)
7. `.github/workflows/project-status-sync.yml` (sync Issue-first Project status from Issue/PR lifecycle)
8. `.github/DISCUSSION_TEMPLATE/*.yml` (portable discussion scaffolding for workflow/ideas/questions/sdk-tooling review)
9. `scripts/workflow/sync-github-labels.sh` (safe label upsert, non-destructive)
10. `scripts/workflow/apply-branch-protection-baseline.sh` (low-friction branch protection baseline)

Bootstrap sequence:

```bash
bash scripts/workflow/sync-github-labels.sh <owner/repo>
bash scripts/workflow/apply-branch-protection-baseline.sh <owner/repo> [branch]
```

Project automation prerequisite:

1. Add repository secret `ADD_TO_PROJECT_PAT` with `project` + repository scopes.
2. Set `PROJECT_OWNER`, `PROJECT_NUMBER`, and `PROJECT_URL` in `.github/workflows/project-intake-sync.yml` and `.github/workflows/project-status-sync.yml`.
3. Configure the Project `Status` field with `Backlog`, `Ready`, `In Progress`, `Review`, `Blocked`, and `Done`.
4. Create the `Source` and `Review Lane` single-select fields on the Project board.

## Suggested Metrics

Track weekly:

1. `issue_cycle_time_days` (open -> done).
2. `blocked_issue_ratio`.
3. `pr_first_pass_rate` (merged without rework cycles).
4. `required-check-failure-rate`.
5. `security-alert-open-count`.
6. `automation-vs-manual-fix ratio`.

Adopt workflow changes only when reliability holds and operator burden stays flat or improves.

## Anti-Patterns

1. Agents working without Issue IDs.
2. Multiple active PRs for one Issue without explicit split.
3. Long-lived “In Progress” items with no status heartbeat.
4. Treating Discussions as execution tracking.
5. Adding blocking checks without latency/noise evidence.
6. Using the Project as a brainstorming board instead of an execution board.
7. Keeping PR cards on the board when the Issue already exists.
