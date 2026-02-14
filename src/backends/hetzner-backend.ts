/**
 * Hetzner Cloud Backend for NanoClaw
 * Runs agents on ephemeral Hetzner Cloud VMs with S3-based I/O.
 * Lifecycle: create VM → sync to B2 → write inbox → wait for VM running → poll outbox → destroy VM.
 *
 * Like Railway, Hetzner uses S3 exclusively for all I/O. The agent writes to S3 outbox, host polls for results.
 * VMs are ephemeral and destroyed after each agent run to minimize costs.
 */

import crypto from 'crypto';

import {
  ASSISTANT_NAME,
  B2_ACCESS_KEY_ID,
  B2_BUCKET,
  B2_ENDPOINT,
  B2_REGION,
  B2_SECRET_ACCESS_KEY,
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  HETZNER_API_TOKEN,
  HETZNER_IMAGE,
  HETZNER_LOCATION,
  HETZNER_SERVER_TYPE,
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
import * as HetznerAPI from './hetzner-api.js';

/** Dummy process wrapper for Hetzner (no real PID). */
class HetznerProcessWrapper implements ContainerProcess {
  private _killed = false;

  get killed(): boolean { return this._killed; }
  kill(): void { this._killed = true; }
  get pid(): number { return 0; }
}

interface HetznerServerContext {
  serverId: number;
}

export class HetznerBackend implements AgentBackend {
  readonly name = 'hetzner';
  private s3!: NanoClawS3;
  private servers = new Map<string, HetznerServerContext>();

  async runAgent(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    if (!this.s3) {
      return { status: 'error', result: null, error: 'Hetzner backend not initialized (missing credentials)' };
    }

    const folder = getFolder(group);
    const groupName = getName(group);
    const containerCfg = getContainerConfig(group);
    const serverFolder = getServerFolder(group);

    logger.info({ group: groupName, folder, isMain: input.isMain }, 'Running agent on Hetzner (S3 mode)');

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

    // 3. Create ephemeral VM
    const serverCtx = await this.createEphemeralServer(folder);
    this.servers.set(folder, serverCtx);

    // 4. Register dummy process
    const processWrapper = new HetznerProcessWrapper();
    onProcess(processWrapper, `hetzner-${folder}`);

    try {
      // 5. Poll S3 outbox for results
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
              'Hetzner agent completed',
            );
            return containerOutput;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      if (processWrapper.killed) {
        return { status: 'error', result: null, error: 'Agent was killed' };
      }

      logger.warn({ group: groupName, timeout: configTimeout }, 'Hetzner agent timed out waiting for S3 outbox');
      return { status: 'error', result: lastOutput.result, error: `Agent timed out after ${configTimeout}ms` };
    } finally {
      // 6. Always destroy VM (ephemeral!)
      await this.destroyEphemeralServer(folder);
    }
  }

  private sanitizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'agent';
  }

  private async createEphemeralServer(agentId: string): Promise<HetznerServerContext> {
    const appName = this.sanitizeName(ASSISTANT_NAME);
    const serverName = `${appName}-${this.sanitizeName(agentId)}-${Date.now()}`.slice(0, 63);

    // No host-side SSH key needed — VMs are fully managed via cloud-init + S3.
    // If the agent needs git SSH keys, cloud-init generates them on the VM
    // and the agent can share the pubkey back via S3 outbox.
    const userData = this.generateCloudInit(agentId);

    const { server, action } = await HetznerAPI.createServer(
      serverName,
      HETZNER_SERVER_TYPE,
      HETZNER_IMAGE,
      HETZNER_LOCATION,
      [], // No SSH keys — ephemeral VM, no SSH access needed
      userData,
    );

    try {
      await HetznerAPI.waitForAction(action.id);
      await HetznerAPI.waitForServerRunning(server.id);
    } catch (err) {
      // Best-effort cleanup to avoid orphaned VMs
      try {
        await HetznerAPI.deleteServer(server.id);
      } catch (cleanupErr) {
        logger.warn({ serverId: server.id, error: cleanupErr }, 'Failed to cleanup server after create failure');
      }
      throw err;
    }

    logger.info(
      { serverId: server.id, serverName, ip: server.public_net.ipv4.ip },
      'Hetzner ephemeral server ready',
    );

    return { serverId: server.id };
  }

  private async destroyEphemeralServer(agentId: string): Promise<void> {
    const serverCtx = this.servers.get(agentId);
    if (!serverCtx) {
      logger.warn({ agentId }, 'No Hetzner server context found to destroy');
      return;
    }

    try {
      await HetznerAPI.deleteServer(serverCtx.serverId);
      logger.info({ serverId: serverCtx.serverId }, 'Destroyed Hetzner ephemeral server');
    } catch (err) {
      logger.warn({ serverId: serverCtx.serverId, error: err }, 'Failed to destroy Hetzner server');
    } finally {
      this.servers.delete(agentId);
    }
  }

  /**
   * Generate cloud-init user-data for ephemeral Hetzner VMs.
   *
   * The VM generates its own SSH key for git operations via ssh-keygen.
   * The agent can share its pubkey back to the user via S3 outbox.
   *
   * NOTE: B2/S3 credentials are embedded in the cloud-init script. This is acceptable
   * for ephemeral VMs that are destroyed after each agent run, but be aware that:
   * - Credentials may be visible in Hetzner Cloud console (server details)
   * - Credentials persist in VM logs (/var/log/cloud-init.log) until VM destruction
   * For higher-security deployments, consider using scoped/temporary B2 application keys
   * with limited bucket permissions and short TTLs.
   */
  private generateCloudInit(agentId: string): string {
    const appName = this.sanitizeName(ASSISTANT_NAME);
    return `#cloud-config
package_update: true
package_upgrade: true

packages:
  - docker.io
  - docker-compose

runcmd:
  - systemctl start docker
  - systemctl enable docker
  - ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -C "${appName}-${agentId}"
  - ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null
  - docker pull ${CONTAINER_IMAGE}
  - docker run -d --name ${appName}-agent \\
      -v /root/.ssh:/home/bun/.ssh:ro \\
      -e NANOCLAW_S3_ENDPOINT=${B2_ENDPOINT} \\
      -e NANOCLAW_S3_REGION=${B2_REGION} \\
      -e NANOCLAW_S3_ACCESS_KEY_ID=${B2_ACCESS_KEY_ID} \\
      -e NANOCLAW_S3_SECRET_ACCESS_KEY=${B2_SECRET_ACCESS_KEY} \\
      -e NANOCLAW_S3_BUCKET=${B2_BUCKET} \\
      -e NANOCLAW_AGENT_ID=${agentId} \\
      ${CONTAINER_IMAGE}
`;
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
      logger.warn({ groupFolder, error: err }, 'Failed to send message to Hetzner agent via S3');
    });
    return true;
  }

  closeStdin(groupFolder: string): void {
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
      logger.warn({ groupFolder, error: err }, 'Failed to write close signal to Hetzner agent');
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
    if (!this.s3) throw new Error('Hetzner backend not initialized');
    await this.s3.writeSync(groupFolder, `workspace/${relativePath}`, content);
  }

  async initialize(): Promise<void> {
    if (!HETZNER_API_TOKEN) {
      logger.warn('HETZNER_API_TOKEN not set — Hetzner backend will not function');
      return;
    }
    if (!B2_ENDPOINT) {
      logger.warn('B2_ENDPOINT not set — Hetzner backend requires S3 storage');
      return;
    }
    if (!B2_ACCESS_KEY_ID || !B2_SECRET_ACCESS_KEY || !B2_BUCKET) {
      logger.warn('B2 credentials incomplete — Hetzner backend requires S3 storage');
      return;
    }

    this.s3 = new NanoClawS3({
      endpoint: B2_ENDPOINT,
      region: B2_REGION,
      accessKeyId: B2_ACCESS_KEY_ID,
      secretAccessKey: B2_SECRET_ACCESS_KEY,
      bucket: B2_BUCKET,
    });

    logger.info('Hetzner backend initialized with S3 storage');
  }

  async shutdown(): Promise<void> {
    for (const [agentId, serverCtx] of this.servers) {
      try {
        await HetznerAPI.deleteServer(serverCtx.serverId);
        logger.info({ serverId: serverCtx.serverId }, 'Cleaned up Hetzner server during shutdown');
      } catch (err) {
        logger.warn({ serverId: serverCtx.serverId, error: err }, 'Failed to cleanup Hetzner server during shutdown');
      }
    }
    this.servers.clear();
  }
}
