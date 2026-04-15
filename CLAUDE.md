# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with a skill-based channel system.

- The current default runtime is `tmux` host execution, not container isolation.
- The runtime abstraction lives in `src/runtime-adapter.ts`.
- Channel support is installation-specific; the repo currently includes Telegram core code and expects other channels to arrive via skills or downstream forks.
- Session lifecycle commands `/compact` and `/clear` are already in core.
- The process now exposes `GET /skills` and `GET /health` from the skill server.

## Key Files

| File                       | Purpose                                               |
| -------------------------- | ----------------------------------------------------- |
| `src/index.ts`             | Orchestrator: state, message loop, agent invocation   |
| `src/channels/registry.ts` | Channel registry (self-registration at startup)       |
| `src/ipc.ts`               | IPC watcher and task processing                       |
| `src/router.ts`            | Message formatting and outbound routing               |
| `src/config.ts`            | Trigger pattern, paths, intervals                     |
| `src/runtime-adapter.ts`   | Runtime descriptor and tmux adapter                   |
| `src/container-runner.ts`  | Spawns tmux-backed agent sessions with mounts         |
| `src/task-scheduler.ts`    | Runs scheduled tasks                                  |
| `src/dispatch-pool.ts`     | Dispatch slot lifecycle, recovery, and drain behavior |
| `src/service-health.ts`    | Builds the `/health` payload                          |
| `src/db.ts`                | SQLite operations                                     |
| `groups/{name}/CLAUDE.md`  | Per-group memory (isolated)                           |

## Skills

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration    |
| `/customize`        | Adding channels, integrations, changing behavior                  |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install         |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build:core   # Compile the main service
npm run build:agent-runner
npm run smoke:runtime
npm run smoke:health
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

Use [docs/SETUP_RECOVERY.md](docs/SETUP_RECOVERY.md) first.

**WhatsApp not connecting after upgrade:** WhatsApp is a downstream channel path, not bundled in the current core. Reapply the relevant channel skill or downstream fork and re-run validation.

## Parallel Dispatch Metrics Gate

Parallel dispatch (4 concurrent worker slots) is gated behind a notification metrics check at startup. The gate queries Agency HQ's `/notifications/metrics/gate` endpoint and requires all three conditions to pass:

1. **≥3 distinct agents** — at least 3 non-test target agents in the notification history
2. **≥7 calendar days** — notifications span at least 7 calendar days
3. **No test rows** — no test-seeded agent names present in the database

If any condition fails, NanoClaw runs in sequential single-worker mode. The fail reason and stats are logged at startup.

**Override with `DISPATCH_PARALLEL` env var:**

| Value     | Behavior                                                     |
| --------- | ------------------------------------------------------------ |
| `true`    | Force-enable parallel dispatch, bypassing the metrics gate   |
| `false`   | Kill switch: force sequential mode regardless of gate result |
| _(unset)_ | Automatic: metrics gate decides                              |

## Recovering from dispatch_blocked_until

When a task fails to dispatch 3 consecutive times, the dispatch loop sets `dispatch_blocked_until` to 24 hours in the future via a PUT to Agency HQ (`/api/v1/tasks/:id` with `status: 'blocked'` and `dispatch_blocked_until: <ISO timestamp>`). The task will not be retried until that timestamp passes.

To unblock a task manually:

```sql
-- In Agency HQ's PostgreSQL database:
UPDATE tasks SET dispatch_blocked_until = NULL, status = 'ready' WHERE id = '<task-id>';
```

There is no dedicated API endpoint for clearing the block — manual SQL against Agency HQ's `tasks` table is required. After clearing, the task will be picked up on the next dispatch loop tick.

The in-memory retry counter (`dispatchRetryCount` in `src/dispatch-loop.ts`) resets on process restart, so restarting NanoClaw also clears the local retry state (but does not clear `dispatch_blocked_until` in Agency HQ — you must clear that separately).

## Container Build Cache

Historical note: container build cache guidance only matters for experimental or historical runtime work. It is not part of the current default tmux runtime.
