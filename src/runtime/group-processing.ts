import { ChildProcess } from 'child_process';

import {
  ASSISTANT_NAME,
  getDefaultModelConfig,
  getTriggerPattern,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import { Channel, RegisteredGroup, ThinkingOverride } from '../core/types.js';
import { writeMemoryContextSnapshot } from '../memory/memory-ipc.js';
import { MemoryService } from '../memory/memory-service.js';
import {
  findChannel,
  formatMessages,
  formatOutboundForChannel,
  stripInternalTagsPreserveWhitespace,
} from '../messaging/router.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import {
  deleteSession,
  getAllJobs,
  getMessagesSince,
  getRecentJobRuns,
} from '../storage/db.js';
import {
  AvailableGroup,
  AgentOutput,
  spawnAgent,
  writeJobRunsSnapshot,
  writeJobsSnapshot,
  writeGroupsSnapshot,
} from './agent-spawn.js';
import { archiveSessionTranscript } from '../session/session-transcript-archive.js';
import { handleSessionCommand } from '../session/session-commands.js';
import {
  collectRuntimeDiagnostics,
  formatRuntimeDiagnosticsMessage,
} from './runtime-diagnostics.js';

export interface GroupProcessingDeps {
  channels: Channel[];
  getGroup: (chatJid: string) => RegisteredGroup | undefined;
  getSession: (groupFolder: string) => string | undefined;
  setSession: (groupFolder: string, sessionId: string) => void;
  clearSession: (groupFolder: string) => void;
  getCursor: (chatJid: string) => string;
  setCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => void;
  setGroupModelOverride: (chatJid: string, model: string | undefined) => void;
  setGroupThinkingOverride: (
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ) => void;
  getAvailableGroups: () => AvailableGroup[];
  getRegisteredJids: () => Set<string>;
  queue: {
    closeStdin: (chatJid: string) => void;
    notifyIdle: (chatJid: string) => void;
    registerProcess: (
      groupJid: string,
      proc: ChildProcess,
      containerName: string,
      groupFolder?: string,
    ) => void;
  };
}

export function createGroupProcessor(deps: GroupProcessingDeps): {
  processGroupMessages: (chatJid: string) => Promise<boolean>;
} {
  async function runAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: AgentOutput) => Promise<void>,
    options?: { timeoutMs?: number },
    userId?: string,
    onMemoryContext?: (retrievedItemIds: string[]) => void,
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    const sessionId = deps.getSession(group.folder);

    const jobs = getAllJobs().map((job) => ({
      id: job.id,
      name: job.name,
      prompt: job.prompt,
      script: job.script || undefined,
      schedule_type: job.schedule_type,
      schedule_value: job.schedule_value,
      status: job.status,
      group_scope: job.group_scope,
      linked_sessions: job.linked_sessions,
      next_run: job.next_run,
      created_by: job.created_by,
      created_at: job.created_at,
      updated_at: job.updated_at,
      timeout_ms: job.timeout_ms,
      max_retries: job.max_retries,
      retry_backoff_ms: job.retry_backoff_ms,
      max_consecutive_failures: job.max_consecutive_failures,
      consecutive_failures: job.consecutive_failures,
      pause_reason: job.pause_reason,
    }));
    writeJobsSnapshot(group.folder, isMain, jobs);
    writeJobRunsSnapshot(group.folder, isMain, getRecentJobRuns(200), jobs);

    try {
      const contextSnapshot = await writeMemoryContextSnapshot(
        group.folder,
        isMain,
        prompt,
        userId,
      );
      onMemoryContext?.(contextSnapshot.retrievedItemIds);
    } catch (err) {
      logger.warn(
        { err, group: group.name },
        'Memory context snapshot failed; continuing without memory context',
      );
      onMemoryContext?.([]);
    }

    writeGroupsSnapshot(
      group.folder,
      isMain,
      deps.getAvailableGroups(),
      deps.getRegisteredJids(),
    );

    let pendingSessionId: string | null = null;

    const wrappedOnOutput = onOutput
      ? async (output: AgentOutput) => {
          if (output.status !== 'error' && output.newSessionId) {
            pendingSessionId = output.newSessionId;
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await spawnAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
          thinking: group.agentConfig?.thinking,
        },
        (proc, containerName) =>
          deps.queue.registerProcess(
            chatJid,
            proc,
            containerName,
            group.folder,
          ),
        wrappedOnOutput,
        options,
      );

      if (output.status === 'error') {
        const staleSessionId = sessionId || '';
        const isStaleSession =
          staleSessionId &&
          output.error &&
          /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
            output.error,
          );

        if (isStaleSession) {
          logger.warn(
            {
              group: group.name,
              staleSessionId,
              error: output.error,
            },
            'Stale session detected — clearing for next retry',
          );
          archiveSessionTranscript({
            groupFolder: group.folder,
            sessionId: staleSessionId,
            assistantName: ASSISTANT_NAME,
            cause: 'stale-session',
            errorSummary: output.error,
            writePlaceholderOnMissing: true,
          });
          deps.clearSession(group.folder);
        }

        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }

      const nextSessionId = output.newSessionId || pendingSessionId;
      if (nextSessionId) {
        deps.setSession(group.folder, nextSessionId);
      }

      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  async function processGroupMessages(chatJid: string): Promise<boolean> {
    const group = deps.getGroup(chatJid);
    if (!group) return true;

    const channel = findChannel(deps.channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;

    const missedMessages = getMessagesSince(
      chatJid,
      deps.getCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );

    if (missedMessages.length === 0) return true;

    const cmdResult = await handleSessionCommand({
      missedMessages,
      isMainGroup,
      groupName: group.name,
      triggerPattern: getTriggerPattern(group.trigger),
      timezone: TIMEZONE,
      deps: {
        sendMessage: (text) => channel.sendMessage(chatJid, text),
        setTyping: (typing) =>
          channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
        runAgent: (prompt, onOutput, options) =>
          runAgent(group, prompt, chatJid, onOutput, options),
        closeStdin: () => deps.queue.closeStdin(chatJid),
        advanceCursor: (ts) => {
          deps.setCursor(chatJid, ts);
          deps.saveState();
        },
        formatMessages,
        getDefaultModel: () => getDefaultModelConfig().model,
        getGroupModelOverride: () => group.agentConfig?.model,
        setGroupModelOverride: (value) =>
          deps.setGroupModelOverride(chatJid, value),
        getGroupThinkingOverride: () => group.agentConfig?.thinking,
        setGroupThinkingOverride: (value) =>
          deps.setGroupThinkingOverride(chatJid, value),
        getRuntimeStatusMessage: async () => {
          const diagnostics = await collectRuntimeDiagnostics();
          return formatRuntimeDiagnosticsMessage(diagnostics);
        },
        archiveCurrentSession: async () => {
          const sessionId = deps.getSession(group.folder);
          if (!sessionId) return;
          archiveSessionTranscript({
            groupFolder: group.folder,
            sessionId,
            assistantName: ASSISTANT_NAME,
            cause: 'new-session',
          });
        },
        onSessionArchived: async () => {
          await MemoryService.getInstance().reflectAfterTurn({
            groupFolder: group.folder,
            prompt: '/new',
            result: 'session archived',
            isMain: isMainGroup,
          });
        },
        clearCurrentSession: () => {
          deps.clearSession(group.folder);
          deleteSession(group.folder);
        },
        canSenderInteract: (msg) => {
          const hasTrigger = getTriggerPattern(group.trigger).test(
            msg.content.trim(),
          );
          const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
          return (
            isMainGroup ||
            !reqTrigger ||
            (hasTrigger &&
              (msg.is_from_me ||
                isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
          );
        },
      },
    });
    if (cmdResult.handled) return cmdResult.success;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const triggerPattern = getTriggerPattern(group.trigger);
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (m) =>
          triggerPattern.test(m.content.trim()) &&
          (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
      );
      if (!hasTrigger) {
        return true;
      }
    }

    const prompt = formatMessages(missedMessages, TIMEZONE);
    const previousCursor = deps.getCursor(chatJid) || '';
    deps.setCursor(
      chatJid,
      missedMessages[missedMessages.length - 1].timestamp,
    );
    deps.saveState();

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
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
        deps.queue.closeStdin(chatJid);
      }, IDLE_TIMEOUT);
    };

    await channel.setTyping?.(chatJid, true);
    let hadError = false;
    let outputSentToUser = false;
    let collectedOutput = '';
    const supportsStreamingChunks =
      typeof channel.sendStreamingChunk === 'function';
    let retrievedItemIdsForTurn: string[] = [];
    const memoryUserId = [...missedMessages]
      .reverse()
      .find((msg) => !msg.is_from_me && !msg.is_bot_message)?.sender;

    const output = await runAgent(
      group,
      prompt,
      chatJid,
      async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const isTelegramGroupStreaming =
            supportsStreamingChunks &&
            channel.name === 'telegram' &&
            chatJid.startsWith('tg:-');
          const text = isTelegramGroupStreaming
            ? stripInternalTagsPreserveWhitespace(raw)
            : formatOutboundForChannel(raw, channel.name);
          logger.info(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );
          if (text) {
            if (supportsStreamingChunks) {
              await channel.sendStreamingChunk!(chatJid, text);
            } else {
              await channel.sendMessage(chatJid, text);
            }
            outputSentToUser = true;
            collectedOutput += `${text}\n`;
          }
          resetIdleTimer();
        }

        if (result.status === 'success' && !result.result) {
          if (supportsStreamingChunks) {
            try {
              await channel.sendStreamingChunk!(chatJid, '', { done: true });
            } catch (err) {
              logger.warn(
                { err, group: group.name },
                'Failed to finalize streaming output',
              );
            }
          }
          deps.queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
          if (supportsStreamingChunks) {
            try {
              await channel.sendStreamingChunk!(chatJid, '', { done: true });
            } catch (err) {
              logger.warn(
                { err, group: group.name },
                'Failed to finalize streaming output after error',
              );
            }
          }
        }
      },
      undefined,
      memoryUserId,
      (retrievedItemIds) => {
        retrievedItemIdsForTurn = retrievedItemIds;
      },
    );

    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      deps.setCursor(chatJid, previousCursor);
      deps.saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    try {
      await MemoryService.getInstance().reflectAfterTurn({
        groupFolder: group.folder,
        prompt,
        result: collectedOutput,
        isMain: isMainGroup,
        userId: memoryUserId,
        retrievedItemIds: retrievedItemIdsForTurn,
      });
    } catch (err) {
      logger.warn(
        { err, group: group.name },
        'Memory reflection failed after successful turn',
      );
    }

    return true;
  }

  return { processGroupMessages };
}
