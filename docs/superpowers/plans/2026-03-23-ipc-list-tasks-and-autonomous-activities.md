# IPC-based list_tasks and Autonomous Activities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the file-snapshot `list_tasks` with an IPC request-response that reads from the DB, then have the bot set up 6 autonomous activity tasks.

**Architecture:** Container writes a `list_tasks` request to the IPC queue, host reads tasks from SQLite, writes response to the container's input dir. Container polls for the response file. After deploying, the bot creates its own scheduled tasks via Discord.

**Tech Stack:** TypeScript, better-sqlite3, MCP SDK, vitest

**Spec:** `docs/superpowers/specs/2026-03-23-ipc-list-tasks-and-autonomous-activities-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/ipc.ts` | Modify | Add `list_tasks` handler in `processQueueFile` switch |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modify | Rewrite `list_tasks` tool: IPC request-response |
| `src/container-runner.ts` | Modify | Remove `writeTasksSnapshot()` function |
| `src/index.ts` | Modify | Remove snapshot callers, pre-create block, gut `onTasksChanged` body |
| `src/task-scheduler.ts` | Modify | Remove `writeTasksSnapshot` call |

---

### Task 1: Add list_tasks IPC handler on host side

**Files:**
- Modify: `src/ipc.ts` (add case in `processQueueFile` switch, ~line 404)

- [ ] **Step 1: Read the current processQueueFile switch to understand the pattern**

The switch at `src/ipc.ts:404` handles `message`, `send_files`, then a block of task types guarded by `if (!threadId)`. The `list_tasks` handler must be a **standalone case** BEFORE the guarded block, since it needs to work from threaded containers.

- [ ] **Step 2: Add the list_tasks case**

In `src/ipc.ts`, in the `processQueueFile` function's switch statement (after the `send_files` case at line 426, before the `schedule_task` case at line 427), add:

```typescript
    case 'list_tasks': {
      const requestId = data.requestId as string;
      if (!requestId) break;

      const allTasks = getAllTasks();
      const filtered = isMain
        ? allTasks
        : allTasks.filter((t) => t.group_folder === sourceGroup);

      const response = filtered.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));

      const responseFile = path.join(
        basePath,
        'input',
        `list_tasks-${requestId}.json`,
      );
      const tempFile = `${responseFile}.tmp`;
      fs.mkdirSync(path.join(basePath, 'input'), { recursive: true });
      fs.writeFileSync(tempFile, JSON.stringify(response));
      fs.renameSync(tempFile, responseFile);
      break;
    }
```

Also add `getAllTasks` to the existing `db.js` import at the top of `src/ipc.ts` (it's not currently imported). Add it alongside the existing imports:

```typescript
import {
  createTask,
  createThreadContext,
  deleteTask,
  getAllTasks, // ADD THIS
  getTaskById,
  // ... rest of existing imports
} from './db.js';
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts
git commit -m "feat: add list_tasks IPC handler — reads tasks from DB"
```

---

### Task 2: Rewrite container list_tasks to use IPC request-response

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (~lines 155-191)

- [ ] **Step 1: Replace the list_tasks tool handler**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, replace the entire `list_tasks` server.tool block (lines 155-191) with:

```typescript
server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    try {
      // Write IPC request
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(QUEUE_DIR, {
        type: 'list_tasks',
        requestId,
        groupFolder,
        isMain: String(isMain),
        timestamp: new Date().toISOString(),
      });

      // Poll for response
      const inputDir = path.join(IPC_DIR, 'input');
      const responseFile = path.join(inputDir, `list_tasks-${requestId}.json`);
      const timeout = 5000;
      const pollInterval = 100;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          const tasks = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          // Clean up response file
          try { fs.unlinkSync(responseFile); } catch { /* ignore */ }

          // Host already filtered by group — no need to re-filter here

          if (tasks.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
          }

          const formatted = tasks
            .map(
              (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
            )
            .join('\n');

          return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Timed out waiting for task list from host. Try again.' }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error listing tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: list_tasks uses IPC request-response instead of file snapshot"
```

---

### Task 3: Remove writeTasksSnapshot and all callers

**Files:**
- Modify: `src/container-runner.ts` (remove `writeTasksSnapshot` function)
- Modify: `src/index.ts` (remove callers, pre-create block, gut `onTasksChanged`)
- Modify: `src/task-scheduler.ts` (remove caller)

- [ ] **Step 1: Remove writeTasksSnapshot from container-runner.ts**

In `src/container-runner.ts`, find the `writeTasksSnapshot` function (starts with `export function writeTasksSnapshot(` around line 858) and delete the entire function through to its closing brace.

Also remove it from the export if it's in a named export block.

- [ ] **Step 2: Remove writeTasksSnapshot import and calls from index.ts**

In `src/index.ts`:

1. Remove `writeTasksSnapshot` from the import at line 25:
```typescript
// Remove writeTasksSnapshot from this import:
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,  // DELETE THIS LINE
} from './container-runner.js';
```

2. Remove the pre-create thread IPC dir block and the writeTasksSnapshot call in `runAgent` (around lines 438-458). Find and delete:
```typescript
  // Pre-create thread IPC dir so the snapshot propagation loop can find it.
  // buildVolumeMounts creates this later, but writeTasksSnapshot needs it now.
  if (threadId) {
    const threadIpcDir = path.join(DATA_DIR, 'ipc', group.folder, threadId);
    fs.mkdirSync(threadIpcDir, { recursive: true });
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );
```

3. Gut the `onTasksChanged` callback body (around lines 987-1001). Replace the snapshot-writing logic with an empty body:
```typescript
    onTasksChanged: () => {
      // Tasks are now read via IPC request-response (list_tasks handler).
      // No snapshot propagation needed.
    },
```

4. Remove `getAllTasks` from the `db.js` import at the top of index.ts — after the above removals it is no longer used anywhere in the file.

- [ ] **Step 3: Remove writeTasksSnapshot import and call from task-scheduler.ts**

In `src/task-scheduler.ts`:

1. Remove `writeTasksSnapshot` from the import (line 15):
```typescript
// Remove writeTasksSnapshot from this import
import {
  writeTasksSnapshot,  // DELETE THIS LINE
  ...
} from './container-runner.js';
```

2. Remove the snapshot write block (around lines 146-162). Find and delete:
```typescript
  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );
```

3. Remove `getAllTasks` from the `db.js` import in task-scheduler.ts — after the snapshot block removal it is no longer used in the file.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no remaining references to `writeTasksSnapshot`

- [ ] **Step 5: Verify no stale references**

```bash
grep -r "writeTasksSnapshot" src/ --include="*.ts"
grep -r "current_tasks.json" src/ --include="*.ts"
```

Expected: No matches in src/ (may still appear in container/agent-runner which we updated in Task 2).

Also check container side:
```bash
grep -r "current_tasks.json" container/ --include="*.ts"
```
Expected: No matches (the old file read was removed in Task 2).

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS (pre-existing discord.test.ts failures are unrelated)

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts src/index.ts src/task-scheduler.ts
git commit -m "refactor: remove writeTasksSnapshot — list_tasks now uses IPC"
```

---

### Task 4: Build, deploy, and verify

**Files:**
- No code changes — build, restart, test

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 2: Rebuild container image**

Run: `./container/build.sh`
Expected: Successful build (the container agent-runner code changed)

- [ ] **Step 3: Restart the service**

Run: `systemctl restart nanoclaw`

- [ ] **Step 4: Verify startup**

Run: `sleep 5 && tail -10 /root/nanoclaw/logs/nanoclaw.log`
Expected: NanoClaw running, Discord bot connected

- [ ] **Step 5: Test list_tasks via Discord**

Send `@Jarvis list your scheduled tasks` in Discord #general.
Expected: Bot responds with a list of 14+ tasks (not "No scheduled tasks found").

- [ ] **Step 6: Commit any fixes**

If Step 5 reveals issues, fix and commit.

- [ ] **Step 7: Push**

```bash
git push origin main
```

---

### Task 5: Set up autonomous activity tasks via Discord

**Files:**
- No code changes — operational setup via Discord message

- [ ] **Step 1: Send setup message to bot**

Send the following message to the bot in Discord #general:

```
@Jarvis I want you to set up 6 new autonomous activity tasks. Before you start, run list_tasks to see what already exists — don't duplicate anything.

Create these scheduled tasks (all isolated context mode, all should only send a message if there's something actionable):

1. think-loop (0 */4 * * *) — Reflect on recent conversations, identify open threads, plan next actions. Silent unless you have something actionable to report.

2. pm-loop (0 */6 * * *) — Check Linear for stale or blocked issues. Run list_tasks first to see what's already being tracked. Only message if something needs attention.

3. activity-orchestrator (0 */8 * * *) — Review conversation context, Linear state, open PRs. Run list_tasks before doing anything. You may spawn up to 2 one-shot tasks per run for specific actions. Never duplicate existing tasks.

4. cleanup-sweep (0 2 * * *) — Run list_tasks, review all tasks. Cancel any that are stale (>7 days old and not recently useful), duplicated, or broken. Report what you cleaned up.

5. purrogue-watcher (0 */12 * * *) — Check the purrogue GitHub repo for new issues, PRs, or activity. Silent unless something needs attention.

6. skill-scout (0 10 * * *) — Review recent conversations for patterns — recurring manual tasks that could become a skill. Only message if you find a good candidate.
```

- [ ] **Step 2: Verify bot creates the tasks**

Wait for the bot to respond. It should call `list_tasks` (which now works via IPC), see the existing 14 tasks, then call `schedule_task` 6 times.

- [ ] **Step 3: Verify tasks appear in list**

Send `@Jarvis list your scheduled tasks` again.
Expected: 20+ tasks (14 existing + 6 new).
