/**
 * Step: channels — Save the list of enabled channels to .env.
 * Called during setup with --channels whatsapp,telegram etc.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const KNOWN_CHANNELS = ['whatsapp', 'telegram', 'slack', 'discord'];

function parseArgs(args: string[]): { channels: string[] } {
  let raw = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channels' && args[i + 1]) {
      raw = args[i + 1];
      i++;
    }
  }
  const channels = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { channels };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { channels } = parseArgs(args);

  if (channels.length === 0) {
    emitStatus('CHANNELS', {
      STATUS: 'failed',
      ERROR: 'no_channels_specified',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const unknown = channels.filter((c) => !KNOWN_CHANNELS.includes(c));
  if (unknown.length > 0) {
    logger.warn({ unknown }, 'Unknown channel names (proceeding anyway)');
  }

  const value = channels.join(',');

  // Update .env
  const envFile = path.join(projectRoot, '.env');
  let envContent = '';
  if (fs.existsSync(envFile)) {
    envContent = fs.readFileSync(envFile, 'utf-8');
  }

  if (envContent.includes('ENABLED_CHANNELS=')) {
    envContent = envContent.replace(
      /^ENABLED_CHANNELS=.*$/m,
      `ENABLED_CHANNELS="${value}"`,
    );
  } else {
    envContent =
      envContent.trimEnd() + `\nENABLED_CHANNELS="${value}"\n`;
  }

  fs.writeFileSync(envFile, envContent);
  logger.info({ channels: value }, 'Saved ENABLED_CHANNELS to .env');

  emitStatus('CHANNELS', {
    ENABLED_CHANNELS: value,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
