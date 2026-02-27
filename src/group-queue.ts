import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { stopContainerAsync } from './container-runtime.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  threadTs?: string;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((chatJid: string, threadTs?: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  /** Build a composite key for per-thread queuing. */
  static queueKey(chatJid: string, threadTs?: string): string {
    return threadTs ? `${chatJid}#${threadTs}` : chatJid;
  }

  /** Extract the chatJid from a composite key. */
  static chatJidFromKey(key: string): string {
    const idx = key.indexOf('#');
    return idx === -1 ? key : key.slice(0, idx);
  }

  /** Extract the threadTs from a composite key (undefined if none). */
  static threadTsFromKey(key: string): string | undefined {
    const idx = key.indexOf('#');
    return idx === -1 ? undefined : key.slice(idx + 1);
  }

  private getGroup(key: string): GroupState {
    let state = this.groups.get(key);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
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

  setProcessMessagesFn(
    fn: (chatJid: string, threadTs?: string) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string, threadTs?: string): void {
    if (this.shuttingDown) return;

    const key = GroupQueue.queueKey(groupJid, threadTs);
    const state = this.getGroup(key);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid, threadTs }, 'Container active, message queued');
      return;
    }

    // Check if any thread for this chatJid is active (serialize per-chatJid)
    for (const [k, s] of this.groups) {
      if (GroupQueue.chatJidFromKey(k) === groupJid && s.active) {
        state.pendingMessages = true;
        // Preempt idle containers so this message gets processed sooner
        if (s.idleWaiting) {
          this.closeStdinForKey(k);
        }
        logger.debug(
          { groupJid, threadTs },
          'Sibling thread active, message queued',
        );
        return;
      }
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(key)) {
        this.waitingGroups.push(key);
      }
      logger.debug(
        { groupJid, threadTs, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(key, groupJid, threadTs, 'messages').catch((err) =>
      logger.error(
        { groupJid, threadTs, err },
        'Unhandled error in runForGroup',
      ),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    // Tasks always use the base key (no thread)
    const key = groupJid;
    const state = this.getGroup(key);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    // Check if any thread for this chatJid is active
    let anyActive = false;
    for (const [k, s] of this.groups) {
      if (GroupQueue.chatJidFromKey(k) === groupJid && s.active) {
        anyActive = true;
        // Preempt idle containers
        if (s.idleWaiting) {
          this.closeStdinForKey(k);
        }
        break;
      }
    }

    if (anyActive) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(key)) {
        this.waitingGroups.push(key);
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

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    threadTs?: string,
  ): void {
    const key = GroupQueue.queueKey(groupJid, threadTs);
    const state = this.getGroup(key);
    state.process = proc;
    state.containerName = containerName;
    state.threadTs = threadTs;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   * Also preempt if sibling threads have pending messages.
   */
  notifyIdle(groupJid: string, threadTs?: string): void {
    const key = GroupQueue.queueKey(groupJid, threadTs);
    const state = this.getGroup(key);
    state.idleWaiting = true;

    // Check base key for pending tasks
    const baseState = this.getGroup(groupJid);
    if (baseState.pendingTasks.length > 0) {
      this.closeStdinForKey(key);
      return;
    }

    // Check if sibling threads have pending messages
    for (const [k, s] of this.groups) {
      if (
        k !== key &&
        GroupQueue.chatJidFromKey(k) === groupJid &&
        s.pendingMessages
      ) {
        this.closeStdinForKey(key);
        return;
      }
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string, threadTs?: string): boolean {
    const key = GroupQueue.queueKey(groupJid, threadTs);
    const state = this.getGroup(key);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
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

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string, threadTs?: string): void {
    const key = GroupQueue.queueKey(groupJid, threadTs);
    this.closeStdinForKey(key);
  }

  private closeStdinForKey(key: string): void {
    const state = this.getGroup(key);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /** Get unique chatJids that have active containers. */
  getActiveJids(): string[] {
    const jids = new Set<string>();
    for (const [key, state] of this.groups) {
      if (state.active) {
        jids.add(GroupQueue.chatJidFromKey(key));
      }
    }
    return Array.from(jids);
  }

  private async runForGroup(
    key: string,
    chatJid: string,
    threadTs: string | undefined,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(key);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    state.threadTs = threadTs;
    this.activeCount++;

    logger.debug(
      { chatJid, threadTs, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(chatJid, threadTs);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(key, chatJid, threadTs, state);
        }
      }
    } catch (err) {
      logger.error(
        { chatJid, threadTs, err },
        'Error processing messages for group',
      );
      this.scheduleRetry(key, chatJid, threadTs, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(key, chatJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const key = groupJid;
    const state = this.getGroup(key);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
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
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(key, groupJid);
    }
  }

  private scheduleRetry(
    key: string,
    chatJid: string,
    threadTs: string | undefined,
    state: GroupState,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { chatJid, threadTs, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { chatJid, threadTs, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(chatJid, threadTs);
      }
    }, delayMs);
  }

  private drainGroup(key: string, chatJid: string): void {
    if (this.shuttingDown) return;

    // Check sibling threads for pending messages first
    for (const [k, s] of this.groups) {
      if (
        k !== key &&
        GroupQueue.chatJidFromKey(k) === chatJid &&
        s.pendingMessages &&
        !s.active
      ) {
        const siblingJid = GroupQueue.chatJidFromKey(k);
        const siblingThread = GroupQueue.threadTsFromKey(k);
        this.runForGroup(k, siblingJid, siblingThread, 'drain').catch((err) =>
          logger.error(
            { chatJid: siblingJid, threadTs: siblingThread, err },
            'Unhandled error in runForGroup (sibling drain)',
          ),
        );
        return;
      }
    }

    const state = this.getGroup(key);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    // Check base key for tasks
    const baseState = this.getGroup(chatJid);
    if (baseState.pendingTasks.length > 0) {
      const task = baseState.pendingTasks.shift()!;
      this.runTask(chatJid, task).catch((err) =>
        logger.error(
          { chatJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages for this key
    if (state.pendingMessages) {
      const threadTs = GroupQueue.threadTsFromKey(key);
      this.runForGroup(key, chatJid, threadTs, 'drain').catch((err) =>
        logger.error(
          { chatJid, threadTs, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextKey = this.waitingGroups.shift()!;
      const nextJid = GroupQueue.chatJidFromKey(nextKey);
      const state = this.getGroup(nextKey);

      // Check base key for tasks
      const baseState = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (baseState.pendingTasks.length > 0) {
        const task = baseState.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        const threadTs = GroupQueue.threadTsFromKey(nextKey);
        this.runForGroup(nextKey, nextJid, threadTs, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Actually stop active containers for graceful shutdown
    const stopPromises: Promise<void>[] = [];
    for (const [, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        stopPromises.push(stopContainerAsync(state.containerName));
      }
    }

    if (stopPromises.length > 0) {
      logger.info(
        { activeCount: stopPromises.length },
        'GroupQueue shutting down, stopping containers...',
      );
      await Promise.allSettled(stopPromises);
    }

    logger.info('GroupQueue shutdown complete');
  }
}
