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

- The primary implementation lane for autonomous `NanoClaw Platform` pilots is local Claude Code `/loop`, not GitHub Actions.
- The repo-tracked command surface is `.claude/commands/platform-pickup.md`.
- The local bootstrap surfaces are:
  - `scripts/workflow/start-platform-loop.sh`
<<<<<<< HEAD
  - `scripts/workflow/platform-loop-sync.sh`
  - `scripts/workflow/check-platform-loop.sh`
  - `launchd/com.nanoclaw-platform-loop.plist`
- The `/loop` lane may claim only one platform item at a time and must stop if any Claude-owned item is already in `Review`.
- The platform loop must reseed its dedicated worktree from `origin/main` before pickup and fail closed if that sync cannot be proven.
||||||| 7476e8b
=======
  - `scripts/workflow/check-platform-loop.sh`
  - `launchd/com.nanoclaw-platform-loop.plist`
- The `/loop` lane may claim only one platform item at a time and must stop if any Claude-owned item is already in `Review`.
>>>>>>> origin/main
- `/loop` may implement, test, branch, and open/update PRs, but it must not merge and it must not bypass deterministic required checks.
- Codex remains the default review lane for these platform PRs.

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
