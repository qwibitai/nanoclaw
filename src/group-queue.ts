import { ChildProcess, exec } from 'child_process';

import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';
import type { WsIpcServer } from './ws-server.js';

interface QueuedTask {
  id: string;
  jid: string;
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
  wsToken: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((jid: string) => Promise<boolean>) | null = null;
  private shuttingDown = false;
  private _wsServer: WsIpcServer | null = null;

  set wsServer(server: WsIpcServer) {
    this._wsServer = server;
  }

  private getGroup(jid: string): GroupState {
    let state = this.groups.get(jid);
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
        wsToken: null,
        retryCount: 0,
      };
      this.groups.set(jid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (jid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(jid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(jid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ jid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(jid)) {
        this.waitingGroups.push(jid);
      }
      logger.debug(
        { jid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(jid, 'messages').catch((err) =>
      logger.error({ jid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(jid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(jid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ jid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, jid, fn });
      if (state.idleWaiting) {
        this.closeStdin(jid);
      }
      logger.debug({ jid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, jid, fn });
      if (!this.waitingGroups.includes(jid)) {
        this.waitingGroups.push(jid);
      }
      logger.debug(
        { jid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(jid, { id: taskId, jid, fn }).catch((err) =>
      logger.error({ jid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    jid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    wsToken?: string,
  ): void {
    const state = this.getGroup(jid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    if (wsToken) state.wsToken = wsToken;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for WS input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(jid: string): void {
    const state = this.getGroup(jid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(jid);
    }
  }

  /**
   * Send a follow-up message to the active container via WebSocket.
   * - 'sent':        delivered over WS
   * - 'retry':       container active but WS not connected yet, caller should retry
   * - 'unavailable': no container can accept this message, caller should enqueue
   */
  sendMessage(jid: string, text: string): 'sent' | 'retry' | 'unavailable' {
    const state = this.getGroup(jid);
    if (!state.active || !state.wsToken || state.isTaskContainer)
      return 'unavailable';
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    if (!this._wsServer) return 'unavailable';
    return this._wsServer.sendInput(state.wsToken, text) ? 'sent' : 'retry';
  }

  /**
   * Signal the active container to wind down via WebSocket close message.
   */
  closeStdin(jid: string): void {
    const state = this.getGroup(jid);
    if (!state.active || !state.wsToken) return;

    if (this._wsServer) {
      this._wsServer.sendClose(state.wsToken);
    }
  }

  private async runForGroup(
    jid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(jid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { jid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(jid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(jid, state);
        }
      }
    } catch (err) {
      logger.error({ jid, err }, 'Error processing messages for group');
      this.scheduleRetry(jid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.wsToken = null;
      this.activeCount--;
      this.drainGroup(jid);
    }
  }

  private async runTask(jid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(jid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    this.activeCount++;

    logger.debug(
      { jid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ jid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.wsToken = null;
      this.activeCount--;
      this.drainGroup(jid);
    }
  }

  private scheduleRetry(jid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { jid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { jid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(jid);
      }
    }, delayMs);
  }

  private drainGroup(jid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(jid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(jid, task).catch((err) =>
        logger.error(
          { jid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(jid, 'drain').catch((err) =>
        logger.error({ jid, err }, 'Unhandled error in runForGroup (drain)'),
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
            { jid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { jid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Signal all active containers to close via WS, then stop them gracefully.
    // Unlike the old file-based IPC, containers cannot persist output after the
    // host process exits — so we must wait for them to flush before shutting down.
    const active: {
      jid: string;
      containerName: string;
      wsToken: string | null;
      process: ChildProcess | null;
    }[] = [];
    for (const [jid, state] of this.groups) {
      if (state.active && state.containerName) {
        active.push({
          jid,
          containerName: state.containerName,
          wsToken: state.wsToken,
          process: state.process,
        });
        // Signal agent to wrap up
        if (state.wsToken && this._wsServer) {
          this._wsServer.sendClose(state.wsToken);
        }
      }
    }

    if (active.length === 0) {
      logger.info('GroupQueue shutting down (no active containers)');
      return;
    }

    logger.info(
      {
        activeCount: active.length,
        containers: active.map((a) => a.containerName),
      },
      'GroupQueue shutting down, stopping containers',
    );

    // Wait for containers to exit on their own, then force-stop stragglers
    await Promise.all(
      active.map(({ jid, containerName, wsToken, process: proc }) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            logger.warn(
              { containerName, jid },
              'Container did not exit in time, stopping',
            );
            exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
              if (err) {
                logger.warn({ err, containerName }, 'Failed to stop container');
              }
              resolve();
            });
          }, gracePeriodMs);

          if (proc && proc.exitCode === null) {
            proc.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
          } else {
            // Already exited
            clearTimeout(timer);
            resolve();
          }
        }).then(() => {
          // Revoke WS token so the server can clean up
          if (wsToken && this._wsServer) {
            this._wsServer.revokeToken(wsToken);
          }
        }),
      ),
    );

    logger.info('GroupQueue shutdown complete');
  }
}
