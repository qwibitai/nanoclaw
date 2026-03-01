import { execSync } from 'child_process';

import { USAGE_ALERT_COOLDOWN, USAGE_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';

interface UsageBucket {
  utilization: number;
  resetsAt: string;
}

interface UsageData {
  fiveHour: UsageBucket;
  sevenDay: UsageBucket;
}

interface UsageMonitorDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getMainJid: () => string | undefined;
}

interface PreviousReading {
  fiveHour: number;
  sevenDay: number;
  timestamp: number;
}

const THRESHOLD = 75;
const SPIKE_DELTA = 20;

let lastAlerts: Record<string, number> = {};
let previousReading: PreviousReading | null = null;

export function getOAuthToken(): string | null {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function fetchUsage(token: string): Promise<UsageData | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Usage endpoint returned error');
      return null;
    }
    const data = (await res.json()) as Record<string, Record<string, unknown>>;
    return {
      fiveHour: {
        utilization: (data.fiveHour?.utilization as number) ?? 0,
        resetsAt: (data.fiveHour?.resetsAt as string) ?? '',
      },
      sevenDay: {
        utilization: (data.sevenDay?.utilization as number) ?? 0,
        resetsAt: (data.sevenDay?.resetsAt as string) ?? '',
      },
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch usage data');
    return null;
  }
}

function canAlert(key: string): boolean {
  const lastAlert = lastAlerts[key];
  if (!lastAlert) return true;
  return Date.now() - lastAlert >= USAGE_ALERT_COOLDOWN;
}

function markAlerted(key: string): void {
  lastAlerts[key] = Date.now();
}

function formatResetTime(resetsAt: string): string {
  if (!resetsAt) return 'unknown';
  try {
    const date = new Date(resetsAt);
    const now = new Date();
    // If resets today, show time only
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    // Otherwise show day name
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  } catch {
    return resetsAt;
  }
}

async function checkUsage(deps: UsageMonitorDeps): Promise<void> {
  const mainJid = deps.getMainJid();
  if (!mainJid) {
    logger.debug('Usage monitor: no main group JID, skipping check');
    return;
  }

  const token = getOAuthToken();
  if (!token) {
    logger.debug('Usage monitor: OAuth token not found, skipping check');
    return;
  }

  const usage = await fetchUsage(token);
  if (!usage) return;

  logger.info(
    { fiveHour: usage.fiveHour.utilization, sevenDay: usage.sevenDay.utilization },
    'Usage check',
  );

  const alerts: string[] = [];

  // Threshold alerts
  if (usage.fiveHour.utilization >= THRESHOLD && canAlert('threshold-5h')) {
    alerts.push(
      `Usage alert: Your 5-hour utilization is at ${Math.round(usage.fiveHour.utilization)}% (resets at ${formatResetTime(usage.fiveHour.resetsAt)}). Consider slowing down to avoid hitting the limit.`,
    );
    markAlerted('threshold-5h');
  }

  if (usage.sevenDay.utilization >= THRESHOLD && canAlert('threshold-7d')) {
    alerts.push(
      `Usage alert: Your 7-day utilization is at ${Math.round(usage.sevenDay.utilization)}% (resets ${formatResetTime(usage.sevenDay.resetsAt)}). You may hit your weekly cap soon.`,
    );
    markAlerted('threshold-7d');
  }

  // Spike detection
  if (previousReading) {
    const fiveHourDelta = usage.fiveHour.utilization - previousReading.fiveHour;
    const sevenDayDelta = usage.sevenDay.utilization - previousReading.sevenDay;

    if (fiveHourDelta >= SPIKE_DELTA && canAlert('spike-5h')) {
      alerts.push(
        `Usage spike: Your 5-hour utilization jumped from ${Math.round(previousReading.fiveHour)}% to ${Math.round(usage.fiveHour.utilization)}% in the last 30 minutes.`,
      );
      markAlerted('spike-5h');
    }

    if (sevenDayDelta >= SPIKE_DELTA && canAlert('spike-7d')) {
      alerts.push(
        `Usage spike: Your 7-day utilization jumped from ${Math.round(previousReading.sevenDay)}% to ${Math.round(usage.sevenDay.utilization)}% in the last 30 minutes.`,
      );
      markAlerted('spike-7d');
    }
  }

  previousReading = {
    fiveHour: usage.fiveHour.utilization,
    sevenDay: usage.sevenDay.utilization,
    timestamp: Date.now(),
  };

  for (const alert of alerts) {
    try {
      await deps.sendMessage(mainJid, alert);
    } catch (err) {
      logger.warn({ err }, 'Failed to send usage alert');
    }
  }
}

export function startUsageMonitor(deps: UsageMonitorDeps): void {
  logger.info(
    { intervalMs: USAGE_POLL_INTERVAL },
    'Starting usage monitor',
  );

  // Initial check after a short delay (let channels settle)
  setTimeout(() => {
    checkUsage(deps).catch((err) =>
      logger.warn({ err }, 'Usage check failed'),
    );
  }, 10_000);

  // Recurring checks
  setInterval(() => {
    checkUsage(deps).catch((err) =>
      logger.warn({ err }, 'Usage check failed'),
    );
  }, USAGE_POLL_INTERVAL);
}

// Exported for testing
export { checkUsage as _checkUsage };
