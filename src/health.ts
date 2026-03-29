import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  CLI_ENABLED,
  DATA_DIR,
  GROUPS_DIR,
  HEALTH_CHECK_INTERVAL,
  MAIN_GROUP_FOLDER,
  MAX_DAILY_SPEND_USD,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { expirePendingBookings } from './square-payments.js';
import {
  getDailySpendUsd,
  getDueTasks,
  getHealthState,
  getLastMessageTimestamp,
  getTaskFailureStreaks,
  logLearningEvent,
  pruneOldLogs,
  pruneOldMessageIds,
  pruneOldOutboundDedup,
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

interface ChannelHealthSnapshot {
  connected: boolean;
  lastConnectedAt: string | null;
  recentDisconnects: number;
  protocolErrorCount: number;
}

interface HealthSnapshot {
  timestamp: string;
  status: 'ok' | 'warning' | 'critical';
  whatsapp: ChannelHealthSnapshot;
  channels: Record<string, ChannelHealthSnapshot>;
  lastMessageAt: string | null;
  authPresent: boolean;
  uptimeMinutes: number;
}

const startTime = Date.now();
let alertedCriticalAt: number | null = null;
let cliProbeFailures = 0;
let interactiveCliFailures = 0;
let lastAutoRestartAt = 0;

/** Called by index.ts when interactive CLI fails for a customer message. */
export function recordInteractiveCliFailure(): void {
  interactiveCliFailures++;
}

/** Reset interactive failure counter (e.g., after a successful CLI call). */
export function resetInteractiveCliFailures(): void {
  interactiveCliFailures = 0;
}

/**
 * Probe CLI health: (1) binary exists via `claude --version`, (2) OAuth credentials
 * file exists and token hasn't expired. This is free and instant — no API calls.
 */
function probeCli(): Promise<boolean> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;

    // Step 1: verify the binary runs
    const proc = spawn('claude', ['--version'], { env, timeout: 15000 });
    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d; });
    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        logger.warn('CLI probe: binary check failed');
        resolve(false);
        return;
      }

      // Step 2: verify OAuth credentials exist and aren't expired
      const home = process.env.HOME || require('os').homedir();
      const credsPath = path.join(home, '.claude', '.credentials.json');
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        const oauth = creds.claudeAiOauth;
        if (!oauth?.accessToken) {
          logger.warn('CLI probe: no accessToken in credentials');
          resolve(false);
          return;
        }
        if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
          logger.warn({ expiresAt: new Date(oauth.expiresAt).toISOString() }, 'CLI probe: OAuth token expired');
          resolve(false);
          return;
        }
        resolve(true);
      } catch (err) {
        logger.warn({ err }, 'CLI probe: failed to read credentials file');
        resolve(false);
      }
    });
    proc.on('error', () => resolve(false));
  });
}

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
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).format(new Date()),
    10,
  );
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

  // Check 6: Booking service health (Sheridan Rentals API on port 3200)
  try {
    const bookingRes = await fetch('http://localhost:3200/health', { signal: AbortSignal.timeout(5000) });
    if (!bookingRes.ok) {
      if (status === 'ok') status = 'warning';
      issues.push(`Booking service unhealthy (HTTP ${bookingRes.status})`);
    }
  } catch {
    if (status === 'ok') status = 'warning';
    issues.push('Booking service unreachable on port 3200 — website bookings may be failing');
  }

  // Check 7: Disk space (Linux only)
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

  // Check 7: Database size
  try {
    const dbPath = path.join(DATA_DIR, 'data.db');
    if (fs.existsSync(dbPath)) {
      const dbSizeMb = fs.statSync(dbPath).size / (1024 ** 2);
      if (dbSizeMb > 1024) {
        status = 'critical';
        issues.push(`Database critically large: ${(dbSizeMb / 1024).toFixed(1)} GB`);
      } else if (dbSizeMb > 500) {
        if (status === 'ok') status = 'warning';
        issues.push(`Database large: ${dbSizeMb.toFixed(0)} MB`);
      }
    }
  } catch { /* non-critical */ }

  // Check 8: Daily spend approaching cap
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

  // Check 9: Task failure streaks (self-healing — adaptive learning)
  try {
    const streaks = getTaskFailureStreaks(3);
    for (const streak of streaks) {
      if (status === 'ok') status = 'warning';
      issues.push(`Task "${streak.task_id}" has ${streak.consecutive_failures} consecutive failures`);
      // Log learning event so the analysis task can write guidance
      logLearningEvent({
        event_type: 'error_pattern',
        group_folder: 'main',
        details: JSON.stringify({
          task_id: streak.task_id,
          consecutive_failures: streak.consecutive_failures,
          last_error: streak.last_error.slice(0, 500),
        }),
        created_at: new Date().toISOString(),
      });
    }
  } catch { /* non-critical */ }

  // Check 10: CLI health probe (can Claude CLI execute at all?)
  if (CLI_ENABLED) {
    try {
      const cliOk = await probeCli();
      if (cliOk) {
        cliProbeFailures = 0;
      } else {
        cliProbeFailures++;
        logger.warn({ consecutiveFailures: cliProbeFailures }, 'CLI health probe failed');
      }

      // Also factor in interactive failures (real customer messages that failed)
      const totalCliIssues = cliProbeFailures + interactiveCliFailures;

      if (totalCliIssues >= 3) {
        status = 'critical';
        issues.push(`CLI broken: ${cliProbeFailures} probe failures, ${interactiveCliFailures} interactive failures — customers are getting error messages`);

        // Auto-restart once per 30 minutes if CLI is persistently broken
        const now = Date.now();
        if (now - lastAutoRestartAt > 30 * 60 * 1000) {
          lastAutoRestartAt = now;
          issues.push('Auto-restart triggered — restarting service to recover CLI');
          logger.warn('CLI persistently broken — triggering auto-restart');

          // Schedule restart after health check completes (give time for alert to send)
          setTimeout(() => {
            spawn('sudo', ['systemctl', 'restart', 'nanoclaw'], { detached: true, stdio: 'ignore' }).unref();
          }, 5000);
        }
      } else if (totalCliIssues >= 1) {
        if (status === 'ok') status = 'warning';
        issues.push(`CLI probe: ${cliProbeFailures} failures, ${interactiveCliFailures} interactive failures`);
      }
    } catch { /* non-critical */ }
  }

  // Persist status
  setHealthState('status', status);
  setHealthState('issues', JSON.stringify(issues));
  setHealthState('last_check', new Date().toISOString());

  // Build per-channel health snapshots
  const channelSnapshots: Record<string, ChannelHealthSnapshot> = {};
  for (const ch of deps.channels) {
    const info = ch.getHealthInfo?.() ?? {
      connected: ch.isConnected(),
      lastConnectedAt: null,
      recentDisconnects: [],
      protocolErrorCount: 0,
    };
    channelSnapshots[ch.name] = {
      connected: info.connected,
      lastConnectedAt: info.lastConnectedAt,
      recentDisconnects: Array.isArray(info.recentDisconnects)
        ? info.recentDisconnects.length
        : 0,
      protocolErrorCount: info.protocolErrorCount,
    };
  }

  // Write health snapshot for Andy's container to read
  const snapshot: HealthSnapshot = {
    timestamp: new Date().toISOString(),
    status,
    whatsapp: channelSnapshots['whatsapp'] ?? {
      connected: healthInfo.connected,
      lastConnectedAt: healthInfo.lastConnectedAt,
      recentDisconnects: Array.isArray(healthInfo.recentDisconnects)
        ? healthInfo.recentDisconnects.length
        : 0,
      protocolErrorCount: healthInfo.protocolErrorCount,
    },
    channels: channelSnapshots,
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

  // Alert immediately on first critical detection, then every 30 min if still critical
  if (status === 'critical') {
    const shouldAlert = !alertedCriticalAt || Date.now() - alertedCriticalAt > 30 * 60 * 1000;
    if (shouldAlert) {
      const mainJid = deps.getMainGroupJid();
      if (mainJid) {
        const prefix = alertedCriticalAt ? '⚠️ Health still critical' : '🚨 Health Alert';
        const alertText = `${prefix}:\n${issues.join('\n')}`;
        try {
          await deps.sendAlert(mainJid, alertText);
          logger.info('Critical health alert sent to main group');
          alertedCriticalAt = Date.now();
        } catch (err) {
          logger.error({ err }, 'Failed to send health alert');
        }
      } else {
        alertedCriticalAt = Date.now();
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

    // Prune old dedup message IDs (>24h)
    try {
      const prunedIds = pruneOldMessageIds();
      if (prunedIds > 0) {
        logger.info({ prunedIds }, 'Pruned old inbound message IDs');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to prune message IDs');
    }

    // Prune old outbound dedup entries
    try {
      pruneOldOutboundDedup();
    } catch (err) {
      logger.error({ err }, 'Failed to prune outbound dedup');
    }

    // Expire stale pending bookings (>30 min old)
    try {
      expirePendingBookings();
    } catch (err) {
      logger.error({ err }, 'Failed to expire pending bookings');
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

    // Daily database backup (overwrites previous — keeps latest)
    try {
      const dbPath = path.join(DATA_DIR, 'data.db');
      const backupPath = dbPath + '.backup';
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, backupPath);
        const sizeMb = (fs.statSync(backupPath).size / (1024 ** 2)).toFixed(1);
        logger.info({ backupPath, sizeMb }, 'Daily database backup completed');
      }
    } catch (err) {
      logger.error({ err }, 'Daily database backup failed');
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
