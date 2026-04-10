import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  GROUPS_DIR,
  ONECLI_URL,
} from './core/config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './runtime/container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './storage/db.js';
import { GroupQueue } from './runtime/group-queue.js';
import { startIpcWatcher } from './runtime/ipc.js';
import { findChannel, formatOutbound } from './messaging/router.js';
import { restoreRemoteControl } from './runtime/remote-control.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './platform/sender-allowlist.js';
import {
  asRemoteControlCommand,
  handleRemoteControlCommand,
} from './runtime/remote-control-command.js';
import { startSessionCleanup } from './session/session-cleanup.js';
import {
  recoverPendingMessages,
  startMessagePollingLoop,
} from './runtime/message-loop.js';
import { startSchedulerLoop } from './runtime/task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './core/types.js';
import { logger } from './core/logger.js';
import {
  listAvailableGroups,
  registerGroup as registerGroupEntry,
  setGroupModelOverride as setGroupModelOverrideEntry,
} from './runtime/group-registry.js';
import { createGroupProcessor } from './runtime/group-processing.js';
import { runRuntimeStartupPreflight } from './runtime/runtime-diagnostics.js';
import { ensurePromptProfileBootstrapped } from './runtime/prompt-profile.js';

export { escapeXml, formatMessages } from './messaging/router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registerGroupEntry(registeredGroups, jid, group, {
    assistantName: ASSISTANT_NAME,
    groupsDir: GROUPS_DIR,
    persist: setRegisteredGroup,
    ensureOneCLIAgent,
  });
}

function setGroupModelOverride(
  chatJid: string,
  model: string | undefined,
): void {
  setGroupModelOverrideEntry(
    registeredGroups,
    chatJid,
    model,
    setRegisteredGroup,
  );
}

export function getAvailableGroups(): import('./runtime/container-runner.js').AvailableGroup[] {
  return listAvailableGroups(getAllChats(), registeredGroups);
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

const groupProcessor = createGroupProcessor({
  channels,
  getGroup: (chatJid) => registeredGroups[chatJid],
  getSession: (groupFolder) => sessions[groupFolder],
  setSession: (groupFolder, sessionId) => {
    sessions[groupFolder] = sessionId;
    setSession(groupFolder, sessionId);
  },
  clearSession: (groupFolder) => {
    delete sessions[groupFolder];
    deleteSession(groupFolder);
  },
  getCursor: getOrRecoverCursor,
  setCursor: (chatJid, timestamp) => {
    lastAgentTimestamp[chatJid] = timestamp;
  },
  saveState,
  setGroupModelOverride,
  getAvailableGroups,
  getRegisteredJids: () => new Set(Object.keys(registeredGroups)),
  queue: {
    closeStdin: (chatJid) => queue.closeStdin(chatJid),
    notifyIdle: (chatJid) => queue.notifyIdle(chatJid),
    registerProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
  },
});

async function processGroupMessages(chatJid: string): Promise<boolean> {
  return groupProcessor.processGroupMessages(chatJid);
}

async function main(): Promise<void> {
  try {
    ensurePromptProfileBootstrapped();
  } catch (err) {
    logger.warn(
      { err },
      'Failed to seed prompt profile files; continuing startup',
    );
  }
  await runRuntimeStartupPreflight();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      const trimmed = msg.content.trim();
      const remoteControlCommand = asRemoteControlCommand(trimmed);
      if (remoteControlCommand) {
        handleRemoteControlCommand(
          remoteControlCommand,
          chatJid,
          msg,
          (jid) => registeredGroups[jid],
          (jid) => findChannel(channels, jid),
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
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
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

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

  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
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
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
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
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages({
    assistantName: ASSISTANT_NAME,
    getRegisteredGroups: () => registeredGroups,
    getLastTimestamp: () => lastTimestamp,
    setLastTimestamp: (timestamp) => {
      lastTimestamp = timestamp;
    },
    getOrRecoverCursor,
    setAgentCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    saveState,
    findChannel: (chatJid) => findChannel(channels, chatJid),
    queue,
  });
  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);
  startMessagePollingLoop({
    assistantName: ASSISTANT_NAME,
    getRegisteredGroups: () => registeredGroups,
    getLastTimestamp: () => lastTimestamp,
    setLastTimestamp: (timestamp) => {
      lastTimestamp = timestamp;
    },
    getOrRecoverCursor,
    setAgentCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    saveState,
    findChannel: (chatJid) => findChannel(channels, chatJid),
    queue,
  }).catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

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
