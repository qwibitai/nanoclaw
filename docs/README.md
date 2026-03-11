# Docs Landing

Curated landing page for the repository docs.

Use this file to find the right starting point quickly.
Use [`DOCS.md`](../DOCS.md) for the full inventory.

## Folder Layout

```text
docs/
  architecture/     # system architecture and design rationale
  workflow/
    control-plane/  # Linear execution sweep, collaboration-surface, lane-routing, project-bootstrap, and Symphony contracts
    delivery/       # delivery loops, gates, and cross-tool execution
    runtime/        # runtime contracts, incident/debug loops, recall
    github/         # GitHub delivery governance and offload boundaries
    docs-discipline/ # docs authoring, pruning, and trigger hygiene
    strategy/       # optimization cadence and slop reduction workflows
  operations/       # role authority and change-management matrix
  tools/            # tool-specific usage maps and best-practice routing
  reference/        # baseline requirements/spec/security documents
  troubleshooting/  # debug playbooks and platform-specific fixes
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
- Token-efficient MCP usage routing: `docs/tools/token-efficient-mcp-usage.md`
- Default delivery workflow: `docs/workflow/delivery/nanoclaw-development-loop.md`
- Runtime and incident debugging: `docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md`
- Worker contract and runtime: `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md` + `docs/workflow/runtime/nanoclaw-jarvis-worker-runtime.md`
- GitHub delivery and workflow governance: `docs/workflow/github/github-delivery-governance.md` + `docs/workflow/github/github-offload-boundary-loop.md`
- Control-plane sweep, collaboration split, lane routing, bootstrap/secrets, custom Symphony, and Symphony operator handling: `docs/workflow/control-plane/session-work-sweep.md` + `docs/workflow/control-plane/collaboration-surface-contract.md` + `docs/workflow/control-plane/execution-lane-routing-contract.md` + `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md` + `docs/workflow/control-plane/custom-symphony-orchestration-contract.md` + `docs/workflow/control-plane/symphony-operations-runbook.md`
- Ownership and update surfaces: `docs/operations/workflow-setup-responsibility-map.md`
- Shared session recall and Notion publish flow: `docs/workflow/runtime/session-recall.md`
- Nightly upstream/tooling improvement lane: `docs/workflow/strategy/nightly-evaluation-loop.md`
- Cross-tool Claude/Codex execution: `docs/workflow/delivery/unified-codex-claude-loop.md`
- Ownership and update surfaces: `docs/operations/workflow-setup-responsibility-map.md` + `docs/operations/update-requirements-matrix.md`
- Research artifacts and optimization evidence: `docs/research/README.md`

## Common Entrypoints

```bash
bash scripts/workflow/session-start.sh --agent codex
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
