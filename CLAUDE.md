# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

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
| `src/group-queue.ts` | Per-group concurrency queue with global container limit |
| `src/types.ts` | Channel interface and shared types |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload (tsx watch)
npm run build        # Compile TypeScript → dist/
npm run start        # Run compiled version
npm run typecheck    # Type check without emitting
npm run format       # Format with prettier
npm run test         # Run tests once (vitest)
npm run test:watch   # Run tests in watch mode
npm run auth         # WhatsApp authentication setup
./container/build.sh # Rebuild agent container image
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

## Architecture: Message Flow

```
WhatsApp (Baileys) → SQLite (messages table)
                              ↓
                    Polling loop (src/index.ts, ~2s)
                              ↓
                    Per-group queue (src/group-queue.ts)
                    [global MAX_CONCURRENT_CONTAINERS limit]
                              ↓
                    Container spawn (src/container-runner.ts)
                    [per-group mounts, isolated session]
                              ↓
                    Claude Agent SDK (container/agent-runner/)
                    [reads IPC input, writes IPC output]
                              ↓
                    IPC watcher (src/ipc.ts)
                              ↓
                    Message router (src/router.ts) → WhatsApp
```

The orchestrator tracks two cursors per group: `lastTimestamp` (messages seen) and `lastAgentTimestamp` (messages processed by agent). On restart, unprocessed messages are recovered automatically.

## Key Patterns

**Cursor rollback**: If a container errors _before_ sending any output, the cursor rolls back so the message retries. If it errors _after_ sending output, the cursor advances to avoid duplicates.

**Session persistence**: Each group's Claude Agent SDK session ID is stored in SQLite and passed on every container invocation. Sessions are kept alive for 30 min (idle timeout) to avoid cold starts.

**Sentinel markers**: Container output is parsed via `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` markers. `<internal>...</internal>` blocks are stripped before sending to users.

**IPC namespaces**: Agent IPC lives at `data/ipc/{groupFolder}/` — per-group directories prevent cross-group access. Non-main groups can only write to their own namespace.

**Trigger rules**: Main group processes all messages. Other groups only wake on `@Andy` prefix (configurable via `TRIGGER_PATTERN`). All accumulated unread messages since last agent run are sent as context.

**Task snapshots**: Before each agent run, the current task list (filtered to the group's scope) is written into the container mount so the agent can query and schedule tasks.

## Security Model

- **Container isolation**: Agents run in containers (Apple Container on macOS, Docker elsewhere) — no host filesystem access
- **Per-group mounts**: Each group only sees its own folder plus a global read-only directory
- **Mount allowlist**: External file at `~/.config/nanoclaw/mount-allowlist.json` controls what extra paths can be mounted (not accessible from inside container)
- **Authorization**: Main group has admin powers (register groups, manage all tasks). Other groups are restricted to their own scope
- **Secrets**: Never written to disk — passed via stdin only

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
