/**
 * Railway Backend for NanoClaw
 * Runs agents on Railway cloud services with S3-based I/O.
 * Lifecycle: sync to B2 → write inbox → ensure service running → poll outbox.
 *
 * Unlike Daytona/Sprites which stream stdout, Railway uses S3 exclusively for
 * all I/O. The agent writes to S3 outbox, host polls for results.
 */

import crypto from 'crypto';

import {
  B2_ACCESS_KEY_ID,
  B2_BUCKET,
  B2_ENDPOINT,
  B2_REGION,
  B2_SECRET_ACCESS_KEY,
  CONTAINER_TIMEOUT,
  RAILWAY_API_TOKEN,
} from '../config.js';
import { logger } from '../logger.js';
import { ContainerProcess } from '../types.js';
import { NanoClawS3 } from '../s3/client.js';
import { syncFilesToS3 } from '../s3/file-sync.js';
import type { S3Message, S3Output } from '../s3/types.js';
import {
  AgentBackend,
  AgentOrGroup,
  ContainerInput,
  ContainerOutput,
  getContainerConfig,
  getFolder,
  getName,
  getServerFolder,
} from './types.js';

/** Dummy process wrapper for Railway (no real PID). */
class RailwayProcessWrapper implements ContainerProcess {
  private _killed = false;

  get killed(): boolean { return this._killed; }
  kill(): void { this._killed = true; }
  get pid(): number { return 0; }
}

export class RailwayBackend implements AgentBackend {
  readonly name = 'railway';
  private s3!: NanoClawS3;

  async runAgent(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    const folder = getFolder(group);
    const groupName = getName(group);
    const containerCfg = getContainerConfig(group);
    const serverFolder = getServerFolder(group);

    logger.info({ group: groupName, folder, isMain: input.isMain }, 'Running agent on Railway (S3 mode)');

    // 1. Sync files to S3
    await syncFilesToS3(this.s3, {
      agentId: folder,
      agentFolder: folder,
      isMain: input.isMain,
      serverFolder,
    });

    // 2. Write input to agent's S3 inbox
    const messageId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const inboxMessage: S3Message = {
      id: messageId,
      timestamp: new Date().toISOString(),
      sourceAgentId: 'host',
      sourceChannelJid: input.chatJid,
      type: 'user_message',
      payload: {
        text: input.prompt,
        sessionId: input.sessionId,
        groupFolder: input.groupFolder,
        chatJid: input.chatJid,
        isMain: input.isMain,
        isScheduledTask: input.isScheduledTask,
        discordGuildId: input.discordGuildId,
        serverFolder: input.serverFolder,
      },
    };
    await this.s3.writeInbox(folder, inboxMessage);

    // 3. Register dummy process
    const processWrapper = new RailwayProcessWrapper();
    onProcess(processWrapper, `railway-${folder}`);

    // 4. Poll S3 outbox for results
    const configTimeout = containerCfg?.timeout || CONTAINER_TIMEOUT;
    const pollInterval = 1000;
    const startTime = Date.now();
    let lastOutput: ContainerOutput = { status: 'success', result: null };

    while (!processWrapper.killed && Date.now() - startTime < configTimeout) {
      const outputs = await this.s3.drainOutbox(folder);

      for (const output of outputs) {
        const containerOutput: ContainerOutput = {
          status: output.status,
          result: output.result,
          newSessionId: output.newSessionId,
          error: output.error,
        };

        if (onOutput) {
          await onOutput(containerOutput);
        }

        lastOutput = containerOutput;

        // If we got a real result (not just a session update), we're done
        if (output.result !== null || output.status === 'error') {
          logger.info(
            { group: groupName, duration: Date.now() - startTime, status: output.status },
            'Railway agent completed',
          );
          return containerOutput;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    if (processWrapper.killed) {
      return { status: 'error', result: null, error: 'Agent was killed' };
    }

    logger.warn({ group: groupName, timeout: configTimeout }, 'Railway agent timed out waiting for S3 outbox');
    return lastOutput;
  }

  sendMessage(groupFolder: string, text: string): boolean {
    if (!this.s3) return false;

    const messageId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const message: S3Message = {
      id: messageId,
      timestamp: new Date().toISOString(),
      sourceAgentId: 'host',
      type: 'user_message',
      payload: { text },
    };

    this.s3.writeInbox(groupFolder, message).catch((err) => {
      logger.warn({ groupFolder, error: err }, 'Failed to send message to Railway agent via S3');
    });
    return true;
  }

  closeStdin(groupFolder: string, _inputSubdir?: string): void {
    if (!this.s3) return;

    const messageId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const message: S3Message = {
      id: messageId,
      timestamp: new Date().toISOString(),
      sourceAgentId: 'host',
      type: 'system',
      payload: { action: 'close' },
    };

    this.s3.writeInbox(groupFolder, message).catch((err) => {
      logger.warn({ groupFolder, error: err }, 'Failed to write close signal to Railway agent');
    });
  }

  writeIpcData(groupFolder: string, filename: string, data: string): void {
    if (!this.s3) return;

    this.s3.writeSync(groupFolder, `ipc/${filename}`, data).catch((err) => {
      logger.warn({ groupFolder, filename, error: err }, 'Failed to write IPC data to S3');
    });
  }

  async readFile(groupFolder: string, relativePath: string): Promise<Buffer | null> {
    if (!this.s3) return null;
    return this.s3.readSync(groupFolder, `workspace/${relativePath}`);
  }

  async writeFile(groupFolder: string, relativePath: string, content: Buffer | string): Promise<void> {
    if (!this.s3) throw new Error('Railway backend not initialized');
    await this.s3.writeSync(groupFolder, `workspace/${relativePath}`, content);
  }

  async initialize(): Promise<void> {
    if (!RAILWAY_API_TOKEN) {
      logger.warn('RAILWAY_API_TOKEN not set — Railway backend will not function');
      return;
    }
    if (!B2_ENDPOINT) {
      logger.warn('B2_ENDPOINT not set — Railway backend requires S3 storage');
      return;
    }

    this.s3 = new NanoClawS3({
      endpoint: B2_ENDPOINT,
      accessKeyId: B2_ACCESS_KEY_ID,
      secretAccessKey: B2_SECRET_ACCESS_KEY,
      bucket: B2_BUCKET,
      region: B2_REGION,
    });

    logger.info('Railway backend initialized (S3 mode)');
  }

  async shutdown(): Promise<void> {
    logger.info('Railway backend shutdown');
  }
}
