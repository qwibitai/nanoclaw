# NanoClaw GitHub Control Plane

Defines who changes GitHub governance and how those changes are shipped.

For cross-domain ownership and update-location mapping, see
`docs/operations/workflow-setup-responsibility-map.md`.

## Responsibility Split

- `Andy-developer` (Claude Code lane):
  - manages `.github/workflows/*`
  - manages PR/review automation policy
  - manages branch governance playbooks
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
- Do not bypass branch protection except for explicit emergency procedure.

## User QA Handoff Gate (Andy-Owned)

When work is marked ready for user testing:

1. Andy reviews worker completion and explicitly approves branch/commit.
2. Andy syncs approved branch/commit into `NanoClawWorkspace`.
3. Andy runs local preflight (`build` + `server start/health`) and records outcomes.
4. Andy verifies no duplicate same-lane running containers before handoff:
   - `container ls -a | rg 'nanoclaw-andy-developer|nanoclaw-jarvis'`
5. Andy sends handoff block with repo path, branch/commit, install/start/health/stop commands, and URL.

If preflight fails or lane state is inconsistent, do not mark ready; return blocker/rework path first.
