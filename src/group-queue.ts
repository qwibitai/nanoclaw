import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  GROUP_THREAD_KEY,
  MAX_CONCURRENT_CONTAINERS,
  MAX_THREADS_PER_GROUP,
} from './config.js';
import { ContainerAttachment } from './container-runner.js';
import { resolveGroupIpcInputPath } from './group-folder.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

export interface ThreadSlot {
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
}

interface GroupState {
  activeThreads: Map<string, ThreadSlot>;
  pendingProcessJids: Array<{ processJid: string; threadKey: string }>;
  pendingTasks: QueuedTask[];
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((processJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        activeThreads: new Map(),
        pendingProcessJids: [],
        pendingTasks: [],
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (processJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Resolve thread key: non-threaded channels use GROUP_THREAD_KEY,
   * threaded channels use the actual threadId.
   */
  private resolveThreadKey(threadId: string | undefined): string {
    return threadId || GROUP_THREAD_KEY;
  }

  enqueueMessageCheck(
    groupJid: string,
    processJid?: string,
    threadId?: string,
  ): void {
    if (this.shuttingDown) return;

    const pid = processJid || groupJid;
    const threadKey = this.resolveThreadKey(threadId);
    const state = this.getGroup(groupJid);

    // If this specific thread already has an active slot, queue or pipe
    if (state.activeThreads.has(threadKey)) {
      const slot = state.activeThreads.get(threadKey)!;
      if (!state.pendingProcessJids.some((p) => p.processJid === pid)) {
        state.pendingProcessJids.push({ processJid: pid, threadKey });
      }
      // Preempt idle container if queued message is for a different thread
      if (slot.idleWaiting) {
        this.closeStdin(groupJid, threadId);
      }
      logger.debug(
        { groupJid, processJid: pid, threadKey },
        'Thread active, message queued',
      );
      return;
    }

    // Check per-group thread limit
    if (state.activeThreads.size >= MAX_THREADS_PER_GROUP) {
      if (!state.pendingProcessJids.some((p) => p.processJid === pid)) {
        state.pendingProcessJids.push({ processJid: pid, threadKey });
      }
      // Preempt an idle thread in this group to free a slot
      for (const [key, slot] of state.activeThreads) {
        if (slot.idleWaiting) {
          this.closeStdin(groupJid, key === GROUP_THREAD_KEY ? undefined : key);
          break;
        }
      }
      logger.debug(
        {
          groupJid,
          processJid: pid,
          threadKey,
          threadCount: state.activeThreads.size,
        },
        'At per-group thread limit, message queued',
      );
      return;
    }

    // Check global concurrency limit
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      if (!state.pendingProcessJids.some((p) => p.processJid === pid)) {
        state.pendingProcessJids.push({ processJid: pid, threadKey });
      }
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, processJid: pid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages', pid, threadKey).catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing
    for (const [, slot] of state.activeThreads) {
      if (slot.runningTaskId === taskId) {
        logger.debug({ groupJid, taskId }, 'Task already running, skipping');
        return;
      }
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    // Tasks serialize per group (use GROUP_THREAD_KEY slot)
    if (state.activeThreads.size > 0) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      // Preempt idle containers to drain tasks faster
      for (const [key, slot] of state.activeThreads) {
        if (slot.idleWaiting) {
          this.closeStdin(groupJid, key === GROUP_THREAD_KEY ? undefined : key);
        }
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
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
    threadId: string | undefined,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const threadKey = this.resolveThreadKey(threadId);
    const state = this.getGroup(groupJid);
    const slot = state.activeThreads.get(threadKey);
    if (slot) {
      slot.process = proc;
      slot.containerName = containerName;
      if (groupFolder) slot.groupFolder = groupFolder;
    }
  }

  /**
   * Mark a thread's container as idle-waiting.
   * Preempt if tasks are pending or messages for other threads are queued.
   */
  notifyIdle(groupJid: string, threadId?: string): void {
    const threadKey = this.resolveThreadKey(threadId);
    const state = this.getGroup(groupJid);
    const slot = state.activeThreads.get(threadKey);
    if (!slot) return;
    slot.idleWaiting = true;

    // Preempt if tasks pending
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid, threadId);
      return;
    }

    // Preempt if messages queued for a different thread
    const hasPendingOtherThread = state.pendingProcessJids.some(
      (p) => p.threadKey !== threadKey,
    );
    if (
      hasPendingOtherThread &&
      state.activeThreads.size >= MAX_THREADS_PER_GROUP
    ) {
      this.closeStdin(groupJid, threadId);
    }
  }

  /** Check if a group has any active containers. */
  isActive(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return state ? state.activeThreads.size > 0 : false;
  }

  /** Check if a specific thread has an active container. */
  isThreadActive(groupJid: string, threadId: string | undefined): boolean {
    const threadKey = this.resolveThreadKey(threadId);
    const state = this.groups.get(groupJid);
    return state?.activeThreads.has(threadKey) === true;
  }

  /** Get the thread slot for a specific thread (if active). */
  getThreadSlot(
    groupJid: string,
    threadId: string | undefined,
  ): ThreadSlot | undefined {
    const threadKey = this.resolveThreadKey(threadId);
    const state = this.groups.get(groupJid);
    return state?.activeThreads.get(threadKey);
  }

  /**
   * Send a follow-up message to a specific thread's container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(
    groupJid: string,
    threadId: string | undefined,
    text: string,
    attachments?: ContainerAttachment[],
  ): boolean {
    const threadKey = this.resolveThreadKey(threadId);
    const state = this.getGroup(groupJid);
    const slot = state.activeThreads.get(threadKey);
    if (!slot || !slot.groupFolder || slot.isTaskContainer) return false;
    slot.idleWaiting = false;

    const inputDir = resolveGroupIpcInputPath(slot.groupFolder, threadKey);
    try {
      // Dir already created by runContainerAgent before container launch
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      const payload: Record<string, unknown> = { type: 'message', text };
      if (attachments && attachments.length > 0) {
        payload.attachments = attachments;
      }
      fs.writeFileSync(tempPath, JSON.stringify(payload));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal a specific thread's container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string, threadId?: string): void {
    const threadKey = this.resolveThreadKey(threadId);
    const state = this.getGroup(groupJid);
    const slot = state.activeThreads.get(threadKey);
    if (!slot || !slot.groupFolder) return;

    const inputDir = resolveGroupIpcInputPath(slot.groupFolder, threadKey);
    try {
      // Dir already created by runContainerAgent before container launch
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
    processJid: string,
    threadKey: string,
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    const slot: ThreadSlot = {
      process: null,
      containerName: null,
      groupFolder: null,
      idleWaiting: false,
      isTaskContainer: false,
      runningTaskId: null,
    };
    state.activeThreads.set(threadKey, slot);
    this.activeCount++;

    logger.debug(
      {
        groupJid,
        processJid,
        reason,
        threadKey,
        activeCount: this.activeCount,
      },
      'Starting container for group thread',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(processJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state, processJid, threadKey);
        }
      }
    } catch (err) {
      logger.error(
        { groupJid, processJid, err },
        'Error processing messages for group',
      );
      this.scheduleRetry(groupJid, state, processJid, threadKey);
    } finally {
      state.activeThreads.delete(threadKey);
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    const taskThreadKey = GROUP_THREAD_KEY;
    const slot: ThreadSlot = {
      process: null,
      containerName: null,
      groupFolder: null,
      idleWaiting: false,
      isTaskContainer: true,
      runningTaskId: task.id,
    };
    state.activeThreads.set(taskThreadKey, slot);
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
      state.activeThreads.delete(taskThreadKey);
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(
    groupJid: string,
    state: GroupState,
    processJid: string,
    threadKey: string,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, processJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, processJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        const threadId = threadKey === GROUP_THREAD_KEY ? undefined : threadKey;
        this.enqueueMessageCheck(groupJid, processJid, threadId);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages).
    // Only run tasks when no other threads are active for this group
    // (tasks use the group folder directly, not worktrees).
    if (state.pendingTasks.length > 0 && state.activeThreads.size === 0) {
      if (this.activeCount < MAX_CONCURRENT_CONTAINERS) {
        const task = state.pendingTasks.shift()!;
        this.runTask(groupJid, task).catch((err) =>
          logger.error(
            { groupJid, taskId: task.id, err },
            'Unhandled error in runTask (drain)',
          ),
        );
        return;
      }
    }

    // Then pending messages — check if we can start more threads
    while (
      state.pendingProcessJids.length > 0 &&
      state.activeThreads.size < MAX_THREADS_PER_GROUP &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const next = state.pendingProcessJids.shift()!;
      // Skip if this thread is already active (message will be piped)
      if (state.activeThreads.has(next.threadKey)) continue;

      this.runForGroup(
        groupJid,
        'drain',
        next.processJid,
        next.threadKey,
      ).catch((err) =>
        logger.error(
          { groupJid, processJid: next.processJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
    }

    // Check if other groups are waiting for a slot
    if (
      state.pendingProcessJids.length === 0 &&
      state.pendingTasks.length === 0
    ) {
      this.drainWaiting();
    }
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages (only when no active threads)
      if (state.pendingTasks.length > 0 && state.activeThreads.size === 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingProcessJids.length > 0) {
        // Start as many threads as limits allow
        while (
          state.pendingProcessJids.length > 0 &&
          state.activeThreads.size < MAX_THREADS_PER_GROUP &&
          this.activeCount < MAX_CONCURRENT_CONTAINERS
        ) {
          const next = state.pendingProcessJids.shift()!;
          if (state.activeThreads.has(next.threadKey)) continue;

          this.runForGroup(
            nextJid,
            'drain',
            next.processJid,
            next.threadKey,
          ).catch((err) =>
            logger.error(
              { groupJid: nextJid, processJid: next.processJid, err },
              'Unhandled error in runForGroup (waiting)',
            ),
          );
        }
        // Re-add to waiting if still has pending items
        if (
          state.pendingProcessJids.length > 0 ||
          state.pendingTasks.length > 0
        ) {
          if (!this.waitingGroups.includes(nextJid)) {
            this.waitingGroups.push(nextJid);
          }
        }
      }
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeContainers: string[] = [];
    for (const [, state] of this.groups) {
      for (const [, slot] of state.activeThreads) {
        if (slot.process && !slot.process.killed && slot.containerName) {
          activeContainers.push(slot.containerName);
        }
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
