import { ChildProcess, exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, EVICTION_TIMEOUT, GRACE_TIMEOUT, IDLE_BEFORE_EVICT, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { stopContainer } from './container-runtime.js';
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
  // New state for 4-state timeout system
  evictable: boolean;
  evictableAt: number | null;
  stopping: boolean;
  evictionTimer: ReturnType<typeof setTimeout> | null; // covers IDLE_BEFORE_EVICT and EVICTION_TIMEOUT phases
  graceTimer: ReturnType<typeof setTimeout> | null;
  clearIdleTimeout: (() => void) | null;
  resetIdleTimeout: (() => void) | null;
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
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        evictable: false,
        evictableAt: null,
        stopping: false,
        evictionTimer: null,
        graceTimer: null,
        clearIdleTimeout: null,
        resetIdleTimeout: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
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
      this.evictOldest();
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      // If container is idle or evictable, soft-stop it so the task can run next
      if (state.idleWaiting || state.evictable) {
        this.softStop(groupJid);
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
      this.evictOldest();
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
    controls?: { clearIdleTimeout: () => void; resetIdleTimeout: () => void },
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    if (controls) {
      state.clearIdleTimeout = controls.clearIdleTimeout;
      state.resetIdleTimeout = controls.resetIdleTimeout;
    }
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * Starts the IDLE_BEFORE_EVICT → EVICTABLE → EVICTION_TIMEOUT chain.
   * If tasks are pending for this group, soft-stop immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (state.stopping) return;

    state.idleWaiting = true;

    // Clear the idle timeout in container-runner (no longer needed — we manage lifecycle)
    state.clearIdleTimeout?.();

    // If tasks pending for this group, preempt immediately
    if (state.pendingTasks.length > 0) {
      this.softStop(groupJid);
      return;
    }

    // Start IDLE_BEFORE_EVICT timer
    state.evictableAt = Date.now();
    this.clearEvictionTimer(state);
    state.evictionTimer = setTimeout(() => {
      // Transition: IDLE → EVICTABLE
      state.evictable = true;
      logger.debug({ groupJid }, 'Container now evictable');

      // Start EVICTION_TIMEOUT
      state.evictionTimer = setTimeout(() => {
        // EVICTION_TIMEOUT expired — stop container
        logger.info({ groupJid }, 'Eviction timeout expired, stopping container');
        this.softStop(groupJid);
      }, EVICTION_TIMEOUT);
    }, IDLE_BEFORE_EVICT);

    // If there are waiting groups, try to evict a different (older) container
    if (this.waitingGroups.length > 0) {
      this.evictOldest();
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer) return false;
    if (state.stopping) return false;

    // If idle or evictable, reactivate before sending
    if (state.idleWaiting || state.evictable) {
      this.reactivate(groupJid);
    }

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
   * Soft-stop: write _close sentinel and start grace timer.
   * Transition to STOPPING state.
   */
  softStop(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (state.stopping || !state.active) return;

    state.stopping = true;
    this.clearEvictionTimer(state);
    state.evictable = false;
    state.evictableAt = null;
    state.idleWaiting = false;

    // Clear the idle timeout so it doesn't fire during grace period
    state.clearIdleTimeout?.();

    logger.debug({ groupJid }, 'Soft-stopping container');
    this.writeCloseSentinel(state);

    // Start grace timer → hard stop if container doesn't exit
    state.graceTimer = setTimeout(() => {
      logger.warn({ groupJid }, 'Grace timeout expired, hard-stopping container');
      this.hardStop(groupJid);
    }, GRACE_TIMEOUT);
  }

  /**
   * Hard-stop: docker stop the container, fallback to SIGKILL.
   */
  hardStop(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.containerName && !state.process) return;

    state.stopping = true;

    if (state.containerName) {
      logger.info({ groupJid, containerName: state.containerName }, 'Hard-stopping container');
      exec(stopContainer(state.containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ groupJid, err }, 'docker stop failed, sending SIGKILL');
          state.process?.kill('SIGKILL');
        }
      });
    } else {
      state.process?.kill('SIGKILL');
    }
  }

  /**
   * Reactivate an IDLE or EVICTABLE container back to ACTIVE.
   */
  private reactivate(groupJid: string): void {
    const state = this.getGroup(groupJid);
    this.clearEvictionTimer(state);
    state.evictable = false;
    state.evictableAt = null;
    state.idleWaiting = false;

    // Restart the idle timeout in container-runner
    state.resetIdleTimeout?.();

    logger.debug({ groupJid }, 'Container reactivated');
  }

  /**
   * Evict the oldest EVICTABLE container to free a slot for waiting groups.
   * Throttled: no-op when stoppingCount >= waitingGroups.length.
   */
  private evictOldest(): boolean {
    const stoppingCount = this.getStoppingCount();
    if (stoppingCount >= this.waitingGroups.length) return false;

    let oldestJid: string | null = null;
    let oldestAt = Infinity;

    for (const [jid, state] of this.groups) {
      if (state.evictable && state.evictableAt != null && state.evictableAt < oldestAt) {
        oldestAt = state.evictableAt;
        oldestJid = jid;
      }
    }

    if (!oldestJid) return false;

    logger.info({ groupJid: oldestJid }, 'Evicting oldest idle container for queue pressure');
    this.softStop(oldestJid);
    return true;
  }

  private getStoppingCount(): number {
    let count = 0;
    for (const state of this.groups.values()) {
      if (state.stopping) count++;
    }
    return count;
  }

  /**
   * Write _close sentinel to signal the container to wind down.
   */
  private writeCloseSentinel(state: GroupState): void {
    if (!state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private clearEvictionTimer(state: GroupState): void {
    if (state.evictionTimer) {
      clearTimeout(state.evictionTimer);
      state.evictionTimer = null;
    }
  }

  private clearGraceTimer(state: GroupState): void {
    if (state.graceTimer) {
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }
  }

  /**
   * Reset all timer state for a group (called in runForGroup/runTask finally blocks).
   */
  private resetGroupTimers(state: GroupState): void {
    this.clearEvictionTimer(state);
    this.clearGraceTimer(state);
    state.evictable = false;
    state.evictableAt = null;
    state.stopping = false;
    state.clearIdleTimeout = null;
    state.resetIdleTimeout = null;
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
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
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.resetGroupTimers(state);
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
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
      this.resetGroupTimers(state);
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
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error({ groupJid, taskId: task.id, err }, 'Unhandled error in runTask (drain)'),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error({ groupJid, err }, 'Unhandled error in runForGroup (drain)'),
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
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error({ groupJid: nextJid, taskId: task.id, err }, 'Unhandled error in runTask (waiting)'),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Unhandled error in runForGroup (waiting)'),
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
    for (const [jid, state] of this.groups) {
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
