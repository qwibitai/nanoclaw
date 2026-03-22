import { spawn } from 'child_process';

import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface UptimeMonitorDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ stdout: string; exit_code: number }> {
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
        exit_code: code ?? 1,
      });
    });
    child.on('error', () => resolve({ stdout: '', exit_code: 1 }));
  });
}

// Track known-failed services to avoid repeat alerts for the same failure.
// Only fires on state transitions (new failure or recovery).
const knownFailures = new Set<string>();

async function checkServices(deps: UptimeMonitorDeps): Promise<void> {
  const { stdout } = await runCommand('systemctl', [
    '--user',
    'list-units',
    '--state=failed',
    '--no-legend',
    '--no-pager',
  ]);

  const currentFailures = new Set(
    stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((unit) => unit && unit.length > 0),
  );

  const mainEntry = Object.entries(deps.registeredGroups()).find(
    ([, g]) => g.isMain === true,
  );
  if (!mainEntry) {
    logger.debug('Uptime monitor: no main group registered yet, skipping');
    return;
  }
  const mainJid = mainEntry[0];

  // Alert on new failures
  for (const unit of currentFailures) {
    if (!knownFailures.has(unit)) {
      knownFailures.add(unit);

      const { stdout: journal } = await runCommand('journalctl', [
        '--user',
        '-n',
        '20',
        '-u',
        unit,
        '--no-pager',
        '--output=short',
      ]);

      const tail = journal.trim().slice(-1500) || '(no journal output)';
      const msg = `*[ALERT] Service down: ${unit}*\n\n\`\`\`\n${tail}\n\`\`\``;

      logger.warn({ unit }, 'Uptime monitor: service failed, sending alert');
      await deps
        .sendMessage(mainJid, msg)
        .catch((err) =>
          logger.error({ err, unit }, 'Uptime monitor: failed to send alert'),
        );
    }
  }

  // Notify on recovery
  for (const unit of knownFailures) {
    if (!currentFailures.has(unit)) {
      knownFailures.delete(unit);
      const msg = `*[RESOLVED] Service recovered: ${unit}*`;
      logger.info({ unit }, 'Uptime monitor: service recovered');
      await deps
        .sendMessage(mainJid, msg)
        .catch((err) =>
          logger.error(
            { err, unit },
            'Uptime monitor: failed to send recovery alert',
          ),
        );
    }
  }
}

let pollHandle: ReturnType<typeof setTimeout> | null = null;

export function startUptimeMonitor(deps: UptimeMonitorDeps): void {
  logger.info({ intervalMs: INTERVAL_MS }, 'Uptime monitor started');

  const poll = () => {
    checkServices(deps).catch((err) =>
      logger.error({ err }, 'Uptime monitor: unexpected error'),
    );
    pollHandle = setTimeout(poll, INTERVAL_MS);
  };

  // First check after one interval to let channels connect before alerting
  pollHandle = setTimeout(poll, INTERVAL_MS);
}

export function stopUptimeMonitor(): void {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
    logger.info('Uptime monitor stopped');
  }
}
