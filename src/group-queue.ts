import { ChildProcess, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupFolder: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  retryCount: number;
}

export class GroupQueue {
  // Queue is now keyed by groupFolder, not chatJid
  // This allows multiple chatJids (Telegram, Signal, etc.) to share one container/session
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupFolder: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  private getGroup(groupFolder: string): GroupState {
    let state = this.groups.get(groupFolder);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        retryCount: 0,
      };
      this.groups.set(groupFolder, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupFolder: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Enqueue a message check for a group folder.
   * All chatJids sharing the same folder will use the same queue entry.
   */
  enqueueMessageCheck(groupFolder: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupFolder);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupFolder }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupFolder)) {
        this.waitingGroups.push(groupFolder);
      }
      logger.debug(
        { groupFolder, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupFolder, 'messages').catch((err) =>
      logger.error({ groupFolder, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(
    groupFolder: string,
    taskId: string,
    fn: () => Promise<void>,
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupFolder);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupFolder, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupFolder, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupFolder, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupFolder);
      }
      logger.debug({ groupFolder, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupFolder, fn });
      if (!this.waitingGroups.includes(groupFolder)) {
        this.waitingGroups.push(groupFolder);
      }
      logger.debug(
        { groupFolder, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupFolder, { id: taskId, groupFolder, fn }).catch((err) =>
      logger.error({ groupFolder, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupFolder: string,
    proc: ChildProcess,
    containerName: string,
  ): void {
    const state = this.getGroup(groupFolder);
    state.process = proc;
    state.containerName = containerName;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupFolder: string): void {
    const state = this.getGroup(groupFolder);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupFolder);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupFolder: string, text: string): boolean {
    const state = this.getGroup(groupFolder);
    if (!state.active || state.isTaskContainer) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
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
  closeStdin(groupFolder: string): void {
    const state = this.getGroup(groupFolder);
    if (!state.active) return;

    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Cooperative interrupt — drop a sentinel that the container's tool loop
   * checks between rounds. The current agent turn aborts cleanly, session
   * state is preserved, and the container returns to idle waiting for the
   * next user message.
   */
  sendInterrupt(groupFolder: string): boolean {
    const state = this.getGroup(groupFolder);
    if (!state.active) return false;

    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_interrupt'), '');
      return true;
    } catch (err) {
      logger.error({ groupFolder, err }, 'Failed to write interrupt sentinel');
      return false;
    }
  }

  /**
   * Hard kill — terminate the container immediately via docker kill. Use
   * when sendInterrupt isn't enough (e.g. agent is stuck inside a single
   * Ollama call and the cooperative check between rounds never fires).
   * The next inbound message spawns a fresh container with the same session.
   */
  killContainer(groupFolder: string): boolean {
    const state = this.getGroup(groupFolder);
    if (!state.containerName) return false;

    const containerName = state.containerName;
    try {
      execFileSync('docker', ['kill', containerName], { stdio: 'ignore' });
    } catch (err) {
      logger.error({ groupFolder, containerName, err }, 'docker kill failed');
      return false;
    }

    // Reset state immediately so the next enqueueMessageCheck spawns fresh.
    state.active = false;
    state.idleWaiting = false;
    state.process = null;
    state.containerName = null;
    return true;
  }

  /**
   * Close the active container AND mark inactive immediately.
   * Use for model switching — prevents new messages from being piped to
   * the dying container. The next enqueueMessageCheck spawns a fresh one.
   */
  forceCloseAndDeactivate(groupFolder: string): void {
    this.closeStdin(groupFolder);
    const state = this.getGroup(groupFolder);
    state.active = false;
    state.idleWaiting = false;
  }

  private async runForGroup(
    groupFolder: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupFolder);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupFolder, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupFolder);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupFolder, state);
        }
      }
    } catch (err) {
      logger.error({ groupFolder, err }, 'Error processing messages for group');
      this.scheduleRetry(groupFolder, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(groupFolder);
    }
  }

  private async runTask(groupFolder: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupFolder);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupFolder, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupFolder, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(groupFolder);
    }
  }

  private scheduleRetry(groupFolder: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupFolder, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupFolder, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupFolder);
      }
    }, delayMs);
  }

  private drainGroup(groupFolder: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupFolder);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupFolder, task).catch((err) =>
        logger.error(
          { groupFolder, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupFolder, 'drain').catch((err) =>
        logger.error(
          { groupFolder, err },
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
      const nextFolder = this.waitingGroups.shift()!;
      const state = this.getGroup(nextFolder);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextFolder, task).catch((err) =>
          logger.error(
            { groupFolder: nextFolder, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextFolder, 'drain').catch((err) =>
          logger.error(
            { groupFolder: nextFolder, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [folder, state] of this.groups) {
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
