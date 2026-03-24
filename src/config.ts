import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Jarvis';
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
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

function parseIntEnv(envVar: string | undefined, fallback: number): number {
  const parsed = parseInt(envVar || String(fallback), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const PR_POLL_INTERVAL = parseIntEnv(
  process.env.PR_POLL_INTERVAL,
  300000,
); // 5 minutes default

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseIntEnv(
  process.env.CONTAINER_TIMEOUT,
  1800000,
);
export const GOAL_TIMEOUT_DEFAULT = parseIntEnv(
  process.env.GOAL_TIMEOUT_DEFAULT,
  14400000,
); // 4 hours
export const GOAL_TIMEOUT_MAX = parseIntEnv(
  process.env.GOAL_TIMEOUT_MAX,
  86400000,
); // 24 hours
export const CONTAINER_MAX_OUTPUT_SIZE = parseIntEnv(
  process.env.CONTAINER_MAX_OUTPUT_SIZE,
  10485760,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseIntEnv(
  process.env.CREDENTIAL_PROXY_PORT,
  3001,
);
export const IPC_POLL_INTERVAL = 1000;
export const DEBUG_QUERY_TIMEOUT_ACTIVE = 120_000; // 120s for active containers (accounts for rate limits)
export const DEBUG_QUERY_TIMEOUT_FRESH = 300_000; // 5min for fresh containers (needs boot + possible rate limits)
export const IDLE_TIMEOUT = parseIntEnv(process.env.IDLE_TIMEOUT, 1800000); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseIntEnv(process.env.MAX_CONCURRENT_CONTAINERS, 5),
);
export const MAX_CONTAINERS_PER_GROUP = Math.max(
  1,
  parseIntEnv(process.env.MAX_CONTAINERS_PER_GROUP, 3),
);
export const THREAD_EXPIRY_HOURS = parseIntEnv(
  process.env.THREAD_EXPIRY_HOURS,
  24,
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

// Allowlist of file extensions agents can send back to channels.
// Scoped narrowly by default; extend via env var.
export const FILE_SEND_ALLOWLIST = (
  process.env.FILE_SEND_ALLOWLIST ||
  '.png,.zip,.pdf,.pptx,.docx,.xlsx,.jpg,.jpeg,.gif,.mp3,.mp4,.webp,.svg,.csv,.txt,.json'
)
  .split(',')
  .map((s) => s.trim().toLowerCase());
