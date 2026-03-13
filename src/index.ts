import { createHash } from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  BUDGET_INTERACTIVE,
  CLI_ENABLED,
  CLI_FALLBACK_ENABLED,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MAX_DAILY_SPEND_USD,
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
import { readEnvFile } from './env.js';
import {
  createTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getDailySpendUsd
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

/** Route an outbound message to the correct channel (with dedup). */
const recentOutbound = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000;

async function routeOutbound(jid: string, text: string): Promise<void> {
  const ch = findChannel(jid);
  if (!ch) {
    logger.warn({ jid }, 'No channel found for outbound message');
    return;
  }

  // Dedup: skip if same content was sent to same JID recently
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const key = `${jid}:${hash}`;
  const now = Date.now();
  const lastSent = recentOutbound.get(key);
  if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
    logger.warn({ jid, hash }, 'Duplicate outbound message suppressed');
    return;
  }
  recentOutbound.set(key, now);

  // Prune old entries periodically
  if (recentOutbound.size > 500) {
    for (const [k, t] of recentOutbound) {
      if (now - t > DEDUP_WINDOW_MS) recentOutbound.delete(k);
    }
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

/**
 * Auto-register a per-sender email JID by cloning the parent group's config.
 * Used for email thread isolation: each unique sender gets their own conversation.
 */
function registerDerivedGroup(childJid: string, parentJid: string): void {
  const parent = registeredGroups[parentJid];
  if (!parent) {
    logger.warn({ childJid, parentJid }, 'Cannot derive group: parent not found');
    return;
  }

  const child: RegisteredGroup = {
    ...parent,
    requiresTrigger: false, // emails always respond
  };

  registeredGroups[childJid] = child;
  setRegisteredGroup(childJid, child);

  logger.info(
    { childJid, parentJid, folder: child.folder },
    'Derived email group registered',
  );
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
        (c.jid.endsWith('@g.us') || c.jid.startsWith('quo:') || c.jid.startsWith('email:') || c.jid.startsWith('messenger:')),
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

  // Daily spend circuit breaker: stop spawning containers if we've exceeded the limit
  const dailySpend = getDailySpendUsd();
  if (dailySpend >= MAX_DAILY_SPEND_USD) {
    logger.warn(
      { dailySpend: dailySpend.toFixed(2), limit: MAX_DAILY_SPEND_USD, group: group.name },
      'Daily spend limit reached — skipping container spawn',
    );
    return true; // return true to prevent retries
  }

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
  const staleThresholdMs = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length === 0) continue;

    // Filter out stale messages (older than 10 min = from a crash, not fresh queue)
    const fresh = pending.filter(
      (m) => now - new Date(m.timestamp).getTime() < staleThresholdMs,
    );

    if (fresh.length > 0) {
      logger.info(
        { group: group.name, freshCount: fresh.length, staleCount: pending.length - fresh.length },
        'Recovery: found fresh unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    } else if (pending.length > 0) {
      // All messages are stale — advance the cursor past them to prevent re-queue
      const latestTimestamp = pending[pending.length - 1].timestamp;
      lastAgentTimestamp[chatJid] = latestTimestamp;
      setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
      logger.info(
        { group: group.name, skippedCount: pending.length, advancedTo: latestTimestamp },
        'Recovery: skipped stale messages, advanced cursor',
      );
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

  // Daily comprehensive digest (8am CT)
  const DIGEST_TASK_ID = 'daily-digest-8am';
  if (!getTaskById(DIGEST_TASK_ID)) {
    const digestCron = '0 8 * * *';
    const digestNext = CronExpressionParser.parse(digestCron, { tz: TIMEZONE })
      .next()
      .toISOString();
    createTask({
      id: DIGEST_TASK_ID,
      group_folder: MAIN_GROUP_FOLDER,
      chat_jid: mainJid,
      prompt: `Generate the daily morning digest for Blayk. Cover BOTH businesses comprehensively:

**SNAK GROUP (Vending):**
- Check IDDI for yesterday's sales totals, any expiring products in the next 7 days, and low-stock alerts
- Check Google Sheets for recent sales performance trends
- Check the CRM pipeline: any new leads, pending deals, or deals needing follow-up
- Check Gmail inbox for any unread customer emails about vending

**SHERIDAN RENTALS (Trailers/RVs):**
- Query the bookings database for today's pickups and returns
- List upcoming reservations for the next 7 days
- Flag any unpaid bookings or overdue payments
- Check the 3 equipment calendars for availability gaps

**ACROSS BOTH:**
- Check Google Calendar for today's appointments
- Summarize any unanswered Quo SMS messages from either business line
- Note any unread Gmail messages requiring attention

Format as a clean, scannable snapshot. Use sections with headers. Keep it concise but complete. If a data source is unavailable, note it briefly and move on.`,
      schedule_type: 'cron',
      schedule_value: digestCron,
      context_mode: 'isolated',
      next_run: digestNext,
      status: 'active',
      created_at: new Date().toISOString(),
      model: 'claude-sonnet-4-6',
      budget_usd: 0.50,
    });
    logger.info({ nextRun: digestNext }, 'Seeded daily digest task (8am CT)');
  }

  // Sam's Club weekly price update (Monday 10am CT)
  const SAMS_TASK_ID = 'sams-club-weekly-prices';
  if (!getTaskById(SAMS_TASK_ID)) {
    const samsCron = '0 10 * * 1';
    const samsNext = CronExpressionParser.parse(samsCron, { tz: TIMEZONE })
      .next()
      .toISOString();
    createTask({
      id: SAMS_TASK_ID,
      group_folder: MAIN_GROUP_FOLDER,
      chat_jid: mainJid,
      prompt: `Run the weekly Sam's Club price update:

1. Read the current product list from the Google Sheets pricing tab
2. For each product, browse Sam's Club website to get the current price
3. Update the Google Sheets pricing tab with current prices and the date checked
4. Flag any significant price changes (>10% increase or decrease) from the previous week
5. Summarize results: how many products checked, any price changes, any products not found

Use browser automation to check Sam's Club prices. If a product page fails to load, note it and continue with the rest.`,
      schedule_type: 'cron',
      schedule_value: samsCron,
      context_mode: 'isolated',
      next_run: samsNext,
      status: 'active',
      created_at: new Date().toISOString(),
      budget_usd: 0.50,
    });
    logger.info({ nextRun: samsNext }, 'Seeded Sam\'s Club weekly price update task');
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

  // --- CLI mode health check ---
  if (CLI_ENABLED) {
    const envSecrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
    const hasOAuthToken = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || envSecrets.CLAUDE_CODE_OAUTH_TOKEN);
    if (!hasOAuthToken) {
      const fallbackWarning = CLI_FALLBACK_ENABLED
        ? 'CLI_FALLBACK_ENABLED=true — tasks WILL fall back to container and BURN API CREDITS'
        : 'CLI_FALLBACK_ENABLED=false (default) — tasks will be SKIPPED when CLI fails';
      logger.warn(
        { cliEnabled: true, oauthToken: false, fallbackEnabled: CLI_FALLBACK_ENABLED },
        `CLAUDE_CODE_OAUTH_TOKEN is not set. Scheduled tasks cannot use the free CLI path. ${fallbackWarning}. Set CLAUDE_CODE_OAUTH_TOKEN in .env to enable free execution via Max subscription.`,
      );
    } else {
      logger.info('CLI mode ready: CLAUDE_CODE_OAUTH_TOKEN is set');
    }
  }

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

  // Create Web Chat channel
  {
    const { WEB_CHANNEL_PORT } = await import("./config.js");
    if (WEB_CHANNEL_PORT) {
      const { WebChannel } = await import("./channels/web.js");
      const web = new WebChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) =>
          storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => registeredGroups,
      });
      channels.push(web);
    }
  }

  // Create Facebook Messenger channel if configured
  {
    const { FB_PAGE_ACCESS_TOKEN } = await import("./config.js");
    if (FB_PAGE_ACCESS_TOKEN) {
      const { MessengerChannel } = await import("./channels/messenger.js");
      const messenger = new MessengerChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) =>
          storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => registeredGroups,
      });
      channels.push(messenger);
    }
  }

  // Create Gmail (IMAP) channel if configured
  {
    const { IMAP_USER: imapUser } = await import("./config.js");
    if (imapUser) {
      const { GmailChannel } = await import("./channels/gmail.js");
      const gmail = new GmailChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) =>
          storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => registeredGroups,
        registerDerivedGroup,
      });
      channels.push(gmail);
    }
  }

  // Connect all channels
  await Promise.all(channels.map((ch) => ch.connect()));

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
