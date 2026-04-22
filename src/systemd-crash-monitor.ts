import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { NotificationBatcher } from './notification-batcher.js';
import type { RegisteredGroup } from './types.js';

const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_OPS_FOLDER = 'ops';

export interface CrashMonitorConfig {
  /** Systemd unit names to monitor (e.g., ['nanoclaw', 'agency-hq']). */
  services: string[];
  /** Poll interval in ms (default: 30s). */
  intervalMs?: number;
  /** Group folder for the ops-agent that receives crash events (default: 'ops'). */
  opsFolder?: string;
  /** Whether to use --user flag for systemctl (default: true). */
  userMode?: boolean;
}

export interface CrashMonitorDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  notificationBatcher?: NotificationBatcher;
}

/** Load monitor config from the config file, or return null if not found. */
export function loadCrashMonitorConfig(): CrashMonitorConfig | null {
  const configPath = path.join(
    process.env.HOME || '',
    '.config',
    'nanoclaw',
    'crash-monitor.json',
  );

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CrashMonitorConfig>;

    if (!Array.isArray(parsed.services) || parsed.services.length === 0) {
      logger.warn(
        { configPath },
        'Crash monitor config has no services to monitor',
      );
      return null;
    }

    // Validate service names (alphanumeric, hyphens, underscores only)
    const validServices = parsed.services.filter((s) =>
      /^[a-zA-Z0-9_@.-]+$/.test(s),
    );
    if (validServices.length === 0) {
      logger.warn('Crash monitor config: no valid service names found');
      return null;
    }

    return {
      services: validServices,
      intervalMs: parsed.intervalMs ?? DEFAULT_INTERVAL_MS,
      opsFolder: parsed.opsFolder ?? DEFAULT_OPS_FOLDER,
      userMode: parsed.userMode ?? true,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ configPath }, 'Crash monitor config not found, skipping');
    } else {
      logger.warn({ err, configPath }, 'Failed to read crash monitor config');
    }
    return null;
  }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString('utf-8'),
        exitCode: code ?? 1,
      });
    });
    child.on('error', () => resolve({ stdout: '', exitCode: 1 }));
  });
}

/** Track known-failed services to only fire on state transitions. */
const knownFailures = new Set<string>();

/** Exported for testing. */
export function _resetKnownFailures(): void {
  knownFailures.clear();
}

/** Exported for testing. */
export function _getKnownFailures(): Set<string> {
  return knownFailures;
}

/**
 * Write an IPC task file that triggers the ops-agent to investigate a crash.
 * Uses the IPC filesystem convention: data/ipc/{opsFolder}/tasks/{filename}.json
 */
export function emitCrashEvent(
  unit: string,
  timestamp: string,
  journalTail: string,
  opsFolder: string,
): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', opsFolder, 'tasks');
  fs.mkdirSync(ipcDir, { recursive: true });

  const taskId = `crash-${unit}-${Date.now()}`;
  const ipcPayload = {
    type: 'schedule_task',
    taskId,
    prompt: `[SYSTEMD CRASH] Service "${unit}" entered failed state at ${timestamp}.\n\nInvestigate the failure and take corrective action. Recent journal output:\n\`\`\`\n${journalTail}\n\`\`\`\n\nSteps:\n1. Check journal logs: journalctl --user -u ${unit} -n 50\n2. Identify root cause\n3. Attempt restart: systemctl --user restart ${unit}\n4. Report findings`,
    schedule_type: 'once',
    schedule_value: new Date().toISOString(),
    context_mode: 'group',
    targetJid: '__ops__',
  };

  const filePath = path.join(ipcDir, `${taskId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(ipcPayload, null, 2));
  logger.info({ unit, filePath, taskId }, 'Crash event IPC file written');
}

/**
 * Check configured services for failures.
 * Fires IPC events for new failures, sends recovery notifications.
 */
export async function checkServiceStatus(
  config: CrashMonitorConfig,
  deps: CrashMonitorDeps,
): Promise<void> {
  const systemctlArgs = config.userMode ? ['--user'] : [];

  const currentFailures = new Set<string>();

  for (const service of config.services) {
    const { exitCode } = await runCommand('systemctl', [
      ...systemctlArgs,
      'is-failed',
      `${service}.service`,
    ]);

    // exit code 0 means the service is in 'failed' state
    if (exitCode === 0) {
      currentFailures.add(service);
    }
  }

  const mainEntry = Object.entries(deps.registeredGroups()).find(
    ([, g]) => g.isMain === true,
  );
  const mainJid = mainEntry?.[0];

  // Alert on new failures
  for (const service of currentFailures) {
    if (!knownFailures.has(service)) {
      knownFailures.add(service);

      const timestamp = new Date().toISOString();

      // Get recent journal output
      const { stdout: journal } = await runCommand('journalctl', [
        ...(config.userMode ? ['--user'] : []),
        '-n',
        '20',
        '-u',
        `${service}.service`,
        '--no-pager',
        '--output=short',
      ]);
      const tail = journal.trim().slice(-1500) || '(no journal output)';

      // Emit IPC event for the ops-agent
      try {
        emitCrashEvent(
          service,
          timestamp,
          tail,
          config.opsFolder ?? DEFAULT_OPS_FOLDER,
        );
      } catch (err) {
        logger.error({ err, service }, 'Failed to emit crash IPC event');
      }

      // Also send notification to main group
      if (mainJid) {
        const msg = `*[CRASH] Service failed: ${service}*\nOps-agent has been triggered to investigate.\n\n\`\`\`\n${tail}\n\`\`\``;
        const send = deps.notificationBatcher
          ? deps.notificationBatcher.send(mainJid, msg, 'error')
          : deps.sendMessage(mainJid, msg);
        await send.catch((err) =>
          logger.error({ err, service }, 'Crash monitor: failed to send alert'),
        );
      }

      logger.warn(
        { service, timestamp },
        'Crash monitor: service failure detected',
      );
    }
  }

  // Notify on recovery
  for (const service of knownFailures) {
    if (!currentFailures.has(service)) {
      knownFailures.delete(service);
      logger.info({ service }, 'Crash monitor: service recovered');

      if (mainJid) {
        const msg = `*[RESOLVED] Service recovered: ${service}*`;
        const send = deps.notificationBatcher
          ? deps.notificationBatcher.send(mainJid, msg, 'info')
          : deps.sendMessage(mainJid, msg);
        await send.catch((err) =>
          logger.error(
            { err, service },
            'Crash monitor: failed to send recovery alert',
          ),
        );
      }
    }
  }
}

let pollHandle: ReturnType<typeof setTimeout> | null = null;

export function startCrashMonitor(
  config: CrashMonitorConfig,
  deps: CrashMonitorDeps,
): void {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  logger.info(
    { intervalMs, services: config.services },
    'Systemd crash monitor started',
  );

  const poll = () => {
    checkServiceStatus(config, deps).catch((err) =>
      logger.error({ err }, 'Crash monitor: unexpected error'),
    );
    pollHandle = setTimeout(poll, intervalMs);
  };

  // First check after one interval to let channels connect
  pollHandle = setTimeout(poll, intervalMs);
}

export function stopCrashMonitor(): void {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
    logger.info('Systemd crash monitor stopped');
  }
}
