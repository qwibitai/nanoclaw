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

interface ThreadState {
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string;
  description: string;
  startedAt: number;
}

interface GroupState {
  orchestratorActive: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  threads: Map<string, ThreadState>;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        orchestratorActive: false,
        pendingMessages: false,
        pendingTasks: [],
        threads: new Map(),
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Sanitize a Slack thread_ts into a safe directory name.
   * Returns '__channel__' for null/undefined (top-level channel messages).
   */
  sanitizeThreadKey(threadTs: string | undefined | null): string {
    if (!threadTs) return '__channel__';
    if (/^\d+\.\d+$/.test(threadTs)) return threadTs;
    return '__channel__';
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.orchestratorActive) {
      state.pendingMessages = true;
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages');
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    // Tasks run independently from message orchestration — only check concurrency
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

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn });
  }

  registerThread(
    groupJid: string,
    threadKey: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
    description: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.threads.set(threadKey, { process: proc, containerName, groupFolder, description, startedAt: Date.now() });
  }

  unregisterThread(groupJid: string, threadKey: string): void {
    const state = this.getGroup(groupJid);
    state.threads.delete(threadKey);
  }

  isThreadActive(groupJid: string, threadKey: string): boolean {
    const state = this.groups.get(groupJid);
    return state?.threads.has(threadKey) ?? false;
  }

  getStatus(): {
    activeContainers: Array<{ groupJid: string; threadKey: string; description: string; startedAt: number; groupFolder: string }>;
    activeCount: number;
    maxConcurrent: number;
    queuedGroups: string[];
  } {
    const activeContainers: Array<{ groupJid: string; threadKey: string; description: string; startedAt: number; groupFolder: string }> = [];
    for (const [groupJid, state] of this.groups) {
      for (const [threadKey, thread] of state.threads) {
        activeContainers.push({
          groupJid,
          threadKey,
          description: thread.description,
          startedAt: thread.startedAt,
          groupFolder: thread.groupFolder,
        });
      }
    }
    return {
      activeContainers,
      activeCount: this.activeCount,
      maxConcurrent: MAX_CONCURRENT_CONTAINERS,
      queuedGroups: [...this.waitingGroups],
    };
  }

  /**
   * Claim a concurrency slot. Returns true if a slot was available.
   */
  claimSlot(): boolean {
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) return false;
    this.activeCount++;
    return true;
  }

  /**
   * Release a concurrency slot and drain waiting groups.
   */
  releaseSlot(): void {
    this.activeCount--;
    this.drainWaiting();
  }

  /**
   * Send a follow-up message to a thread's container via IPC file.
   * Returns true if the message was written, false if no active thread.
   */
  sendMessage(groupJid: string, text: string, threadKey: string): boolean {
    const state = this.getGroup(groupJid);
    const thread = state.threads.get(threadKey);
    if (!thread) return false;

    const inputDir = path.join(DATA_DIR, 'ipc', thread.groupFolder, `input-${threadKey}`);
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
   * Signal a thread's container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string, threadKey: string): void {
    const state = this.getGroup(groupJid);
    const thread = state.threads.get(threadKey);
    if (!thread) return;

    const inputDir = path.join(DATA_DIR, 'ipc', thread.groupFolder, `input-${threadKey}`);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.orchestratorActive = true;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.orchestratorActive = false;
      state.threads.clear();
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    // Tasks do NOT set orchestratorActive — they run independently from
    // message processing, using only a concurrency slot. This prevents
    // scheduled tasks (e.g. reminders) from being blocked behind
    // long-running message containers.
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
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0 && this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task);
      return;
    }

    // Then pending messages — only if the message orchestrator isn't already running
    if (state.pendingMessages && !state.orchestratorActive) {
      this.runForGroup(groupJid, 'drain');
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
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task);
      } else if (state.pendingMessages && !state.orchestratorActive) {
        this.runForGroup(nextJid, 'drain');
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      for (const [_threadKey, thread] of state.threads) {
        if (thread.process && !thread.process.killed && thread.containerName) {
          activeContainers.push(thread.containerName);
        }
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
