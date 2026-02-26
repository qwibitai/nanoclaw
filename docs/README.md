# Docs Folder Index

This folder is subclassified by operating concern.

## Folder Layout

```text
docs/
  architecture/     # system architecture and design rationale
  workflow/         # dispatch/runtime workflow and acceptance gates
  operations/       # role authority and change-management matrix
  reference/        # baseline requirements/spec/security documents
  troubleshooting/  # debug playbooks and platform-specific fixes
```

## Start Points

- Architecture first: `docs/architecture/nanoclaw-system-architecture.md`
- Architecture optimization plan: `docs/architecture/nanoclaw-architecture-optimization-plan.md`
- Workflow contract: `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`
- Runtime behavior: `docs/workflow/nanoclaw-jarvis-worker-runtime.md`
- GitHub control-plane: `docs/workflow/nanoclaw-github-control-plane.md`
- User review readiness gate: `docs/workflow/nanoclaw-github-control-plane.md` (QA handoff section) + `docs/troubleshooting/DEBUG_CHECKLIST.md` (runtime recovery)
- Ops scripts quick entrypoint: `scripts/jarvis-ops.sh` (`preflight`, `recover`, `smoke`, `watch`)
- Operational ownership: `docs/operations/roles-classification.md`
- Workflow setup + update ownership: `docs/operations/workflow-setup-responsibility-map.md`
- Skills-vs-docs decision boundary: `docs/operations/skills-vs-docs-map.md`
- Upstream daily sync policy: `docs/operations/upstream-sync-policy.md`
- Skill source-of-truth (global symlinked skills for testing/browser-testing): `docs/operations/roles-classification.md` + `docs/operations/workflow-setup-responsibility-map.md`
- Agreement-driven auto-sync discipline: `docs/operations/agreement-sync-protocol.md`
- Runtime vs prebaked boundary: `docs/operations/runtime-vs-prebaked-boundary.md`
- Change impact: `docs/operations/update-requirements-matrix.md`
- Debug loop: `docs/troubleshooting/DEBUG_CHECKLIST.md`

## Authority

- `DOCS.md` is the root map for full repository documentation.
- `CLAUDE.md` is the compressed trigger index used by runtime agents.
