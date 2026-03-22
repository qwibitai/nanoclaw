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

/**
 * Priority tiers for the unified waiting queue.
 * Lower number = higher priority.
 */
const PRIORITY_MAIN_MESSAGE = 0;
const PRIORITY_MESSAGE = 1;
const PRIORITY_TASK = 2;

interface WaitingEntry {
  groupJid: string;
  type: 'message' | 'task';
  priority: number;
  task?: QueuedTask;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

/**
 * Per-group state with separate tracking for message and task containers.
 *
 * Messages and tasks run in independent "lanes" within each group so a
 * long-running background task never blocks the user from getting a quick
 * response.  All lanes share a single global concurrency pool with
 * priority-based scheduling and a soft-reserved slot for the main group.
 */
interface GroupState {
  // Message lane
  activeMessage: boolean;
  idleWaiting: boolean;
  pendingMessages: boolean;
  messageProcess: ChildProcess | null;
  messageContainerName: string | null;
  messageGroupFolder: string | null;
  retryCount: number;

  // Task lane
  activeTask: boolean;
  runningTaskId: string | null;
  pendingTasks: QueuedTask[];
  taskProcess: ChildProcess | null;
  taskContainerName: string | null;
  taskGroupFolder: string | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingQueue: WaitingEntry[] = [];
  private mainGroupJid: string | null = null;
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        activeMessage: false,
        idleWaiting: false,
        pendingMessages: false,
        messageProcess: null,
        messageContainerName: null,
        messageGroupFolder: null,
        retryCount: 0,

        activeTask: false,
        runningTaskId: null,
        pendingTasks: [],
        taskProcess: null,
        taskContainerName: null,
        taskGroupFolder: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  // ── Priority / capacity helpers ──────────────────────────────────────

  /**
   * Set the main group JID for priority scheduling.
   * The main group gets a soft-reserved slot and highest queue priority.
   */
  setMainGroup(jid: string): void {
    this.mainGroupJid = jid;
    logger.info({ mainGroupJid: jid }, 'Main group set for queue priority');
  }

  /**
   * Whether the main group can start a new container.
   * Main can use ALL slots (including the reserved one).
   */
  private canStartMain(): boolean {
    return this.activeCount < MAX_CONCURRENT_CONTAINERS;
  }

  /**
   * Whether a non-main group can start a new container.
   * When the main group has pending work, one slot is reserved for it.
   * When the main group is idle, all slots are available.
   */
  private canStartNonMain(): boolean {
    const limit = this.mainHasPending()
      ? MAX_CONCURRENT_CONTAINERS - 1
      : MAX_CONCURRENT_CONTAINERS;
    return this.activeCount < limit;
  }

  /**
   * Check if the main group has any pending work (messages or tasks)
   * that could need the reserved slot.
   */
  private mainHasPending(): boolean {
    if (!this.mainGroupJid) return false;
    const state = this.groups.get(this.mainGroupJid);
    if (!state) return false;
    return state.pendingMessages || state.pendingTasks.length > 0;
  }

  /**
   * Insert an entry into the waiting queue, sorted by priority.
   * Within the same priority, entries are FIFO (appended after existing same-priority entries).
   */
  private addToWaitingQueue(entry: WaitingEntry): void {
    // Deduplicate: don't add if an identical entry already exists
    const isDuplicate = this.waitingQueue.some(
      (e) =>
        e.groupJid === entry.groupJid &&
        e.type === entry.type &&
        (entry.type === 'message' || e.task?.id === entry.task?.id),
    );
    if (isDuplicate) return;

    const idx = this.waitingQueue.findIndex((e) => e.priority > entry.priority);
    if (idx === -1) {
      this.waitingQueue.push(entry);
    } else {
      this.waitingQueue.splice(idx, 0, entry);
    }
  }

  /**
   * Try to preempt an idle-waiting container to free a slot for main.
   * Prefers non-main idle containers. Returns true if a preemption was initiated.
   */
  private preemptIdleContainer(): boolean {
    // Prefer non-main idle containers
    for (const [jid, state] of this.groups) {
      if (jid === this.mainGroupJid) continue;
      if (state.activeMessage && state.idleWaiting) {
        logger.info(
          { preemptedJid: jid },
          'Preempting idle container to free slot for main group',
        );
        this.closeStdin(jid);
        return true;
      }
    }
    // Last resort: preempt main's own idle container (e.g., old session)
    if (this.mainGroupJid) {
      const mainState = this.groups.get(this.mainGroupJid);
      if (mainState?.activeMessage && mainState.idleWaiting) {
        logger.info(
          'Preempting main group idle container for new main message',
        );
        this.closeStdin(this.mainGroupJid);
        return true;
      }
    }
    return false;
  }

  // ── Public API ───────────────────────────────────────────────────────

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) {
      logger.warn(
        { groupJid },
        'Message check enqueue rejected: queue shutting down',
      );
      return;
    }

    const state = this.getGroup(groupJid);

    if (state.activeMessage) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Message container active, message queued');
      return;
    }

    const isMain = groupJid === this.mainGroupJid;
    const canStart = isMain ? this.canStartMain() : this.canStartNonMain();

    if (!canStart) {
      state.pendingMessages = true;

      // Main message at full capacity: try to preempt an idle container
      if (isMain) {
        this.preemptIdleContainer();
      }

      this.addToWaitingQueue({
        groupJid,
        type: 'message',
        priority: isMain ? PRIORITY_MAIN_MESSAGE : PRIORITY_MESSAGE,
      });
      logger.debug(
        {
          groupJid,
          activeCount: this.activeCount,
          isMain,
          waitingDepth: this.waitingQueue.length,
        },
        'At concurrency limit, message queued',
      );
      return;
    }

    // Increment synchronously to prevent concurrency overshoot
    state.activeMessage = true;
    state.idleWaiting = false;
    state.pendingMessages = false;
    this.activeCount++;
    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) {
      logger.warn(
        { groupJid, taskId },
        'Task enqueue rejected: queue shutting down (task will be skipped)',
      );
      return;
    }

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.info(
        { groupJid, taskId },
        'Task already queued, skipping duplicate',
      );
      return;
    }
    // Also check the global waiting queue for duplicate tasks
    if (
      this.waitingQueue.some(
        (e) =>
          e.type === 'task' && e.groupJid === groupJid && e.task?.id === taskId,
      )
    ) {
      logger.info(
        { groupJid, taskId },
        'Task already in waiting queue, skipping duplicate',
      );
      return;
    }

    if (state.activeTask) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      logger.info(
        { groupJid, taskId, queueDepth: state.pendingTasks.length },
        'Task queued behind active task container',
      );
      return;
    }

    // If a message container is idle-waiting and a task arrives, preempt the
    // idle message container so it finishes quickly and frees its slot.
    if (state.activeMessage && state.idleWaiting) {
      this.closeStdin(groupJid);
    }

    const canStart = this.canStartNonMain();

    if (!canStart) {
      const task = { id: taskId, groupJid, fn };
      this.addToWaitingQueue({
        groupJid,
        type: 'task',
        priority: PRIORITY_TASK,
        task,
      });
      logger.info(
        {
          groupJid,
          taskId,
          activeCount: this.activeCount,
          maxConcurrent: MAX_CONCURRENT_CONTAINERS,
          waitingDepth: this.waitingQueue.length,
        },
        'At concurrency limit, task queued (will run when slot available)',
      );
      return;
    }

    // Run immediately -- increment synchronously to prevent concurrency overshoot
    state.activeTask = true;
    state.runningTaskId = taskId;
    this.activeCount++;
    logger.info(
      { groupJid, taskId, activeCount: this.activeCount },
      'Task starting immediately',
    );
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    lane: 'message' | 'task' = 'message',
  ): void {
    const state = this.getGroup(groupJid);
    if (lane === 'task') {
      state.taskProcess = proc;
      state.taskContainerName = containerName;
      if (groupFolder) state.taskGroupFolder = groupFolder;
    } else {
      state.messageProcess = proc;
      state.messageContainerName = containerName;
      if (groupFolder) state.messageGroupFolder = groupFolder;
    }
  }

  /**
   * Mark the message container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending (either per-group or in the global waiting queue) and no
   * task container is running, preempt the idle message container to free a slot.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;

    const hasLocalPendingTasks =
      state.pendingTasks.length > 0 && !state.activeTask;
    const hasGlobalPendingTasks = this.waitingQueue.some(
      (e) => e.type === 'task' && e.groupJid === groupJid,
    );

    if (hasLocalPendingTasks || hasGlobalPendingTasks) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active message container via IPC file.
   * Returns true if the message was written, false if no active message container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.activeMessage || !state.messageGroupFolder) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      state.messageGroupFolder,
      'input',
    );
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
   * Signal the active message container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.activeMessage || !state.messageGroupFolder) return;

    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      state.messageGroupFolder,
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
   * Signal the active task container to wind down by writing a close sentinel.
   */
  closeTaskStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.activeTask || !state.taskGroupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.taskGroupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Mark the task container as having completed its work.
   * Unlike message containers, task containers don't have an idle-waiting concept,
   * so this is a no-op for state but could be used for future task lifecycle tracking.
   */
  notifyTaskIdle(_groupJid: string): void {
    // Task containers are single-turn -- no idle waiting state to manage.
    // The task scheduler handles closing via closeTaskStdin.
  }

  // ── Internal runners ─────────────────────────────────────────────────

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    // activeMessage, idleWaiting, pendingMessages, and activeCount are now set
    // synchronously by the caller to prevent concurrency overshoot.

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting message container for group',
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
      state.activeMessage = false;
      state.messageProcess = null;
      state.messageContainerName = null;
      state.messageGroupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    // activeTask, runningTaskId, and activeCount are now set synchronously by
    // the caller to prevent concurrency overshoot.

    logger.info(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running task in separate container',
    );

    const taskStart = Date.now();
    try {
      await task.fn();
      logger.info(
        { groupJid, taskId: task.id, durationMs: Date.now() - taskStart },
        'Task container finished',
      );
    } catch (err) {
      logger.error(
        { groupJid, taskId: task.id, durationMs: Date.now() - taskStart, err },
        'Error running task',
      );
    } finally {
      state.activeTask = false;
      state.runningTaskId = null;
      state.taskProcess = null;
      state.taskContainerName = null;
      state.taskGroupFolder = null;
      this.activeCount--;
      logger.debug(
        {
          groupJid,
          taskId: task.id,
          activeCount: this.activeCount,
          pendingTasks: state.pendingTasks.length,
        },
        'Task slot released, draining group',
      );
      this.drainGroup(groupJid);
    }
  }

  getRetryCount(groupJid: string): number {
    const state = this.groups.get(groupJid);
    return state ? state.retryCount : 0;
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

  // ── Drain logic ──────────────────────────────────────────────────────

  /**
   * After a container finishes for a group, try to start any pending work
   * for that same group first, then check the global waiting queue.
   */
  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    const isMain = groupJid === this.mainGroupJid;

    // Messages first -- user-facing responses take priority over background tasks
    if (state.pendingMessages && !state.activeMessage) {
      const canStart = isMain ? this.canStartMain() : this.canStartNonMain();
      if (canStart) {
        state.activeMessage = true;
        state.idleWaiting = false;
        state.pendingMessages = false;
        this.activeCount++;
        this.runForGroup(groupJid, 'drain').catch((err) =>
          logger.error(
            { groupJid, err },
            'Unhandled error in runForGroup (drain)',
          ),
        );
      }
    }

    // Then pending tasks (per-group queue, independent of message lane)
    if (state.pendingTasks.length > 0 && !state.activeTask) {
      const canStart = this.canStartNonMain();
      if (canStart) {
        const task = state.pendingTasks.shift()!;
        state.activeTask = true;
        state.runningTaskId = task.id;
        this.activeCount++;
        logger.info(
          {
            groupJid,
            taskId: task.id,
            activeCount: this.activeCount,
            remainingTasks: state.pendingTasks.length,
          },
          'Draining pending task from queue',
        );
        this.runTask(groupJid, task).catch((err) =>
          logger.error(
            { groupJid, taskId: task.id, err },
            'Unhandled error in runTask (drain)',
          ),
        );
      } else {
        logger.debug(
          {
            groupJid,
            activeCount: this.activeCount,
            pendingTasks: state.pendingTasks.length,
          },
          'Cannot drain pending tasks: at concurrency limit',
        );
      }
    }

    // Check if other groups are waiting for a slot
    this.drainWaiting();
  }

  /**
   * Drain the global waiting queue in priority order.
   * Priority 0 (main messages) > 1 (other messages) > 2 (tasks).
   * Within the same priority, entries are FIFO.
   */
  private drainWaiting(): void {
    if (this.shuttingDown || this.waitingQueue.length === 0) return;

    let i = 0;
    while (i < this.waitingQueue.length) {
      const entry = this.waitingQueue[i];
      const state = this.getGroup(entry.groupJid);
      const isMainMessage =
        entry.groupJid === this.mainGroupJid && entry.type === 'message';
      const canStart = isMainMessage
        ? this.canStartMain()
        : this.canStartNonMain();

      if (!canStart) {
        // If even main can't start, nothing can -- stop draining
        if (isMainMessage) break;
        i++;
        continue;
      }

      // Check if this entry can actually start (no active lane conflict)
      if (entry.type === 'message') {
        if (state.activeMessage) {
          // Already has an active message container -- mark pending instead
          state.pendingMessages = true;
          this.waitingQueue.splice(i, 1);
          continue;
        }

        // Start message
        this.waitingQueue.splice(i, 1);
        state.activeMessage = true;
        state.idleWaiting = false;
        state.pendingMessages = false;
        this.activeCount++;
        this.runForGroup(entry.groupJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: entry.groupJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      } else {
        if (state.activeTask) {
          // Already has an active task container -- move to per-group queue
          if (entry.task) {
            state.pendingTasks.push(entry.task);
          }
          this.waitingQueue.splice(i, 1);
          continue;
        }

        // Start task
        this.waitingQueue.splice(i, 1);
        state.activeTask = true;
        state.runningTaskId = entry.task!.id;
        this.activeCount++;
        logger.info(
          {
            groupJid: entry.groupJid,
            taskId: entry.task!.id,
            activeCount: this.activeCount,
          },
          'Starting task from waiting queue',
        );
        this.runTask(entry.groupJid, entry.task!).catch((err) =>
          logger.error(
            { groupJid: entry.groupJid, taskId: entry.task!.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      }
    }
  }

  // ── Status / observability ───────────────────────────────────────────

  /**
   * Returns true when the group has an active message container that is not
   * idle-waiting.  Task containers are invisible to this check -- the user
   * should not be told "wait" just because a background task is running.
   */
  isBusy(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return !!state && state.activeMessage && !state.idleWaiting;
  }

  /**
   * Returns a snapshot of all active and pending work across all groups.
   * Used by the /status command to show background task execution state.
   */
  getStatus(): Array<{
    groupJid: string;
    activeMessage: boolean;
    idleWaiting: boolean;
    pendingMessages: boolean;
    activeTask: boolean;
    pendingTaskCount: number;
    messageContainerName: string | null;
    taskContainerName: string | null;
  }> {
    const result: Array<{
      groupJid: string;
      activeMessage: boolean;
      idleWaiting: boolean;
      pendingMessages: boolean;
      activeTask: boolean;
      pendingTaskCount: number;
      messageContainerName: string | null;
      taskContainerName: string | null;
    }> = [];
    for (const [groupJid, state] of this.groups) {
      if (
        state.activeMessage ||
        state.activeTask ||
        state.pendingMessages ||
        state.pendingTasks.length > 0
      ) {
        result.push({
          groupJid,
          activeMessage: state.activeMessage,
          idleWaiting: state.idleWaiting,
          pendingMessages: state.pendingMessages,
          activeTask: state.activeTask,
          pendingTaskCount: state.pendingTasks.length,
          messageContainerName: state.messageContainerName,
          taskContainerName: state.taskContainerName,
        });
      }
    }
    return result;
  }

  /**
   * Returns global queue metrics for observability.
   */
  getQueueMetrics(): {
    activeCount: number;
    maxContainers: number;
    waitingByPriority: {
      mainMessages: number;
      messages: number;
      tasks: number;
    };
    reservedSlotAvailable: boolean;
  } {
    let mainMessages = 0;
    let messages = 0;
    let tasks = 0;
    for (const entry of this.waitingQueue) {
      if (entry.priority === PRIORITY_MAIN_MESSAGE) mainMessages++;
      else if (entry.priority === PRIORITY_MESSAGE) messages++;
      else tasks++;
    }

    return {
      activeCount: this.activeCount,
      maxContainers: MAX_CONCURRENT_CONTAINERS,
      waitingByPriority: { mainMessages, messages, tasks },
      reservedSlotAvailable:
        this.activeCount < MAX_CONCURRENT_CONTAINERS && !this.mainHasPending(),
    };
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them -- they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (
        state.messageProcess &&
        !state.messageProcess.killed &&
        state.messageContainerName
      ) {
        activeContainers.push(state.messageContainerName);
      }
      if (
        state.taskProcess &&
        !state.taskProcess.killed &&
        state.taskContainerName
      ) {
        activeContainers.push(state.taskContainerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
