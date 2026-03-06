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

## Claude Review Automation Baseline

- Use `anthropics/claude-code-action@v1` for PR review automation.
- Default trigger should be on-demand (`@claude`) unless project requirements require always-on review.
- Keep permissions minimal (`contents: read`, `pull-requests: write`, `issues: write`).
- Store API key in `ANTHROPIC_API_KEY` repository secret.
- This repository ships an on-demand example at `.github/workflows/claude-review.yml`.

## Workflow Selection Matrix (Andy-Owned)

| Requirement Profile | Workflow Bundle | Claude Review Mode |
|---------------------|-----------------|--------------------|
| Low risk / internal utility | build + test only | disabled or manual dispatch |
| Standard product change flow | build + test + optional review workflow | on-demand (`@claude`) |
| High-risk / compliance-heavy | build + test + policy/security checks + review workflow | required per PR policy |

Andy-developer should choose the minimum bundle that satisfies reliability and governance requirements.

## Required Validation Before Merge

- `npm run build`
- `npm test`
- Any workflow-specific policy checks enabled for the repo

## Operational Guardrails

- Keep control-plane changes on admin branches (`jarvis-admin-*` recommended).
- Keep product implementation branches on worker branches (`jarvis-*`).
- Allow Andy-developer push only for control-plane/admin branches and worker branch seeding.
- Do not bypass branch protection except for explicit emergency procedure.

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
