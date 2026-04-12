/**
 * MessageProcessor — message loop, per-group processing, and container execution.
 */

import type { RegisteredGroup as InternalRegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  ContainerEvent,
  runContainerAgent,
  writeGroupsSnapshot,
} from '../container-runner.js';
import { findChannel, formatMessages } from '../router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from '../sender-allowlist.js';
import type { AgentContext } from './agent-context.js';
import type { ChannelManager } from './channel-manager.js';
import type { GroupManager } from './group-manager.js';
import type { TaskManager } from './task-manager.js';

/**
 * Build the runtime MCP server configs for ContainerInput.
 * Strips `source` (host path), keeps command/args/env,
 * and injects --experimental-transform-types for .ts entry files
 * so Node 22+ runs them natively inside the container.
 */
export function buildMcpRuntimeConfig(
  mcpServers: Record<string, { source: string; command: string; args?: string[]; env?: Record<string, string> }> | null,
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | null {
  if (!mcpServers) return null;
  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, cfg]) => {
      const needsTs =
        cfg.command === 'node' && cfg.args?.[0]?.endsWith('.ts');
      return [
        name,
        {
          command: cfg.command,
          args: needsTs
            ? ['--experimental-transform-types', ...(cfg.args ?? [])]
            : cfg.args,
          env: cfg.env,
        },
      ];
    }),
  );
}

export class MessageProcessor {
  private messageLoopRunning = false;
  private _messageLoopPromise: Promise<void> | null = null;
  private _wakeLoop: (() => void) | null = null;

  constructor(
    private readonly ctx: AgentContext,
    private readonly channelMgr: ChannelManager,
    private readonly groupMgr: GroupManager,
    private readonly taskMgr: TaskManager,
  ) {}

  /** Start the message polling loop. Returns promise that resolves when stopped. */
  start(): Promise<void> {
    this._messageLoopPromise = this.startMessageLoop().catch((err) => {
      logger.fatal({ err, agent: this.ctx.name }, 'Message loop crashed');
      throw err;
    });
    return this._messageLoopPromise;
  }

  /** Wake the loop from its sleep interval. */
  wake(): void {
    this._wakeLoop?.();
  }

  /** Wait for the loop to finish (called during stop). */
  async waitForStop(): Promise<void> {
    this.wake();
    await this._messageLoopPromise;
  }

  /** Recover unprocessed messages from before restart. */
  recoverPendingMessages(): void {
    for (const [chatJid, group] of Object.entries(this.ctx.registeredGroups)) {
      const pending = this.ctx.db.getMessagesSince(
        chatJid,
        this.ctx.lastAgentTimestamp[chatJid] || '',
        this.ctx.config.assistantName,
      );
      if (pending.length > 0) {
        logger.info(
          {
            group: group.name,
            pendingCount: pending.length,
            agent: this.ctx.name,
          },
          'Recovery: unprocessed messages',
        );
        this.ctx.queue.enqueueMessageCheck(chatJid);
      }
    }
  }

  /** Process messages for a single group. Returns true on success. */
  async processGroupMessages(chatJid: string): Promise<boolean> {
    const group = this.ctx.registeredGroups[chatJid];
    if (!group) return true;

    const channel = findChannel(this.channelMgr.channelArray, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;
    const sinceTimestamp = this.ctx.lastAgentTimestamp[chatJid] || '';
    const missedMessages = this.ctx.db.getMessagesSince(
      chatJid,
      sinceTimestamp,
      this.ctx.config.assistantName,
    );

    if (missedMessages.length === 0) return true;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (m) =>
          this.ctx.config.triggerPattern.test(m.content.trim()) &&
          (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
      );
      if (!hasTrigger) return true;
    }

    const prompt = formatMessages(
      missedMessages,
      this.ctx.runtimeConfig.timezone,
    );

    const previousCursor = this.ctx.lastAgentTimestamp[chatJid] || '';
    this.ctx.lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    this.ctx.saveState();

    logger.info(
      {
        group: group.name,
        messageCount: missedMessages.length,
        agent: this.ctx.name,
      },
      'Processing messages',
    );

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        this.ctx.queue.closeStdin(chatJid);
      }, this.ctx.runtimeConfig.idleTimeout);
    };

    await channel.setTyping?.(chatJid, true);
    let hadError = false;
    let outputSentToUser = false;

    const output = await this.runAgent(
      group,
      prompt,
      chatJid,
      async (result) => {
        if (result.type === 'state') {
          this.ctx.emit('run.state', {
            agentId: this.ctx.id,
            jid: chatJid,
            name: group.name,
            folder: group.folder,
            state: result.state,
            timestamp: new Date().toISOString(),
            reason: result.reason,
            exitCode: result.exitCode,
          });
          if (result.state === 'idle') this.ctx.queue.notifyIdle(chatJid);
          return;
        }

        if (result.type === 'result' && result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );
          if (text) {
            outputSentToUser = await this.channelMgr.sendOutboundMessage(
              chatJid,
              raw,
              channel,
            );
          }
          resetIdleTimer();
        }
        if (result.type === 'error') hadError = true;
      },
    );

    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output sent, skipping cursor rollback',
        );
        return true;
      }
      this.ctx.lastAgentTimestamp[chatJid] = previousCursor;
      this.ctx.saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back cursor for retry',
      );
      return false;
    }

    return true;
  }

  /** Execute agent in a container for the given group. */
  async runAgent(
    group: InternalRegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerEvent) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    const sessionId = this.ctx.sessions[group.folder];

    this.taskMgr.refreshTaskSnapshots();

    const availableGroups = this.groupMgr.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this.ctx.registeredGroups)),
      this.ctx.config.dataDir,
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerEvent) => {
          if (output.newSessionId) {
            this.ctx.sessions[group.folder] = output.newSessionId;
            this.ctx.db.setSession(group.folder, output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          workDir: this.ctx.config.workDir,
          chatJid,
          isMain,
          assistantName: this.ctx.config.assistantName,
          agentId: this.ctx.id,
          groupsDir: this.ctx.config.groupsDir,
          dataDir: this.ctx.config.dataDir,
          credentialResolver: this.ctx.credentialResolver ?? undefined,
          mountAllowlist: this.ctx.resolvedMountAllowlist,
          mcpServers: buildMcpRuntimeConfig(this.ctx.config.mcpServers),
        },
        this.ctx.runtimeConfig,
        (boxName, _containerName) =>
          this.ctx.queue.registerBox(chatJid, boxName, group.folder),
        wrappedOnOutput,
      );

      if (output.newSessionId) {
        this.ctx.sessions[group.folder] = output.newSessionId;
        this.ctx.db.setSession(group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }
      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  // ─── Message loop ─────────────────────────────────────────────────

  private async startMessageLoop(): Promise<void> {
    if (this.messageLoopRunning) return;
    this.messageLoopRunning = true;

    logger.info(
      { agent: this.ctx.name },
      `Agent running (trigger: @${this.ctx.config.assistantName})`,
    );

    while (!this.ctx.stopping) {
      try {
        const jids = Object.keys(this.ctx.registeredGroups);
        const { messages, newTimestamp } = this.ctx.db.getNewMessages(
          jids,
          this.ctx.lastTimestamp,
          this.ctx.config.assistantName,
        );

        if (messages.length > 0) {
          logger.info(
            { count: messages.length, agent: this.ctx.name },
            'New messages',
          );
          this.ctx.lastTimestamp = newTimestamp;
          this.ctx.saveState();

          const messagesByGroup = new Map<string, typeof messages>();
          for (const msg of messages) {
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) existing.push(msg);
            else messagesByGroup.set(msg.chat_jid, [msg]);
          }

          for (const [chatJid, groupMessages] of messagesByGroup) {
            const group = this.ctx.registeredGroups[chatJid];
            if (!group) continue;

            const channel = findChannel(this.channelMgr.channelArray, chatJid);
            if (!channel) {
              logger.warn({ chatJid }, 'No channel owns JID, skipping');
              continue;
            }

            const needsTrigger =
              !group.isMain && group.requiresTrigger !== false;
            if (needsTrigger) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = groupMessages.some(
                (m) =>
                  this.ctx.config.triggerPattern.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
              );
              if (!hasTrigger) continue;
            }

            const allPending = this.ctx.db.getMessagesSince(
              chatJid,
              this.ctx.lastAgentTimestamp[chatJid] || '',
              this.ctx.config.assistantName,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(
              messagesToSend,
              this.ctx.runtimeConfig.timezone,
            );

            if (this.ctx.queue.sendMessage(chatJid, formatted)) {
              this.ctx.lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              this.ctx.saveState();
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to set typing indicator',
                  ),
                );
            } else {
              this.ctx.queue.enqueueMessageCheck(chatJid);
            }
          }
        }
      } catch (err) {
        logger.error({ err, agent: this.ctx.name }, 'Error in message loop');
      }
      await new Promise<void>((resolve) => {
        this._wakeLoop = resolve;
        setTimeout(resolve, this.ctx.runtimeConfig.pollInterval);
      });
      this._wakeLoop = null;
    }

    this.messageLoopRunning = false;
  }
}
