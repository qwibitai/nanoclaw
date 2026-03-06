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
  research/         # workflow research intake and weekly optimization evidence
```

## Start Points

- Architecture first: `docs/architecture/nanoclaw-system-architecture.md`
- Architecture audit: `docs/architecture/architecture-audit.md`
- Harness alignment: `docs/architecture/harness-engineering-alignment.md`
- Jarvis architecture: `docs/architecture/nanoclaw-jarvis.md`
- Mission baseline profile: `docs/architecture/mission-core-profile.md`
- Optional ops profile: `docs/architecture/mission-optional-features.md`
- Architecture optimization plan: `docs/architecture/nanoclaw-architecture-optimization-plan.md`
- Workflow contract: `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`
- Default development loop: `docs/workflow/nanoclaw-development-loop.md`
- Workflow optimization loop: `docs/workflow/workflow-optimization-loop.md`
- Weekly slop optimization loop: `docs/workflow/weekly-slop-optimization-loop.md`
- Unified Claude/Codex loop: `docs/workflow/unified-codex-claude-loop.md`
- GitHub offload boundary loop: `docs/workflow/github-offload-boundary-loop.md`
- GitHub multi-agent collaboration loop: `docs/workflow/github-multi-agent-collaboration-loop.md`
- Claude CLI resume consult lane: `docs/workflow/claude-cli-resume-consult-lane.md`
- Session recall workflow: `docs/workflow/session-recall.md`
- Runtime behavior: `docs/workflow/nanoclaw-jarvis-worker-runtime.md`
- Acceptance gates: `docs/workflow/nanoclaw-jarvis-acceptance-checklist.md`
- GitHub control-plane: `docs/workflow/nanoclaw-github-control-plane.md`
- User happiness gate: `docs/workflow/nanoclaw-andy-user-happiness-gate.md`
- Container debugging flow: `docs/workflow/nanoclaw-container-debugging.md`
- User review readiness gate: `docs/workflow/nanoclaw-github-control-plane.md` (QA handoff section) + `docs/troubleshooting/DEBUG_CHECKLIST.md` (runtime recovery)
- Ops scripts quick entrypoint: `scripts/jarvis-ops.sh` (`preflight`, `reliability`, `acceptance-gate`, `status`, `trace`, `verify-worker-connectivity`, `dispatch-lint`, `completion-lint`, `auth-health`, `linkage-audit`, `weekend-prevention`, `db-doctor`, `incident`, `probe`, `hotspots`, `incident-bundle`, `consult`, `recover`, `smoke`, `watch`)
- Message timeline helper script: `scripts/jarvis-message-timeline.sh` (invoked by `scripts/jarvis-ops.sh message-timeline`)
- Tooling governance lint (hooks/subagents/built-ins): `bash scripts/check-tooling-governance.sh`
- Operational ownership: `docs/operations/roles-classification.md`
- Workflow setup + update ownership: `docs/operations/workflow-setup-responsibility-map.md`
- Skills-vs-docs decision boundary: `docs/operations/skills-vs-docs-map.md`
- Claude/Codex adapter matrix: `docs/operations/claude-codex-adapter-matrix.md`
- Subagent catalog: `docs/operations/subagent-catalog.md`
- Tooling governance budget (hooks/subagents/built-ins): `docs/operations/tooling-governance-budget.json`
- Upstream daily sync policy: `docs/operations/upstream-sync-policy.md`
- Skill source-of-truth (global symlinked skills for testing/browser-testing): `docs/operations/roles-classification.md` + `docs/operations/workflow-setup-responsibility-map.md`
- Agreement-driven auto-sync discipline: `docs/operations/agreement-sync-protocol.md`
- Runtime vs prebaked boundary: `docs/operations/runtime-vs-prebaked-boundary.md`
- Change impact: `docs/operations/update-requirements-matrix.md`
- Debug loop: `docs/troubleshooting/DEBUG_CHECKLIST.md`
- Apple container networking: `docs/troubleshooting/APPLE-CONTAINER-NETWORKING.md`
- Worker dispatch root-cause archive: `docs/troubleshooting/worker-dispatch-root-cause-2026-02-24.md`
- Requirements baseline: `docs/reference/REQUIREMENTS.md`
- Spec baseline: `docs/reference/SPEC.md`
- Security baseline: `docs/reference/SECURITY.md`
- Mission statement: `docs/MISSION.md`
- Changelog: `docs/CHANGELOG.md`
- Archive index: `docs/archives/CHANGELOG-2026-02-26.md`
- Research intake + weekly optimization evidence: `docs/research/README.md`

## Authority

- `DOCS.md` is the root map for full repository documentation.
- `CLAUDE.md` is the compressed trigger index used by runtime agents.
