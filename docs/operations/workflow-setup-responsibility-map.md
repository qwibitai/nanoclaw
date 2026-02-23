# Workflow Setup Responsibility Map

Canonical map for selecting workflow setup, assigning responsibility, and knowing exactly where updates belong.

## Workflow Setup by Requirement

| Requirement Profile | Workflow Setup | Review Mode | Decision Owner |
|---------------------|----------------|-------------|----------------|
| Low-risk internal utility | build + test | `@claude` optional/disabled | `andy-developer` |
| Standard product delivery | build + test + optional `claude-review` workflow | on-demand (`@claude`) | `andy-developer` |
| High-risk/compliance-sensitive | build + test + policy/security checks + review workflow | required | `andy-developer` |

## Responsibility and Update Locations

| Concern | Primary Owner | Repository-Tracked Update Locations | Runtime-Local Update Locations |
|---------|---------------|-------------------------------------|-------------------------------|
| GitHub Actions and governance | `andy-developer` | `.github/workflows/*`, `docs/workflow/nanoclaw-github-control-plane.md` | `groups/andy-developer/docs/github-workflow-admin.md` |
| PR review mode policy (`@claude`) | `andy-developer` | `docs/workflow/nanoclaw-github-control-plane.md`, `docs/operations/roles-classification.md` | `groups/andy-developer/CLAUDE.md`, `groups/andy-developer/docs/github.md` |
| Role boundaries (Andy vs Jarvis) | `andy-developer` + core maintainer | `docs/operations/roles-classification.md`, `container/rules/andy-developer-operating-rule.md`, `src/ipc.ts` | `groups/andy-developer/CLAUDE.md`, `groups/jarvis-worker-*/CLAUDE.md` |
| Worker dispatch/completion contract | core maintainer + `andy-developer` | `src/dispatch-validator.ts`, `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`, `src/jarvis-worker-dispatch.test.ts` | `groups/andy-developer/docs/jarvis-dispatch.md` |
| Worker runtime setup (OpenCode/image/mounts) | core maintainer + `andy-developer` | `container/worker/*`, `src/container-runner.ts`, `docs/workflow/nanoclaw-jarvis-worker-runtime.md` | `groups/jarvis-worker-*/docs/workflow/*` |
| Product implementation tasks | `jarvis-worker-*` | product repo source + tests | worker group docs/memory as needed |

## Update Protocol

1. Classify the change using the table above.
2. Apply the agreement sync protocol: `docs/operations/agreement-sync-protocol.md`.
3. Update repository-tracked source-of-truth docs/code first.
4. Update `groups/*` lane docs for execution behavior in the same change set.
5. Keep root `CLAUDE.md` compressed: add or change only trigger lines, not long procedures.

## Notes

- `groups/*` instruction surfaces are commit-tracked in this repo (`CLAUDE.md`, `docs/*`, memory markdown, and selected runtime config files per `.gitignore`).
- For change impact matrix, see `docs/operations/update-requirements-matrix.md`.
- For placement decisions (runtime vs prebaked), see `docs/operations/runtime-vs-prebaked-boundary.md`.
