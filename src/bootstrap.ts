import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CLI_ENABLED,
  CLI_FALLBACK_ENABLED,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { writeGroupsSnapshot } from './container-runner.js';
import { readEnvFile } from './env.js';
import {
  createTask,
  getDailySpendUsd,
  getTaskById,
  initDatabase,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { CronExpressionParser } from 'cron-parser';
import { startHealthMonitor } from './health.js';
import { startHealthServer } from './health-endpoint.js';
import { startIpcWatcher } from './ipc.js';
import { formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import {
  getRegisteredGroups,
  getSessions,
  loadState,
  registerDerivedGroup,
  registerGroup,
  getAvailableGroups,
} from './registry.js';
import {
  addChannel,
  getChannels,
  getPipelineStats,
  routeOutbound,
  setEscalationAlert,
  shouldProcessInbound,
} from './routing.js';

// ── Container system ──────────────────────────────────────────────

export function ensureContainerSystemRunning(): void {
  const isLinux = os.platform() === 'linux';

  if (isLinux) {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
      logger.debug('Docker is available');
    } catch (err) {
      logger.error({ err }, 'Docker is not available');
      console.error('\nFATAL: Docker is not available.');
      console.error('Agents cannot run without Docker. To fix:');
      console.error('  1. Install Docker: https://docs.docker.com/engine/install/');
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
        throw new Error('Apple Container system is required but failed to start');
      }
    }
  }

  // Kill orphaned containers from previous runs
  try {
    if (isLinux) {
      const output = execSync('docker ps --filter "name=nanoclaw-" --format "{{.Names}}"', { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
      const orphans = output.trim().split('\n').filter(Boolean);
      for (const name of orphans) { try { execSync(`docker stop ${name}`, { stdio: 'pipe' }); } catch { /* already stopped */ } }
      if (orphans.length > 0) logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    } else {
      const output = execSync('container ls --format json', { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
      const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
      const orphans = containers.filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-')).map((c) => c.configuration.id);
      for (const name of orphans) { try { execSync(`container stop ${name}`, { stdio: 'pipe' }); } catch { /* already stopped */ } }
      if (orphans.length > 0) logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

// ── Health task seeding ───────────────────────────────────────────

export function seedHealthTasks(): void {
  const registeredGroups = getRegisteredGroups();
  let mainJid: string | null = null;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) { mainJid = jid; break; }
  }
  if (!mainJid) {
    logger.debug('No main group registered yet, skipping health task seeding');
    return;
  }

  const seedTask = (id: string, cron: string, prompt: string, opts?: { model?: string; budget_usd?: number }) => {
    if (getTaskById(id)) return;
    const nextRun = CronExpressionParser.parse(cron, { tz: TIMEZONE }).next().toISOString();
    createTask({
      id, group_folder: MAIN_GROUP_FOLDER, chat_jid: mainJid!,
      prompt, schedule_type: 'cron', schedule_value: cron,
      context_mode: 'isolated', next_run: nextRun, status: 'active',
      created_at: new Date().toISOString(), ...opts,
    });
    logger.info({ taskId: id, nextRun }, `Seeded task: ${id}`);
  };

  seedTask('health-daily-check', '0 9 * * *',
    `Read the health snapshot at /workspace/ipc/health_snapshot.json and give a concise daily status report.
Include: WhatsApp connection status, last message time, recent disconnects, uptime, and any current issues.
If there are problems, suggest specific fixes. Keep it brief — this is a daily check-in, not a deep dive.
If everything looks good, just say so in one line.`);

  seedTask('health-weekly-deps', '0 10 * * 1',
    `Run a dependency health check:
1. Run \`npm outdated --json\` and report any outdated packages, especially @whiskeysockets/baileys
2. Run \`npm audit --json\` and report any critical or high severity vulnerabilities
3. If Baileys has an update available, note whether it's a patch/minor/major bump
Keep the report concise. Only flag things that need attention.`);

  seedTask('daily-digest-8am', '0 8 * * *',
    `Generate the daily morning digest for Blayk. Cover BOTH businesses comprehensively:

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
    { model: 'claude-sonnet-4-6', budget_usd: 0.50 });

  seedTask('sams-club-weekly-prices', '0 10 * * 1',
    `Run the weekly Sam's Club price update:

1. Read the current product list from the Google Sheets pricing tab
2. For each product, browse Sam's Club website to get the current price
3. Update the Google Sheets pricing tab with current prices and the date checked
4. Flag any significant price changes (>10% increase or decrease) from the previous week
5. Summarize results: how many products checked, any price changes, any products not found

Use browser automation to check Sam's Club prices. If a product page fails to load, note it and continue with the rest.`,
    { budget_usd: 0.50 });

  seedTask('follow-up-check', '0 10 * * *',
    `Check for stale customer inquiries that need follow-up:

1. Run: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stale --days 3
   This returns conversions stuck in 'inquiry' or 'quoted' stage.
2. Also check for quoted leads stale >5 days: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stale --days 5
3. For each stale entry, compose a brief, friendly follow-up message
4. Send follow-ups via the appropriate channel (WhatsApp, email, SMS)
5. Update the conversion with: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action update --id "<conv_id>" --notes "follow-up sent on [date]"
6. Report summary: how many follow-ups sent, which businesses, which channels

Be natural and helpful — not pushy. Reference their original inquiry. Example:
"Hi [name], just wanted to check in about the vending machine placement we discussed.
Still happy to help if you're interested! Let me know if you have any questions."

For Sheridan Rentals:
"Hi [name], following up on your trailer rental inquiry. We still have availability
if you're interested. Happy to answer any questions about the equipment."`,
    { model: 'claude-sonnet-4-6', budget_usd: 0.30 });

  seedTask('review-solicitation', '0 11 * * *',
    `Check for recently completed services that should get a review request:

1. Query completed conversions: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action query --stage completed
   Filter results to entries updated in the last 48 hours.
2. For each one, send a brief review request via the original channel
3. Update to 'reviewed': npx tsx /workspace/project/tools/conversions/track-conversion.ts --action update --id "<conv_id>" --stage reviewed --notes "review requested on [date]"

For Snak Group:
"Thanks for choosing Snak Group for your breakroom vending! If you're enjoying the service,
we'd really appreciate a quick Google review — it helps other businesses find us.
[Include Google review link if available]"

For Sheridan Rentals:
"Thanks for renting with Sheridan! Hope everything went smoothly. If you have a moment,
a Google review would mean a lot to us.
[Include Google review link if available]"

Only send ONE review request per customer. Check notes for "review requested" before sending.`,
    { model: 'claude-sonnet-4-6', budget_usd: 0.20 });

  seedTask('weekly-revenue-dashboard', '0 9 * * 1',
    `Generate the weekly revenue and conversion dashboard for Blayk. Cover BOTH businesses:

**SNAK GROUP:**
1. Get conversion stats: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stats --business "snak-group" --days 7
2. Calculate conversion rate (inquiries → booked)
3. Total revenue from completed conversions this week vs. last week
4. Check stale leads: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stale --days 3
5. Top source channels (WhatsApp vs. email vs. SMS) for new inquiries

**SHERIDAN RENTALS:**
1. Get conversion stats: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stats --business "sheridan-rentals" --days 7
2. Fleet utilization: how many days were trailers/equipment rented vs. available
3. Revenue from completed rentals this week vs. last week
4. Upcoming returns this week
5. Any repeat customers (check conversion history for same customer_id)

**COMBINED:**
- Total revenue across both businesses this week
- Week-over-week growth percentage
- Pipeline value (sum of quoted + negotiating conversions)
- Complaint summary: npx tsx /workspace/project/tools/complaints/query-complaints.ts --action stats --days 7
- Check for open complaints: npx tsx /workspace/project/tools/complaints/query-complaints.ts --action open
- Top 3 action items for the coming week

Format as a clean, executive-style dashboard. Use numbers, not paragraphs.
Update the Google Sheet "Revenue Dashboard" tab if it exists.`,
    { model: 'claude-sonnet-4-6', budget_usd: 0.50 });
}

// ── CLI readiness check ───────────────────────────────────────────

export function checkCliReadiness(): void {
  if (CLI_ENABLED) {
    const envSecrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
    const hasOAuthToken = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || envSecrets.CLAUDE_CODE_OAUTH_TOKEN);
    if (!hasOAuthToken) {
      const fallbackWarning = CLI_FALLBACK_ENABLED
        ? 'CLI_FALLBACK_ENABLED=true — tasks WILL fall back to container and BURN API CREDITS'
        : 'CLI_FALLBACK_ENABLED=false (default) — tasks will be SKIPPED when CLI fails';
      logger.warn(
        { cliEnabled: true, oauthToken: false, fallbackEnabled: CLI_FALLBACK_ENABLED },
        `CLAUDE_CODE_OAUTH_TOKEN is not set. ${fallbackWarning}.`,
      );
    } else {
      logger.info('CLI mode ready: CLAUDE_CODE_OAUTH_TOKEN is set');
    }
  }
}

// ── Channel initialization ────────────────────────────────────────

export async function initChannels(queue: GroupQueue): Promise<WhatsAppChannel> {
  const whatsapp = new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => getRegisteredGroups(),
  });
  addChannel(whatsapp);

  const { QUO_API_KEY } = await import('./config.js');
  if (QUO_API_KEY) {
    const { QuoChannel } = await import('./channels/quo.js');
    const quo = new QuoChannel({
      onMessage: (chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => getRegisteredGroups(),
      shouldProcess: shouldProcessInbound,
    });
    addChannel(quo);
  }

  {
    const { WEB_CHANNEL_PORT } = await import('./config.js');
    if (WEB_CHANNEL_PORT) {
      const { WebChannel } = await import('./channels/web.js');
      const web = new WebChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => getRegisteredGroups(),
      });
      addChannel(web);
    }
  }

  {
    const { FB_PAGE_ACCESS_TOKEN } = await import('./config.js');
    if (FB_PAGE_ACCESS_TOKEN) {
      const { MessengerChannel } = await import('./channels/messenger.js');
      const messenger = new MessengerChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => getRegisteredGroups(),
        shouldProcess: shouldProcessInbound,
      });
      addChannel(messenger);
    }
  }

  {
    const { IMAP_USER: imapUser } = await import('./config.js');
    if (imapUser) {
      const { GmailChannel } = await import('./channels/gmail.js');
      const gmail = new GmailChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => getRegisteredGroups(),
        registerDerivedGroup,
        shouldProcess: shouldProcessInbound,
      });
      addChannel(gmail);
    }
  }

  const channels = getChannels();
  await Promise.all(channels.map((ch) => ch.connect()));

  // Wire escalation alerts now that channels are connected
  setEscalationAlert((jid, text) => routeOutbound(jid, text));

  return whatsapp;
}

// ── Service startup ───────────────────────────────────────────────

export function startServices(queue: GroupQueue, whatsapp: WhatsAppChannel): void {
  // HTTP health endpoint for monitoring
  startHealthServer({
    getStatus: () => ({
      uptime: process.uptime(),
      channels: Object.fromEntries(
        getChannels().map(ch => [ch.name, ch.isConnected() ? 'up' as const : 'down' as const]),
      ),
      activeGroups: Object.keys(getRegisteredGroups()).length,
      dailySpend: getDailySpendUsd(),
      pipelineStats: getPipelineStats(),
    }),
  });

  startHealthMonitor({
    channels: getChannels(),
    sendAlert: (jid, text) => routeOutbound(jid, text),
    getMainGroupJid: () => {
      for (const [jid, group] of Object.entries(getRegisteredGroups())) {
        if (group.folder === MAIN_GROUP_FOLDER) return jid;
      }
      return null;
    },
  });

  startSchedulerLoop({
    registeredGroups: () => getRegisteredGroups(),
    getSessions: () => getSessions(),
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
    registeredGroups: () => getRegisteredGroups(),
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
}

// ── Database init + backup ─────────────────────────────────────────

export { initDatabase } from './db.js';

/** Best-effort DB backup at startup — overwrites previous backup. */
export function backupDatabase(): void {
  const dbPath = path.join(DATA_DIR, 'data.db');
  const backupPath = dbPath + '.backup';
  try {
    if (!fs.existsSync(dbPath)) return;
    fs.copyFileSync(dbPath, backupPath);
    const sizeMb = (fs.statSync(backupPath).size / (1024 ** 2)).toFixed(1);
    logger.info({ backupPath, sizeMb }, 'Database backed up at startup');
  } catch (err) {
    logger.error({ err }, 'Database backup failed (non-fatal)');
  }
}
