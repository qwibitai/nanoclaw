# Docs Landing

Curated landing page for the repository docs.

Use this file to find the right starting point quickly.
Use [`DOCS.md`](../DOCS.md) for the full inventory.

## Folder Layout

```text
docs/
  architecture/     # system architecture and design rationale
  workflow/
    delivery/       # delivery loops, gates, and cross-tool execution
    runtime/        # runtime contracts, incident/debug loops, recall
    github/         # GitHub collaboration, governance, and offload boundaries
    docs-discipline/ # docs authoring, pruning, and trigger hygiene
    strategy/       # optimization cadence and slop reduction workflows
  operations/       # role authority and change-management matrix
  reference/        # baseline requirements/spec/security documents
  troubleshooting/  # debug playbooks and platform-specific fixes
  archives/         # historical RCA and archived doc snapshots
  research/         # workflow research intake and weekly optimization evidence
```

## Start Here

- Mission and operating intent: `docs/MISSION.md`
- Core-vs-extension ownership contract: `docs/ARCHITECTURE.md`
- Mission runtime profiles: `docs/architecture/mission-runtime-profiles.md`
- Core architecture: `docs/architecture/nanoclaw-system-architecture.md`
- Jarvis architecture and delegation model: `docs/architecture/nanoclaw-jarvis.md`
- Doc creation and pruning discipline: `docs/workflow/docs-discipline/doc-creation-contract.md` + `docs/workflow/docs-discipline/docs-pruning-loop.md`
- Task-start routing: `docs/workflow/docs-discipline/skill-routing-preflight.md` + `docs/operations/skills-vs-docs-map.md`
- Default delivery workflow: `docs/workflow/delivery/nanoclaw-development-loop.md`
- Runtime and incident debugging: `docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md`
- Worker contract and runtime: `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md` + `docs/workflow/runtime/nanoclaw-jarvis-worker-runtime.md`
- GitHub and workflow governance: `docs/workflow/github/nanoclaw-github-control-plane.md` + `docs/workflow/github/github-offload-boundary-loop.md`
- Day-to-day GitHub agent collaboration: `docs/workflow/github/github-agent-collaboration-loop.md`
- NanoClaw Platform Claude loop: `docs/workflow/github/nanoclaw-platform-loop.md`
- Cross-tool Claude/Codex execution: `docs/workflow/delivery/unified-codex-claude-loop.md`
- Ownership and update surfaces: `docs/operations/workflow-setup-responsibility-map.md` + `docs/operations/update-requirements-matrix.md`
- Research artifacts and optimization evidence: `docs/research/README.md`

## Common Entrypoints

```bash
bash scripts/qmd-context-recall.sh --bootstrap
bash scripts/workflow/preflight.sh
bash scripts/jarvis-ops.sh acceptance-gate
bash scripts/check-workflow-contracts.sh
bash scripts/check-claude-codex-mirror.sh
```

## Authority

- `CLAUDE.md` is the compressed trigger index used by runtime agents.
- `docs/README.md` is the curated landing page.
- `DOCS.md` is the full documentation inventory.
