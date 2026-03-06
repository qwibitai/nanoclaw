# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/reference/REQUIREMENTS.md](docs/reference/REQUIREMENTS.md) for architecture decisions.

## Instruction Sync Contract

- `CLAUDE.md` is the canonical instruction source for this repository.
- `AGENTS.md` is a mirror/bridge for Codex and must remain fully aligned with this file.
- `docs/README.md` is the landing page for curated start points; `DOCS.md` is the full inventory.
- Codex task preflight: read this file first, then load only the docs referenced by relevant `Docs Index` trigger lines.
- Any policy/process change here must be reflected in `AGENTS.md` in the same change.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

NanoClaw baseline is the default. Jarvis docs apply only when working on the `jarvis-worker-*` execution tier.

## Mission-Aligned Engineering Contract (Mirror)

- Ground every task in `docs/MISSION.md` and make alignment explicit in reasoning and decisions.
- Think from first principles: requirements, constraints, invariants, and tradeoffs before implementation choice.
- Operate as an expert with a clear technical opinion on the correct mission-aligned path.
- Prioritize reliability, optimization, and efficiency as core defaults.
- Use the most relevant internal skills/tools first and verify outcomes with concrete evidence.
- If a better mission-aligned approach exists, surface it proactively and reason with the user before execution.
- Do not rely on assumptions when facts are retrievable; gather repo facts from code/docs and use DeepWiki for repository documentation when more context is required.
- Any issue discovered during work must be logged/updated in `.claude/progress/incident.json` via the incident workflow before closure.
- Any new feature request not already mapped must be feature-tracked and work-item tracked before implementation.

## Docs Index

```text
AT SESSION START, session handoff, or when changing recall/sync/export behavior → read docs/workflow/session-recall.md
BEFORE editing root CLAUDE.md → read docs/workflow/nanoclaw-root-claude-compression.md
BEFORE creating a new docs file or adding a new CLAUDE trigger → read docs/workflow/doc-creation-contract.md
BEFORE adding/removing/renaming docs → read docs/workflow/docs-pruning-loop.md
BEFORE task-start routing for implementation/debug/setup/update work → read docs/workflow/skill-routing-preflight.md
BEFORE single-lane feature, bug-fix, or reliability delivery → read docs/workflow/nanoclaw-development-loop.md
BEFORE workflow optimization from external research → read docs/workflow/workflow-optimization-loop.md
BEFORE weekly slop cleanup or tooling-governance review → read docs/workflow/weekly-slop-optimization-loop.md
BEFORE reviewing hooks/subagents or built-in routing budgets → read docs/operations/tooling-governance-budget.json
BEFORE split-lane Claude/Codex worktrees or review fanout → read docs/workflow/unified-codex-claude-loop.md
BEFORE defining subagent fanout for plan/review/verification → read docs/operations/subagent-catalog.md and docs/operations/subagent-routing.md
BEFORE deciding Claude-vs-Codex execution adapter behavior → read docs/operations/claude-codex-adapter-matrix.md
BEFORE changing core orchestrator/channel/IPC/scheduler behavior → read docs/reference/REQUIREMENTS.md, docs/reference/SPEC.md, docs/reference/SECURITY.md
BEFORE changing core-vs-extension ownership or adding Jarvis-specific logic to shared runtime files → read docs/ARCHITECTURE.md
BEFORE changing high-level orchestration methodology → read docs/architecture/harness-engineering-alignment.md
BEFORE changing Jarvis architecture/state machine → read docs/architecture/nanoclaw-jarvis.md
BEFORE finalizing Jarvis workflow/contract changes → read docs/workflow/nanoclaw-jarvis-acceptance-checklist.md
BEFORE changing worker contract code/docs → read docs/workflow/jarvis-dispatch-contract-discipline.md
BEFORE changing worker dispatch validation/contracts → read docs/workflow/nanoclaw-jarvis-dispatch-contract.md
BEFORE changing worker container runtime/mounts/model config → read docs/workflow/nanoclaw-jarvis-worker-runtime.md
BEFORE changing GitHub Actions/review governance for Andy/Jarvis lanes → read docs/workflow/nanoclaw-github-control-plane.md
BEFORE finalizing Andy user-facing reliability fixes → read docs/workflow/nanoclaw-andy-user-happiness-gate.md
BEFORE deciding workflow setup, responsibility ownership, or where updates belong → read docs/operations/workflow-setup-responsibility-map.md
BEFORE deciding whether to run a skill workflow or docs-first workflow → read docs/operations/skills-vs-docs-map.md
BEFORE deciding what to offload to GitHub Actions/rulesets vs keep in local lanes → read docs/workflow/github-offload-boundary-loop.md
BEFORE setting up multi-agent GitHub coordination using Issues/Projects/Discussions/rulesets → read docs/workflow/github-multi-agent-collaboration-loop.md
BEFORE consulting Claude Code CLI via resumed/forked sessions for parallel reasoning/review → read docs/workflow/claude-cli-resume-consult-lane.md
BEFORE pulling/fetching upstream main or resolving upstream sync conflicts → read docs/operations/upstream-sync-policy.md
BEFORE finalizing any Andy/Jarvis operating agreement change → read docs/operations/agreement-sync-protocol.md
BEFORE deciding runtime-local vs prebaked container placement → read docs/operations/runtime-vs-prebaked-boundary.md
BEFORE editing Andy's groups/main/CLAUDE.md → read docs/workflow/andy-compression-loop.md
BEFORE debugging Andy/Jarvis worker flow issues → read docs/workflow/nanoclaw-jarvis-debug-loop.md
BEFORE debugging Apple Container build/runtime issues → read docs/troubleshooting/DEBUG_CHECKLIST.md and docs/troubleshooting/APPLE-CONTAINER-NETWORKING.md
BEFORE debugging container/auth/session/mount issues → read docs/workflow/nanoclaw-container-debugging.md
```

## Key Files

- `docs/ARCHITECTURE.md`: hard core-vs-extension ownership contract
- `src/index.ts`: orchestrator state, message loop, agent invocation
- `src/ipc.ts`: dispatch authorization and task processing
- `src/container-runner.ts`: worker runtime staging, mounts, lifecycle
- `src/router.ts`: outbound routing and formatting
- `groups/{name}/CLAUDE.md`: per-group isolated memory and routing
- `container/skills/agent-browser/SKILL.md`: browser automation capability available to agents

## Quick Commands

```bash
bash scripts/qmd-context-recall.sh --bootstrap
bash scripts/workflow/preflight.sh
npm run build
npm test
bash scripts/jarvis-ops.sh acceptance-gate
```

For expanded commands, workflow helpers, and entrypoints, start with [`docs/README.md`](docs/README.md) and use [`DOCS.md`](DOCS.md) for the full inventory.
