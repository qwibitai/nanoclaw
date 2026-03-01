# Sovereign (NanoClaw Fork)

Personal Claude assistant framework. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Discord/WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory. Forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp channel |
| `src/channels/discord.ts` | Discord channel |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/updatebot` | Check 3am update, apply new configs, health check bots |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## VPS & Infrastructure

- **Primary (hz):** `ssh hz` — 46.225.126.49 (Hetzner Nuremberg, 4GB RAM, 2 vCPU)
- **Source:** `/root/nanoclaw-src/` (deployed via systemd `nanoclaw.service`)
- **Docker image:** `nanoclaw-agent:latest` (2.61GB)
- **DB:** `store/messages.db` (NOT `data/nanoclaw.db`)
- **Auth:** OpenRouter via `ANTHROPIC_BASE_URL=https://openrouter.ai/api`
- **Discord bot:** AdamLoveAI#7931
- **Cloudflare Tunnel:** adamloveai.com
- **Weekly update cron:** Sundays 4am SGT — `/root/scripts/update-nanoclaw.sh`

**Key VPS paths:**
- Agent workspace: `groups/main/` (Adam Love identity + memory)
- Container sessions: `data/sessions/main/.claude`
- Host scripts: `/root/scripts/`
- Cloudflared: `/etc/cloudflared/config.yml`

**Infrastructure rules:**
- Always use `ssh hz` (not old aliases)
- Check RAM/disk before Docker builds
- Never pass private keys over SSH stdout
- Docker env vars must be in BOTH docker-compose.yml AND `.env`
- NEVER add unknown keys to config — causes crash loops

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

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
