# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/reference/REQUIREMENTS.md](docs/reference/REQUIREMENTS.md) for architecture decisions.

## Instruction Sync Contract

- `CLAUDE.md` is the canonical instruction source for this repository.
- `AGENTS.md` is a mirror/bridge for Codex and must remain fully aligned with this file.
- Codex task preflight: read this file first, then load only the docs referenced by relevant `Docs Index` trigger lines.
- Any policy/process change here must be reflected in `AGENTS.md` in the same change.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

Folder-level docs index: [`docs/README.md`](docs/README.md)

## Mission-Aligned Engineering Contract

- Ground every task in [`docs/MISSION.md`](docs/MISSION.md) and make alignment explicit in reasoning and decisions.
- Think from first principles: define requirements, constraints, invariants, and tradeoffs before selecting an implementation.
- Operate as an expert with a clear technical opinion on the correct path; explain why it is the best mission-aligned approach.
- Never side step any issue or put a patch fix.
- Prioritize reliability, optimization, and efficiency as core defaults for design, implementation, and validation.
- Use the most relevant internal skills/tools first, and verify outcomes with concrete evidence.
- If a better mission-aligned approach exists, surface it proactively and reason with the user before execution.
- Do not rely on assumptions when facts are retrievable; gather repo facts from code/docs and use DeepWiki for repository documentation when additional context is needed.
- Any issue discovered during work must be logged/updated in `.claude/progress/incident.json` through the incident workflow before closure.
- Any new feature request not already mapped must be feature-tracked and work-item tracked before implementation.

## Docs Index

```text
AT SESSION START or resuming interrupted work → read docs/workflow/session-recall.md
BEFORE ending a session with in-progress work/blockers → read docs/workflow/session-recall.md
BEFORE changing session recall/sync/export behavior → read docs/workflow/session-recall.md
BEFORE editing root CLAUDE.md → read docs/workflow/nanoclaw-root-claude-compression.md
BEFORE adding/removing/renaming docs → read docs/workflow/docs-pruning-loop.md
BEFORE starting implementation/debug/setup/update work → read docs/workflow/skill-routing-preflight.md
BEFORE starting feature, bug-fix, or reliability implementation → read docs/workflow/nanoclaw-development-loop.md
BEFORE optimizing development workflow strategy/cadence based on external research → read docs/workflow/workflow-optimization-loop.md
BEFORE running weekly docs/scripts/config/code slop cleanup during optimization cycles → read docs/workflow/weekly-slop-optimization-loop.md
BEFORE reviewing hooks/subagents or built-in tool routing governance → read docs/workflow/weekly-slop-optimization-loop.md and docs/operations/tooling-governance-budget.json
BEFORE running parallel Claude/Codex worktrees or assigning implementation/review across tools → read docs/workflow/unified-codex-claude-loop.md
BEFORE defining subagent fanout for plan/review/verification → read docs/operations/subagent-catalog.md and docs/operations/subagent-routing.md
BEFORE deciding Claude-vs-Codex execution adapter behavior → read docs/operations/claude-codex-adapter-matrix.md
BEFORE changing core orchestrator/channel/IPC/scheduler behavior → read docs/reference/REQUIREMENTS.md, docs/reference/SPEC.md, docs/reference/SECURITY.md
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

NanoClaw baseline is the default. Jarvis docs apply only when working on the `jarvis-worker-*` execution tier.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser/SKILL.md` | Browser automation tool (available to all agents via Bash) |

## Skills

Decision boundary: `docs/operations/skills-vs-docs-map.md`

Mandatory preflight:

- New feature/custom behavior work starts with `/customize` (or a more specific `/add-*` skill if available)
- Runtime/auth/container issue debugging starts with `/debug`
- Incident triage, recurring-issue investigation, and incident lifecycle tracking are docs-first: `docs/workflow/nanoclaw-jarvis-debug-loop.md`, `docs/workflow/nanoclaw-container-debugging.md`, and `.claude/progress/incident.json`
- Incident registry is `.claude/progress/incident.json` (open/resolved state and lifecycle notes)
- Feature inventory/touch-set discipline starts with `feature-tracking`, then `nanoclaw-orchestrator` work-item tracking
- For browser/docs/repo tasks, use intent-matched MCP routing from `docs/operations/skills-vs-docs-map.md` (`chrome-devtools` preferred for browser tasks)

Primary ops:

- `/setup`, `/customize`, `/debug`, `/update`, `/convert-to-apple-container`

Channel/integration skills:

- `/add-telegram`, `/add-telegram-swarm`, `/add-discord`, `/add-gmail`, `/add-voice-transcription`, `/add-parallel`, `/x-integration`

Quality/governance helpers:

- `/get-qodo-rules`, `/qodo-pr-resolver`

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Session recall/sync helpers:

```bash
bash scripts/qmd-context-recall.sh --bootstrap # Recall-only workflow (no sync/git)
bash scripts/qmd-session-sync.sh               # Session export sync + qmd update + git add/commit
```

Unified workflow helpers:

```bash
bash scripts/workflow/preflight.sh
bash scripts/workflow/plan-lock.sh --ticket <id> --goal "<goal>"
bash scripts/workflow/verify.sh
bash scripts/workflow/finalize-pr.sh
bash scripts/workflow/sync-mirror.sh
bash scripts/check-tooling-governance.sh
bash scripts/worktree/open.sh --ticket <id> --base main
bash scripts/worktree/clean.sh --ticket <id> --delete-branches
```

Jarvis ops entrypoint:

```bash
bash scripts/jarvis-ops.sh reliability
bash scripts/jarvis-ops.sh acceptance-gate
bash scripts/jarvis-ops.sh trace --lane andy-developer --until <iso-timestamp>
bash scripts/jarvis-ops.sh verify-worker-connectivity
bash scripts/jarvis-ops.sh happiness-gate --user-confirmation "<manual User POV runbook completed>"
```

Runtime tuning env vars (see `.env.example` for defaults):

- `IDLE_TIMEOUT`
- `CONTAINER_TIMEOUT`
- `CONTAINER_NO_OUTPUT_TIMEOUT`
- `WA_RECONNECT_BASE_DELAY_MS`
- `WA_RECONNECT_MAX_DELAY_MS`
- `WA_RECONNECT_JITTER_MS`
- `WA_RECONNECT_BURST_WINDOW_MS`
- `WA_RECONNECT_BURST_THRESHOLD`
- `WA_RECONNECT_COOLDOWN_MS`

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```
