import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  HEALTH_CHECK_INTERVAL,
  MAIN_GROUP_FOLDER,
  MAX_DAILY_SPEND_USD,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  getDailySpendUsd,
  getDueTasks,
  getHealthState,
  getLastMessageTimestamp,
  pruneOldLogs,
  setHealthState,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

// Systemd watchdog: notify systemd we're still alive
function notifyWatchdog(): void {
  if (!process.env.NOTIFY_SOCKET) return;

  execFile('systemd-notify', ['WATCHDOG=1'], { timeout: 5000 }, () => {
    // Best-effort: ignore errors
  });
}

function notifyReady(): void {
  if (!process.env.NOTIFY_SOCKET) return;

  execFile('systemd-notify', ['--ready'], { timeout: 5000 }, (err) => {
    if (err) logger.warn({ err: String(err) }, 'Failed to send READY=1');
  });
}

export interface HealthMonitorDeps {
  channels: Channel[];
  sendAlert: (jid: string, text: string) => Promise<void>;
  getMainGroupJid: () => string | null;
}

interface HealthSnapshot {
  timestamp: string;
  status: 'ok' | 'warning' | 'critical';
  whatsapp: {
    connected: boolean;
    lastConnectedAt: string | null;
    recentDisconnects: number;
    protocolErrorCount: number;
  };
  lastMessageAt: string | null;
  authPresent: boolean;
  uptimeMinutes: number;
}

const startTime = Date.now();
let alertedCriticalAt: number | null = null;

function getWhatsAppChannel(channels: Channel[]): WhatsAppChannel | null {
  return (
    (channels.find((c) => c.name === 'whatsapp') as WhatsAppChannel) || null
  );
}

function checkAuthState(): boolean {
  const authDir = path.join(STORE_DIR, 'auth');
  try {
    const files = fs.readdirSync(authDir);
    return files.length > 0;
  } catch {
    return false;
  }
}

function isActiveHours(): boolean {
  const hour = new Date().getHours();
  return hour >= 9 && hour <= 18; // Business hours only — reduces false "no messages" warnings
}

async function runHealthCheck(deps: HealthMonitorDeps): Promise<void> {
  // Ping systemd watchdog — proves we're not hung
  notifyWatchdog();

  const wa = getWhatsAppChannel(deps.channels);
  const healthInfo = wa?.getHealthInfo() ?? {
    connected: false,
    lastConnectedAt: null,
    recentDisconnects: [],
    protocolErrorCount: 0,
  };

  let status: 'ok' | 'warning' | 'critical' = 'ok';
  const issues: string[] = [];

  // Check 1: WA Connection + protocol error loop detection
  if (!healthInfo.connected) {
    status = 'warning';
    issues.push('WhatsApp disconnected');
  }

  if (healthInfo.protocolErrorCount >= 3 && wa) {
    status = 'critical';
    issues.push(
      `Protocol error loop detected (${healthInfo.protocolErrorCount} errors in 10 min) — forcing reconnect`,
    );
    logger.warn(
      { protocolErrorCount: healthInfo.protocolErrorCount },
      'Protocol error loop — triggering force reconnect',
    );
    try {
      await wa.forceReconnect();
      issues.push('Force reconnect initiated');
    } catch (err) {
      logger.error({ err }, 'Force reconnect failed');
      issues.push('Force reconnect failed');
    }
  }

  // Check 2: Message silence (only during active hours)
  const lastMsgTs = getLastMessageTimestamp();
  if (lastMsgTs && isActiveHours()) {
    const silenceMs = Date.now() - new Date(lastMsgTs).getTime();
    const silenceHours = silenceMs / (1000 * 60 * 60);
    if (silenceHours >= 6) {
      if (status === 'ok') status = 'warning';
      issues.push(`No messages in ${silenceHours.toFixed(1)} hours`);
    }
  }

  // Check 3: Stale scheduled tasks (next_run stuck in the past)
  try {
    const dueTasks = getDueTasks();
    const now = Date.now();
    for (const task of dueTasks) {
      if (task.schedule_type === 'cron' && task.next_run) {
        const staleness = now - new Date(task.next_run).getTime();
        if (staleness > 30 * 60 * 1000) {
          // 30+ min stale
          try {
            const nextRun = CronExpressionParser.parse(task.schedule_value, {
              tz: TIMEZONE,
            })
              .next()
              .toISOString();
            updateTask(task.id, { next_run: nextRun });
            logger.warn(
              {
                taskId: task.id,
                staleMinutes: Math.round(staleness / 60000),
                nextRun,
              },
              'Health monitor auto-fixed stale cron task',
            );
            issues.push(
              `Auto-fixed stale task ${task.id} (was ${Math.round(staleness / 60000)} min overdue)`,
            );
          } catch {
            /* invalid cron */
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error checking stale tasks');
  }

  // Check 4: Auth state
  const authPresent = checkAuthState();
  if (!authPresent) {
    status = 'critical';
    issues.push('Auth directory empty — QR re-authentication needed');
  }

  // Check 5: Non-WhatsApp channel health
  for (const ch of deps.channels) {
    if (ch.name !== 'whatsapp' && !ch.isConnected()) {
      if (status === 'ok') status = 'warning';
      issues.push(`${ch.name} channel disconnected`);
    }
  }

  // Check 6: Disk space (Linux only)
  try {
    const stats = fs.statfsSync(STORE_DIR);
    const freeGb = (stats.bfree * stats.bsize) / (1024 ** 3);
    if (freeGb < 1) {
      status = 'critical';
      issues.push(`Disk space critically low: ${freeGb.toFixed(1)} GB free`);
    } else if (freeGb < 3) {
      if (status === 'ok') status = 'warning';
      issues.push(`Disk space low: ${freeGb.toFixed(1)} GB free`);
    }
  } catch {
    // statfsSync may not be available on all platforms
  }

  // Check 7: Daily spend approaching cap
  if (MAX_DAILY_SPEND_USD > 0) {
    try {
      const spent = getDailySpendUsd();
      const pct = spent / MAX_DAILY_SPEND_USD;
      if (pct >= 0.8) {
        if (status === 'ok') status = 'warning';
        issues.push(`Daily spend at ${(pct * 100).toFixed(0)}% ($${spent.toFixed(2)} / $${MAX_DAILY_SPEND_USD})`);
      }
    } catch {
      // non-critical
    }
  }

  // Persist status
  setHealthState('status', status);
  setHealthState('issues', JSON.stringify(issues));
  setHealthState('last_check', new Date().toISOString());

  // Write health snapshot for Andy's container to read
  const snapshot: HealthSnapshot = {
    timestamp: new Date().toISOString(),
    status,
    whatsapp: {
      connected: healthInfo.connected,
      lastConnectedAt: healthInfo.lastConnectedAt,
      recentDisconnects: Array.isArray(healthInfo.recentDisconnects)
        ? healthInfo.recentDisconnects.length
        : 0,
      protocolErrorCount: healthInfo.protocolErrorCount,
    },
    lastMessageAt: lastMsgTs,
    authPresent,
    uptimeMinutes: Math.round((Date.now() - startTime) / 60000),
  };

  const ipcDir = path.join(DATA_DIR, 'ipc', MAIN_GROUP_FOLDER);
  fs.mkdirSync(ipcDir, { recursive: true });
  const snapshotPath = path.join(ipcDir, 'health_snapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  if (issues.length > 0) {
    logger.info({ status, issues }, 'Health check completed with issues');
  } else {
    logger.debug({ status }, 'Health check OK');
  }

  // Alert if critical for >30 minutes
  if (status === 'critical') {
    if (!alertedCriticalAt) {
      alertedCriticalAt = Date.now();
    } else if (Date.now() - alertedCriticalAt > 30 * 60 * 1000) {
      const mainJid = deps.getMainGroupJid();
      if (mainJid) {
        const alertText = `⚠️ Health Alert (critical for 30+ min):\n${issues.join('\n')}`;
        try {
          await deps.sendAlert(mainJid, alertText);
          logger.info('Critical health alert sent to main group');
          // Reset so we don't spam — will alert again after another 30 min
          alertedCriticalAt = Date.now();
        } catch (err) {
          logger.error({ err }, 'Failed to send health alert');
        }
      }
    }
  } else {
    alertedCriticalAt = null;
  }
}

export function startHealthMonitor(deps: HealthMonitorDeps): void {
  logger.info({ intervalMs: HEALTH_CHECK_INTERVAL }, 'Starting health monitor');

  // Tell systemd we are ready + start watchdog pings
  const notifySocket = process.env.NOTIFY_SOCKET;
  logger.info({ notifySocket: notifySocket || '(not set)' }, 'Systemd notify socket');
  if (notifySocket) {
    notifyReady();
    logger.info('Sent READY=1 to systemd');
  }

  // Ping watchdog more frequently than the health check interval
  // WatchdogSec=120s, so ping every 30s to stay well within the timeout
  setInterval(() => notifyWatchdog(), 30000);

  // Run first check after a short delay to let connections settle
  setTimeout(() => {
    runHealthCheck(deps).catch((err) =>
      logger.error({ err }, 'Health check error'),
    );
  }, 30000);

  setInterval(() => {
    runHealthCheck(deps).catch((err) =>
      logger.error({ err }, 'Health check error'),
    );
  }, HEALTH_CHECK_INTERVAL);

  // Daily maintenance: prune old logs and clean up container log files
  const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000; // 24h
  const runMaintenance = () => {
    try {
      const pruned = pruneOldLogs();
      if (pruned.taskRuns > 0 || pruned.usage > 0 || pruned.messages > 0) {
        logger.info(pruned, 'Daily maintenance: pruned old log entries');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to prune logs');
    }

    // Clean up container log files older than 7 days
    try {
      const cutoff = Date.now() - 7 * 86400000;
      const groupsDir = GROUPS_DIR;
      if (fs.existsSync(groupsDir)) {
        for (const folder of fs.readdirSync(groupsDir)) {
          const logsDir = path.join(groupsDir, folder, 'logs');
          if (!fs.existsSync(logsDir)) continue;
          for (const file of fs.readdirSync(logsDir)) {
            const filePath = path.join(logsDir, file);
            try {
              const stat = fs.statSync(filePath);
              if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
            } catch { /* skip */ }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to clean container logs');
    }

    // Clean up IPC error files
    try {
      const errDir = path.join(DATA_DIR, 'ipc', 'errors');
      if (fs.existsSync(errDir)) {
        const cutoff = Date.now() - 7 * 86400000;
        for (const file of fs.readdirSync(errDir)) {
          const filePath = path.join(errDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to clean IPC error files');
    }
  };

  // Run maintenance 5 minutes after startup, then every 24h
  setTimeout(runMaintenance, 5 * 60 * 1000);
  setInterval(runMaintenance, MAINTENANCE_INTERVAL);
}
