# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/reference/REQUIREMENTS.md](docs/reference/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

Folder-level docs index: [`docs/README.md`](docs/README.md)

## Docs Index

```text
BEFORE editing root CLAUDE.md → read .claude/rules/nanoclaw-root-claude-compression.md
BEFORE adding/removing/renaming docs → read .claude/rules/docs-pruning-loop.md
BEFORE changing core orchestrator/channel/IPC/scheduler behavior → read docs/reference/REQUIREMENTS.md, docs/reference/SPEC.md, docs/reference/SECURITY.md
BEFORE changing high-level orchestration methodology → read docs/architecture/harness-engineering-alignment.md
BEFORE changing Jarvis architecture/state machine → read docs/architecture/nanoclaw-jarvis.md
BEFORE changing worker contract code/docs → read .claude/rules/jarvis-dispatch-contract-discipline.md
BEFORE changing worker dispatch validation/contracts → read docs/workflow/nanoclaw-jarvis-dispatch-contract.md
BEFORE changing worker container runtime/mounts/model config → read docs/workflow/nanoclaw-jarvis-worker-runtime.md
BEFORE changing GitHub Actions/review governance for Andy/Jarvis lanes → read docs/workflow/nanoclaw-github-control-plane.md
BEFORE deciding workflow setup, responsibility ownership, or where updates belong → read docs/operations/workflow-setup-responsibility-map.md
BEFORE deciding runtime-local vs prebaked container placement → read docs/operations/runtime-vs-prebaked-boundary.md
BEFORE debugging Andy/Jarvis worker flow issues → read .claude/rules/nanoclaw-jarvis-debug-loop.md
BEFORE debugging Apple Container build/runtime issues → read docs/troubleshooting/DEBUG_CHECKLIST.md and docs/troubleshooting/APPLE-CONTAINER-NETWORKING.md
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

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
