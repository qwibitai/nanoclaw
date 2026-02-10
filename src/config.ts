import os from 'os';
import path from 'path';
import { VaultConfig } from './types.js';
import { loadJson } from './utils.js';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Jarvis';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
export const PROJECT_ROOT = process.cwd();
export const HOME_DIR = process.env.HOME || os.homedir();

// All runtime data lives outside the source tree
export const NANOCLAW_HOME = process.env.NANOCLAW_HOME || path.join(HOME_DIR, '.nanoclaw');
export const STORE_DIR = path.join(NANOCLAW_HOME, 'store');
export const DATA_DIR = path.join(NANOCLAW_HOME, 'data');
export const GROUPS_DIR = path.join(NANOCLAW_HOME, 'groups');
export const LOGS_DIR = path.join(NANOCLAW_HOME, 'logs');
export const MOUNT_ALLOWLIST_PATH = path.join(NANOCLAW_HOME, 'mount-allowlist.json');
export const VAULT_CONFIG_PATH = path.join(NANOCLAW_HOME, 'vault-config.json');
export const ENV_FILE_PATH = path.join(NANOCLAW_HOME, 'env');
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
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
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

export function loadVaultConfig(): VaultConfig {
  return loadJson<VaultConfig>(VAULT_CONFIG_PATH, {});
}

// Re-export expandPath from mount-security to avoid duplication
export { expandPath } from './mount-security.js';
