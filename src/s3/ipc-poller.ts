/**
 * Universal S3 IPC Poller for NanoClaw
 * Replaces sprites-ipc-poller.ts + daytona-ipc-poller.ts with a single
 * S3-based poller that works for all cloud agents.
 *
 * Polls each cloud agent's S3 outbox for results, and S3 inbox for
 * IPC messages/tasks written by agents to other agents' inboxes.
 */

import { IPC_POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';
import type { NanoClawS3 } from './client.js';
import type { S3Output } from './types.js';

export interface S3IpcPollerDeps {
  s3: NanoClawS3;
  /** Get the list of cloud agent IDs that should be polled. */
  getCloudAgentIds: () => string[];
  /** Process an outbox result (deliver to channel). */
  processOutput: (agentId: string, output: S3Output) => Promise<void>;
  /** Process an IPC message file's contents (from agent's IPC messages dir). */
  processMessage: (sourceAgentId: string, data: any) => Promise<void>;
  /** Process an IPC task file's contents. */
  processTask: (sourceAgentId: string, isAdmin: boolean, data: any) => Promise<void>;
  /** Check if an agent is admin. */
  isAdmin: (agentId: string) => boolean;
}

let pollerRunning = false;

/**
 * Start polling cloud agents' S3 outboxes and IPC directories.
 * This is the universal replacement for sprites-ipc-poller and daytona-ipc-poller.
 */
export function startS3IpcPoller(deps: S3IpcPollerDeps): void {
  if (pollerRunning) return;
  pollerRunning = true;

  const poll = async () => {
    const agentIds = deps.getCloudAgentIds();
    if (agentIds.length === 0) {
      setTimeout(poll, IPC_POLL_INTERVAL);
      return;
    }

    for (const agentId of agentIds) {
      try {
        // 1. Drain outbox — deliver results to channels
        const outputs = await deps.s3.drainOutbox(agentId);
        for (const output of outputs) {
          try {
            await deps.processOutput(agentId, output);
          } catch (err) {
            logger.warn({ agentId, outputId: output.id, error: err }, 'Error processing S3 outbox output');
          }
        }

        // 2. Check for IPC messages (agent→host communication)
        //    These are in agents/{agentId}/ipc/messages/ prefix
        const messageKeys = await deps.s3.list(`agents/${agentId}/ipc/messages/`);
        for (const key of messageKeys) {
          try {
            const text = await deps.s3.read(key);
            if (text) {
              const data = JSON.parse(text);
              await deps.processMessage(agentId, data);
              await deps.s3.delete(key);
            }
          } catch (err) {
            logger.warn({ agentId, key, error: err }, 'Error processing S3 IPC message');
          }
        }

        // 3. Check for IPC tasks
        const taskKeys = await deps.s3.list(`agents/${agentId}/ipc/tasks/`);
        for (const key of taskKeys) {
          try {
            const text = await deps.s3.read(key);
            if (text) {
              const data = JSON.parse(text);
              await deps.processTask(agentId, deps.isAdmin(agentId), data);
              await deps.s3.delete(key);
            }
          } catch (err) {
            logger.warn({ agentId, key, error: err }, 'Error processing S3 IPC task');
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('404') && !msg.includes('NoSuchKey')) {
          logger.warn({ agentId, error: msg }, 'Error polling S3 IPC');
        }
      }
    }

    setTimeout(poll, IPC_POLL_INTERVAL);
  };

  poll();
  logger.info('S3 IPC poller started');
}

/** Stop the poller (for testing). */
export function stopS3IpcPoller(): void {
  pollerRunning = false;
}
