# CodeClaw

GitHub AI coding agent. See [README.md](README.md) for setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that receives GitHub webhooks, routes events to Claude Agent SDK running in containers (Linux VMs). Each repo gets isolated filesystem and memory. Agents respond via the GitHub API (comments, reviews, PRs).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: webhook handling, repo checkout, agent invocation |
| `src/webhook-server.ts` | HTTP server for GitHub webhooks |
| `src/channels/github.ts` | GitHub channel: post comments, reviews, PRs via Octokit |
| `src/github/auth.ts` | GitHub App JWT auth + installation token caching |
| `src/github/event-mapper.ts` | Webhook payload → normalized messages |
| `src/github/access-control.ts` | Permission checking + rate limiting |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Paths, intervals, container config |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, GitHub App creation, service configuration |
| `/customize` | Adding integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream changes, merge with customizations, run migrations |

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
launchctl load ~/Library/LaunchAgents/com.codeclaw.plist
launchctl unload ~/Library/LaunchAgents/com.codeclaw.plist
launchctl kickstart -k gui/$(id -u)/com.codeclaw  # restart

# Linux (systemd)
systemctl --user start codeclaw
systemctl --user stop codeclaw
systemctl --user restart codeclaw
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
