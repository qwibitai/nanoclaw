# NanoClaw GitHub Control Plane

Defines who changes GitHub governance and how those changes are shipped.

For cross-domain ownership and update-location mapping, see
`docs/operations/workflow-setup-responsibility-map.md`.

## Owns

This document owns GitHub-hosted governance for this repository:

1. workflow auth and secrets expectations
2. PR review automation policy
3. CI failure feedback loops
4. merge policy, required validation, and governance branch guardrails

## Does Not Own

This document does not own:

1. day-to-day use of Discussions, Issues, and the Project board
2. the reusable multi-agent board/category/template rollout shape
3. the decision of whether a concern belongs on GitHub or should stay local

Use instead:

1. `docs/workflow/github/github-agent-collaboration-loop.md` for daily GitHub collaboration behavior
2. `docs/workflow/github/github-multi-agent-collaboration-loop.md` for setup shape and rollout
3. `docs/workflow/github/github-offload-boundary-loop.md` for GitHub-vs-local placement

## Responsibility Split

- `Andy-developer` (Claude Code lane):
  - manages `.github/workflows/*`
  - manages PR/review automation policy
  - manages branch governance playbooks
  - creates and pushes pre-seeded `jarvis-*` worker branches from approved base branches
  - decides whether `@claude` review is required, optional, or disabled per project
- `jarvis-worker-*` (OpenCode lane):
  - implements product code changes from dispatch contracts
  - does not own branch protection/workflow governance by default

## Collaboration Surface Governance Boundary

- This repository ships two project workflows:
  - `.github/workflows/project-intake-sync.yml` for Issue intake + default field initialization
  - `.github/workflows/project-status-sync.yml` for status sync from Issue/PR lifecycle
- Delivery execution state on `Andy/Jarvis Delivery` is additionally host-managed from `andy_requests` + `worker_runs` through `src/extensions/jarvis/github-delivery-sync.ts`.
- Repo Issues/Discussions stay on `ingpoc/nanoclaw`; `NanoClaw Platform` board checks/mutations use `ingpoc`, while `Andy/Jarvis Delivery` board checks use `openclaw-gurusharan`.
- Discussion category taxonomy is only partially repo-configurable. The repository ships templates for the default GitHub categories (`General`, `Ideas`, `Q&A`), and any rename to the preferred collaboration taxonomy is a one-time GitHub UI admin action.
- The operating rules for how agents use those surfaces are intentionally not repeated here; they belong in `docs/workflow/github/github-agent-collaboration-loop.md`.

## Merge Policy

1. `main` is PR-only.
2. Direct pushes to `main` are blocked.
3. Required checks must pass before merge.
4. Governance changes must include rollback notes in PR description.
5. PRs should link an issue; maintenance/docs/governance PRs may use `No issue: maintenance` in the Linked Work Item section.

## Claude Review Automation Baseline

- Use `anthropics/claude-code-action@v1` for PR review automation.
- Default trigger should be on-demand comment invocation (`@claude`) on PR threads, review comments, or submitted PR reviews unless project requirements require always-on review.
- Keep permissions minimal (`contents: read`, `pull-requests: write`, `issues: write`).
- This repository currently authenticates Claude GitHub Actions through `ANTHROPIC_API_KEY`.
- Repository Actions secrets are the authority for GitHub-hosted workflows; local `.env` auth values do not flow into GitHub Actions automatically.
- Grant `id-token: write` so the action can mint the GitHub token it uses for repository interaction.
- Restrict invocation to trusted repo actors (`OWNER`, `MEMBER`, `COLLABORATOR`) unless a project explicitly wants broader public triggering.
- Bound the lane with workflow concurrency and a short timeout; Claude should stay review/discussion-first, not a required merge gate.
- Maintain a single curated Claude workflow. If the Claude GitHub App opens bootstrap PRs with generated workflows, treat them as scaffolding to review and selectively absorb, not as the canonical control-plane implementation.
- This repository ships an on-demand example at `.github/workflows/claude-review.yml`.

## NanoClaw Platform Claude Loop Baseline

- The primary implementation lane for autonomous `NanoClaw Platform` pilots is the local sparse Claude pickup lane, not GitHub Actions.
- The repo-tracked command surface is `.claude/commands/platform-pickup.md`.
- The local bootstrap surfaces are:
  - `scripts/workflow/start-platform-loop.sh`
  - `scripts/workflow/platform-loop-sync.sh`
  - `scripts/workflow/check-platform-loop.sh`
  - `launchd/com.nanoclaw-platform-loop.plist`
- The launchd schedule is sparse: `10:00` and `15:00` Asia/Kolkata, with manual one-shot pickup still allowed between slots.
- The pickup lane may claim only one platform item at a time and must stop if any Claude-owned item is already in `Review`.
- The pickup lane must reseed its dedicated worktree from `origin/main` before pickup and fail closed if that sync cannot be proven.
- The pickup lane may implement, test, branch, and open/update PRs, but it must not merge and it must not bypass deterministic required checks.
- Codex remains the default review lane for these platform PRs.

## Nightly Improvement Lane Baseline

- The overnight improvement lane is local headless Claude Code automation, not GitHub Actions.
- The repo-tracked agent surface is `.claude/agents/nightly-improvement-researcher.md`.
- The slash-command surface `.claude/commands/nightly-improvement-eval.md` is manual debugging only.
- The local bootstrap surfaces are:
  - `.claude/agents/nightly-improvement-researcher.md`
  - `scripts/workflow/nightly-improvement.js`
  - `scripts/workflow/start-nightly-improvement.sh`
  - `launchd/com.nanoclaw-nightly-improvement.plist`
- The launcher runs `claude -p --agent nightly-improvement-researcher --model sonnet`.
- The nightly lane is research-only:
  - it may create or update Discussions
  - it may record runtime-local cursor state
  - it must not create execution Issues directly
  - it must not move Project state
  - it must not open PRs
- The nightly lane must skip already evaluated upstream heads and tool versions unless explicitly forced.
- Codex remains the morning triage lane for selective promotion from nightly findings into execution work.

## Morning Codex Prep Lane Baseline

- The morning prep lane is local headless Codex automation, not GitHub Actions.
- The repo-tracked Codex surfaces are `.codex/config.toml` and `.codex/agents/morning-prep.toml`.
- The local bootstrap surfaces are:
  - `scripts/workflow/start-morning-codex-prep.sh`
  - `scripts/workflow/morning-codex-prep-output-schema.json`
  - `launchd/com.nanoclaw-morning-codex-prep.plist`
- The launcher runs `codex exec -p morning_prep` in non-interactive mode with structured output.
- The morning lane must:
  - run `bash scripts/workflow/session-start.sh --agent codex --no-background-sync`
  - resolve only GitHub collaboration items surfaced by that session-start sweep
  - promote nightly findings only when the next action is concrete enough for an execution Issue
  - stop after writing its structured summary
- The morning lane must not edit repo-tracked files.

## CI Failure Feedback Loop

- Keep deterministic `CI` as the required merge gate.
- On PR-scoped `CI` failure, post a single sticky summary comment with the failing job/step and logs link.
- On the next successful `CI` run for that PR, remove the stale failure summary automatically.
- Keep model analysis opt-in from that summary comment; do not auto-trigger Claude or Codex from a failing CI run by default.
- `workflow_run` feedback workflows only become active after the workflow file exists on the default branch; do not expect the PR that introduces the workflow to self-summarize its own failures before merge.
- This repository ships that feedback loop at `.github/workflows/ci-failure-summary.yml`.

## Codex Repair Automation Baseline

- Use `openai/codex-action@v1` for explicit repair automation on trusted PR branches.
- Keep Codex out of required merge checks; deterministic CI remains the merge gate.
- Trigger Codex only from explicit collaborator intent (for example `@codex fix`), not on every PR event.
- Restrict Codex repairs to same-repository PR branches and bounded branch-local edits.
- Run Codex with `safety-strategy: drop-sudo` and the narrowest sandbox that can complete the repair (`workspace-write` by default).
- Store API key in `OPENAI_API_KEY` repository secret.
- This repository keeps the repair lane scaffold at `.github/workflows/codex-repair.yml`, but it is intentionally disabled until `OPENAI_API_KEY` is provisioned.

## Autonomous Repair Boundary

Use this rule for all PR failure handling in GitHub-hosted automation:

1. Anything that is deterministic, bounded, reversible, and easy to verify should be autonomous.
2. Anything that requires product judgment, architecture judgment, policy interpretation, or non-trivial behavioral change should stay human-owned or explicit `@codex fix`.

### Autonomous First

Default to autonomous repair when all are true:

1. the failure maps to a known check or step with a stable repair command
2. the repair is low-risk and repo-scoped
3. the repair can be validated by rerunning the same deterministic check
4. the change does not require choosing between multiple plausible product behaviors

Preferred autonomous actions:

1. one-shot rerun for known flaky or stateful checks
2. formatter or lint `--fix`
3. generated file refresh with a deterministic command
4. PR metadata normalization
5. issue/link/body/label repair for governance checks

### Keep Human or `@codex fix`

Do not make these autonomous by default:

1. failing tests with unclear root cause
2. type or build failures that require code judgment
3. architecture boundary or policy failures
4. security-sensitive fixes
5. runtime/reliability regressions
6. any repair that changes product behavior without a deterministic contract

### Escalation Ladder

Use this order for PR self-healing:

1. deterministic auto-fix command
2. single rerun when the failure class is known to be flaky or API-stateful
3. explicit `@codex fix` for bounded reasoning-based repair
4. human handoff when the repair remains ambiguous or high-impact

Codex should be second-line repair, not first-line cleanup for trivial failures.

### Repository Default Matrix

Use this default classification unless a more specific workflow contract overrides it:

| Failure Surface | Default Owner | Default Action |
|-----------------|---------------|----------------|
| `pr-linked-issue` | autonomous | deterministic repair of PR metadata / linked issue reference, then rerun failed validation |
| `sync-project-status` | autonomous | rerun once automatically, then stop if still failing |
| formatter / import-order / auto-fixable lint step | autonomous | run the bounded fix command, push diff, let checks rerun |
| generated artifact drift | autonomous | run deterministic regeneration command, push diff, let checks rerun |
| umbrella `ci` failure without deterministic subclassification | human or `@codex fix` | inspect failing job/step first; do not auto-fix the whole bucket blindly |
| test / build / type failures requiring code decisions | `@codex fix` or human | bounded reasoning-based repair only after deterministic auto-fix options are exhausted |

This repository now ships the deterministic `pr-linked-issue` repair lane at `.github/workflows/pr-linked-issue-autofix.yml`.
The repair is intentionally narrow:

1. it only runs after `Multi-Agent Governance` fails on `pr-linked-issue`
2. it only applies `No issue: maintenance` when the PR diff is limited to non-product governance/docs/workflow surfaces
3. the governance check reads the live PR body from the GitHub API, not only the original event payload
4. after applying the safe body repair, the workflow explicitly reruns failed jobs once
5. it leaves ambiguous PRs untouched so issue linkage remains a human or explicit `@codex fix` decision

This repository also ships the one-shot `sync-project-status` rerun lane at `.github/workflows/sync-project-status-rerun.yml`.
That lane:

1. only runs after `Project Status Sync` fails
2. only reruns when the failed job is `sync-project-status`
3. only reruns on the first attempt (`run_attempt == 1`)
4. stops after one retry instead of looping

## Workflow Selection Matrix (Andy-Owned)

| Requirement Profile | Workflow Bundle | Claude Review Mode |
|---------------------|-----------------|--------------------|
| Low risk / internal utility | build + test only | disabled or manual dispatch |
| Standard product change flow | build + test + optional review workflow + explicit repair lane | on-demand (`@claude`) |
| High-risk / compliance-heavy | build + test + policy/security checks + review workflow | required per PR policy |

Andy-developer should choose the minimum bundle that satisfies reliability and governance requirements.

## Required Validation Before Merge

- `npm run build`
- `npm test`
- `bash scripts/check-workflow-contracts.sh`
- `bash scripts/jarvis-ops.sh acceptance-gate` for Andy/Jarvis workflow/runtime behavior changes
- Any workflow-specific policy checks enabled for the repo

## Operational Guardrails

- Keep control-plane changes on admin branches (`jarvis-admin-*` recommended).
- Keep product implementation branches on worker branches (`jarvis-*`).
- Allow Andy-developer push only for control-plane/admin branches and worker branch seeding.
- Do not bypass branch protection except for explicit emergency procedure.

## App-Generated Workflow Intake

Use this when installing GitHub Apps that auto-open workflow PRs.

1. Review the generated PR as a reference implementation, not an auto-merge candidate.
2. Port only the mechanics that are actually required for this repository's control-plane policy:
   - missing permissions
   - supported trigger shapes
   - action-specific auth requirements
3. Reject duplicated workflows, broader-than-needed trigger surfaces, or auth changes that conflict with the repository's chosen secret model.
4. Land the curated change on the main control-plane PR/branch, then close the generated bootstrap PR as redundant.

## Related Operational Routing

- Fork auth and sync procedure: `docs/operations/upstream-sync-policy.md`
- User QA handoff and user-facing readiness: `docs/workflow/delivery/nanoclaw-andy-user-happiness-gate.md`
- GitHub governance task routing: `docs/operations/subagent-routing.md`
