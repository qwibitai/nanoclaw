# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

Three execution layers: (1) NanoClaw orchestrator handles message routing and scheduling, (2) host-executor runs `claude -p` tasks on the VPS host with full Python hooks, (3) containers run agent sessions with governance guardrails. Tier 2+ tasks use `--worktree` isolation for safe parallel execution.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/telegram.ts` | Telegram channel (Grammy bot, Markdown formatting) |
| `src/ipc.ts` | IPC watcher, task processing, document uploads |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/commands.ts` | Telegram slash commands: /pause, /resume, /status, /approve, /reject, /quota, /reset-mode, /codex |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/credential-proxy.ts` | Proxy that injects API credentials into containers (OAuth auto-refresh) |
| `src/remote-control.ts` | Spawns `claude -p` sessions from Telegram, returns Remote Control URL |
| `src/auto-pause.ts` | Consecutive failure tracking, group-level pause with CEO escalation |
| `src/task-planner.ts` | Parallelization safety (observability only — worktree isolation is primary) |
| `src/task-scheduler.ts` | Runs scheduled tasks, M2 graduation evaluation |
| `src/db.ts` | SQLite operations |
| `host/host-executor.py` | VPS host bridge: watches pending tasks, runs `claude -p`, auto-pushes commits |
| `mission-control/server.cjs` | CEO glance dashboard (server-rendered HTML, basic auth, auto-refresh) |
| `git-sync.sh` | VPS sync: pull updates, restart services on changes |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/agent-runner/src/governance/` | Governance module: quota, tier-gate, canary, audit, response interceptor |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Telegram Commands

Handled mechanically in `src/commands.ts` — no LLM, no container, instant response.

| Command | Purpose |
|---------|---------|
| `/pause [taskId]` | Pause a scheduled task or all autonomous work |
| `/resume [taskId\|groupName]` | Resume paused task or auto-paused group |
| `/status` | Show task queue, graduation tier, quota usage, auto-pause state |
| `/approve [taskId]` | Approve a pending task in the approval queue |
| `/reject [taskId]` | Reject a pending task |
| `/quota` | Show quota usage breakdown (weighted units, model split, throttle state) |
| `/reset-mode` | Reset mode from paused/maintenance back to active |
| `/codex [on\|off]` | Toggle Codex delegation (on) or Claude subagents (off) |

## Governance Module (container/agent-runner/src/governance/)

Injected into every container session. Components:

- **Tier Gate** (`tier-gate.ts`): Maps graduation tier to available tools.
- **Quota** (`quota.ts`): Self-calibrating usage tracking. Model weights: haiku=0.1, sonnet=1.0, opus=5.0. Starts at 1000 weighted units/day estimate, adjusts from 429 responses.
- **Response Interceptor** (`response-interceptor.ts`): Haiku-based quality check on CEO-facing Telegram messages before delivery.
- **Canary** (`canary.ts`): Constitution validation at session start.
- **Audit** (`audit.ts`): Logs tool calls, governance events, post-task analysis.
- **Learning** (`learning.ts`): Post-task analysis for graduation credit.

## Host Executor (host/host-executor.py)

Runs on VPS host (not containerized). Watches `~/.atlas/host-tasks/pending/` for task JSON. Runs `claude -p` with tier-appropriate flags (Tier 2+ uses `--worktree`). Auto-pushes commits. Includes M2 graduation evaluation and self-healing for auth/outage failures. Systemd: `atlas-host-executor.service`.

## Mission Control (mission-control/server.cjs)

Single-file CEO dashboard. Server-rendered HTML, dark theme, auto-refresh 10s. Shows conversation pairs with status icons, escalations, graduation progress. Auth via `MISSION_CONTROL_USER`/`MISSION_CONTROL_PASS` env vars. Port: `MC_PORT` (default 8080).

## Safety Features

- **Auto-pause** (`src/auto-pause.ts`): Tracks consecutive failures per group. After threshold, pauses group and sends CEO Telegram alert. `/resume` clears.
- **Worktree isolation**: Tier 2+ tasks get isolated git worktrees. Branches merged back after completion.
- **Passive monitoring**: Staff group conversations evaluated after each exchange — surfaces approval needs, blockers, risks, wins for CEO.
- **Mechanical acks**: Valid Telegram messages get instant receive confirmation before container spawn. Denied senders get rejection messages.
- **Escalation alerts**: Staff containers write escalation files + IPC to atlas_main. CEO gets Telegram alert. File watcher as backup path.

## Group Architecture

Groups live in `groups/{name}/`. Each has `CLAUDE.md` (isolated memory) and `config.json`.

Shared workspaces (`~/.atlas/shared/`) provide cross-group coordination:
- Departments: marketing, operations, property-management, field-ops, executive
- Each has: `directives/` (CEO RO), `updates/` (staff RW), `briefs/` (CEO RO), `escalations/` (staff RW)

Self-knowledge (`~/.atlas/atlas-self-knowledge.md`) injected into container system prompts alongside global and group CLAUDE.md files.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

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

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
