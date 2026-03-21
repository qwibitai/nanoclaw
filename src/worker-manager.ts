/**
 * Worker Manager (Gas Town)
 *
 * Polls for pending worker tasks, spawns agent containers to execute them,
 * collects results, and triggers orchestrator synthesis when root tasks complete.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, WORKER_TASK_POLL_INTERVAL } from './config.js';
import { runContainerAgent } from './container-runner.js';
import {
  getChildTasks,
  getPendingWorkerTasks,
  getRootTaskId,
  getWallEntries,
  getWorkerTask,
  updateWorkerTask,
} from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, WorkerTask } from './types.js';

export interface WorkerManagerDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRootTaskComplete: (
    task: WorkerTask,
    result: string,
    groupFolder: string,
    chatJid: string,
  ) => Promise<void>;
}

let workerManagerRunning = false;

export function startWorkerTaskLoop(deps: WorkerManagerDeps): void {
  if (workerManagerRunning) return;
  workerManagerRunning = true;

  const poll = async () => {
    try {
      await processPendingTasks(deps);
    } catch (err) {
      logger.error({ err }, 'Worker task poll error');
    }
    setTimeout(poll, WORKER_TASK_POLL_INTERVAL);
  };

  poll();
  logger.info('Worker task loop started');
}

async function processPendingTasks(deps: WorkerManagerDeps): Promise<void> {
  const pending = getPendingWorkerTasks(3);
  for (const task of pending) {
    // Mark as running before spawning to avoid double-spawn on overlap
    updateWorkerTask(task.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      assigned_worker: `worker-${task.id}`,
    });

    // Don't await — let workers run concurrently
    runWorker(task, deps).catch((err) => {
      logger.error({ taskId: task.id, err }, 'Worker run uncaught error');
      updateWorkerTask(task.id, {
        status: 'failed',
        error: String(err),
        completed_at: new Date().toISOString(),
      });
    });
  }
}

async function runWorker(
  task: WorkerTask,
  deps: WorkerManagerDeps,
): Promise<void> {
  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.warn(
      { taskId: task.id, groupFolder: task.group_folder },
      'Worker task: group not found, marking failed',
    );
    updateWorkerTask(task.id, {
      status: 'failed',
      error: 'Group not registered',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  // Write wall snapshot to IPC input dir for the worker to read
  const rootId = getRootTaskId(task.id);
  const wallEntries = getWallEntries(rootId);
  const ipcDir = resolveGroupIpcPath(group.folder);
  const workerInputDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'worker-inputs',
  );
  fs.mkdirSync(workerInputDir, { recursive: true });
  const contextFile = path.join(workerInputDir, `${task.id}.json`);
  fs.writeFileSync(
    contextFile,
    JSON.stringify(
      {
        taskId: task.id,
        rootTaskId: rootId,
        depth: task.depth,
        parentTaskId: task.parent_task_id,
        wall: wallEntries,
      },
      null,
      2,
    ),
  );

  // Build worker prompt: task description + parent chain + wall context
  const prompt = buildWorkerPrompt(task, wallEntries, ipcDir);

  logger.info(
    { taskId: task.id, depth: task.depth, groupFolder: group.folder },
    'Spawning worker container',
  );

  const resultChunks: string[] = [];

  const output = await runContainerAgent(
    group,
    {
      prompt,
      groupFolder: group.folder,
      chatJid: task.chat_jid,
      isMain: false,
      isWorkerTask: true,
      workerTaskId: task.id,
      workerDepth: task.depth,
    },
    (proc, containerName) => {
      updateWorkerTask(task.id, { assigned_worker: containerName });
      // No queue registration needed — workers are fire-and-forget
      void proc;
    },
    async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text) resultChunks.push(text);
      }
    },
  );

  // Clean up context file
  try {
    fs.unlinkSync(contextFile);
  } catch {
    /* ignore */
  }

  if (output.status === 'error') {
    logger.error(
      { taskId: task.id, error: output.error },
      'Worker container failed',
    );
    updateWorkerTask(task.id, {
      status: 'failed',
      error: output.error ?? 'Container error',
      completed_at: new Date().toISOString(),
    });
  } else {
    const result = resultChunks.join('\n').trim() || '(no output)';
    logger.info(
      { taskId: task.id, resultLength: result.length },
      'Worker task completed',
    );
    updateWorkerTask(task.id, {
      status: 'done',
      result,
      completed_at: new Date().toISOString(),
    });
  }

  // Check if parent task is now complete
  await checkParentCompletion(task, deps);
}

async function checkParentCompletion(
  task: WorkerTask,
  deps: WorkerManagerDeps,
): Promise<void> {
  if (!task.parent_task_id) {
    // This IS the root task — trigger synthesis
    const updated = getWorkerTask(task.id);
    if (updated?.status === 'done' && updated.result) {
      await deps.onRootTaskComplete(
        updated,
        updated.result,
        task.group_folder,
        task.chat_jid,
      );
    }
    return;
  }

  const siblings = getChildTasks(task.parent_task_id);
  const allDone = siblings.every(
    (s) => s.status === 'done' || s.status === 'failed',
  );

  if (!allDone) return;

  // Synthesize parent result from children
  const successResults = siblings
    .filter((s) => s.status === 'done' && s.result)
    .map((s) => `[${s.description}]\n${s.result}`)
    .join('\n\n');

  updateWorkerTask(task.parent_task_id, {
    status: 'done',
    result: successResults || '(all subtasks failed)',
    completed_at: new Date().toISOString(),
  });

  // Recurse up the tree
  const parent = getWorkerTask(task.parent_task_id);
  if (parent) {
    await checkParentCompletion(parent, deps);
  }
}

function buildWorkerPrompt(
  task: WorkerTask,
  wallEntries: Array<{ author: string; type: string; content: string }>,
  _ipcDir: string,
): string {
  const lines: string[] = [];

  lines.push('[WORKER TASK]');
  lines.push(
    'You are executing a delegated task. Complete it and provide your result as output.',
  );
  lines.push(
    'Do not engage in general conversation — just do the work and output the result.',
  );
  lines.push('');
  lines.push(`Task: ${task.description}`);

  if (task.depth > 0) {
    lines.push(`Depth: ${task.depth} (this is a subtask)`);
  }

  if (wallEntries.length > 0) {
    lines.push('');
    lines.push('--- Shared Context (Wall) ---');
    for (const entry of wallEntries) {
      lines.push(`[${entry.author} / ${entry.type}] ${entry.content}`);
    }
    lines.push('--- End Wall ---');
  }

  lines.push('');
  lines.push(
    'You can create subtasks by writing a JSON file to /workspace/ipc/tasks/ with:',
  );
  lines.push(
    '  {"type":"create_worker_task","chatJid":"<chat_jid>","description":"<task>","parentTaskId":"<your_task_id>","parentDepth":<your_depth>}',
  );
  lines.push('You can post findings to the shared wall by writing:');
  lines.push(
    '  {"type":"post_wall","taskId":"<your_task_id>","content":"<finding>","wallType":"finding","author":"<your_task_id>"}',
  );
  lines.push(`Your task ID is: ${task.id}`);
  lines.push(`Chat JID: ${task.chat_jid}`);

  return lines.join('\n');
}
