import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  BUDGET_INTERACTIVE,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MODEL_INTERACTIVE,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startHealthMonitor } from './health.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  hasBotReplyAfter,
  getRouterState,
  getTaskById,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { CronExpressionParser } from 'cron-parser';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

/** Find the channel that owns a given JID. */
function findChannel(jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}

/** Route an outbound message to the correct channel. */
async function routeOutbound(jid: string, text: string): Promise<void> {
  const ch = findChannel(jid);
  if (!ch) {
    logger.warn({ jid }, 'No channel found for outbound message');
    return;
  }
  await ch.sendMessage(jid, text);
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

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  // Validate folder name to prevent path traversal
  if (
    group.folder.includes('..') ||
    group.folder.includes('/') ||
    group.folder.includes('\\') ||
    group.folder !== path.basename(group.folder)
  ) {
    logger.error(
      { folder: group.folder },
      'Rejected group registration: invalid folder name',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(
      (c) =>
        c.jid !== '__group_sync__' &&
        (c.jid.endsWith('@g.us') ||
      c.jid.startsWith('quo:') ||
      c.jid.startsWith('web:')),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Save the cursor we'll advance to on success.
  // Cursor is NOT advanced until the agent succeeds — prevents message loss on timeout.
  const nextCursor = missedMessages[missedMessages.length - 1].timestamp;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  const channel = findChannel(chatJid);
  await channel?.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await routeOutbound(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel?.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, advance cursor anyway —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, advancing cursor to prevent duplicates',
      );
      lastAgentTimestamp[chatJid] = nextCursor;
      saveState();
      return true;
    }
    // Cursor was never advanced — messages will be re-processed on retry
    logger.warn(
      { group: group.name },
      'Agent error, cursor not advanced — messages will retry',
    );
    return false;
  }

  // Success — advance the cursor now
  lastAgentTimestamp[chatJid] = nextCursor;
  saveState();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
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
        chatJid,
        isMain,
        model: MODEL_INTERACTIVE,
        maxBudgetUsd: BUDGET_INTERACTIVE,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
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

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            findChannel(chatJid)?.setTyping?.(chatJid, true);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      // Check if bot already replied after the last pending user message.
      // This prevents re-processing on repeated restarts where the cursor
      // wasn't saved but the bot DID respond.
      const lastPendingTs = pending[pending.length - 1].timestamp;
      const botRepliedAfter = hasBotReplyAfter(chatJid, lastPendingTs, ASSISTANT_NAME);
      if (botRepliedAfter) {
        // Bot already handled these — just advance the cursor silently
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: bot already replied, advancing cursor',
        );
        lastAgentTimestamp[chatJid] = lastPendingTs;
        saveState();
      } else {
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: found unprocessed messages',
        );
        queue.enqueueMessageCheck(chatJid);
      }
    }
  }
}

/**
 * Seed Andy's scheduled health/dependency check tasks if they don't exist yet.
 * Only creates tasks for the main group.
 */
function seedHealthTasks(): void {
  // Find main group JID
  let mainJid: string | null = null;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) {
      mainJid = jid;
      break;
    }
  }
  if (!mainJid) {
    logger.debug('No main group registered yet, skipping health task seeding');
    return;
  }

  const HEALTH_TASK_ID = 'health-daily-check';
  const DEP_TASK_ID = 'health-weekly-deps';

  // Daily health check (9am)
  if (!getTaskById(HEALTH_TASK_ID)) {
    const dailyCron = '0 9 * * *';
    const dailyNext = CronExpressionParser.parse(dailyCron, { tz: TIMEZONE })
      .next()
      .toISOString();
    createTask({
      id: HEALTH_TASK_ID,
      group_folder: MAIN_GROUP_FOLDER,
      chat_jid: mainJid,
      prompt: `Read the health snapshot at /workspace/ipc/health_snapshot.json and give a concise daily status report.
Include: WhatsApp connection status, last message time, recent disconnects, uptime, and any current issues.
If there are problems, suggest specific fixes. Keep it brief — this is a daily check-in, not a deep dive.
If everything looks good, just say so in one line.`,
      schedule_type: 'cron',
      schedule_value: dailyCron,
      context_mode: 'isolated',
      next_run: dailyNext,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info({ nextRun: dailyNext }, 'Seeded daily health check task');
  }

  // Weekly dependency check (Monday 10am)
  if (!getTaskById(DEP_TASK_ID)) {
    const weeklyCron = '0 10 * * 1';
    const weeklyNext = CronExpressionParser.parse(weeklyCron, { tz: TIMEZONE })
      .next()
      .toISOString();
    createTask({
      id: DEP_TASK_ID,
      group_folder: MAIN_GROUP_FOLDER,
      chat_jid: mainJid,
      prompt: `Run a dependency health check:
1. Run \`npm outdated --json\` and report any outdated packages, especially @whiskeysockets/baileys
2. Run \`npm audit --json\` and report any critical or high severity vulnerabilities
3. If Baileys has an update available, note whether it's a patch/minor/major bump
Keep the report concise. Only flag things that need attention.`,
      schedule_type: 'cron',
      schedule_value: weeklyCron,
      context_mode: 'isolated',
      next_run: weeklyNext,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info({ nextRun: weeklyNext }, 'Seeded weekly dependency check task');
  }
}

function ensureContainerSystemRunning(): void {
  const isLinux = os.platform() === 'linux';

  if (isLinux) {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
      logger.debug('Docker is available');
    } catch (err) {
      logger.error({ err }, 'Docker is not available');
      console.error('\nFATAL: Docker is not available.');
      console.error('Agents cannot run without Docker. To fix:');
      console.error(
        '  1. Install Docker: https://docs.docker.com/engine/install/',
      );
      console.error('  2. Start Docker: systemctl start docker');
      console.error('  3. Restart NanoClaw\n');
      throw new Error('Docker is required but not available');
    }
  } else {
    try {
      execSync('container system status', { stdio: 'pipe' });
      logger.debug('Apple Container system already running');
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        execSync('container system start', { stdio: 'pipe', timeout: 30000 });
        logger.info('Apple Container system started');
      } catch (err) {
        logger.error({ err }, 'Failed to start Apple Container system');
        console.error(
          '\n╔════════════════════════════════════════════════════════════════╗',
        );
        console.error(
          '║  FATAL: Apple Container system failed to start                 ║',
        );
        console.error(
          '║                                                                ║',
        );
        console.error(
          '║  Agents cannot run without Apple Container. To fix:           ║',
        );
        console.error(
          '║  1. Install from: https://github.com/apple/container/releases ║',
        );
        console.error(
          '║  2. Run: container system start                               ║',
        );
        console.error(
          '║  3. Restart NanoClaw                                          ║',
        );
        console.error(
          '╚════════════════════════════════════════════════════════════════╝\n',
        );
        throw new Error(
          'Apple Container system is required but failed to start',
        );
      }
    }
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    if (isLinux) {
      const output = execSync(
        'docker ps --filter "name=nanoclaw-" --format "{{.Names}}"',
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      const orphans = output.trim().split('\n').filter(Boolean);
      for (const name of orphans) {
        try {
          execSync(`docker stop ${name}`, { stdio: 'pipe' });
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    } else {
      const output = execSync('container ls --format json', {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(output || '[]');
      const orphans = containers
        .filter(
          (c) =>
            c.status === 'running' &&
            c.configuration.id.startsWith('nanoclaw-'),
        )
        .map((c) => c.configuration.id);
      for (const name of orphans) {
        try {
          execSync(`container stop ${name}`, { stdio: 'pipe' });
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  seedHealthTasks();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create WhatsApp channel
  const whatsapp = new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) =>
      storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => registeredGroups,
  });
  channels.push(whatsapp);

  // Create Quo Phone channel if configured
  const { QUO_API_KEY } = await import('./config.js');
  if (QUO_API_KEY) {
    const { QuoChannel } = await import('./channels/quo.js');
    const quo = new QuoChannel({
      onMessage: (chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp, name) =>
        storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => registeredGroups,
    });
    channels.push(quo);
  }

  // Create Web channel (Socket.IO chat widget)
  {
    const { WebChannel } = await import('./channels/web.js');
    const web = new WebChannel({
      onMessage: (chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp, name) =>
        storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => registeredGroups,
    });
    channels.push(web);
  }

  // Create Gmail (IMAP) channel if IMAP is configured
  {
    const { IMAP_HOST, IMAP_USER } = await import('./config.js');
    if (IMAP_HOST && IMAP_USER) {
      const { GmailChannel } = await import('./channels/gmail.js');
      const gmail = new GmailChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) =>
          storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => registeredGroups,
      });
      channels.push(gmail);
    }
  }

  // Connect all channels
  await Promise.all(channels.map((ch) => ch.connect()));

  // Register web:snak-group JID if not already registered
  if (!registeredGroups['web:snak-group']) {
    registerGroup('web:snak-group', {
      name: 'Snak Group Web Chat',
      folder: 'snak-group',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false, // web chat always responds without trigger
    });
  }

  // Start health monitor
  startHealthMonitor({
    channels,
    sendAlert: (jid, text) => routeOutbound(jid, text),
    getMainGroupJid: () => {
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.folder === MAIN_GROUP_FOLDER) return jid;
      }
      return null;
    },
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await routeOutbound(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => routeOutbound(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
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
