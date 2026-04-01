# NanoClaw Specification

Personal Claude assistant. Single Node.js process, channel-based messaging, container-isolated agent execution.

## Architecture

```
Channels → SQLite → Message Loop → Container (Claude Agent SDK) → IPC → Response
```

Three polling loops run concurrently:
- **Message loop** (2s) — polls for unprocessed messages, dispatches to containers
- **Task scheduler** (60s) — checks for due scheduled tasks, spawns containers
- **IPC watcher** (1s) — reads container output from filesystem, routes to channels

## Message Processing

Messages have a `processed` flag in SQLite. The message loop queries for `processed = 0`, groups by chat, and either pipes to an active container (via IPC) or enqueues a new container spawn. Messages are marked `processed = 1` before container execution to prevent concurrent container races. On error without output, they're rolled back to `processed = 0` for retry.

Bot messages are born with `processed = 1`. Non-triggered messages in non-main groups are marked processed immediately.

## IPC Protocol

Containers communicate with the host via a unified `queue/` directory:

```
data/ipc/{groupFolder}/queue/*.json        # flat path
data/ipc/{groupFolder}/{threadId}/queue/*.json  # threaded path
```

Each JSON file has a `type` field dispatched by `processQueueFile()`:
- `message` — send text to user
- `send_files` — send files to user
- `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `update_task` — task CRUD
- `register_group`, `refresh_groups` — group management
- `watch_pr`, `unwatch_pr` — PR watching (registered by pr-watcher module)

Legacy per-type directories (`messages/`, `tasks/`, `files/`, `prs/`) are still read for backward compatibility with deprecation warnings.

External modules can register custom IPC types via `registerIpcHandler(type, handler)`.

## Channel System

Channels self-register at startup via factory pattern in `src/channels/registry.ts`. Each channel skill adds a file to `src/channels/` that calls `registerChannel()` at module load. Factories return `null` if credentials are missing — the channel is silently skipped.

## Optional Features

Optional features self-register via `src/features/index.ts` (barrel import pattern, same as channels):
- **PR Watcher** (`src/pr-watcher.ts`) — polls GitHub for new PR comments, spawns containers to respond. Activates only if `gh auth status` succeeds. Registers its own IPC handlers (`watch_pr`, `unwatch_pr`).

## Container Execution

Each agent runs in an isolated Docker container with:
- `/workspace/group` — group folder (read-write)
- `/workspace/global` — global CLAUDE.md (read-only, non-main only)
- `/workspace/ipc` — IPC directory (read-write)
- `/home/node/.claude` — per-group session, settings, skills

Settings default to `model: "opusplan"` (Opus for planning, Sonnet for execution).

Container concurrency: `MAX_CONCURRENT_CONTAINERS` (default 5) global, `MAX_CONTAINERS_PER_GROUP` (default 3) per group.

## Scheduled Tasks

SQLite `scheduled_tasks` table. Types: `cron`, `interval`, `once`. Each run spawns a container. `context_mode: 'group'` shares the group's session; `'isolated'` starts fresh.

## Auto-Deploy

A systemd timer polls GitHub every 2 minutes for new commits on `main`. When changes are detected:

1. `git pull --ff-only` (aborts if not fast-forward)
2. `npm install && npm run build`
3. `./container/build.sh` (rebuild agent image)
4. Notify active groups via IPC
5. Wait up to 5 min for active containers to finish
6. `systemctl restart nanoclaw`

Files: `deploy/auto-deploy.sh`, `deploy/nanoclaw-deploy.timer`, `deploy/nanoclaw-deploy.service`. Lock file at `/tmp/nanoclaw-deploy.lock` prevents concurrent deploys. Logs to `logs/auto-deploy.log`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: message loop, container dispatch |
| `src/channels/registry.ts` | Channel self-registration |
| `src/features/index.ts` | Optional feature self-registration |
| `src/ipc.ts` | IPC watcher, queue dispatcher, handler registry |
| `src/router.ts` | Message formatting, channel routing |
| `src/group-queue.ts` | Per-group queue with concurrency control |
| `src/container-runner.ts` | Container spawning, mount setup |
| `src/task-scheduler.ts` | Scheduled task polling and execution |
| `src/pr-watcher.ts` | GitHub PR comment polling (optional) |
| `src/db.ts` | SQLite schema, queries, migrations |
| `src/config.ts` | Constants and environment config |
| `container/agent-runner/src/index.ts` | In-container agent entry point |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tool server for IPC |
| `deploy/auto-deploy.sh` | Auto-deploy: pull, rebuild, restart |
| `deploy/nanoclaw-deploy.timer` | Systemd timer (2-min poll) |

## Database Tables

- `messages` — chat messages with `processed` flag
- `chats` — chat metadata
- `registered_groups` — group config (folder, trigger, container config)
- `sessions` — per-group Claude session IDs
- `scheduled_tasks` — task definitions and scheduling
- `task_run_logs` — execution history
- `thread_contexts` — Discord thread tracking
- `watched_prs` — PR watch state
- `router_state` — key-value store for misc state

## Configuration

Constants in `src/config.ts`. Key settings:

- `ASSISTANT_NAME` — trigger word (env: `ASSISTANT_NAME`, default: `Andy`)
- `POLL_INTERVAL` — message loop interval (2000ms)
- `CONTAINER_IMAGE` — Docker image name (default: `nanoclaw-agent:latest`)
- `CONTAINER_TIMEOUT` — max container runtime (default: 30min)
- `MAX_CONCURRENT_CONTAINERS` — global concurrency (default: 5)
