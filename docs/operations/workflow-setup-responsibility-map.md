# Workflow Setup Responsibility Map

## Purpose

Canonical map for selecting workflow setup, assigning responsibility, and knowing exactly where updates belong.

## Doc Type

`map`

## Canonical Owner

This document owns the update-surface map for workflow governance changes.
It does not own field-level control-plane rules or lane-routing policy.

## Use When

- deciding where a workflow or control-plane change must be updated
- assigning a primary owner for setup, routing, or governance work
- checking whether a change belongs in repo docs, runtime-local state, or both

## Do Not Use When

- changing the Linear/Notion/GitHub/Symphony split itself; use `docs/workflow/control-plane/collaboration-surface-contract.md`
- changing execution-lane policy; use `docs/workflow/control-plane/execution-lane-routing-contract.md`
- changing project bootstrap or secret-scope policy; use `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md`

## Verification

- `bash scripts/check-workflow-contracts.sh`
- `bash scripts/check-docs-hygiene.sh`
- `bash scripts/check-claude-codex-mirror.sh`

## Related Docs

- `docs/workflow/control-plane/collaboration-surface-contract.md`
- `docs/workflow/control-plane/execution-lane-routing-contract.md`
- `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md`
- `docs/workflow/control-plane/custom-symphony-orchestration-contract.md`

## Workflow Setup by Requirement

| Requirement Profile | Workflow Setup | Review Mode | Decision Owner |
|---------------------|----------------|-------------|----------------|
| Low-risk internal utility | build + test | `@claude` optional/disabled | `andy-developer` |
| Standard product delivery | build + test + optional `claude-review` workflow | on-demand (`@claude`) | `andy-developer` |
| High-risk/compliance-sensitive | build + test + policy/security checks + review workflow | required | `andy-developer` |

## Responsibility and Update Locations

| Concern | Primary Owner | Repository-Tracked Update Locations | Runtime-Local Update Locations |
|---------|---------------|-------------------------------------|-------------------------------|
| Collaboration-surface split (`WhatsApp` / `Notion` / `Linear` / `Symphony` / `GitHub`) | `andy-developer` | `docs/workflow/control-plane/collaboration-surface-contract.md`, `docs/workflow/control-plane/execution-lane-routing-contract.md`, `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md`, `docs/workflow/control-plane/custom-symphony-orchestration-contract.md`, `docs/workflow/control-plane/symphony-operations-runbook.md`, `docs/operations/workflow-setup-responsibility-map.md` | `groups/andy-developer/docs/workflow-control-admin.md` |
| Linear execution control plane and issue routing | `andy-developer` | `scripts/workflow/work-control-plane.js`, `scripts/workflow/work-sweep.sh`, `scripts/workflow/linear-work-sweep.js`, `scripts/workflow/platform-loop.js`, `docs/workflow/control-plane/session-work-sweep.md`, `docs/workflow/control-plane/execution-lane-routing-contract.md`, `docs/workflow/delivery/platform-claude-pickup-lane.md` | `groups/andy-developer/docs/workflow-control-admin.md` |
| Notion shared context layer | `andy-developer` | `scripts/workflow/notion-context.js`, `docs/workflow/runtime/session-recall.md`, `docs/workflow/strategy/nightly-evaluation-loop.md`, `docs/workflow/control-plane/collaboration-surface-contract.md` | `groups/andy-developer/docs/workflow-control-admin.md` |
| Cross-project secrets and integration access model | human admin + `andy-developer` | `docs/workflow/control-plane/collaboration-surface-contract.md`, `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md`, auth/setup docs, env var contracts, workflow governance docs | runtime secret stores, local env files, machine secret managers |
| Custom Symphony orchestration and backend routing | `andy-developer` + core maintainer | `docs/workflow/control-plane/custom-symphony-orchestration-contract.md`, `docs/workflow/control-plane/symphony-operations-runbook.md`, `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md`, `docs/workflow/control-plane/execution-lane-routing-contract.md`, `src/symphony-routing.ts`, `src/symphony-dispatch.ts`, `src/symphony-daemon.ts`, `src/symphony-server.ts`, `src/symphony-state.ts`, `scripts/workflow/symphony.ts`, `.claude/examples/symphony-project-registry.example.json`, `.claude/examples/symphony-linear-issue-template.md` | `.nanoclaw/symphony/*`, runtime secret stores, `groups/andy-developer/docs/workflow-control-admin.md` |
| NanoClaw repo execution lanes (`codex`, `claude-code`) | `andy-developer` + core maintainer | `docs/workflow/control-plane/execution-lane-routing-contract.md`, `docs/workflow/delivery/platform-claude-pickup-lane.md`, `docs/operations/roles-classification.md`, scheduled-lane scripts under `scripts/workflow/` | `groups/andy-developer/CLAUDE.md` |
| Downstream project execution lanes (`jarvis-worker-*`) | `andy-developer` + core maintainer | `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md`, `docs/operations/roles-classification.md`, `src/ipc.ts`, `src/dispatch-validator.ts` | `groups/andy-developer/docs/jarvis-dispatch.md`, `groups/jarvis-worker-*/CLAUDE.md` |
| GitHub Actions and delivery governance | `andy-developer` | `.github/workflows/*`, `docs/workflow/github/github-delivery-governance.md` | `groups/andy-developer/docs/workflow-control-admin.md` |
| Role boundaries and authority | `andy-developer` + core maintainer | `docs/operations/roles-classification.md`, `docs/workflow/control-plane/execution-lane-routing-contract.md`, `container/rules/andy-developer-operating-rule.md`, `src/ipc.ts` | `groups/andy-developer/CLAUDE.md`, `groups/jarvis-worker-*/CLAUDE.md` |
| Worker runtime setup (OpenCode/image/mounts) | core maintainer + `andy-developer` | `docs/workflow/runtime/nanoclaw-jarvis-worker-runtime.md`, `src/container-runner.ts`, `container/*` | worker-group config and runtime state |
| Scheduled NanoClaw support lanes (nightly, morning prep, pickup, reliability, PR guardian) | `andy-developer` + core maintainer | `scripts/workflow/start-platform-loop.sh`, `scripts/workflow/start-nightly-improvement.sh`, `scripts/workflow/start-morning-codex-prep.sh`, `scripts/workflow/morning-codex-prep-output-schema.json`, launchd plists, `docs/workflow/strategy/nightly-evaluation-loop.md`, `docs/workflow/delivery/platform-claude-pickup-lane.md` | `.nanoclaw/*`, `groups/andy-developer/docs/workflow-control-admin.md` |
| Tracked progress, catalog, and test evidence layout | `andy-developer` + core maintainer | `.claude/progress/incident.json`, `.claude/progress/session-handoff.jsonl`, `.claude/catalog/*`, `data/diagnostics/tests/*`, `.claude/examples/*`, feature-tracking/testing skill files | none |
| Unified Claude/Codex anti-slop policy and mirror governance | `andy-developer` + core maintainer | `CLAUDE.md`, `AGENTS.md`, `docs/workflow/delivery/unified-codex-claude-loop.md`, `docs/operations/claude-codex-adapter-matrix.md`, `docs/operations/subagent-catalog.md`, `docs/operations/tooling-governance-budget.json`, `.codex/config.toml`, `.claude/settings.local.json`, `.claude/hooks/*`, `scripts/check-claude-codex-mirror.sh`, `scripts/check-tooling-governance.sh` | `~/.codex/config.toml`, `~/.claude/settings.json` |

## Update Protocol

1. Classify the change using the table above.
2. Apply the agreement sync protocol: `docs/operations/agreement-sync-protocol.md`.
3. Update repository-tracked source-of-truth docs/code first.
4. Update `groups/*` lane docs for execution behavior in the same change set.
5. Keep root `CLAUDE.md` compressed: add or change only trigger lines, not long procedures.

## Notes

- `groups/*` instruction surfaces are commit-tracked in this repo (`CLAUDE.md`, `docs/*`, memory markdown, and selected runtime config files per `.gitignore`).
- `container/skills/testing` and `container/skills/browser-testing` are symlinks to `~/.claude/skills/*`; edit the target files, not copied files in-repo.
- For change impact matrix, see `docs/operations/update-requirements-matrix.md`.
- For placement decisions (runtime vs prebaked), see `docs/operations/runtime-vs-prebaked-boundary.md`.
