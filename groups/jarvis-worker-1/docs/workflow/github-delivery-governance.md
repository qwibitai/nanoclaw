# NanoClaw GitHub Delivery Governance

Defines the worker-facing GitHub boundary in the current operating model.

`Linear` owns tasks and readiness.
`Notion` owns shared context.
`GitHub` owns code delivery only.

For cross-domain ownership and update-location mapping, see `docs/operations/workflow-setup-responsibility-map.md`.

## Responsibility Split

- `andy-developer`:
  - manages `.github/workflows/*`
  - manages PR and review automation policy
  - manages branch governance playbooks
  - creates and pushes pre-seeded `jarvis-*` worker branches from approved base branches
  - decides whether `@claude` review is required, optional, or disabled per project
- `jarvis-worker-*`:
  - implements product code changes from dispatch contracts
  - opens or updates PRs when instructed
  - does not own workflow governance, branch protection, or execution-state changes in Linear

## Merge Policy

1. `main` is PR-only.
2. Direct pushes to `main` are blocked.
3. Required checks must pass before merge.
4. Governance changes must include rollback notes in the PR description.

## Claude Review Automation Baseline

- Use `anthropics/claude-code-action@v1` for PR review automation.
- Default trigger should be on-demand (`@claude`) unless project requirements require always-on review.
- Keep permissions minimal (`contents: read`, `pull-requests: write`, `issues: write`).
- Store API key in `ANTHROPIC_API_KEY` repository secret.

## Workflow Selection Matrix

| Requirement Profile | Workflow Bundle | Claude Review Mode |
|---------------------|-----------------|--------------------|
| Low risk / internal utility | build + test only | disabled or manual dispatch |
| Standard product change flow | build + test + optional review workflow | on-demand (`@claude`) |
| High-risk / compliance-heavy | build + test + policy/security checks + review workflow | required per PR policy |

Andy-developer chooses the minimum bundle that satisfies reliability and governance requirements.

## Required Validation Before Merge

- `npm run build`
- `npm test`
- any workflow-specific policy checks enabled for the repo

## Operational Guardrails

- Keep delivery-governance changes on admin branches (`jarvis-admin-*` recommended).
- Keep product implementation branches on worker branches (`jarvis-*`).
- Let Andy-developer seed or reseed worker branches when governance changes require it.
- Do not bypass branch protection except for an explicit emergency procedure.
- Do not store execution state on GitHub.

## Related Routing

- upstream auth and sync procedure: `docs/operations/upstream-sync-policy.md`
- user QA handoff and user-facing readiness: `docs/workflow/delivery/nanoclaw-andy-user-happiness-gate.md`
- GitHub governance task routing: `docs/operations/subagent-routing.md`
