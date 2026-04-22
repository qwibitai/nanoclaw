/**
 * Standalone entry point for the systemd crash monitor.
 *
 * Runs outside the main NanoClaw process so it can detect when NanoClaw
 * itself crashes. Writes IPC task files that the ops-agent picks up on
 * the next NanoClaw restart (or immediately if NanoClaw is running).
 *
 * Usage: node dist/systemd-crash-monitor-standalone.js
 * Config: ~/.config/nanoclaw/crash-monitor.json
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { logger } from './logger.js';

interface CrashMonitorConfig {
  services: string[];
  intervalMs?: number;
  opsFolder?: string;
  userMode?: boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_OPS_FOLDER = 'ops';
const DATA_DIR = path.resolve(process.cwd(), 'data');

function loadConfig(): CrashMonitorConfig | null {
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
      logger.fatal({ configPath }, 'No services configured');
      return null;
    }

    const validServices = parsed.services.filter((s) =>
      /^[a-zA-Z0-9_@.-]+$/.test(s),
    );
    if (validServices.length === 0) {
      logger.fatal('No valid service names found');
      return null;
    }

    return {
      services: validServices,
      intervalMs: parsed.intervalMs ?? DEFAULT_INTERVAL_MS,
      opsFolder: parsed.opsFolder ?? DEFAULT_OPS_FOLDER,
      userMode: parsed.userMode ?? true,
    };
  } catch (err) {
    logger.fatal({ err, configPath }, 'Failed to read crash monitor config');
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

const knownFailures = new Set<string>();

async function checkServices(config: CrashMonitorConfig): Promise<void> {
  const systemctlArgs = config.userMode ? ['--user'] : [];

  for (const service of config.services) {
    const { exitCode } = await runCommand('systemctl', [
      ...systemctlArgs,
      'is-failed',
      `${service}.service`,
    ]);

    if (exitCode === 0 && !knownFailures.has(service)) {
      knownFailures.add(service);

      const timestamp = new Date().toISOString();
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

      // Write IPC task file
      const opsFolder = config.opsFolder ?? DEFAULT_OPS_FOLDER;
      const ipcDir = path.join(DATA_DIR, 'ipc', opsFolder, 'tasks');
      fs.mkdirSync(ipcDir, { recursive: true });

      const taskId = `crash-${service}-${Date.now()}`;
      const payload = {
        type: 'schedule_task',
        taskId,
        prompt: `[SYSTEMD CRASH] Service "${service}" entered failed state at ${timestamp}.\n\nInvestigate the failure and take corrective action. Recent journal output:\n\`\`\`\n${tail}\n\`\`\`\n\nSteps:\n1. Check journal logs: journalctl --user -u ${service} -n 50\n2. Identify root cause\n3. Attempt restart: systemctl --user restart ${service}\n4. Report findings`,
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        context_mode: 'group',
        targetJid: '__ops__',
      };

      fs.writeFileSync(
        path.join(ipcDir, `${taskId}.json`),
        JSON.stringify(payload, null, 2),
      );
      logger.warn(
        { service, taskId, timestamp },
        'Crash detected, IPC written',
      );
    } else if (exitCode !== 0 && knownFailures.has(service)) {
      knownFailures.delete(service);
      logger.info({ service }, 'Service recovered');
    }
  }
}

// --- Main ---

const config = loadConfig();
if (!config) {
  process.exit(1);
}

logger.info(
  { services: config.services, intervalMs: config.intervalMs },
  'Standalone crash monitor starting',
);

const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;

const poll = () => {
  checkServices(config).catch((err) =>
    logger.error({ err }, 'Crash monitor: unexpected error'),
  );
};

// Initial check after short delay, then poll on interval
setTimeout(poll, 5000);
setInterval(poll, intervalMs);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Standalone crash monitor shutting down');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('Standalone crash monitor shutting down');
  process.exit(0);
});
