import fs from 'fs';
import path from 'path';

import type { AgentBackend } from './backends/types.js';
import { DATA_DIR, MAX_CONCURRENT_CONTAINERS, MAX_TASK_CONTAINERS } from './config.js';
import { logger } from './logger.js';
import { ContainerProcess } from './types.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
  promptPreview: string;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

export type Lane = 'message' | 'task';

interface ActiveTaskInfo {
  taskId: string;
  promptPreview: string;
  startedAt: number;
}

interface GroupState {
  // Message lane
  messageActive: boolean;
  messagePendingMessages: boolean;
  messageProcess: ContainerProcess | null;
  messageContainerName: string | null;
  messageGroupFolder: string | null;
  messageBackend: AgentBackend | null;
  retryCount: number;

  // Task lane
  taskActive: boolean;
  pendingTasks: QueuedTask[];
  taskProcess: ContainerProcess | null;
  taskContainerName: string | null;
  taskGroupFolder: string | null;
  taskBackend: AgentBackend | null;

  // Tracking for context injection
  activeTaskInfo: ActiveTaskInfo | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private activeTaskCount = 0;
  private waitingMessageGroups: string[] = [];
  private waitingTaskGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        messageActive: false,
        messagePendingMessages: false,
        messageProcess: null,
        messageContainerName: null,
        messageGroupFolder: null,
        messageBackend: null,
        retryCount: 0,

        taskActive: false,
        pendingTasks: [],
        taskProcess: null,
        taskContainerName: null,
        taskGroupFolder: null,
        taskBackend: null,

        activeTaskInfo: null,
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

    // Only check the message lane — task lane is independent
    if (state.messageActive) {
      state.messagePendingMessages = true;
      logger.debug({ groupJid }, 'Message container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.messagePendingMessages = true;
      if (!this.waitingMessageGroups.includes(groupJid)) {
        this.waitingMessageGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages');
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>, promptPreview: string = ''): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    // If task lane is already active for this group, queue the task
    if (state.taskActive) {
      state.pendingTasks.push({ id: taskId, groupJid, fn, promptPreview });
      logger.debug({ groupJid, taskId }, 'Task container active, task queued');
      return;
    }

    // Check both global limit and task-specific limit
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS || this.activeTaskCount >= MAX_TASK_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn, promptPreview });
      if (!this.waitingTaskGroups.includes(groupJid)) {
        this.waitingTaskGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount, activeTaskCount: this.activeTaskCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn, promptPreview });
  }

  registerProcess(groupJid: string, proc: ContainerProcess, containerName: string, groupFolder?: string, backend?: AgentBackend, lane: Lane = 'message'): void {
    const state = this.getGroup(groupJid);
    if (lane === 'message') {
      state.messageProcess = proc;
      state.messageContainerName = containerName;
      if (groupFolder) state.messageGroupFolder = groupFolder;
      if (backend) state.messageBackend = backend;
    } else {
      state.taskProcess = proc;
      state.taskContainerName = containerName;
      if (groupFolder) state.taskGroupFolder = groupFolder;
      if (backend) state.taskBackend = backend;
    }
  }

  /**
   * Send a follow-up message to the active message container via IPC.
   * Delegates to the backend if one is registered (supports local + cloud).
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.messageActive || !state.messageGroupFolder) return false;

    // Delegate to backend if available (handles both local and cloud)
    if (state.messageBackend) {
      return state.messageBackend.sendMessage(state.messageGroupFolder, text);
    }

    // Fallback: direct local filesystem write
    const inputDir = path.join(DATA_DIR, 'ipc', state.messageGroupFolder, 'input');
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
   * Signal the active container on a specific lane to wind down.
   * Delegates to the backend if one is registered.
   */
  closeStdin(groupJid: string, lane: Lane = 'message'): void {
    const state = this.getGroup(groupJid);

    const active = lane === 'message' ? state.messageActive : state.taskActive;
    const groupFolder = lane === 'message' ? state.messageGroupFolder : state.taskGroupFolder;
    const backend = lane === 'message' ? state.messageBackend : state.taskBackend;

    if (!active || !groupFolder) return;

    // Delegate to backend if available
    if (backend) {
      const inputSubdir = lane === 'task' ? 'input-task' : 'input';
      backend.closeStdin(groupFolder, inputSubdir);
      return;
    }

    // Fallback: direct local filesystem write
    const inputSubdir = lane === 'task' ? 'input-task' : 'input';
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, inputSubdir);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Get info about the currently running task for a group.
   * Used for context injection into message prompts.
   */
  getActiveTaskInfo(groupJid: string): ActiveTaskInfo | null {
    const state = this.groups.get(groupJid);
    return state?.activeTaskInfo ?? null;
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.messageActive = true;
    state.messagePendingMessages = false;
    this.activeCount++;

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
      state.messageActive = false;
      state.messageProcess = null;
      state.messageContainerName = null;
      state.messageGroupFolder = null;
      state.messageBackend = null;
      this.activeCount--;
      this.drainMessageLane(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.taskActive = true;
    state.activeTaskInfo = {
      taskId: task.id,
      promptPreview: task.promptPreview,
      startedAt: Date.now(),
    };
    this.activeCount++;
    this.activeTaskCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount, activeTaskCount: this.activeTaskCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.taskActive = false;
      state.activeTaskInfo = null;
      state.taskProcess = null;
      state.taskContainerName = null;
      state.taskGroupFolder = null;
      state.taskBackend = null;
      this.activeCount--;
      this.activeTaskCount--;
      this.drainTaskLane(groupJid);
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

  /** Drain pending messages for a group's message lane, then try other waiting groups. */
  private drainMessageLane(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (state.messagePendingMessages) {
      this.runForGroup(groupJid, 'drain');
      // A global slot was freed and immediately re-used; also try draining waiting tasks
      this.drainWaitingTasks();
      return;
    }

    // Nothing pending for this group; a global slot freed up — drain both waiting lists
    this.drainWaitingMessages();
    this.drainWaitingTasks();
  }

  /** Drain pending tasks for a group's task lane, then try other waiting groups. */
  private drainTaskLane(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (state.pendingTasks.length > 0) {
      // Check task concurrency limits before starting next task
      if (this.activeCount < MAX_CONCURRENT_CONTAINERS && this.activeTaskCount < MAX_TASK_CONTAINERS) {
        const task = state.pendingTasks.shift()!;
        this.runTask(groupJid, task);
        // A global slot was freed and immediately re-used; also try draining waiting messages
        this.drainWaitingMessages();
        return;
      }
      // Can't run now — put back in waiting list
      if (!this.waitingTaskGroups.includes(groupJid)) {
        this.waitingTaskGroups.push(groupJid);
      }
      return;
    }

    // Nothing pending for this group; a global slot freed up — drain both waiting lists
    this.drainWaitingMessages();
    this.drainWaitingTasks();
  }

  private drainWaitingMessages(): void {
    while (
      this.waitingMessageGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingMessageGroups.shift()!;
      const state = this.getGroup(nextJid);

      if (state.messagePendingMessages) {
        this.runForGroup(nextJid, 'drain');
      }
    }
  }

  private drainWaitingTasks(): void {
    while (
      this.waitingTaskGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS &&
      this.activeTaskCount < MAX_TASK_CONTAINERS
    ) {
      const nextJid = this.waitingTaskGroups.shift()!;
      const state = this.getGroup(nextJid);

      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task);
      }
    }
  }

  /** Check if a specific lane is active for a group. */
  isActive(key: string, lane?: Lane): boolean {
    const state = this.groups.get(key);
    if (!state) return false;
    if (lane === 'message') return state.messageActive;
    if (lane === 'task') return state.taskActive;
    // No lane specified: return true if either lane is active
    return state.messageActive || state.taskActive;
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.messageProcess && !state.messageProcess.killed && state.messageContainerName) {
        activeContainers.push(state.messageContainerName);
      }
      if (state.taskProcess && !state.taskProcess.killed && state.taskContainerName) {
        activeContainers.push(state.taskContainerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
