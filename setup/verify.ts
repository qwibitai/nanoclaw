/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import {
  getPlatform,
  getServiceManager,
  hasSystemd,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();

  logger.info('Starting verification');

  // 1. Check service status
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      if (output.includes('com.nanoclaw')) {
        // Check if it has a PID (actually running)
        const line = output.split('\n').find((l) => l.includes('com.nanoclaw'));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {
      // launchctl not available
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active nanoclaw`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes('nanoclaw')) {
          service = 'stopped';
        }
      } catch {
        // systemctl not available
      }
    }
  } else {
    // Check for nohup PID file
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
        if (pid) {
          execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }
  logger.info({ service }, 'Service status');

  // 2. Check container runtime
  let containerRuntime = 'none';
  try {
    execSync('command -v container', { stdio: 'ignore' });
    containerRuntime = 'apple-container';
  } catch {
    try {
      execSync('docker info', { stdio: 'ignore' });
      containerRuntime = 'docker';
    } catch {
      // No runtime
    }
  }

  // 3. Check credentials
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }

  // 4. Check channel auth (per enabled channel)
  const envVars = readEnvFile([
    'ENABLED_CHANNELS',
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
  ]);
  const enabledChannels = (
    process.env.ENABLED_CHANNELS ||
    envVars.ENABLED_CHANNELS ||
    'whatsapp'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const channelAuth: Record<string, string> = {};
  for (const ch of enabledChannels) {
    switch (ch) {
      case 'whatsapp': {
        const authDir = path.join(projectRoot, 'store', 'auth');
        channelAuth[ch] =
          fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0
            ? 'authenticated'
            : 'not_found';
        break;
      }
      case 'telegram':
        channelAuth[ch] =
          process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN
            ? 'configured'
            : 'not_found';
        break;
      case 'slack':
        channelAuth[ch] =
          (process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN) &&
          (process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN)
            ? 'configured'
            : 'not_found';
        break;
      case 'discord':
        channelAuth[ch] =
          process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN
            ? 'configured'
            : 'not_found';
        break;
      default:
        channelAuth[ch] = 'unknown';
    }
  }
  const allChannelsAuthed = enabledChannels.every(
    (ch) => channelAuth[ch] !== 'not_found',
  );

  // 5. Check registered groups (using better-sqlite3, not sqlite3 CLI)
  let registeredGroups = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_groups')
        .get() as { count: number };
      registeredGroups = row.count;
      db.close();
    } catch {
      // Table might not exist
    }
  }

  // 6. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // Determine overall status
  const status =
    service === 'running' &&
    credentials !== 'missing' &&
    allChannelsAuthed &&
    registeredGroups > 0
      ? 'success'
      : 'failed';

  logger.info({ status, channelAuth }, 'Verification complete');

  emitStatus('VERIFY', {
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    ENABLED_CHANNELS: enabledChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: mountAllowlist,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
