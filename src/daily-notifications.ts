import { CronExpressionParser } from 'cron-parser';

import { getBacklogResolvedSince, getShipLogSince } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Default: 8am Eastern (America/New_York handles DST automatically)
const DAILY_NOTIFY_CRON = process.env.DAILY_NOTIFY_CRON || '0 8 * * *';
const DAILY_NOTIFY_TZ = process.env.DAILY_NOTIFY_TZ || 'America/New_York';

export interface DailyNotificationDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function getUniqueFolders(groups: Record<string, RegisteredGroup>): string[] {
  return [...new Set(Object.values(groups).map((g) => g.folder))];
}

/** Returns unique non-thread JIDs for a folder, with notifyJid appended if set and different. */
function getTargetJids(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): string[] {
  const entries = Object.entries(groups).filter(
    ([jid, g]) => g.folder === folder && !jid.includes(':thread:'),
  );
  const defaultJid = entries[0]?.[0];
  if (!defaultJid) return [];

  const overrideEntry = entries.find(([, g]) => g.containerConfig?.notifyJid);
  const notifyJid = overrideEntry?.[1].containerConfig?.notifyJid;
  const targets = [defaultJid];
  if (notifyJid && notifyJid !== defaultJid) targets.push(notifyJid);
  return targets;
}

export async function sendDailySummaries(
  deps: DailyNotificationDeps,
): Promise<void> {
  const groups = deps.registeredGroups();
  const folders = getUniqueFolders(groups);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  for (const folder of folders) {
    const shipped = getShipLogSince(folder, since);
    const resolved = getBacklogResolvedSince(folder, since);

    if (shipped.length === 0 && resolved.length === 0) continue;

    const lines: string[] = [`📋 **Daily Summary** — ${folder}`];

    if (shipped.length > 0) {
      lines.push(`\n📦 **Shipped** (${shipped.length}):`);
      for (const entry of shipped) {
        const prPart = entry.pr_url ? ` — ${entry.pr_url}` : '';
        lines.push(`• ${entry.title}${prPart}`);
      }
    }

    if (resolved.length > 0) {
      lines.push(`\n✅ **Resolved** (${resolved.length}):`);
      for (const item of resolved) {
        const emoji = item.status === 'resolved' ? '✅' : '🚫';
        lines.push(`${emoji} ${item.title}`);
      }
    }

    const message = lines.join('\n');
    const targets = getTargetJids(groups, folder);

    for (const jid of targets) {
      try {
        await deps.sendMessage(jid, message);
      } catch (err) {
        logger.warn({ folder, jid, err }, 'Failed to send daily summary');
      }
    }

    logger.info(
      { folder, shipped: shipped.length, resolved: resolved.length },
      'Daily summary sent',
    );
  }
}

export function startDailyNotifier(deps: DailyNotificationDeps): void {
  const scheduleNextRun = () => {
    try {
      const interval = CronExpressionParser.parse(DAILY_NOTIFY_CRON, {
        tz: DAILY_NOTIFY_TZ,
      });
      const next = interval.next().toDate();
      const delay = next.getTime() - Date.now();
      logger.info(
        { next: next.toISOString(), cron: DAILY_NOTIFY_CRON },
        'Daily notifier scheduled',
      );
      setTimeout(async () => {
        await sendDailySummaries(deps).catch((err) =>
          logger.error({ err }, 'Daily summary failed'),
        );
        scheduleNextRun();
      }, delay);
    } catch (err) {
      logger.error(
        { err, cron: DAILY_NOTIFY_CRON },
        'Invalid daily notify cron expression',
      );
    }
  };

  scheduleNextRun();
}
