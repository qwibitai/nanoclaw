import os from 'os';

import {
  CONTROL_PLANE_FAILURE_STATUS,
  CONTROL_PLANE_HEARTBEAT_INTERVAL_MS,
  CONTROL_PLANE_INCLUDE_BACKLOG,
  CONTROL_PLANE_POLL_INTERVAL_MS,
  CONTROL_PLANE_SUCCESS_STATUS,
} from './config.js';
import { ControlPlaneClient } from './control-plane-client.js';
import {
  executeControlPlaneTask,
  resolveControlPlaneGroup,
} from './control-plane-executor.js';
import {
  isBacklogTask,
  normalizeControlPlaneTask,
  NormalizedControlPlaneTask,
} from './control-plane-task.js';
import { logger } from './logger.js';

export interface ControlPlaneRunnerDeps {
  client?: Pick<
    ControlPlaneClient,
    'bootstrap' | 'heartbeat' | 'getTasks' | 'updateTask' | 'postMessage'
  >;
  executeTask?: typeof executeControlPlaneTask;
  resolveGroup?: typeof resolveControlPlaneGroup;
  sleep?: (ms: number) => Promise<void>;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  includeBacklog?: boolean;
  successStatus?: string;
  failureStatus?: string;
}

export function createControlPlaneRunner(deps: ControlPlaneRunnerDeps) {
  const client = deps.client;
  const executeTask = deps.executeTask || executeControlPlaneTask;
  const resolveGroup = deps.resolveGroup || resolveControlPlaneGroup;
  const sleep = deps.sleep || defaultSleep;
  const heartbeatIntervalMs =
    deps.heartbeatIntervalMs || CONTROL_PLANE_HEARTBEAT_INTERVAL_MS;
  const pollIntervalMs = deps.pollIntervalMs || CONTROL_PLANE_POLL_INTERVAL_MS;
  const includeBacklog =
    deps.includeBacklog ?? CONTROL_PLANE_INCLUDE_BACKLOG;
  const successStatus = deps.successStatus || CONTROL_PLANE_SUCCESS_STATUS;
  const failureStatus = deps.failureStatus ?? CONTROL_PLANE_FAILURE_STATUS;

  if (!client) {
    throw new Error('ControlPlaneRunner requires a control-plane client');
  }

  let stopped = false;
  let activeTaskId: string | null = null;
  let lastBootstrap: any = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const recentlyHandled = new Map<string, number>();

  const runner = {
    async start(): Promise<void> {
      const selection = resolveGroup();
      await safeBootstrap(client);
      await safeHeartbeat(client, selection.group.folder);
      heartbeatTimer = setInterval(() => {
        void safeHeartbeat(client, selection.group.folder);
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();

      logger.info(
        {
          groupFolder: selection.group.folder,
          groupName: selection.group.name,
          jid: selection.jid,
          pollIntervalMs,
          heartbeatIntervalMs,
        },
        'Control-plane worker started',
      );

      while (!stopped) {
        try {
          await runner.pollOnce();
        } catch (err) {
          logger.warn(
            { err, activeTaskId },
            'Control-plane poll iteration failed',
          );
        }
        await sleep(pollIntervalMs);
      }
    },

    stop(): void {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },

    async pollOnce(): Promise<void> {
      if (activeTaskId) return;

      const selection = resolveGroup();
      const tasks = await client.getTasks(includeBacklog);
      const normalizedTasks = tasks
        .map((task) => normalizeControlPlaneTask(task))
        .filter((task): task is NormalizedControlPlaneTask => !!task);
      const nextTask = normalizedTasks.find(
        (task) => isBacklogTask(task) && !wasRecentlyHandled(task.id, recentlyHandled),
      );

      if (!nextTask) return;

      activeTaskId = nextTask.id;
      recentlyHandled.set(nextTask.id, Date.now());
      pruneRecentlyHandled(recentlyHandled);

      try {
        await client.updateTask(nextTask.id, {
          claim: true,
          status: 'in-progress',
          message: `Picked up ${nextTask.displayId} and starting work.`,
        });
        await client.postMessage({
          taskId: nextTask.id,
          body: `NanoClaw picked up ${nextTask.displayId} in local group "${selection.group.folder}" and is starting work.`,
        });

        let lastPostedOutput: string | null = null;
        const result = await executeTask(selection, {
          taskId: nextTask.id,
          prompt: nextTask.prompt,
          onOutput: async (output) => {
            if (!output.result) return;
            const text = normalizeMessageBody(output.result);
            if (!text || text === lastPostedOutput) return;
            lastPostedOutput = text;
            await client.postMessage({
              taskId: nextTask.id,
              body: text,
            });
          },
        });

        if (result.status === 'error') {
          const failureMessage = `NanoClaw failed while processing ${nextTask.displayId}: ${result.error || 'unknown error'}`;
          await client.postMessage({
            taskId: nextTask.id,
            body: failureMessage,
          });
          if (failureStatus) {
            await client.updateTask(nextTask.id, {
              status: failureStatus,
              message: failureMessage,
            });
          }
          return;
        }

        const completionMessage =
          normalizeMessageBody(result.result) ||
          `NanoClaw completed ${nextTask.displayId}.`;
        if (completionMessage !== lastPostedOutput) {
          await client.postMessage({
            taskId: nextTask.id,
            body: completionMessage,
          });
        }
        await client.updateTask(nextTask.id, {
          status: successStatus,
          message: `NanoClaw completed ${nextTask.displayId} and marked it ${successStatus}.`,
        });
      } finally {
        activeTaskId = null;
      }
    },

    getActiveTaskId(): string | null {
      return activeTaskId;
    },

    getLastBootstrap(): any {
      return lastBootstrap;
    },
  };

  return runner;

  async function safeBootstrap(
    apiClient: Pick<ControlPlaneClient, 'bootstrap'>,
  ): Promise<void> {
    try {
      lastBootstrap = await apiClient.bootstrap();
      logger.info(
        {
          identity:
            lastBootstrap?.agent?.name ||
            lastBootstrap?.agent?.id ||
            'unknown',
        },
        'Control-plane bootstrap complete',
      );
    } catch (err) {
      logger.warn({ err }, 'Control-plane bootstrap failed');
    }
  }

  async function safeHeartbeat(
    apiClient: Pick<ControlPlaneClient, 'heartbeat'>,
    groupFolder: string,
  ): Promise<void> {
    try {
      await apiClient.heartbeat('online', {
        host: os.hostname(),
        groupFolder,
        pid: process.pid,
      });
    } catch (err) {
      logger.warn({ err }, 'Control-plane heartbeat failed');
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wasRecentlyHandled(
  taskId: string,
  recentlyHandled: Map<string, number>,
): boolean {
  const at = recentlyHandled.get(taskId);
  return !!at && Date.now() - at < 30_000;
}

function pruneRecentlyHandled(recentlyHandled: Map<string, number>): void {
  const cutoff = Date.now() - 60_000;
  for (const [taskId, timestamp] of recentlyHandled.entries()) {
    if (timestamp < cutoff) {
      recentlyHandled.delete(taskId);
    }
  }
}

function normalizeMessageBody(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 8000);
}
