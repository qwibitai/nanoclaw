# IPC-based list_tasks and Autonomous Activity System

**Date:** 2026-03-23
**Status:** Proposed

## Problem

1. **list_tasks is broken for threaded containers.** The `list_tasks` MCP tool reads from a `current_tasks.json` file snapshot that the host writes before spawning containers. For threaded containers (`ctx-{id}`), the snapshot is written before the thread IPC directory exists, so the container sees "no tasks." A timing fix (pre-creating the dir) is deployed but the snapshot pattern is fragile — it's the only read operation still using file-based snapshots while every write operation (schedule, cancel, pause, resume, update) uses IPC request-response via the DB.

2. **The bot can't bootstrap autonomous activities without list_tasks.** When asked to set up recurring autonomous tasks, the bot called `list_tasks`, got an empty result, and proposed from scratch — missing the 14 tasks already configured. With `list_tasks` working, the bot can see existing tasks and build on them.

## Design

### Part 1: IPC-based list_tasks

Replace the file snapshot read with an IPC request-response pattern.

#### Container side

In `container/agent-runner/src/ipc-mcp-stdio.ts`, the `list_tasks` tool handler changes from reading `current_tasks.json` to:

1. Generate a `requestId` (e.g., `Date.now()-random`)
2. Write `{"type": "list_tasks", "requestId": "{requestId}", "groupFolder": "{groupFolder}", "isMain": "{isMain}"}` to the IPC queue directory
3. Poll `input/` directory for a response file named `list_tasks-{requestId}.json`
4. Timeout after 5 seconds — return error message if no response
5. Parse response JSON and return formatted task list

Poll interval: 100ms. The IPC watcher runs every ~1s, so typical response time is 1-2s.

#### Host side

In `src/ipc.ts`, add a handler for `type: 'list_tasks'` as a **standalone case in `processQueueFile`'s switch statement**. It must NOT go inside the `processTaskIpc` function or the existing task-type case block — those are guarded by `if (!threadId)`, which would silently drop `list_tasks` requests from threaded containers (exactly the scenario we're fixing).

1. Read `getAllTasks()` from SQLite (returns `ScheduledTask[]` from `src/db.ts`)
2. Filter: derive group identity from `sourceGroup` (the IPC directory path, same as other handlers). Main group sees all tasks, non-main sees only tasks where `group_folder` matches `sourceGroup`
3. Map `group_folder` to `groupFolder` and format to: `{id, groupFolder, prompt, schedule_type, schedule_value, status, next_run}`
4. Write response to `{basePath}/input/list_tasks-{requestId}.json` where `basePath` is the resolved IPC directory (already handles thread vs non-thread — `data/ipc/{sourceGroup}/{threadId}/` or `data/ipc/{sourceGroup}/`)

The `groupFolder` and `isMain` fields in the container's request payload are informational/logging only — the host derives identity from the filesystem path, same as all other IPC handlers.

The response file is written atomically (`.tmp` → rename) to prevent partial reads.

#### Cleanup after response

The container deletes the response file after reading it. If the container dies before cleanup, orphaned response files in `input/` are harmless — the existing input file processing in the container already ignores unknown file formats.

#### Removals

- `writeTasksSnapshot()` function in `container-runner.ts`
- All callers of `writeTasksSnapshot`: `runAgent` in `index.ts`, pre-task-run in `task-scheduler.ts`
- The `onTasksChanged` callback body in `index.ts` (which calls `writeTasksSnapshot` for all groups) — gut the snapshot-writing logic but keep the `onTasksChanged` property in the `IpcDeps` interface and call sites. Other future uses may need the hook. The body becomes a no-op or is used only for `writeGroupsSnapshot` if that's still called there.
- The `current_tasks.json` files are no longer written
- The pre-create thread IPC dir block added in the timing fix (`index.ts`) can be removed — `buildVolumeMounts` already creates the thread IPC dir, and `list_tasks` no longer depends on a pre-existing snapshot

#### Kept

- `writeGroupsSnapshot()` and `available_groups.json` — separate concern, not changed
- All task write operations (schedule, cancel, etc.) — unchanged, already IPC-based

#### Files changed

| File | Change |
|------|--------|
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Rewrite `list_tasks` tool: IPC request-response instead of file read |
| `src/ipc.ts` | Add `list_tasks` handler in `processQueueFile` |
| `src/container-runner.ts` | Remove `writeTasksSnapshot()` function |
| `src/index.ts` | Remove `writeTasksSnapshot` calls from `runAgent`, remove pre-create IPC dir block, remove `onTasksChanged` snapshot propagation |
| `src/task-scheduler.ts` | Remove `writeTasksSnapshot` call from pre-task-run |

### Part 2: Autonomous Activity System

No new code. The bot creates 6 scheduled tasks via the existing `schedule_task` MCP tool. This is triggered by sending the bot a message with the setup instructions.

#### Tasks to create

All tasks use `context_mode: 'isolated'` and include "only send a message if there's something actionable" in their prompts to avoid noise.

| Task | Schedule | Purpose |
|------|----------|---------|
| think-loop | Every 4 hours (`0 */4 * * *`) | Reflection + planning. Reviews recent conversations, identifies open threads, plans next actions. Silent unless actionable. |
| pm-loop | Every 6 hours (`0 */6 * * *`) | Scans Linear for stale/blocked issues, flags anything urgent. Uses `list_tasks` to avoid duplicating existing work. |
| activity-orchestrator | Every 8 hours (`0 */8 * * *`) | Reviews conversation context, Linear state, open PRs. Spawns one-shot tasks for specific actions. Must call `list_tasks` before creating new tasks. |
| cleanup-sweep | Daily 2am (`0 2 * * *`) | Lists all tasks via `list_tasks`, cancels anything stale (>7 days old, not recently useful). Prevents runaway task proliferation. |
| purrogue-watcher | Every 12 hours (`0 */12 * * *`) | Monitors purrogue repo for new issues/PRs. Silent unless something needs attention. |
| skill-scout | Daily (`0 10 * * *`) | Checks for recurring tasks the bot does manually that could become a skill. Reviews recent conversations for patterns. |

#### Intervals are conservative

Start with longer intervals. The activity-orchestrator can tighten them based on what proves useful — it has access to `update_task` to modify schedules.

#### Delivery

After Part 1 is deployed, send the bot a message in Discord with the setup instructions. The bot creates the tasks itself using `schedule_task`. No code change needed.

## Risk

- **Part 1 blast radius:** Touches IPC handler, container MCP tool, and removes snapshot callers. Moderate — but the snapshot system is well-understood and the replacement follows existing IPC patterns.
- **Part 1 timeout:** If the host IPC watcher is slow (>5s), `list_tasks` returns an error. Mitigation: 5s timeout is generous given the watcher polls every ~1s.
- **Part 2 container load:** 6 new tasks on top of 14 existing ones. Conservative intervals (4-12h) mean at most 1-2 extra containers per hour. Well within `MAX_CONCURRENT_CONTAINERS=5` with priority preemption.
- **Part 2 task proliferation:** The activity-orchestrator can spawn tasks, and cleanup-sweep reaps them. If cleanup-sweep itself fails, tasks accumulate. Mitigation: cleanup-sweep is a cron task that runs daily — if it fails, the scheduler retries. The orchestrator's prompt limits it to spawning at most 2 one-shot tasks per run.
