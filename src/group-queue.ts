import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  MAX_CONTAINERS_PER_GROUP,
} from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface ThreadState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  threadId: string;
}

interface GroupState {
  pendingMessages: Map<string, boolean>; // threadId → has pending
  pendingTasks: QueuedTask[];
  retryCount: number;
  runningTaskId: string | null;
  activeThreadCount: number;
  waitingThreads: string[]; // threadIds waiting for a per-group slot
}

const STATUS_FILE = path.join(DATA_DIR, 'status.json');

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private threads = new Map<string, ThreadState>(); // keyed by {groupJid}:{threadId}
  private activeCount = 0;
  private waitingGroups: string[] = []; // groupJids waiting for a global slot
  private processMessagesFn:
    | ((groupJid: string, threadId?: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  private threadKey(groupJid: string, threadId: string): string {
    return `${groupJid}:${threadId}`;
  }

  private writeStatus(): void {
    try {
      fs.writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          activeContainers: this.activeCount,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch {
      /* best-effort */
    }
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        pendingMessages: new Map(),
        pendingTasks: [],
        retryCount: 0,
        runningTaskId: null,
        activeThreadCount: 0,
        waitingThreads: [],
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private getThread(groupJid: string, threadId: string): ThreadState {
    const key = this.threadKey(groupJid, threadId);
    let state = this.threads.get(key);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        process: null,
        containerName: null,
        groupFolder: null,
        threadId,
      };
      this.threads.set(key, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (groupJid: string, threadId?: string) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  isActive(groupJid: string, threadId?: string): boolean {
    if (threadId !== undefined) {
      const thread = this.threads.get(this.threadKey(groupJid, threadId));
      return thread?.active === true && !thread.isTaskContainer;
    }
    // Check if any thread in this group is active (non-task)
    const group = this.groups.get(groupJid);
    if (!group) return false;
    for (const [key, thread] of this.threads) {
      if (key.startsWith(`${groupJid}:`) && thread.active && !thread.isTaskContainer) {
        return true;
      }
    }
    return false;
  }

  /**
   * Backward-compatible entry point — uses 'default' threadId.
   */
  enqueueMessageCheck(groupJid: string): void {
    this.enqueueThreadMessageCheck(groupJid, 'default');
  }

  /**
   * Main entry point: enqueue a message check for a specific thread.
   */
  enqueueThreadMessageCheck(groupJid: string, threadId: string): void {
    if (this.shuttingDown) return;

    const group = this.getGroup(groupJid);
    const thread = this.getThread(groupJid, threadId);

    if (thread.active) {
      group.pendingMessages.set(threadId, true);
      logger.debug({ groupJid, threadId }, 'Thread active, message queued');
      return;
    }

    // Per-group cap
    if (group.activeThreadCount >= MAX_CONTAINERS_PER_GROUP) {
      group.pendingMessages.set(threadId, true);
      if (!group.waitingThreads.includes(threadId)) {
        group.waitingThreads.push(threadId);
      }
      logger.debug(
        { groupJid, threadId, activeThreadCount: group.activeThreadCount },
        'At per-group limit, thread queued',
      );
      return;
    }

    // Global cap
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      group.pendingMessages.set(threadId, true);
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, threadId, activeCount: this.activeCount },
        'At global concurrency limit, message queued',
      );
      return;
    }

    this.runForThread(groupJid, threadId, 'messages').catch((err) =>
      logger.error(
        { groupJid, threadId, err },
        'Unhandled error in runForThread',
      ),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const group = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (group.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (group.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    // Check if any thread in this group is active (tasks share the group slot)
    const anyThreadActive = this.isAnyThreadActive(groupJid);

    if (anyThreadActive) {
      group.pendingTasks.push({ id: taskId, groupJid, fn });
      // Preempt idle threads in the group
      this.preemptIdleThreads(groupJid);
      logger.debug({ groupJid, taskId }, 'Thread active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      group.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  /**
   * Check if any thread in the group has an active container (including task containers).
   */
  private isAnyThreadActive(groupJid: string): boolean {
    for (const [key, thread] of this.threads) {
      if (key.startsWith(`${groupJid}:`) && thread.active) {
        return true;
      }
    }
    return false;
  }

  /**
   * Preempt all idle threads in a group (write _close sentinel).
   */
  private preemptIdleThreads(groupJid: string): void {
    for (const [key, thread] of this.threads) {
      if (key.startsWith(`${groupJid}:`) && thread.active && thread.idleWaiting) {
        const colonIdx = key.indexOf(':');
        const tid = key.slice(colonIdx + 1);
        this.closeStdin(groupJid, tid);
      }
    }
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    threadId: string = 'default',
  ): void {
    const thread = this.getThread(groupJid, threadId);
    thread.process = proc;
    thread.containerName = containerName;
    if (groupFolder) thread.groupFolder = groupFolder;
  }

  /**
   * Mark the container for a specific thread as idle-waiting.
   * If tasks are pending for the group, preempt immediately.
   */
  notifyIdle(groupJid: string, threadId: string = 'default'): void {
    const thread = this.getThread(groupJid, threadId);
    const group = this.getGroup(groupJid);
    thread.idleWaiting = true;
    if (group.pendingTasks.length > 0) {
      this.closeStdin(groupJid, threadId);
    }
  }

  /**
   * Send a follow-up message to the active thread container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, threadId: string, text: string): boolean;
  sendMessage(groupJid: string, text: string): boolean;
  sendMessage(
    groupJid: string,
    threadIdOrText: string,
    text?: string,
  ): boolean {
    let threadId: string;
    let messageText: string;

    if (text === undefined) {
      // 2-arg backward-compat: sendMessage(groupJid, text)
      threadId = 'default';
      messageText = threadIdOrText;
    } else {
      // 3-arg: sendMessage(groupJid, threadId, text)
      threadId = threadIdOrText;
      messageText = text;
    }

    const thread = this.getThread(groupJid, threadId);
    if (!thread.active || !thread.groupFolder || thread.isTaskContainer) {
      logger.info(
        {
          groupJid,
          threadId,
          active: thread.active,
          groupFolder: thread.groupFolder || null,
          isTaskContainer: thread.isTaskContainer,
        },
        'sendMessage rejected: container not ready for IPC',
      );
      return false;
    }
    thread.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      thread.groupFolder,
      threadId,
      'input',
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({ type: 'message', text: messageText }),
      );
      fs.renameSync(tempPath, filepath);
      return true;
    } catch (err) {
      logger.warn(
        { groupJid, threadId, err },
        'Failed to write IPC message to container',
      );
      return false;
    }
  }

  /**
   * Signal the active container for a specific thread to wind down.
   */
  closeStdin(groupJid: string, threadId: string = 'default'): void {
    const thread = this.getThread(groupJid, threadId);
    if (!thread.active || !thread.groupFolder) return;

    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      thread.groupFolder,
      threadId,
      'input',
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Common setup/teardown for running a container (messages or tasks).
   */
  private async withContainer(
    groupJid: string,
    threadId: string,
    opts: { isTask: boolean; taskId?: string },
    fn: () => Promise<void>,
  ): Promise<void> {
    const group = this.getGroup(groupJid);
    const thread = this.getThread(groupJid, threadId);

    thread.active = true;
    thread.idleWaiting = false;
    thread.isTaskContainer = opts.isTask;
    if (!opts.isTask) group.pendingMessages.delete(threadId);
    if (opts.taskId) group.runningTaskId = opts.taskId;
    group.activeThreadCount++;
    this.activeCount++;
    this.writeStatus();

    try {
      await fn();
    } finally {
      thread.active = false;
      thread.isTaskContainer = false;
      thread.process = null;
      thread.containerName = null;
      thread.groupFolder = null;
      if (opts.taskId) group.runningTaskId = null;
      group.activeThreadCount--;
      this.activeCount--;
      this.writeStatus();
      this.drainGroup(groupJid);
    }
  }

  private async runForThread(
    groupJid: string,
    threadId: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const group = this.getGroup(groupJid);

    logger.debug(
      {
        groupJid,
        threadId,
        reason,
        activeCount: this.activeCount + 1,
        activeThreadCount: group.activeThreadCount + 1,
      },
      'Starting container for thread',
    );

    await this.withContainer(groupJid, threadId, { isTask: false }, async () => {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, threadId);
        if (success) {
          group.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, threadId, group);
        }
      }
    }).catch((err) => {
      logger.error(
        { groupJid, threadId, err },
        'Error processing messages for thread',
      );
      this.scheduleRetry(groupJid, threadId, group);
    });
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const taskThreadId = `task:${task.id}`;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount + 1 },
      'Running queued task',
    );

    await this.withContainer(
      groupJid,
      taskThreadId,
      { isTask: true, taskId: task.id },
      async () => {
        await task.fn();
      },
    ).catch((err) => {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    });
  }

  private scheduleRetry(
    groupJid: string,
    threadId: string,
    group: GroupState,
  ): void {
    group.retryCount++;
    if (group.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, threadId, retryCount: group.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      group.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, group.retryCount - 1);
    logger.info(
      { groupJid, threadId, retryCount: group.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueThreadMessageCheck(groupJid, threadId);
      }
    }, delayMs).unref();
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const group = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (
      group.pendingTasks.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const task = group.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Drain waiting threads within this group first (before other groups)
    while (
      group.waitingThreads.length > 0 &&
      group.activeThreadCount < MAX_CONTAINERS_PER_GROUP &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextThreadId = group.waitingThreads.shift()!;
      if (group.pendingMessages.get(nextThreadId)) {
        this.runForThread(groupJid, nextThreadId, 'drain').catch((err) =>
          logger.error(
            { groupJid, threadId: nextThreadId, err },
            'Unhandled error in runForThread (waiting thread)',
          ),
        );
        return;
      }
    }

    // Then pending messages for this group (default thread pattern)
    if (
      group.pendingMessages.size > 0 &&
      group.activeThreadCount < MAX_CONTAINERS_PER_GROUP &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextThreadId = group.pendingMessages.keys().next().value;
      if (nextThreadId !== undefined) {
        group.pendingMessages.delete(nextThreadId);
        this.runForThread(groupJid, nextThreadId, 'drain').catch((err) =>
          logger.error(
            { groupJid, threadId: nextThreadId, err },
            'Unhandled error in runForThread (drain)',
          ),
        );
        return;
      }
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const group = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (group.pendingTasks.length > 0) {
        const task = group.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
        break;
      }

      // Check waiting threads first, then generic pending messages
      if (group.waitingThreads.length > 0) {
        const nextThreadId = group.waitingThreads.shift()!;
        if (group.pendingMessages.get(nextThreadId)) {
          this.runForThread(nextJid, nextThreadId, 'drain').catch((err) =>
            logger.error(
              { groupJid: nextJid, threadId: nextThreadId, err },
              'Unhandled error in runForThread (waiting)',
            ),
          );
          break;
        }
      } else if (group.pendingMessages.size > 0) {
        const nextThreadId = group.pendingMessages.keys().next().value;
        if (nextThreadId === undefined) continue;
        group.pendingMessages.delete(nextThreadId);
        this.runForThread(nextJid, nextThreadId, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, threadId: nextThreadId, err },
            'Unhandled error in runForThread (waiting)',
          ),
        );
        break;
      }
      // If neither pending, skip this group (continue loop)
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_key, thread] of this.threads) {
      if (thread.process && !thread.process.killed && thread.containerName) {
        activeContainers.push(thread.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
