import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import {
  stopContainerWithVerification,
  stopRunningContainersByPrefix,
} from './container-runtime.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const DEAD_LETTER_RETRY_MS = 5 * 60 * 1000;

interface GroupState {
  active: boolean;
  activeSinceMs: number | null;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  activeRunId: string | null;
  retryCount: number;
}

interface AbortRunOptions {
  groupFolder?: string;
  activeContainerName?: string | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private deadLetterFile(groupJid: string): string {
    const safe = groupJid.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(DATA_DIR, 'dead-letter', 'message-retries', `${safe}.json`);
  }

  private persistDeadLetter(groupJid: string, retryCount: number, delayMs: number): void {
    try {
      const file = this.deadLetterFile(groupJid);
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      const temp = `${file}.tmp`;
      const payload = {
        groupJid,
        retryCount,
        failedAt: new Date().toISOString(),
        nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
        reason: 'max_retries_exceeded',
      };
      fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
      fs.renameSync(temp, file);
    } catch (err) {
      logger.warn({ groupJid, err }, 'Failed to persist dead-letter retry state');
    }
  }

  private clearDeadLetter(groupJid: string): void {
    try {
      const file = this.deadLetterFile(groupJid);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      logger.warn({ groupJid, err }, 'Failed to clear dead-letter retry state');
    }
  }

  private scheduleRetryTimer(groupJid: string, delayMs: number): void {
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        activeSinceMs: null,
        idleWaiting: false,
        isTaskContainer: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        activeRunId: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private hasPendingInputMessages(groupFolder: string | null): boolean {
    if (!groupFolder) return false;
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      const entries = fs.readdirSync(inputDir);
      return entries.some((entry) => entry.endsWith('.json'));
    } catch {
      return false;
    }
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  getRuntimeState(groupJid: string): {
    active: boolean;
    activeSinceMs: number | null;
    idleWaiting: boolean;
    isTaskContainer: boolean;
    pendingMessages: boolean;
  } {
    const state = this.getGroup(groupJid);
    return {
      active: state.active,
      activeSinceMs: state.activeSinceMs,
      idleWaiting: state.idleWaiting,
      isTaskContainer: state.isTaskContainer,
      pendingMessages: state.pendingMessages,
    };
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
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
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
    runId?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    if (runId !== undefined) state.activeRunId = runId;
  }

  abortActiveRun(
    groupJid: string,
    runId: string,
    reason: string,
    options?: AbortRunOptions,
  ): {
    aborted: boolean;
    stopVerified: boolean;
    stopAttempts: string[];
    detail: string;
  } {
    const state = this.getGroup(groupJid);
    const runtimeStopByContainer = (
      containerName: string,
      detailPrefix: string,
    ): {
      aborted: boolean;
      stopVerified: boolean;
      stopAttempts: string[];
      detail: string;
    } => {
      const stopResult = stopContainerWithVerification(containerName);
      logger.warn(
        {
          groupJid,
          runId,
          reason,
          containerName,
          stopVerified: stopResult.stopped,
          stopAttempts: stopResult.attempts,
        },
        'Abort requested for worker run via runtime container stop fallback',
      );
      return {
        aborted: stopResult.stopped,
        stopVerified: stopResult.stopped,
        stopAttempts: stopResult.attempts,
        detail: stopResult.stopped ? detailPrefix : `${detailPrefix}_stop_failed`,
      };
    };

    const runtimeStopByPrefix = (
      groupFolder: string,
      detailPrefix: string,
    ): {
      aborted: boolean;
      stopVerified: boolean;
      stopAttempts: string[];
      detail: string;
    } => {
      const prefix = `nanoclaw-${groupFolder}-`;
      const stopResult = stopRunningContainersByPrefix(prefix);
      const attempts = [
        `matched:${stopResult.matched.join(',') || '(none)'}`,
        `stopped:${stopResult.stopped.join(',') || '(none)'}`,
        ...stopResult.failures.map(
          (failure) => `${failure.name}:${failure.attempts.join(' || ')}`,
        ),
      ];
      const stopped = stopResult.stopped.length > 0;
      logger.warn(
        {
          groupJid,
          runId,
          reason,
          groupFolder,
          prefix,
          matched: stopResult.matched,
          stopped: stopResult.stopped,
          failures: stopResult.failures,
        },
        'Abort requested for worker run via runtime prefix stop fallback',
      );
      return {
        aborted: stopped,
        stopVerified: stopped,
        stopAttempts: attempts,
        detail: stopped ? detailPrefix : `${detailPrefix}_no_running_container`,
      };
    };

    const fallbackContainerName = `${options?.activeContainerName ?? ''}`.trim();
    if (fallbackContainerName && !fallbackContainerName.startsWith('prefix:')) {
      const fallback = runtimeStopByContainer(
        fallbackContainerName,
        'runtime_container_stop_fallback',
      );
      if (fallback.stopVerified) return fallback;
    }
    const fallbackFolder = options?.groupFolder || state.groupFolder;
    if (fallbackFolder) {
      const fallback = runtimeStopByPrefix(
        fallbackFolder,
        'runtime_prefix_stop_fallback',
      );
      if (fallback.stopVerified) return fallback;
    }

    if (!state.active) {
      return {
        aborted: false,
        stopVerified: false,
        stopAttempts: [],
        detail: 'lane_not_active',
      };
    }
    if (state.activeRunId && state.activeRunId !== runId) {
      return {
        aborted: false,
        stopVerified: false,
        stopAttempts: [],
        detail: `active_run_mismatch:${state.activeRunId}`,
      };
    }

    if (!state.containerName || !state.process) {
      return {
        aborted: false,
        stopVerified: false,
        stopAttempts: [],
        detail: 'missing_container_or_process',
      };
    }

    if (state.groupFolder) {
      this.closeStdin(groupJid);
    }

    const stopResult = stopContainerWithVerification(state.containerName);
    try {
      if (!state.process.killed) {
        state.process.kill('SIGTERM');
      }
    } catch {
      // best effort
    }
    try {
      if (!state.process.killed) {
        state.process.kill('SIGKILL');
      }
    } catch {
      // best effort
    }

    logger.warn(
      {
        groupJid,
        runId,
        reason,
        containerName: state.containerName,
        stopVerified: stopResult.stopped,
        stopAttempts: stopResult.attempts,
      },
      'Abort requested for active worker run',
    );

    return {
      aborted: true,
      stopVerified: stopResult.stopped,
      stopAttempts: stopResult.attempts,
      detail: stopResult.stopped ? 'stopped' : 'stop_verification_failed',
    };
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

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.activeSinceMs = Date.now();
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
          this.clearDeadLetter(groupJid);
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      if (this.hasPendingInputMessages(state.groupFolder)) {
        state.pendingMessages = true;
        logger.warn(
          { groupJid, groupFolder: state.groupFolder },
          'Detected unconsumed IPC input after container exit; scheduling recovery run',
        );
      }
      state.active = false;
      state.activeSinceMs = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.activeRunId = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.activeSinceMs = Date.now();
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
      state.activeSinceMs = null;
      state.isTaskContainer = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.activeRunId = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      const delayMs = DEAD_LETTER_RETRY_MS;
      logger.error(
        { groupJid, retryCount: state.retryCount, delayMs },
        'Max retries exceeded, moving to dead-letter retry flow',
      );
      this.persistDeadLetter(groupJid, state.retryCount, delayMs);
      state.retryCount = MAX_RETRIES;
      this.scheduleRetryTimer(groupJid, delayMs);
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    this.scheduleRetryTimer(groupJid, delayMs);
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
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
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

  private listActiveStates(): Array<{ jid: string; state: GroupState }> {
    const active: Array<{ jid: string; state: GroupState }> = [];
    for (const [jid, state] of this.groups) {
      if (state.active && state.process && !state.process.killed && state.containerName) {
        active.push({ jid, state });
      }
    }
    return active;
  }

  private async waitForDrain(gracePeriodMs: number): Promise<void> {
    if (gracePeriodMs <= 0) return;

    const deadline = Date.now() + gracePeriodMs;
    while (Date.now() < deadline) {
      if (this.listActiveStates().length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const requestedCloseSentinels: string[] = [];
    for (const { jid, state } of this.listActiveStates()) {
      // Only ask idle agent lanes to close gracefully. Active worker runs should
      // get a chance to finish during the drain window.
      if (state.groupFolder && state.idleWaiting) {
        this.closeStdin(jid);
        requestedCloseSentinels.push(jid);
      }
    }

    await this.waitForDrain(gracePeriodMs);

    const stoppedContainers: string[] = [];
    const failedStops: Array<{ name: string; attempts: string[] }> = [];
    const signaledGroups: string[] = [];

    // After drain window, force-stop any remaining containers to avoid detached
    // orphan agents outliving the host process.
    const remaining = this.listActiveStates();
    for (const { jid, state } of remaining) {
      if (!state.process || state.process.killed || !state.containerName) continue;

      if (state.groupFolder) {
        this.closeStdin(jid);
      }

      const stopResult = stopContainerWithVerification(state.containerName);
      if (stopResult.stopped) {
        stoppedContainers.push(state.containerName);
      } else {
        failedStops.push({ name: state.containerName, attempts: stopResult.attempts });
      }

      try {
        state.process.kill('SIGTERM');
        signaledGroups.push(jid);
      } catch {
        // best-effort signal only
      }
    }

    logger.info(
      {
        activeCount: this.activeCount,
        gracePeriodMs,
        requestedCloseSentinels,
        forcedStopCount: remaining.length,
        stoppedContainers,
        failedStops,
        signaledGroups,
      },
      'GroupQueue shutting down (active containers stop requested)',
    );
  }
}
