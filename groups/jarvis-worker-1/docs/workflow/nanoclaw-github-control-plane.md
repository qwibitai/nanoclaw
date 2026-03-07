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

## Related Operational Routing

- Fork auth and sync procedure: `docs/operations/upstream-sync-policy.md`
- User QA handoff and user-facing readiness: `docs/workflow/delivery/nanoclaw-andy-user-happiness-gate.md`
- GitHub governance task routing: `docs/operations/subagent-routing.md`
