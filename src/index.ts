import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  HOST_MODE,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  TIMEZONE,
  WEBHOOK_ENABLED,
  WEBHOOK_PORT,
  getTriggerPattern,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  deleteSession,
  getAllTasks,
  getMessagesSince,
  initDatabase,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from './container-runner.js';
import { GroupQueue } from './group-queue.js';
import { getEffectiveModel } from './orchestrator/effective-model.js';
import {
  ensureOneCLIAgent as ensureOneCLIAgentFn,
  getAvailableGroups as getAvailableGroupsFn,
  registerGroup,
} from './orchestrator/group-registry.js';
import {
  recoverOutbox as recoverOutboxFn,
  recoverPendingMessages as recoverPendingMessagesFn,
  startMessageLoop as startMessageLoopFn,
} from './orchestrator/message-loop.js';
import { createProcessGroupMessages } from './orchestrator/process-group-messages.js';
import { createRunAgent } from './orchestrator/run-agent.js';
import {
  createState,
  getOrRecoverCursor,
  loadState,
  saveState,
} from './orchestrator/state.js';
import { startIpcWatcher } from './ipc.js';
import {
  extractImages,
  findChannel,
  formatMessages,
  formatOutbound,
  sendImages,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { SessionGuard } from './session-guard.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { startWebhookServer, stopWebhookServer } from './webhook.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

const state = createState();
const sessionGuard = new SessionGuard();

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

// Aliases that keep the rest of src/index.ts readable without fully
// rewriting every state access. Each points at the same object/set as
// the canonical state, so mutations flow back.
const { compactPending, deferredCompact } = state;

function loadStateHere(): void {
  loadState(state);
}
function saveStateHere(): void {
  saveState(state);
}
function getOrRecoverCursorHere(chatJid: string): string {
  return getOrRecoverCursor(state, chatJid, ASSISTANT_NAME);
}
function registerGroupHere(jid: string, group: RegisteredGroup): void {
  registerGroup(
    { onecli, registeredGroups: state.registeredGroups },
    jid,
    group,
  );
}

/** Available groups list for the agent (barrel export). */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  return getAvailableGroupsFn(state.registeredGroups);
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  state.registeredGroups = groups;
}

// Re-export for backwards-compat test imports
export {
  getEffectiveModel,
  type EffectiveModelResult,
} from './orchestrator/effective-model.js';

// processGroupMessages lives in ./orchestrator/process-group-messages.ts
// runAgent lives in ./orchestrator/run-agent.ts
// startMessageLoop + recoverPendingMessages + recoverOutbox live in
// ./orchestrator/message-loop.ts
const runAgent = createRunAgent({ state, queue, channels, sessionGuard });
const processGroupMessages = createProcessGroupMessages({
  state,
  queue,
  channels,
  runAgent,
});
function recoverPendingMessages(): void {
  recoverPendingMessagesFn({ state, queue, channels });
}
async function recoverOutbox(): Promise<void> {
  await recoverOutboxFn({ channels });
}
async function startMessageLoop(): Promise<void> {
  await startMessageLoopFn({ state, queue, channels });
}

function ensureContainerSystemRunning(): void {
  if (HOST_MODE) {
    logger.info('Host mode enabled — skipping container runtime check');
    return;
  }
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadStateHere();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(state.registeredGroups)) {
    ensureOneCLIAgentFn(onecli, jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // Advance cursor for all groups before killing containers so piped
    // messages are not re-delivered on restart (Issue #10).
    for (const chatJid of Object.keys(state.registeredGroups)) {
      const pending = getMessagesSince(
        chatJid,
        getOrRecoverCursorHere(chatJid),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (pending.length > 0) {
        state.lastAgentTimestamp[chatJid] =
          pending[pending.length - 1].timestamp;
      }
    }
    saveStateHere();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    await stopWebhookServer();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = state.registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        state.registeredGroups[chatJid]
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);

      // Event-driven: kick message processing immediately without waiting for poll
      const group = state.registeredGroups[chatJid];
      if (!group) return;

      const ch = findChannel(channels, chatJid);
      if (!ch) return;

      const isMainGroup = group.isMain === true;
      const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

      if (needsTrigger) {
        const triggerPattern = getTriggerPattern(group.trigger);
        const allowlistCfg = loadSenderAllowlist();
        const hasTrigger =
          triggerPattern.test(msg.content.trim()) &&
          (msg.is_from_me ||
            isTriggerAllowed(chatJid, msg.sender, allowlistCfg));
        if (!hasTrigger) return;
      }

      // Active container → pipe via IPC + typing indicator
      const allPending = getMessagesSince(
        chatJid,
        getOrRecoverCursorHere(chatJid),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (allPending.length > 0) {
        const formatted = formatMessages(
          allPending,
          TIMEZONE,
          group,
          getEffectiveModel(group).model,
        );
        if (queue.sendMessage(chatJid, formatted)) {
          // Advance cursor so the next pipe doesn't re-send these messages
          state.lastAgentTimestamp[chatJid] =
            allPending[allPending.length - 1].timestamp;
          saveStateHere();
          if (!queue.isRecentResponseSent(chatJid)) {
            ch.setTyping?.(chatJid, true)?.catch(() => {});
          }
          return;
        }
      }

      // No active container → enqueue for a new one
      queue.enqueueMessageCheck(chatJid);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => state.registeredGroups,
    getStatus: () => ({
      activeContainers: queue.getStatus().activeContainers,
      uptimeSeconds: Math.floor(process.uptime()),
      sessions: { ...state.sessions },
      lastUsage: { ...state.lastUsage },
      compactCount: { ...state.compactCount },
      lastRateLimit: { ...state.lastRateLimit },
    }),
    sendIpcMessage: (chatJid: string, text: string) => {
      const sent = queue.sendMessage(chatJid, text);
      if (sent && text === '/compact') {
        compactPending.add(chatJid);
      }
      if (!sent && text === '/compact') {
        // No active container — defer compact to next container run if session exists
        const group = state.registeredGroups[chatJid];
        if (group && state.sessions[group.folder]) {
          deferredCompact.add(chatJid);
          return true;
        }
      }
      return sent;
    },
    clearSession: (groupFolder: string, chatJid: string) => {
      delete state.sessions[groupFolder];
      deleteSession(groupFolder);
      sessionGuard.markCleared(groupFolder);
      queue.closeStdin(chatJid);
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => state.registeredGroups,
    getSessions: () => state.sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (!text) return;
      const { cleanText, images } = extractImages(text);
      if (cleanText) await channel.sendMessage(jid, cleanText);
      await sendImages(channel, jid, images);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const { cleanText, images } = extractImages(text);
      if (cleanText) await channel.sendMessage(jid, cleanText);
      await sendImages(channel, jid, images);
    },
    registeredGroups: () => state.registeredGroups,
    registerGroup: registerGroupHere,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        name: t.name,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        context_mode: t.context_mode,
        silent: t.silent,
        model: t.model,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(state.registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.advanceCursorFn = (chatJid) => {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursorHere(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      state.lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
      saveStateHere();
    }
  };
  queue.onMaxRetriesExceeded = (groupJid) => {
    const ch = findChannel(channels, groupJid);
    if (ch) {
      ch.sendMessage(
        groupJid,
        'Sorry, I was unable to process your message after several attempts. Please try again.',
      ).catch(() => {});
    }
  };
  await recoverOutbox();
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  // Incoming webhook: external systems can trigger the agent via HTTP POST
  if (WEBHOOK_ENABLED) {
    startWebhookServer(WEBHOOK_PORT, {
      getMainGroupJid: () =>
        Object.keys(state.registeredGroups).find(
          (jid) => state.registeredGroups[jid].isMain === true,
        ),
      onWebhookMessage: (chatJid: string, text: string) => {
        const msg: NewMessage = {
          id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: 'webhook',
          sender_name: 'Webhook',
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        };
        storeMessage(msg);

        // Event-driven: pipe to active container or enqueue for a new one
        const allPending = getMessagesSince(
          chatJid,
          getOrRecoverCursorHere(chatJid),
          ASSISTANT_NAME,
          MAX_MESSAGES_PER_PROMPT,
        );
        if (allPending.length > 0) {
          const grp = state.registeredGroups[chatJid];
          const formatted = formatMessages(
            allPending,
            TIMEZONE,
            grp,
            grp ? getEffectiveModel(grp).model : undefined,
          );
          if (queue.sendMessage(chatJid, formatted)) {
            state.lastAgentTimestamp[chatJid] =
              allPending[allPending.length - 1].timestamp;
            saveStateHere();
            return;
          }
        }
        queue.enqueueMessageCheck(chatJid);
      },
    }).catch((err) => {
      logger.warn(
        { err },
        'Webhook server failed to start, continuing without it',
      );
    });
  }
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
