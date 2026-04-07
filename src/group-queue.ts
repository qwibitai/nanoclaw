import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

export function queueKey(groupJid: string, threadId?: string | null): string {
  return threadId ? `${groupJid}\0${threadId}` : groupJid;
}

function parseQueueKey(key: string): {
  groupJid: string;
  threadId: string | undefined;
} {
  const idx = key.indexOf('\0');
  if (idx === -1) return { groupJid: key, threadId: undefined };
  return { groupJid: key.slice(0, idx), threadId: key.slice(idx + 1) };
}

interface GroupState {
  groupJid: string;
  threadId: string | undefined;
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupJid: string, threadId?: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  private getGroup(groupJid: string, threadId?: string | null): GroupState {
    const key = queueKey(groupJid, threadId);
    let state = this.groups.get(key);
    if (!state) {
      state = {
        groupJid,
        threadId: threadId ?? undefined,
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(key, state);
    }
    return state;
  }

  private ipcInputDir(groupFolder: string, threadId?: string): string {
    const subdir = threadId ? `input-${threadId}` : 'input';
    return path.join(DATA_DIR, 'ipc', groupFolder, subdir);
  }

  setProcessMessagesFn(
    fn: (groupJid: string, threadId?: string) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string, threadId?: string | null): void {
    if (this.shuttingDown) return;

    const key = queueKey(groupJid, threadId);
    const state = this.getGroup(groupJid, threadId);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid, threadId }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(key)) {
        this.waitingGroups.push(key);
      }
      logger.debug(
        { groupJid, threadId, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, threadId ?? undefined, 'messages').catch((err) =>
      logger.error(
        { groupJid, threadId, err },
        'Unhandled error in runForGroup',
      ),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      const key = queueKey(groupJid);
      if (!this.waitingGroups.includes(key)) {
        this.waitingGroups.push(key);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    threadId?: string | null,
  ): void {
    const state = this.getGroup(groupJid, threadId);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  notifyIdle(groupJid: string, threadId?: string | null): void {
    const state = this.getGroup(groupJid, threadId);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid, threadId);
    }
  }

  isIdleWaiting(groupJid: string, threadId?: string | null): boolean {
    return this.getGroup(groupJid, threadId).idleWaiting;
  }

  sendMessage(
    groupJid: string,
    text: string,
    threadId?: string | null,
  ): boolean {
    const state = this.getGroup(groupJid, threadId);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false;

    const inputDir = this.ipcInputDir(state.groupFolder, state.threadId);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupJid: string, threadId?: string | null): void {
    const state = this.getGroup(groupJid, threadId);
    if (!state.active || !state.groupFolder) return;

    const inputDir = this.ipcInputDir(state.groupFolder, state.threadId);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    threadId: string | undefined,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid, threadId);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, threadId, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, threadId);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(state);
        }
      }
    } catch (err) {
      logger.error(
        { groupJid, threadId, err },
        'Error processing messages for group',
      );
      this.scheduleRetry(state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid, threadId);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        {
          groupJid: state.groupJid,
          threadId: state.threadId,
          retryCount: state.retryCount,
        },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      {
        groupJid: state.groupJid,
        threadId: state.threadId,
        retryCount: state.retryCount,
        delayMs,
      },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(state.groupJid, state.threadId);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string, threadId?: string | null): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid, threadId);

    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    if (state.pendingMessages) {
      this.runForGroup(groupJid, threadId ?? undefined, 'drain').catch((err) =>
        logger.error(
          { groupJid, threadId, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextKey = this.waitingGroups.shift()!;
      const { groupJid, threadId } = parseQueueKey(nextKey);
      const state = this.getGroup(groupJid, threadId);

      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(groupJid, task).catch((err) =>
          logger.error(
            { groupJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(groupJid, threadId, 'drain').catch((err) =>
          logger.error(
            { groupJid, threadId, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeContainers: string[] = [];
    for (const [_key, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
