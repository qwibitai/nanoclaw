import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  HOST_MODE,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  WEBHOOK_ENABLED,
  WEBHOOK_PORT,
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
import { writeGroupsSnapshot, writeTasksSnapshot } from './container-runner.js';
import { getAllTasks, getMessagesSince, initDatabase } from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { logger } from './logger.js';
import { buildChannelOpts } from './orchestrator/channel-opts.js';
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
import { startWebhookBridge } from './orchestrator/webhook-bridge.js';
import { restoreRemoteControl } from './remote-control.js';
import {
  extractImages,
  findChannel,
  formatOutbound,
  sendImages,
} from './router.js';
import { SessionGuard } from './session-guard.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, RegisteredGroup } from './types.js';
import { stopWebhookServer } from './webhook.js';

const state = createState();
const sessionGuard = new SessionGuard();

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

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

function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  return getAvailableGroupsFn(state.registeredGroups);
}

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

  // Channel callbacks (shared by all channels)
  const channelOpts = buildChannelOpts({
    state,
    queue,
    channels,
    sessionGuard,
  });

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
    startWebhookBridge({ state, queue, port: WEBHOOK_PORT });
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
