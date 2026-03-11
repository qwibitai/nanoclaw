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
| GitHub Actions and governance | `andy-developer` | `.github/workflows/*`, `docs/workflow/github/nanoclaw-github-control-plane.md` | `groups/andy-developer/docs/github-workflow-admin.md` |
| GitHub Project / Discussions collaboration taxonomy | `andy-developer` | `.github/workflows/project-intake-sync.yml`, `.github/workflows/project-status-sync.yml`, `.github/DISCUSSION_TEMPLATE/*`, `docs/workflow/github/github-multi-agent-collaboration-loop.md`, `docs/workflow/github/nanoclaw-github-control-plane.md` | `groups/andy-developer/docs/github-workflow-admin.md` |
| Worker branch seeding (`base_branch` -> `jarvis-*`) | `andy-developer` | `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md`, `src/ipc.ts` | `groups/andy-developer/docs/jarvis-dispatch.md`, `groups/jarvis-worker-*/CLAUDE.md` |
| PR review mode policy (`@claude`) | `andy-developer` | `docs/workflow/github/nanoclaw-github-control-plane.md`, `docs/operations/roles-classification.md` | `groups/andy-developer/CLAUDE.md`, `groups/andy-developer/docs/github.md` |
| Role boundaries (Andy vs Jarvis) | `andy-developer` + core maintainer | `docs/operations/roles-classification.md`, `container/rules/andy-developer-operating-rule.md`, `src/ipc.ts` | `groups/andy-developer/CLAUDE.md`, `groups/jarvis-worker-*/CLAUDE.md` |
| Worker dispatch/completion contract | core maintainer + `andy-developer` | `src/dispatch-validator.ts`, `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md`, `src/jarvis-worker-dispatch.test.ts` | `groups/andy-developer/docs/jarvis-dispatch.md` |
| Worker runtime setup (OpenCode/image/mounts) | core maintainer + `andy-developer` | `container/worker/*`, `src/container-runner.ts`, `docs/workflow/runtime/nanoclaw-jarvis-worker-runtime.md` | `groups/jarvis-worker-*/docs/workflow/*` |
| Browser test skill behavior (WebMCP gate, pass/fail evidence) | core maintainer + `andy-developer` | `docs/operations/roles-classification.md`, `container/rules/andy-developer-operating-rule.md`, `container/rules/jarvis-worker-operating-rule.md` | `~/.claude/skills/testing/SKILL.md`, `~/.claude/skills/browser-testing/SKILL.md` (mounted via `container/skills/testing` and `container/skills/browser-testing` symlinks) |
| Workflow optimization strategy/cadence and research-to-pilot decisions | `andy-developer` + core maintainer | `docs/workflow/strategy/workflow-optimization-loop.md`, `docs/workflow/strategy/weekly-slop-optimization-loop.md`, `CLAUDE.md`, `docs/operations/update-requirements-matrix.md` | `groups/andy-developer/CLAUDE.md` (if lane execution instructions change) |
| Autonomous Claude/Codex delivery stack (hourly Claude pickup, nightly research, morning Codex readiness, Codex PR guardian, Claude reliability, pause/lock helpers, board state flow) | `andy-developer` + core maintainer | `.claude/commands/platform-pickup.md`, `.claude/commands/nightly-improvement-eval.md`, `.claude/agents/nightly-improvement-researcher.md`, `.codex/config.toml`, `.codex/agents/morning-prep.toml`, `.codex/agents/pr-guardian.toml`, `.github/labels.json`, `scripts/workflow/autonomy-lane.sh`, `scripts/workflow/autonomy-pr-guardian-output-schema.json`, `scripts/workflow/platform-loop.js`, `scripts/workflow/platform-loop-sync.sh`, `scripts/workflow/run-platform-claude-session.sh`, `scripts/workflow/start-platform-loop.sh`, `scripts/workflow/check-platform-loop.sh`, `scripts/workflow/trigger-platform-pickup-now.sh`, `scripts/workflow/start-pr-guardian.sh`, `scripts/workflow/start-autonomy-reliability.sh`, `scripts/workflow/nightly-improvement.js`, `scripts/workflow/start-nightly-improvement.sh`, `scripts/workflow/start-morning-codex-prep.sh`, `scripts/workflow/morning-codex-prep-output-schema.json`, `launchd/com.nanoclaw-platform-loop.plist`, `launchd/com.nanoclaw-pr-guardian.plist`, `launchd/com.nanoclaw-reliability-loop.plist`, `launchd/com.nanoclaw-nightly-improvement.plist`, `launchd/com.nanoclaw-morning-codex-prep.plist`, `docs/workflow/github/nanoclaw-platform-loop.md`, `docs/workflow/strategy/nightly-evaluation-loop.md`, `docs/workflow/github/github-agent-collaboration-loop.md`, `docs/workflow/github/nanoclaw-github-control-plane.md` | `.nanoclaw/autonomy/*`, `.nanoclaw/platform-loop/*`, `.nanoclaw/reliability-loop/*`, `.nanoclaw/pr-guardian/*`, `.nanoclaw/nightly-improvement/*`, `.nanoclaw/morning-codex-prep/*`, `groups/andy-developer/docs/github-workflow-admin.md`, `groups/andy-developer/CLAUDE.md` |
| Tracked progress, catalog, and test evidence layout | `andy-developer` + core maintainer | `.claude/progress/incident.json`, `.claude/progress/session-handoff.jsonl`, `.claude/progress/work-items.json`, `.claude/catalog/*`, `data/diagnostics/tests/*`, `.claude/examples/*`, `.claude/skills/feature-tracking/*`, `.claude/skills/nanoclaw-orchestrator/*`, `.claude/skills/nanoclaw-testing/*` | none |
| Unified Claude/Codex anti-slop workflow policy and mirror governance | `andy-developer` + core maintainer | `CLAUDE.md` (canonical), `AGENTS.md` (mirror), `docs/workflow/delivery/unified-codex-claude-loop.md`, `docs/operations/claude-codex-adapter-matrix.md`, `docs/operations/subagent-catalog.md`, `docs/operations/tooling-governance-budget.json`, `.codex/config.toml`, `.codex/agents/*`, `.claude/settings.local.json`, `.claude/hooks/*`, `scripts/check-claude-codex-mirror.sh`, `scripts/check-tooling-governance.sh` | `~/.codex/config.toml`, `~/.claude/settings.json` for global defaults only |
| Product implementation tasks | `jarvis-worker-*` | product repo source + tests | worker group docs/memory as needed |

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
