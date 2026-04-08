# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to **Qwen Code CLI** (`qwen`) running directly on the host. Each group has an isolated filesystem under `groups/{folder}/`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/qwen-runner.ts` | Spawns Qwen CLI agent, parses stream-json output |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/group-queue.ts` | Per-group concurrency and retry with backoff |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/credential-proxy.ts` | HTTP proxy that injects API credentials for containers |
| `src/sender-allowlist.ts` | Per-group sender filtering (allowlist/blocklist) |
| `src/mount-security.ts` | Validates additional container mounts against allowlist |
| `src/types.ts` | All shared interfaces (Channel, RegisteredGroup, etc.) |
| `groups/{name}/CLAUDE.md` | Per-group agent memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emitting
npm test             # Run all tests (vitest)
npx vitest run src/foo.test.ts  # Run a single test file
./container/build.sh # Rebuild agent container
```

Set `LOG_LEVEL=debug` to enable verbose logging.

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

## Architecture

### Message Flow
1. Channel receives inbound message → `storeMessage()` to SQLite
2. Message loop polls SQLite every 2s → checks for new messages per registered group
3. Non-main groups require a trigger (`@AssistantName` or custom) before processing
4. `GroupQueue` serializes agent invocations per group; piped messages go to active processes via IPC files
5. `runContainerAgent()` in `qwen-runner.ts` spawns `qwen --output-format stream-json --approval-mode yolo --cwd groups/{folder}/`; result parsed from `{"type":"result",...}` stream-json event
6. Agent replies are sent back via the channel's `sendMessage()`

### Groups
- **Main group** (`isMain: true`): no trigger required, elevated privileges (sees project root read-only + IPC)
- **Non-main groups**: trigger required by default; isolated filesystem at `groups/{folder}/`
- Group folders live under `groups/` and are referenced by name (`folder` field). Valid folder names: alphanumeric + hyphens, no path traversal
- CLAUDE.md is copied from `groups/main/CLAUDE.md` or `groups/global/CLAUDE.md` template on first registration

### Agent Backend (Qwen)
- Qwen Code CLI (`/opt/homebrew/bin/qwen`) is the agent — no containers or credential proxy needed
- Sessions resumed via `--resume <sessionId>`; `session_id` comes from the `{"type":"result",...}` stream-json event
- Qwen auth managed by `~/.qwen/oauth_creds.json`; settings at `.qwen/settings.json`
- IPC MCP server (schedule_task, registerGroup, etc.) is **not yet wired** for qwen — agents respond but can't call back to the host
- Sender allowlist config at `~/.config/nanoclaw/sender-allowlist.json`

### IPC
Containers write commands to `data/ipc/{groupFolder}/` JSON files; the host IPC watcher polls these and dispatches to `sendMessage`, `registerGroup`, task CRUD, etc.
Follow-up messages from the message loop are delivered to active containers via `data/ipc/{groupFolder}/input/` files.

### Database
SQLite at `store/messages.db`. Schema migrations are inline in `db.ts` (`ALTER TABLE … ADD COLUMN` with try/catch). Tables: `messages`, `chats`, `sessions`, `registered_groups`, `router_state`, `scheduled_tasks`, `task_run_logs`.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Gotcha: Channel Barrel File

`src/channels/index.ts` has **all channel imports commented out** by default. If a channel skill is installed, its import line must be explicitly present (e.g. `import './telegram.js'`). A missing import causes `FATAL: No channels connected` at startup — this can happen silently after an upstream merge if the merge resets the file.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
