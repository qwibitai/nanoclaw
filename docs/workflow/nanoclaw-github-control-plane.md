# NanoClaw GitHub Control Plane

Defines who changes GitHub governance and how those changes are shipped.

For cross-domain ownership and update-location mapping, see
`docs/operations/workflow-setup-responsibility-map.md`.

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

## Fork Auth and Sync Workflow (Andy Analysis)

Use this when Andy analysis must read `openclaw-gurusharan/nanoclaw` `main`.

1. Verify remote mapping and normalize alias names.
   - `git remote -v`
   - Expected:
     - `origin` -> `https://github.com/ingpoc/nanoclaw.git`
     - `nanoclaw` -> `https://github.com/openclaw-gurusharan/nanoclaw.git`
     - `upstream` -> `https://github.com/qwibitai/nanoclaw`
   - If old alias exists, rename once:
     - `git remote rename openclaw nanoclaw`
2. Verify active GitHub CLI account and switch before pushing.
   - `gh auth status -h github.com`
   - `gh auth switch -h github.com -u openclaw-gurusharan`
   - If tokens are invalid:
     - `gh auth login -h github.com --git-protocol https --web`
     - `gh auth switch -h github.com -u openclaw-gurusharan`
3. Sync code to fork.
   - Preferred (policy-safe): push branch and merge via PR into `main`.
     - `git push -u nanoclaw <branch>`
     - `gh pr create --repo openclaw-gurusharan/nanoclaw --base main --head <branch>`
   - Emergency/admin-only direct update (if explicitly allowed):
     - `git push nanoclaw <branch>:main`
4. Confirm `main` contains expected commit.
   - `git ls-remote --heads nanoclaw main`
   - `git log --oneline -n 1`

Troubleshooting:
- `permission denied` on push usually means wrong active account or missing write permission to target branch.
- If `gh auth switch` fails, re-run `gh auth status -h github.com` and refresh auth with `gh auth login`.

## User QA Handoff Gate (Andy-Owned)

When work is marked ready for user testing:

1. Andy reviews worker completion and explicitly approves branch/commit.
2. Andy syncs approved branch/commit into `NanoClawWorkspace` (clone first if repo missing).
3. Andy runs local preflight (`build` + `server start/health`) and records outcomes.
4. Andy verifies no duplicate same-lane running containers before handoff:
   - `container ls -a | rg 'nanoclaw-andy-developer|nanoclaw-jarvis'`
5. Andy confirms preflight was executed on the same approved branch/commit under test.
6. Andy sends handoff block with repo path, branch/commit, and user-run install/start/health/stop commands.

If preflight fails or lane state is inconsistent, do not mark ready; return blocker/rework path first.

## Agent Routing

| Step | Agent | Mode | Notes |
|------|-------|------|-------|
| Policy decisions | opus | — | Governance changes require judgment |
| Workflow YAML reads | scout | fg | Scan `.github/workflows/` for drift |
| Drift detection | scout | fg | Compare current vs expected governance state |
| CI status checks | verifier | fg | `gh run list` exit codes |
