import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'INSTANCE_ID',
  'CONTAINER_CPUS',
  'CONTAINER_MEMORY',
  'CONTAINER_PIDS_LIMIT',
  'LITESTREAM_ENABLED',
  'GCS_BACKUP_BUCKET',
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

// Multi-tenant instance isolation — prefixes all container names
function getOsUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    // os.userInfo() throws on musl-based containers and some CI environments
    return process.env.USER || process.env.LOGNAME || 'default';
  }
}

function safeInstanceId(): string {
  const raw =
    process.env.INSTANCE_ID || envConfig.INSTANCE_ID || getOsUsername();
  // Strip non-alphanumeric chars, limit to 32 chars (Docker name limit is 128)
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  return sanitized || 'default';
}

export const INSTANCE_ID = safeInstanceId();
export const CONTAINER_NAME_PREFIX = `nanoclaw-${INSTANCE_ID}`;

// Container resource limits (empty/0 = no limit, preserves current behavior)
export const CONTAINER_CPUS =
  process.env.CONTAINER_CPUS || envConfig.CONTAINER_CPUS || '';
export const CONTAINER_MEMORY =
  process.env.CONTAINER_MEMORY || envConfig.CONTAINER_MEMORY || '';
export const CONTAINER_PIDS_LIMIT =
  process.env.CONTAINER_PIDS_LIMIT || envConfig.CONTAINER_PIDS_LIMIT || '';

// Validate resource limits early so operators get clear errors instead of
// cryptic Docker failures at container spawn time.
if (CONTAINER_CPUS && !/^\d+(\.\d+)?$/.test(CONTAINER_CPUS)) {
  console.warn(
    `WARNING: CONTAINER_CPUS="${CONTAINER_CPUS}" is not a valid number (e.g. "0.5", "2")`,
  );
}
if (CONTAINER_MEMORY && !/^\d+[bkmg]?$/i.test(CONTAINER_MEMORY)) {
  console.warn(
    `WARNING: CONTAINER_MEMORY="${CONTAINER_MEMORY}" is not a valid Docker memory value (e.g. "512m", "1g")`,
  );
}
if (CONTAINER_PIDS_LIMIT && !/^\d+$/.test(CONTAINER_PIDS_LIMIT)) {
  console.warn(
    `WARNING: CONTAINER_PIDS_LIMIT="${CONTAINER_PIDS_LIMIT}" is not a valid integer`,
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Web channel API port
export const WEB_CHANNEL_PORT = parseInt(
  process.env.WEB_CHANNEL_PORT || '3100',
  10,
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Anton's brain: company context cloned from a git repo
export const BRAIN_REPO_URL = process.env.BRAIN_REPO_URL || '';
export const BRAIN_DIR = path.resolve(DATA_DIR, 'brain');

// Litestream backup (GCE only — disabled on local dev)
export const LITESTREAM_ENABLED =
  (process.env.LITESTREAM_ENABLED || envConfig.LITESTREAM_ENABLED) === 'true';
export const GCS_BACKUP_BUCKET =
  process.env.GCS_BACKUP_BUCKET || envConfig.GCS_BACKUP_BUCKET || '';
