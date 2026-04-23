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
import { isAcpNoticeMessage } from '../acp/notice.js';
import type { AgentContext } from './agent-context.js';
import type { ChannelManager } from './channel-manager.js';
import type { GroupManager } from './group-manager.js';
import type { TaskManager } from './task-manager.js';
import { buildMcpRuntimeConfig } from './mcp-runtime.js';

export { buildMcpRuntimeConfig };

/** Compute the start of the current daily budget period (epoch ms). */
function getDailyPeriodStart(resetHour: number): number {
  const now = new Date();
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      resetHour,
      0,
      0,
      0,
    ),
  );
  if (start.getTime() > now.getTime()) {
    start.setUTCDate(start.getUTCDate() - 1);
  }
  return start.getTime();
}

function hasWakeTrigger(
  messages: Array<{ content: string; sender: string; is_from_me?: boolean }>,
  chatJid: string,
  triggerPattern: RegExp,
): boolean {
  const allowlistCfg = loadSenderAllowlist();
  return messages.some(
    (m) =>
      isAcpNoticeMessage(m) ||
      (triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg))),
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
      const hasTrigger = hasWakeTrigger(
        missedMessages,
        chatJid,
        this.ctx.config.triggerPattern,
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

    // ── Budget enforcement ───────────────────────���────────────────
    const budgetBlocked = await this.checkAndEnforceBudget(chatJid);
    if (budgetBlocked) return false;
    // ─────────────────────────────────────────────────────────────

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
      async (event) => {
        // ── Container lifecycle events ────────────────────────
        if (event.type === 'state') {
          this.ctx.emit('run.state', {
            agentId: this.ctx.id,
            jid: chatJid,
            name: group.name,
            folder: group.folder,
            state: event.state,
            timestamp: new Date().toISOString(),
            reason: event.reason,
            exitCode: event.exitCode,
          });
          if (event.state === 'idle') this.ctx.queue.notifyIdle(chatJid);
          return;
        }

        if (event.type === 'result' && event.result) {
          const raw =
            typeof event.result === 'string'
              ? event.result
              : JSON.stringify(event.result);
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
          return;
        }

        if (event.type === 'error') {
          hadError = true;
          return;
        }

        // ── Raw SDK message: emit raw + derive curated events ─
        if (event.type === 'sdk_message') {
          const now = new Date().toISOString();
          const msg = event.message;

          // Always emit raw event — consumers get all 21 SDK types
          this.ctx.emit('run.sdk_message', {
            agentId: this.ctx.id,
            jid: chatJid,
            sdkType: event.sdkType,
            sdkSubtype: event.sdkSubtype,
            message: msg,
            timestamp: now,
          });

          // Derive curated convenience events from SDK messages
          if (event.sdkType === 'assistant' && msg?.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'tool_use' && block.name && block.id) {
                this.ctx.emit('run.tool', {
                  agentId: this.ctx.id,
                  jid: chatJid,
                  toolName: block.name,
                  toolUseId: block.id,
                  input: block.input
                    ? JSON.stringify(block.input).slice(0, 500)
                    : undefined,
                  timestamp: now,
                });
              }
            }
            resetIdleTimer();
          }

          if (event.sdkType === 'tool_progress') {
            this.ctx.emit('run.tool_progress', {
              agentId: this.ctx.id,
              jid: chatJid,
              toolName: msg.tool_name,
              toolUseId: msg.tool_use_id,
              elapsedSeconds: msg.elapsed_time_seconds,
              timestamp: now,
            });
            resetIdleTimer();
          }

          if (event.sdkSubtype === 'task_started') {
            this.ctx.emit('run.subagent', {
              agentId: this.ctx.id,
              jid: chatJid,
              subtype: 'started',
              taskId: msg.task_id,
              description: msg.description,
              timestamp: now,
            });
            resetIdleTimer();
          }

          if (event.sdkSubtype === 'task_progress') {
            this.ctx.emit('run.subagent', {
              agentId: this.ctx.id,
              jid: chatJid,
              subtype: 'progress',
              taskId: msg.task_id,
              description: msg.description,
              lastToolName: msg.last_tool_name,
              summary: msg.summary,
              timestamp: now,
            });
            resetIdleTimer();
          }

          if (event.sdkSubtype === 'task_notification') {
            this.ctx.emit('run.subagent', {
              agentId: this.ctx.id,
              jid: chatJid,
              subtype: msg.status,
              taskId: msg.task_id,
              description: msg.summary,
              summary: msg.summary,
              timestamp: now,
            });
            resetIdleTimer();
          }

          if (event.sdkSubtype === 'status' && msg.status) {
            this.ctx.emit('run.status', {
              agentId: this.ctx.id,
              jid: chatJid,
              status: msg.status,
              timestamp: now,
            });
          }
        }
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

  /**
   * Check whether this group's token budget is exceeded or warning-level.
   * Returns true if the agent should be blocked (budget exceeded), false otherwise.
   * Emits 'budget.exceeded' or 'budget.warning' events as appropriate.
   * Sends a user-facing message when pausing.
   */
  private async checkAndEnforceBudget(chatJid: string): Promise<boolean> {
    const config = this.ctx.db.getBudgetConfig(chatJid);
    if (!config || (config.daily_limit_usd == null && config.total_limit_usd == null)) {
      return false; // no budget configured
    }

    const state = this.ctx.db.getBudgetState(chatJid);
    const now = new Date().toISOString();

    // If already paused, block immediately.
    if (state.paused) {
      this.ctx.emit('budget.exceeded', {
        agentId: this.ctx.id,
        jid: chatJid,
        limitType: state.paused_reason === 'total_limit' ? 'total' : 'daily',
        limitUsd:
          state.paused_reason === 'total_limit'
            ? (config.total_limit_usd ?? 0)
            : (config.daily_limit_usd ?? 0),
        usedUsd: 0,
        timestamp: now,
      });
      const channel = findChannel(this.channelMgr.channelArray, chatJid);
      await channel?.sendMessage?.(
        chatJid,
        'Agent paused: token budget exceeded. Resume from Dune settings.',
      );
      return true;
    }

    const periodStart = getDailyPeriodStart(config.reset_hour);
    const dailyCost = this.ctx.db.getDailyUsageUsd(chatJid, periodStart);
    const totalCost = this.ctx.db.getTotalUsageUsd(chatJid);

    // Check hard limits.
    if (
      (config.daily_limit_usd != null && dailyCost >= config.daily_limit_usd) ||
      (config.total_limit_usd != null && totalCost >= config.total_limit_usd)
    ) {
      const isDaily =
        config.daily_limit_usd != null && dailyCost >= config.daily_limit_usd;
      const limitType: 'daily' | 'total' = isDaily ? 'daily' : 'total';
      const limitUsd = isDaily ? config.daily_limit_usd! : config.total_limit_usd!;
      const usedUsd = isDaily ? dailyCost : totalCost;

      this.ctx.db.setBudgetPaused(chatJid, `${limitType}_limit` as 'daily_limit' | 'total_limit');
      this.ctx.emit('budget.exceeded', {
        agentId: this.ctx.id,
        jid: chatJid,
        limitType,
        limitUsd,
        usedUsd,
        timestamp: now,
      });

      const channel = findChannel(this.channelMgr.channelArray, chatJid);
      await channel?.sendMessage?.(
        chatJid,
        `Agent paused: ${limitType} token budget exceeded ($${usedUsd.toFixed(4)} of $${limitUsd.toFixed(2)} used). Resume from Dune settings.`,
      );

      logger.warn(
        { chatJid, limitType, limitUsd, usedUsd, agent: this.ctx.name },
        'Budget exceeded — agent paused',
      );
      return true;
    }

    // Check warning threshold (80%).
    const warnDaily =
      config.daily_limit_usd != null &&
      dailyCost >= 0.8 * config.daily_limit_usd;
    const warnTotal =
      config.total_limit_usd != null &&
      totalCost >= 0.8 * config.total_limit_usd;

    if (warnDaily || warnTotal) {
      const isDaily = warnDaily;
      const limitType: 'daily' | 'total' = isDaily ? 'daily' : 'total';
      const limitUsd = isDaily ? config.daily_limit_usd! : config.total_limit_usd!;
      const usedUsd = isDaily ? dailyCost : totalCost;
      const pctUsed = usedUsd / limitUsd;

      this.ctx.emit('budget.warning', {
        agentId: this.ctx.id,
        jid: chatJid,
        pctUsed,
        limitType,
        limitUsd,
        usedUsd,
        timestamp: now,
      });

      logger.info(
        { chatJid, limitType, pctUsed: Math.round(pctUsed * 100), agent: this.ctx.name },
        'Budget warning — approaching limit',
      );
    }

    return false; // proceed normally
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
          if (
            (output.type === 'state' ||
              output.type === 'result' ||
              output.type === 'error') &&
            output.newSessionId
          ) {
            this.ctx.sessions[group.folder] = output.newSessionId;
            this.ctx.db.setSession(group.folder, output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const actionAuth = this.ctx.actionsHttp.mintContainerToken(
        group.folder,
        isMain,
      );
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
          actionsAuth: actionAuth
            ? { url: actionAuth.url, token: actionAuth.token }
            : undefined,
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
              const hasTrigger = hasWakeTrigger(
                groupMessages,
                chatJid,
                this.ctx.config.triggerPattern,
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
