---
name: add-script-tasks
description: Add script task support to NanoClaw. Script tasks run shell commands in a container on a schedule, without launching a Claude agent session. Useful for maintenance tasks like git pulls, backups, health checks. Supports config file seeding, chat agent creation, and notify controls.
---

# Add Script Tasks

Extends the NanoClaw scheduler with a `script` task type that runs a shell command inside a container on a schedule — no Claude agent session required. Useful for maintenance tasks like git pulls, backups, and health checks.

## What It Adds

- **`task_type: 'prompt' | 'script'`** on `ScheduledTask` — new field (DB migration included)
- **`notify: 'always' | 'on_error' | 'never'`** on all tasks — controls when results are forwarded to chat
- **`runContainerScript()`** in `container-runner.ts` — runs `sh -c <command>` in a container, reusing the same mounts as agent tasks
- **`~/.config/nanoclaw/script-tasks.json`** — optional static config file for defining recurring script tasks at startup (idempotent by `id`)
- **IPC support** — chat agents can create script tasks via `schedule_task` IPC with `task_type: "script"` and `command` fields

## Phase 1: Pre-flight

Check if already applied:

```bash
grep -q 'runContainerScript' src/container-runner.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

Make the following edits. Read each file before editing.

### 1. `src/types.ts` — Add `task_type` and `notify` to `ScheduledTask`

In the `ScheduledTask` interface, after the `context_mode` field, add:

```typescript
  /** 'prompt' runs a Claude agent session; 'script' runs a shell command in a container */
  task_type: 'prompt' | 'script';
  /** When to forward the result to chat */
  notify: 'always' | 'on_error' | 'never';
```

### 2. `src/config.ts` — Add `SCRIPT_TASKS_CONFIG_PATH`

After the `SENDER_ALLOWLIST_PATH` export, add:

```typescript
export const SCRIPT_TASKS_CONFIG_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'script-tasks.json',
);
```

### 3. `src/db.ts` — DB migration + createTask/updateTask updates

**3a.** In `createSchema()`, after the existing `context_mode` migration block (the `try { database.exec('ALTER TABLE scheduled_tasks ADD COLUMN context_mode...') }` block), add two new migration blocks:

```typescript
  // Add task_type column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN task_type TEXT DEFAULT 'prompt'`,
    );
  } catch {
    /* column already exists */
  }

  // Add notify column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN notify TEXT DEFAULT 'always'`,
    );
  } catch {
    /* column already exists */
  }
```

**3b.** In `createTask()`, update the INSERT statement to include the new columns:

Change:
```typescript
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
```

To:
```typescript
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, task_type, notify, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
```

And add the two new values after `context_mode`:
```typescript
    task.context_mode || 'isolated',
    task.task_type || 'prompt',
    task.notify || 'always',
    task.next_run,
```

**3c.** In `updateTask()`, add `notify` to the `Pick<ScheduledTask, ...>` union type:

```typescript
      | 'notify'
```

And add the handler in the body:
```typescript
  if (updates.notify !== undefined) {
    fields.push('notify = ?');
    values.push(updates.notify);
  }
```

### 4. `src/container-runner.ts` — Add entrypoint override + `runContainerScript`

**4a.** In `buildContainerArgs()`, add an optional `entrypointOverride` parameter:

Change the signature from:
```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
```

To:
```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  entrypointOverride?: string,
): string[] {
```

**4b.** In `buildContainerArgs()`, just before `args.push(CONTAINER_IMAGE)`, add the entrypoint override block:

```typescript
  if (entrypointOverride) {
    args.push('--entrypoint', entrypointOverride);
  }
```

**4c.** After the closing brace of `runContainerAgent()` (at the end of the file), add the new function:

```typescript
/**
 * Run a shell command in a container without a Claude agent session.
 * Reuses the same container image and mount configuration as agent tasks,
 * but overrides the entrypoint to `sh -c <command>`.
 * Stdout is returned as the result; exits with error on non-zero exit code.
 */
export async function runContainerScript(
  group: RegisteredGroup,
  command: string,
  isMain: boolean,
  onProcess: (proc: ChildProcess, containerName: string) => void,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-script-${safeName}-${Date.now()}`;
  // Override entrypoint to sh so we run the command directly, not the agent runner
  const containerArgs = [
    ...buildContainerArgs(mounts, containerName, 'sh'),
    '-c',
    command,
  ];

  logger.info(
    { group: group.name, containerName, command },
    'Spawning script container',
  );

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';

    container.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (stdout.length < CONTAINER_MAX_OUTPUT_SIZE) {
        stdout += chunk.slice(0, CONTAINER_MAX_OUTPUT_SIZE - stdout.length);
      }
    });

    container.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (stderr.length < CONTAINER_MAX_OUTPUT_SIZE) {
        stderr += chunk.slice(0, CONTAINER_MAX_OUTPUT_SIZE - stderr.length);
      }
    });

    // Script tasks use a shorter default timeout (60s) since they should be quick
    const timeoutMs = group.containerConfig?.timeout || 60_000;
    const killTimer = setTimeout(() => {
      logger.error(
        { group: group.name, containerName },
        'Script container timed out',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) container.kill('SIGKILL');
      });
    }, timeoutMs);

    container.on('close', (code) => {
      clearTimeout(killTimer);
      const duration = Date.now() - startTime;
      const result = stdout.trim() || null;

      logger.info(
        { group: group.name, containerName, code, duration },
        'Script container completed',
      );

      if (code !== 0) {
        resolve({
          status: 'error',
          result,
          error: stderr.trim() || `Script exited with code ${code}`,
        });
      } else {
        resolve({ status: 'success', result });
      }
    });

    container.on('error', (err) => {
      clearTimeout(killTimer);
      logger.error(
        { group: group.name, containerName, error: err },
        'Script container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Script spawn error: ${err.message}`,
      });
    });
  });
}
```

### 5. `src/ipc.ts` — Add `command`, `task_type`, `notify` to `schedule_task`

**5a.** In `processTaskIpc`, in the anonymous `data` type literal (the block with `type: string; taskId?: string; prompt?: string;`), add after `prompt?`:

```typescript
    /** For script tasks: the shell command to run (alternative to prompt) */
    command?: string;
    task_type?: string;
    notify?: string;
```

**5b.** In the `schedule_task` case, change the validation guard from:

```typescript
        data.prompt &&
```

To:

```typescript
        (data.prompt || data.command) &&
```

**5c.** In the `schedule_task` handler, after the `contextMode` assignment, add:

```typescript
        const taskType = data.task_type === 'script' ? 'script' : 'prompt';
        const notifySetting =
          data.notify === 'on_error' || data.notify === 'never'
            ? (data.notify as 'on_error' | 'never')
            : 'always';
        // For script tasks, command takes precedence; prompt is the fallback
        const promptOrCommand =
          taskType === 'script'
            ? (data.command ?? data.prompt ?? '')
            : (data.prompt ?? '');
```

**5d.** In the `createTask()` call within `schedule_task`, change `prompt: data.prompt` to `prompt: promptOrCommand`, and add the new fields:

```typescript
          prompt: promptOrCommand,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          task_type: taskType,
          notify: notifySetting,
```

**5e.** In the `update_task` case, after `if (data.prompt !== undefined) updates.prompt = data.prompt;`, add:

```typescript
        if (data.command !== undefined) updates.prompt = data.command; // script task alias
```

And after the `schedule_value` update block, add:

```typescript
        if (data.notify !== undefined)
          updates.notify = data.notify as 'always' | 'on_error' | 'never';
```

### 6. `src/task-scheduler.ts` — Handle script vs prompt tasks in `runTask`

**6a.** Add `runContainerScript` to the import from `./container-runner.js`:

```typescript
import {
  ContainerOutput,
  runContainerAgent,
  runContainerScript,
  writeTasksSnapshot,
} from './container-runner.js';
```

**6b.** In `runTask()`, the entire try/catch block that calls `runContainerAgent` needs to be restructured to branch on `task.task_type`. Replace the existing try block contents with:

```typescript
  const notify = task.notify || 'always';

  try {
    if (task.task_type === 'script') {
      // Script task: run command directly in container, no Claude session
      const output = await runContainerScript(
        group,
        task.prompt, // prompt field holds the shell command for script tasks
        isMain,
        (proc, containerName) =>
          deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      );

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      }
      result = output.result;

      // Forward result based on notify setting
      const shouldNotify =
        notify === 'always' ||
        (notify === 'on_error' && output.status === 'error');
      if (shouldNotify) {
        const msg =
          output.status === 'error'
            ? `Script task error:\n${output.error}${output.result ? `\n\n${output.result}` : ''}`
            : (output.result ?? 'Script completed (no output)');
        await deps.sendMessage(task.chat_jid, msg);
      }

      logger.info(
        { taskId: task.id, durationMs: Date.now() - startTime },
        'Script task completed',
      );
    } else {
      // Prompt task: run a Claude agent session (existing behaviour)
      const sessions = deps.getSessions();
      const sessionId =
        task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

      const TASK_CLOSE_DELAY_MS = 10000;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;

      const scheduleClose = () => {
        if (closeTimer) return;
        closeTimer = setTimeout(() => {
          logger.debug(
            { taskId: task.id },
            'Closing task container after result',
          );
          deps.queue.closeStdin(task.chat_jid);
        }, TASK_CLOSE_DELAY_MS);
      };

      const output = await runContainerAgent(
        group,
        {
          prompt: task.prompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.result) {
            result = streamedOutput.result;
            const shouldNotify =
              notify === 'always' ||
              (notify === 'on_error' && streamedOutput.status === 'error');
            if (shouldNotify) {
              await deps.sendMessage(task.chat_jid, streamedOutput.result);
            }
            scheduleClose();
          }
          if (streamedOutput.status === 'success') {
            deps.queue.notifyIdle(task.chat_jid);
            scheduleClose();
          }
          if (streamedOutput.status === 'error') {
            error = streamedOutput.error || 'Unknown error';
          }
        },
      );

      if (closeTimer) clearTimeout(closeTimer);

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      } else if (output.result) {
        result = output.result;
      }

      logger.info(
        { taskId: task.id, durationMs: Date.now() - startTime },
        'Task completed',
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }
```

Also, in the `task` object passed to `runTask` (the inline object built from `t`), add after `prompt`:

```typescript
      task_type: t.task_type || 'prompt',
```

### 7. `src/index.ts` — Import and call `seedScriptTasksFromConfig`

**7a.** Add the import after the `startSchedulerLoop` import line:

```typescript
import { seedScriptTasksFromConfig } from './script-tasks-config.js';
```

**7b.** In `main()`, after `loadState();` (and after `restoreRemoteControl()` if that function exists), add:

```typescript
  seedScriptTasksFromConfig(registeredGroups);
```

**7c.** In `runAgent()`, in the `task` object built from `t`, add after `prompt`:

```typescript
      task_type: t.task_type || 'prompt',
```

### 8. Create `src/script-tasks-config.ts`

Create this new file with the full content:

```typescript
/**
 * Script task config seeder
 *
 * Reads ~/.config/nanoclaw/script-tasks.json on startup and upserts any
 * tasks that don't already exist in the DB (matched by id). This lets you
 * define static recurring script tasks without going through chat.
 *
 * Config format:
 * [
 *   {
 *     "id": "notes-git-pull",
 *     "group_folder": "main",
 *     "command": "git -C /workspace/extra/notes pull --ff-only",
 *     "schedule_type": "interval",
 *     "schedule_value": "900000",
 *     "notify": "on_error"
 *   }
 * ]
 *
 * Fields:
 *   id            Stable identifier — used to avoid re-creating the task on restart
 *   group_folder  Must match a registered group's folder name
 *   command       Shell command to run inside the container
 *   schedule_type "cron" | "interval" | "once"
 *   schedule_value Cron expression, milliseconds, or ISO timestamp respectively
 *   notify        "always" | "on_error" (default) | "never"
 */
import fs from 'fs';

import { CronExpressionParser } from 'cron-parser';

import { SCRIPT_TASKS_CONFIG_PATH, TIMEZONE } from './config.js';
import { createTask, getTaskById } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

interface ScriptTaskConfig {
  id: string;
  group_folder: string;
  command: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  notify?: 'always' | 'on_error' | 'never';
}

export function seedScriptTasksFromConfig(
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  if (!fs.existsSync(SCRIPT_TASKS_CONFIG_PATH)) return;

  let configs: ScriptTaskConfig[];
  try {
    configs = JSON.parse(fs.readFileSync(SCRIPT_TASKS_CONFIG_PATH, 'utf-8'));
  } catch (err) {
    logger.error(
      { err, path: SCRIPT_TASKS_CONFIG_PATH },
      'Failed to parse script-tasks.json',
    );
    return;
  }

  if (!Array.isArray(configs)) {
    logger.error(
      { path: SCRIPT_TASKS_CONFIG_PATH },
      'script-tasks.json must be a JSON array',
    );
    return;
  }

  // Build folder → jid lookup from registered groups
  const folderToJid = new Map<string, string>();
  for (const [jid, group] of Object.entries(registeredGroups)) {
    folderToJid.set(group.folder, jid);
  }

  for (const cfg of configs) {
    if (
      !cfg.id ||
      !cfg.group_folder ||
      !cfg.command ||
      !cfg.schedule_type ||
      !cfg.schedule_value
    ) {
      logger.warn(
        { cfg },
        'script-tasks.json: skipping entry with missing required fields',
      );
      continue;
    }

    // Idempotent: skip tasks that already exist in the DB
    if (getTaskById(cfg.id)) continue;

    const chatJid = folderToJid.get(cfg.group_folder);
    if (!chatJid) {
      logger.warn(
        { id: cfg.id, group_folder: cfg.group_folder },
        'script-tasks.json: group not registered, skipping task',
      );
      continue;
    }

    let nextRun: string | null = null;
    if (cfg.schedule_type === 'cron') {
      try {
        const interval = CronExpressionParser.parse(cfg.schedule_value, {
          tz: TIMEZONE,
        });
        nextRun = interval.next().toISOString();
      } catch {
        logger.warn(
          { id: cfg.id, value: cfg.schedule_value },
          'script-tasks.json: invalid cron expression, skipping task',
        );
        continue;
      }
    } else if (cfg.schedule_type === 'interval') {
      const ms = parseInt(cfg.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        logger.warn(
          { id: cfg.id, value: cfg.schedule_value },
          'script-tasks.json: invalid interval value, skipping task',
        );
        continue;
      }
      nextRun = new Date(Date.now() + ms).toISOString();
    } else if (cfg.schedule_type === 'once') {
      const date = new Date(cfg.schedule_value);
      if (isNaN(date.getTime())) {
        logger.warn(
          { id: cfg.id, value: cfg.schedule_value },
          'script-tasks.json: invalid timestamp, skipping task',
        );
        continue;
      }
      nextRun = date.toISOString();
    }

    createTask({
      id: cfg.id,
      group_folder: cfg.group_folder,
      chat_jid: chatJid,
      prompt: cfg.command,
      schedule_type: cfg.schedule_type,
      schedule_value: cfg.schedule_value,
      context_mode: 'isolated',
      task_type: 'script',
      notify: cfg.notify ?? 'on_error',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logger.info(
      {
        id: cfg.id,
        group_folder: cfg.group_folder,
        schedule_type: cfg.schedule_type,
      },
      'script-tasks.json: task seeded',
    );
  }
}
```

### 9. Update test fixtures

In `src/db.test.ts`, `src/ipc-auth.test.ts`, and `src/task-scheduler.test.ts`, all existing `ScheduledTask` fixture objects now need the two new required fields. Add `task_type: 'prompt'` and `notify: 'always'` to every fixture object in those files (after the `context_mode` field).

### 10. Build and test

```bash
npm run build
npm test
```

## Phase 3: Restart

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Optional: config file

Create `~/.config/nanoclaw/script-tasks.json` to define static recurring tasks:

```json
[
  {
    "id": "notes-git-pull",
    "group_folder": "main",
    "command": "git -C /workspace/extra/notes pull --ff-only",
    "schedule_type": "interval",
    "schedule_value": "900000",
    "notify": "on_error"
  }
]
```

The notes repo must be in `additionalMounts` for the group (read-write):

```json
{
  "additionalMounts": [
    { "hostPath": "~/notes", "readonly": false }
  ]
}
```

### From chat

An agent can create a script task via IPC:

```json
{
  "type": "schedule_task",
  "task_type": "script",
  "command": "git -C /workspace/extra/notes pull --ff-only",
  "targetJid": "<group-jid>",
  "schedule_type": "interval",
  "schedule_value": "900000",
  "notify": "on_error"
}
```

### Notify behaviour

| Value | Behaviour |
|-------|-----------|
| `always` | Forward stdout to chat on every run |
| `on_error` | Only forward to chat when exit code ≠ 0 |
| `never` | Silent — result logged only |

### Container timeout

Script tasks default to a **60-second timeout** (vs 30 minutes for agent tasks). Override per-group via `containerConfig.timeout` in the group registration.
