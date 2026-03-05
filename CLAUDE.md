# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

**This install:** Assistant name is **Homie**. Channel is Discord (bot: Homie#5609, channel `1468824513654423697`, guild `1468824512756973705`). Model provider is MiniMax via `ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic`. Two groups: `homie` (orchestrator, is_main) and `worker` (task execution). Orchestrator runs on a 5-minute heartbeat scheduler.

## Development Commands

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emitting
npm run format       # Format src/**/*.ts with prettier
npm test             # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
./container/build.sh # Rebuild agent container image
```

Run a single test file: `npx vitest run src/container-runner.test.ts`

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

```
Channel → SQLite → Poll loop (2s) → GroupQueue → Container (Claude Agent SDK) → IPC → Response
```

**Message flow:**
1. Channels deliver inbound messages via `onMessage` callback → stored in SQLite
2. `startMessageLoop` polls SQLite every 2s for new messages across all registered groups
3. If a trigger (`@Andy` by default) is detected, `GroupQueue.enqueueMessageCheck(jid)` is called
4. `GroupQueue` spawns a container (up to `MAX_CONCURRENT_CONTAINERS=5` at once) via `runContainerAgent`
5. Follow-up messages (while container is active) are piped via IPC files (`data/ipc/{group}/input/`)
6. Agent outputs stream back via `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` sentinels parsed from stdout
7. IPC watcher (`src/ipc.ts`) polls `data/ipc/{group}/messages/` and `data/ipc/{group}/tasks/` for agent-initiated actions

**Channel self-registration:** Each channel skill adds a file to `src/channels/` that calls `registerChannel(name, factory)` at module load time. `src/channels/index.ts` barrel-imports them all. The factory receives `ChannelOpts` and returns a `Channel` or `null` if credentials are missing.

**IPC authorization model:** Containers are namespace-isolated by group folder. Non-main groups can only write to their own `data/ipc/{group}/` directory. The main group can send to any JID and register new groups. `isMain` is verified from the directory path, never from the IPC payload itself.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/group-queue.ts` | Per-group queue with global concurrency limit |
| `src/config.ts` | Trigger pattern, paths, intervals, env vars |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Docker/Apple Container runtime abstraction |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/mount-security.ts` | Validates additional mounts against external allowlist |
| `src/group-folder.ts` | Path validation and traversal prevention for group folder names |
| `src/env.ts` | Custom `.env` parser — deliberately does NOT load into `process.env` to prevent secret leakage to child processes |
| `src/types.ts` | Shared interfaces (`Channel`, `RegisteredGroup`, `ScheduledTask`, etc.) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/agent-runner/src/index.ts` | Agent entrypoint inside container |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Data Directory Layout

```
data/
  ipc/{group}/
    messages/   # Agent → host outbound messages (JSON files, consumed by ipc.ts)
    tasks/      # Agent → host task operations (schedule, pause, cancel)
    input/      # Host → agent follow-up messages (JSON files, consumed inside container)
    current_tasks.json     # Tasks snapshot written before each container run
    available_groups.json  # Groups snapshot (main only sees all groups)
  sessions/{group}/
    .claude/    # Isolated Claude session state per group
      settings.json   # Agent flags (AGENT_TEAMS, AUTO_MEMORY, etc.)
      skills/         # Skills synced from container/skills/ at each run
    agent-runner-src/ # Per-group copy of agent-runner source (customizable)
store/          # SQLite database
groups/{name}/
  CLAUDE.md     # Group memory
  logs/         # Container run logs (written per container run)
```

## Container Mounts (per group)

| Host path | Container path | Access |
|-----------|---------------|--------|
| `groups/{folder}/` | `/workspace/group` | read-write |
| `groups/global/` | `/workspace/global` | read-only (non-main) |
| Project root | `/workspace/project` | read-only (main only) |
| `/dev/null` | `/workspace/project/.env` | shadows secrets |
| `data/sessions/{group}/.claude/` | `/home/node/.claude` | read-write |
| `data/sessions/{group}/agent-runner-src/` | `/app/src` | read-write |
| `data/ipc/{group}/` | `/workspace/ipc` | read-write |
| Additional mounts | `/workspace/extra/{name}` | allowlist-controlled |

Additional mounts are validated against `~/.config/nanoclaw/mount-allowlist.json` (outside project root, never mounted into containers — tamper-proof).

## Config / Environment Variables

Key `.env` values read at startup (see `src/config.ts`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `ASSISTANT_NAME` | `Andy` | Trigger word (`@Andy`) |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | When `true`, bot has its own phone number (changes trigger behavior) |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Agent container image |
| `CONTAINER_TIMEOUT` | `1800000` (30m) | Hard kill timeout |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10MB) | Max bytes captured from container stdout |
| `IDLE_TIMEOUT` | `1800000` (30m) | Close stdin after idle |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Global container concurrency |
| `LOG_LEVEL` | `info` | Pino log level |
| `TZ` | system timezone | Timezone for scheduled tasks (cron expressions) |

Secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, etc.) are read in `container-runner.ts` and passed via container stdin — never written to disk or visible in process env.

## Groups

| Folder | JID | is_main | Purpose |
|--------|-----|---------|---------|
| `homie` | `dc:1468824513654423697` | yes | Orchestrator — tick loop, task dispatch, Discord comms |
| `worker` | `worker-agent` | no | Task execution — spawned by orchestrator via IPC |

### Homie group layout
```
groups/homie/
  CLAUDE.md               # Orchestrator tick loop instructions
  bin/mc.ts               # Mission control CLI (standalone, node, --base-dir flag)
  workers/CLAUDE.md      # Worker agent instructions (path-adjusted for NanoClaw mounts)
  briefings/              # Daily briefings written by orchestrator
  mission-control/
    tasks/                # Task files (6 tasks)
    initiatives/          # Initiative files (2 initiatives)
    outputs/              # Task output files (4 outputs)
    activity.log.ndjson   # Audit log
    lock.json             # Worker lock (locked/unlocked)
```

### Container mounts for homie/worker
Both groups get `dirtsignals` (rw) and `groups/homie` (rw) as additional mounts at `/workspace/extra/`.

Workers access mission-control via:
```bash
node /workspace/extra/homie/bin/mc.ts --base-dir /workspace/extra/homie <resource> <command>
```

### Orchestrator heartbeat
```
id: heartbeat-5min  |  interval: 300000ms  |  context_mode: isolated
```

### Mount allowlist
`~/.config/nanoclaw/mount-allowlist.json` — two allowed roots: `~/Documents/dev/dirtsignals` and `~/Documents/dev/claws/NanoClaw/groups/homie`.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

**Container build cache:** The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

**Per-group agent-runner customization:** Each group gets its own copy of `container/agent-runner/src/` in `data/sessions/{group}/agent-runner-src/`. The copy is made once on first run; subsequent changes to `container/agent-runner/src/` are NOT automatically propagated. Delete the group's `agent-runner-src/` directory to reset.
