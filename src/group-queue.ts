import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: (containerId: string) => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

// Internal to GroupQueue — represents a single container running for a group.
// Multiple ContainerSlots can exist per group, enabling concurrent containers.
interface ContainerSlot {
  containerId: string; // unique ID for this slot (generated at spawn time)
  type: 'message' | 'task';
  idleWaiting: boolean;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  runningTaskId: string | null;
}

interface GroupState {
  containers: Map<string, ContainerSlot>; // containerId -> slot
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  retryCount: number;
}

// Monotonic counter for generating unique container IDs within a process lifetime
let slotCounter = 0;

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupJid: string, containerId: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;
  private onContainerStartFn:
    | ((
        groupFolder: string,
        session: { containerId: string; type: 'message' | 'task' },
      ) => void)
    | null = null;
  private onContainerExitFn:
    | ((groupFolder: string, containerId: string) => void)
    | null = null;

  // Tracks which containerId is being registered during processMessagesFn callback.
  // Safe because Node.js is single-threaded: between runForGroup starting and
  // registerProcess being called (within the same async chain), no other
  // registration can interleave for the same groupJid.
  private pendingRegistrations = new Map<string, string>(); // groupJid -> containerId

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        containers: new Map(),
        pendingMessages: false,
        pendingTasks: [],
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  /**
   * Find an idle non-task container in the group.
   * Returns the first idle message-type container, or undefined if none.
   */
  private findIdleContainer(state: GroupState): ContainerSlot | undefined {
    for (const slot of state.containers.values()) {
      if (slot.idleWaiting && slot.type === 'message') {
        return slot;
      }
    }
    return undefined;
  }

  setProcessMessagesFn(
    fn: (groupJid: string, containerId: string) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  setOnContainerStart(
    fn: (
      groupFolder: string,
      session: { containerId: string; type: 'message' | 'task' },
    ) => void,
  ): void {
    this.onContainerStartFn = fn;
  }

  setOnContainerExit(
    fn: (groupFolder: string, containerId: string) => void,
  ): void {
    this.onContainerExitFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // EDGE CASE 2: Check idle containers BEFORE global cap. Reuse doesn't cost
    // a new slot (container already counted in activeCount), so a group can always
    // reuse its own idle container even when at the global cap.
    const idleContainer = this.findIdleContainer(state);
    if (idleContainer) {
      state.pendingMessages = true;
      logger.debug(
        { groupJid, containerId: idleContainer.containerId },
        'Idle container available, message queued for reuse',
      );
      return;
    }

    // No idle container — check global cap before spawning a new one
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

    // Spawn a new container — even if others are already running for this group.
    // EDGE CASE 1: runForGroup creates the slot synchronously (before awaiting),
    // so a second enqueueMessageCheck sees the new slot with idleWaiting=false
    // and won't mistake it for an idle container.
    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: (containerId: string) => Promise<void>,
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // EDGE CASE 5: Dedup must scan ALL container slots for the group, not just
    // a single field. A task might be running in any of the group's containers.
    for (const slot of state.containers.values()) {
      if (slot.runningTaskId === taskId) {
        logger.debug({ groupJid, taskId }, 'Task already running, skipping');
        return;
      }
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    // If group has containers running, queue the task and preempt any idle one
    if (state.containers.size > 0) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      const idleContainer = this.findIdleContainer(state);
      if (idleContainer) {
        // Preempt idle container so it exits, freeing a slot for the task
        this.closeStdinForSlot(idleContainer);
      }
      logger.debug({ groupJid, taskId }, 'Containers active, task queued');
      return;
    }

    // No containers running — check global cap
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
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  /**
   * Register a container process against a specific slot.
   *
   * When called with a `containerId`, registers directly against that slot.
   * When called without (backward compat), uses the pending registration
   * from the most recent runForGroup/runTask call for this group.
   */
  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    containerId?: string,
  ): void {
    const state = this.getGroup(groupJid);

    // Resolve the target container slot
    const targetId = containerId ?? this.pendingRegistrations.get(groupJid);
    if (targetId) {
      this.pendingRegistrations.delete(groupJid);
    }

    const slot = targetId ? state.containers.get(targetId) : undefined;
    if (slot) {
      slot.process = proc;
      slot.containerName = containerName;
      if (groupFolder) slot.groupFolder = groupFolder;

      // Notify session awareness — container is now registered and running
      if (groupFolder && this.onContainerStartFn) {
        this.onContainerStartFn(groupFolder, {
          containerId: slot.containerId,
          type: slot.type,
        });
      }
    } else {
      // Fallback: no matching slot found. This shouldn't happen in normal flow
      // but log a warning rather than silently dropping.
      logger.warn(
        { groupJid, containerName, containerId: targetId },
        'registerProcess: no matching container slot found',
      );
    }
  }

  /**
   * Mark a specific container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt this container immediately.
   *
   * When called with containerId, targets that specific slot.
   * When called without (backward compat), targets the first non-idle message container.
   */
  notifyIdle(groupJid: string, containerId?: string): void {
    const state = this.getGroup(groupJid);

    let slot: ContainerSlot | undefined;
    if (containerId) {
      slot = state.containers.get(containerId);
    } else {
      // Backward compat: find the most recently active message container
      // that isn't already idle
      for (const s of state.containers.values()) {
        if (s.type === 'message' && !s.idleWaiting) {
          slot = s;
          break;
        }
      }
    }

    if (!slot) return;

    slot.idleWaiting = true;

    if (state.pendingTasks.length > 0) {
      this.closeStdinForSlot(slot);
    }
  }

  /**
   * Send a follow-up message to an idle non-task container via IPC file.
   * Finds any idle message-type container in the group and pipes to it.
   * Returns true if the message was written, false if no suitable container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);

    // EDGE CASE 4: Multiple idle containers may exist for the same group.
    // Pick the first — others stay idle and will eventually time out via
    // the container's own idle timeout mechanism.
    const slot = this.findIdleContainer(state);
    if (!slot || !slot.groupFolder) return false;

    slot.idleWaiting = false; // Container is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', slot.groupFolder, 'input');
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
   * Signal a container to wind down by writing a close sentinel.
   *
   * When called with containerId, closes that specific container.
   * When called without (backward compat), closes the first idle container
   * for the group — or the first container if none are idle.
   */
  closeStdin(groupJid: string, containerId?: string): void {
    const state = this.getGroup(groupJid);

    if (containerId) {
      const slot = state.containers.get(containerId);
      if (slot) this.closeStdinForSlot(slot);
      return;
    }

    // Backward compat: find first idle container, or first container if none idle
    const idleSlot = this.findIdleContainer(state);
    if (idleSlot) {
      this.closeStdinForSlot(idleSlot);
      return;
    }

    // No idle container — close the first message container we find
    for (const slot of state.containers.values()) {
      if (slot.type === 'message' && slot.groupFolder) {
        this.closeStdinForSlot(slot);
        return;
      }
    }
  }

  /**
   * Write the close sentinel for a specific container slot.
   */
  private closeStdinForSlot(slot: ContainerSlot): void {
    if (!slot.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', slot.groupFolder, 'input');
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

    // Generate a unique container ID for this slot
    const containerId = `${groupJid}-${Date.now()}-${++slotCounter}`;
    const slot: ContainerSlot = {
      containerId,
      type: 'message',
      idleWaiting: false,
      process: null,
      containerName: null,
      groupFolder: null,
      runningTaskId: null,
    };

    state.containers.set(containerId, slot);
    state.pendingMessages = false;
    this.activeCount++;

    // Store pending registration so registerProcess can find this slot.
    // Safe in single-threaded Node.js: registerProcess is called synchronously
    // within processMessagesFn's callback chain before any other runForGroup
    // for the same group could overwrite this.
    this.pendingRegistrations.set(groupJid, containerId);

    logger.debug(
      {
        groupJid,
        containerId,
        reason,
        activeCount: this.activeCount,
        groupContainers: state.containers.size,
      },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, containerId);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error(
        { groupJid, containerId, err },
        'Error processing messages for group',
      );
      this.scheduleRetry(groupJid, state);
    } finally {
      // Notify session awareness — container is exiting
      if (slot.groupFolder && this.onContainerExitFn) {
        this.onContainerExitFn(slot.groupFolder, containerId);
      }

      // EDGE CASE 3: Always clean up this specific slot in finally — even if
      // processMessagesFn throws. No orphan slots possible. Other containers
      // for this group are completely unaffected.
      state.containers.delete(containerId);
      this.pendingRegistrations.delete(groupJid);
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);

    // Generate a unique container ID for this task slot
    const containerId = `${groupJid}-task-${Date.now()}-${++slotCounter}`;
    const slot: ContainerSlot = {
      containerId,
      type: 'task',
      idleWaiting: false,
      process: null,
      containerName: null,
      groupFolder: null,
      runningTaskId: task.id,
    };

    state.containers.set(containerId, slot);
    this.activeCount++;

    // Store pending registration for task container
    this.pendingRegistrations.set(groupJid, containerId);

    logger.debug(
      {
        groupJid,
        containerId,
        taskId: task.id,
        activeCount: this.activeCount,
        groupContainers: state.containers.size,
      },
      'Running queued task',
    );

    try {
      await task.fn(containerId);
    } catch (err) {
      logger.error(
        { groupJid, taskId: task.id, containerId, err },
        'Error running task',
      );
    } finally {
      // Notify session awareness — task container is exiting
      if (slot.groupFolder && this.onContainerExitFn) {
        this.onContainerExitFn(slot.groupFolder, containerId);
      }

      // EDGE CASE 3: Always clean up in finally — no orphan task slots possible.
      state.containers.delete(containerId);
      this.pendingRegistrations.delete(groupJid);
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

  /**
   * After a container finishes, check if there's pending work for this group.
   *
   * EDGE CASE 6: Only starts new containers when there are pending items AND
   * room under the global cap. Does NOT interfere with other still-running
   * containers for the same group — each container's lifecycle is independent.
   */
  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (
      state.pendingTasks.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages — only spawn if under global cap
    if (state.pendingMessages && this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group (or at cap); check if other groups are waiting
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritise tasks over messages
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

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers across all groups but don't kill them — they'll
    // finish on their own via idle timeout or container timeout.
    // The --rm flag cleans them up on exit. This prevents WhatsApp
    // reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      for (const slot of state.containers.values()) {
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
