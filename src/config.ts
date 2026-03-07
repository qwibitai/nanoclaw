import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'NO_TRIGGER_REQUIRED_IN_DMS',
  'HAL_WORKSPACE_DIR',
  'OPENCLAW_AUTH_DIR',
  'HAL_ALLOWED_WHATSAPP_SENDER',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Hal';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const NO_TRIGGER_REQUIRED_IN_DMS =
  (process.env.NO_TRIGGER_REQUIRED_IN_DMS ||
    envConfig.NO_TRIGGER_REQUIRED_IN_DMS ||
    'true') !== 'false';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();
const OPENCLAW_HOME = path.join(HOME_DIR, '.openclaw');

function resolveConfiguredPath(rawPath: string): string {
  if (rawPath === '~') return HOME_DIR;
  if (rawPath.startsWith('~/')) {
    return path.resolve(HOME_DIR, rawPath.slice(2));
  }
  return path.resolve(rawPath);
}

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const OPENCLAW_WORKSPACE_DIR = resolveConfiguredPath(
  process.env.HAL_WORKSPACE_DIR ||
    envConfig.HAL_WORKSPACE_DIR ||
    path.join(OPENCLAW_HOME, 'workspace'),
);
export const OPENCLAW_AUTH_DIR = resolveConfiguredPath(
  process.env.OPENCLAW_AUTH_DIR ||
    envConfig.OPENCLAW_AUTH_DIR ||
    path.join(OPENCLAW_HOME, 'store', 'auth'),
);
export const OPENCLAW_WORKSPACE_CONTAINER_PATH =
  '/workspace/openclaw-workspace';
export const HOST_TOOLS_CONTAINER_PATH = '/workspace/host-tools';
export const HAL_ALLOWED_WHATSAPP_SENDER =
  process.env.HAL_ALLOWED_WHATSAPP_SENDER ||
  envConfig.HAL_ALLOWED_WHATSAPP_SENDER ||
  '19493969849@s.whatsapp.net';

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
// Defaults to Hal's home timezone; can be overridden via TZ.
export const TIMEZONE = process.env.TZ || envConfig.TZ || 'America/Los_Angeles';
