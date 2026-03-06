import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ONLY',
  'THINGS_AUTH_TOKEN',
  'THINGS_SYNC_INTERVAL',
  'THINGS_DB_PATH',
  'EXOCORTEX_PATH',
  'OBSIDIAN_VAULT_PATH',
  'OBSIDIAN_SYNC_INTERVAL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Telegram configuration
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY =
  (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';

// Things + Exocortex configuration
export const THINGS_AUTH_TOKEN =
  process.env.THINGS_AUTH_TOKEN || envConfig.THINGS_AUTH_TOKEN || '';
export const THINGS_SYNC_INTERVAL = parseInt(
  process.env.THINGS_SYNC_INTERVAL ||
    envConfig.THINGS_SYNC_INTERVAL ||
    '3600000',
  10,
);
export const THINGS_DB_PATH =
  process.env.THINGS_DB_PATH ||
  envConfig.THINGS_DB_PATH ||
  '~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-YN4YZ/Things Database.thingsdatabase/main.sqlite';
export const EXOCORTEX_PATH =
  process.env.EXOCORTEX_PATH || envConfig.EXOCORTEX_PATH || '';
export const OBSIDIAN_VAULT_PATH =
  process.env.OBSIDIAN_VAULT_PATH || envConfig.OBSIDIAN_VAULT_PATH || '';
export const OBSIDIAN_SYNC_INTERVAL = parseInt(
  process.env.OBSIDIAN_SYNC_INTERVAL ||
    envConfig.OBSIDIAN_SYNC_INTERVAL ||
    '600000',
  10,
);
