import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Flux';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

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
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '300000',
  10,
); // 5min default — kill agent if no output for 5 min (overridden by CONTAINER_TIMEOUT for long tasks)
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '3', 10) || 3,
);

// Per-agent resource limits (enforced via systemd-run --scope on Linux).
// Prevents a runaway agent from starving others.
// Set to empty string to disable limits.
export const AGENT_MEMORY_MAX = process.env.AGENT_MEMORY_MAX || '1G';
export const AGENT_CPU_QUOTA = process.env.AGENT_CPU_QUOTA || '100%'; // 1 core per agent
export const AGENT_TASKS_MAX = parseInt(process.env.AGENT_TASKS_MAX || '100', 10); // max subprocesses

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

// Ops HTTP server
export const OPS_HTTP_PORT = parseInt(
  process.env.OPS_HTTP_PORT || '7700',
  10,
);
export const OPS_HTTP_HOST = process.env.OPS_HTTP_HOST || '127.0.0.1';
export const OS_HTTP_SECRET = process.env.OS_HTTP_SECRET || '';

// Worker multi-node
export const WORKER_PORT = parseInt(process.env.WORKER_PORT || '7801', 10);
export const WORKER_HEALTH_INTERVAL = parseInt(
  process.env.WORKER_HEALTH_INTERVAL || '30000',
  10,
);
export const WORKER_TUNNEL_RECONNECT_MAX = parseInt(
  process.env.WORKER_TUNNEL_RECONNECT_MAX || '10',
  10,
);

// Nonce hardening
export const NONCE_TTL_MS = parseInt(
  process.env.NONCE_TTL_MS || '60000',
  10,
); // 60s default
export const NONCE_CLEANUP_OLDER_THAN_MS = parseInt(
  process.env.NONCE_CLEANUP_OLDER_THAN_MS || '86400000',
  10,
); // 24h default
export const NONCE_CAP = parseInt(
  process.env.NONCE_CAP || '100000',
  10,
);
export const NONCE_CLEANUP_INTERVAL_MS = parseInt(
  process.env.NONCE_CLEANUP_INTERVAL_MS || '21600000',
  10,
); // 6h default
