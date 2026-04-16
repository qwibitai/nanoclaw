import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  WARM_POOL_SIZE,
  WARM_POOL_IDLE_TIMEOUT,
} from './config.js';
import { eventBus } from './event-bus.js';
import type {
  TaskQueuedEvent,
  TaskStartedEvent,
  TaskCompleteEvent,
  PoolWarmCreatedEvent,
  PoolWarmUsedEvent,
  PoolWarmEvictedEvent,
} from './events.js';
import { logger } from './logger.js';
import { PriorityQueue, type TaskPriority } from './priority-queue.js';

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
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

interface WarmSlot {
  id: string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * ExecutorPool — priority-aware task executor with warm pool support.
 *
 * Replaces GroupQueue with:
 * - Three-level priority queue (interactive > scheduled > proactive) instead of flat FIFO
 * - Warm pool slot reservations for faster container starts
 * - Event emission on all state transitions
 */
export class ExecutorPool {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingQueue = new PriorityQueue<string>();
  /** Track which groups are in the waiting queue to prevent double-enqueue */
  private waitingGroupSet = new Set<string>();
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  // Warm pool: counter-based slot reservation system.
  // Actual container spawning is owned by index.ts (processMessagesFn / runTask).
  // Warm slots reserve concurrency capacity so tasks get faster starts.
  private warmSlots: WarmSlot[] = [];
  private warmSlotCounter = 0;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
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
        groupFolder: null,
        retryCount: 0,
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
      if (!this.waitingGroupSet.has(groupJid)) {
        this.waitingQueue.enqueue(groupJid, 'interactive', groupJid);
        this.waitingGroupSet.add(groupJid);
      }
      const queuedEvent: TaskQueuedEvent = {
        type: 'task.queued',
        source: 'executor',
        groupId: groupJid,
        timestamp: Date.now(),
        payload: {
          taskId: `msg-${groupJid}-${Date.now()}`,
          groupJid,
          priority: 'interactive',
          queuePosition: this.waitingQueue.size(),
        },
      };
      eventBus.emit('task.queued', queuedEvent);
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
    priority: TaskPriority = 'scheduled',
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
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
      if (!this.waitingGroupSet.has(groupJid)) {
        this.waitingQueue.enqueue(groupJid, priority, groupJid);
        this.waitingGroupSet.add(groupJid);
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
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
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
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  // --- Warm pool management ---

  /**
   * Initialize the warm pool by creating slot reservations.
   * Each warm slot represents a reserved concurrency slot that can be
   * claimed by incoming tasks for faster starts.
   */
  initWarmPool(): void {
    if (this.shuttingDown) return;

    const slotsToCreate = Math.min(
      WARM_POOL_SIZE,
      MAX_CONCURRENT_CONTAINERS - this.activeCount - this.warmSlots.length,
    );

    for (let i = 0; i < slotsToCreate; i++) {
      this.createWarmSlot();
    }

    logger.info(
      { warmSlots: this.warmSlots.length, target: WARM_POOL_SIZE },
      'Warm pool initialized',
    );
  }

  private createWarmSlot(): void {
    if (this.shuttingDown) return;

    const id = `warm-${++this.warmSlotCounter}-${Date.now()}`;
    const slot: WarmSlot = {
      id,
      createdAt: Date.now(),
      timer: null,
    };

    // Set idle timeout to evict stale warm slots
    slot.timer = setTimeout(() => {
      this.evictWarmSlot(slot, 'idle_timeout');
    }, WARM_POOL_IDLE_TIMEOUT);

    this.warmSlots.push(slot);

    const createdEvent: PoolWarmCreatedEvent = {
      type: 'pool.warm.created',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        containerId: id,
        poolSize: this.warmSlots.length,
      },
    };
    eventBus.emit('pool.warm.created', createdEvent);

    logger.debug(
      { slotId: id, poolSize: this.warmSlots.length },
      'Warm slot created',
    );
  }

  /**
   * Try to claim a warm slot for a task. Returns the slot if available, null otherwise.
   */
  private claimWarmSlot(groupJid: string, taskId: string): WarmSlot | null {
    if (this.warmSlots.length === 0) return null;

    const slot = this.warmSlots.shift()!;
    if (slot.timer) clearTimeout(slot.timer);

    const usedEvent: PoolWarmUsedEvent = {
      type: 'pool.warm.used',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        containerId: slot.id,
        groupJid,
        taskId,
      },
    };
    eventBus.emit('pool.warm.used', usedEvent);

    logger.debug(
      {
        slotId: slot.id,
        groupJid,
        taskId,
        remainingSlots: this.warmSlots.length,
      },
      'Warm slot claimed',
    );

    // Async replace the consumed slot
    setTimeout(() => this.replenishWarmPool(), 0);

    return slot;
  }

  private evictWarmSlot(
    slot: WarmSlot,
    reason: 'idle_timeout' | 'crash' | 'shutdown',
  ): void {
    const idx = this.warmSlots.indexOf(slot);
    if (idx < 0) return; // Already removed

    this.warmSlots.splice(idx, 1);
    if (slot.timer) clearTimeout(slot.timer);

    const evictedEvent: PoolWarmEvictedEvent = {
      type: 'pool.warm.evicted',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        containerId: slot.id,
        reason,
      },
    };
    eventBus.emit('pool.warm.evicted', evictedEvent);

    logger.debug(
      { slotId: slot.id, reason, remainingSlots: this.warmSlots.length },
      'Warm slot evicted',
    );

    // Replace evicted slot (unless shutting down or evicted for shutdown)
    if (reason !== 'shutdown' && !this.shuttingDown) {
      this.replenishWarmPool();
    }
  }

  private replenishWarmPool(): void {
    if (this.shuttingDown) return;

    const deficit = WARM_POOL_SIZE - this.warmSlots.length;
    const available =
      MAX_CONCURRENT_CONTAINERS - this.activeCount - this.warmSlots.length;
    const toCreate = Math.min(deficit, available);

    for (let i = 0; i < toCreate; i++) {
      this.createWarmSlot();
    }
  }

  // --- Core execution ---

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

    const taskId = `msg-${groupJid}-${Date.now()}`;
    const startMs = Date.now();

    // Try to claim a warm slot
    this.claimWarmSlot(groupJid, taskId);

    const startedEvent: TaskStartedEvent = {
      type: 'task.started',
      source: 'executor',
      groupId: groupJid,
      timestamp: startMs,
      payload: {
        taskId,
        groupJid,
        containerName: '',
        slotIndex: this.activeCount - 1,
      },
    };
    eventBus.emit('task.started', startedEvent);

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    let success = false;
    try {
      if (this.processMessagesFn) {
        success = await this.processMessagesFn(groupJid);
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
      const completeEvent: TaskCompleteEvent = {
        type: 'task.complete',
        source: 'executor',
        groupId: groupJid,
        timestamp: Date.now(),
        payload: {
          taskId,
          groupJid,
          status: success ? 'success' : 'error',
          durationMs: Date.now() - startMs,
        },
      };
      eventBus.emit('task.complete', completeEvent);

      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    const startMs = Date.now();

    // Try to claim a warm slot
    this.claimWarmSlot(groupJid, task.id);

    const startedEvent: TaskStartedEvent = {
      type: 'task.started',
      source: 'executor',
      groupId: groupJid,
      timestamp: startMs,
      payload: {
        taskId: task.id,
        groupJid,
        containerName: '',
        slotIndex: this.activeCount - 1,
      },
    };
    eventBus.emit('task.started', startedEvent);

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    let taskSuccess = true;
    try {
      await task.fn();
    } catch (err) {
      taskSuccess = false;
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      const completeEvent: TaskCompleteEvent = {
        type: 'task.complete',
        source: 'executor',
        groupId: groupJid,
        timestamp: Date.now(),
        payload: {
          taskId: task.id,
          groupJid,
          status: taskSuccess ? 'success' : 'error',
          durationMs: Date.now() - startMs,
        },
      };
      eventBus.emit('task.complete', completeEvent);

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
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
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
      !this.waitingQueue.isEmpty() &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const result = this.waitingQueue.dequeue();
      if (!result) break;

      const nextJid = result.item;
      this.waitingGroupSet.delete(nextJid);
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  getWarmSlotCount(): number {
    return this.warmSlots.length;
  }

  simulateWarmSlotCrash(index: number): void {
    const slot = this.warmSlots[index];
    if (!slot) return;
    this.evictWarmSlot(slot, 'crash');
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Evict all warm slots
    const slotsToEvict = [...this.warmSlots];
    for (const slot of slotsToEvict) {
      this.evictWarmSlot(slot, 'shutdown');
    }

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'ExecutorPool shutting down (containers detached, not killed)',
    );
  }
}
