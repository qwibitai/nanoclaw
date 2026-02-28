import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'DISCORD_BOT_TOKEN',
  'DISCORD_ONLY',
  'ALLOWED_USERS',
  'OBSERVER_ENABLED',
  'MIN_OBSERVER_MESSAGES',
  'QUALITY_TRACKER_ENABLED',
  'AUTO_LEARNER_ENABLED',
  'HINDSIGHT_ENABLED',
  'ROUTER_ENABLED',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
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

// Discord configuration
export const DISCORD_BOT_TOKEN =
  process.env.DISCORD_BOT_TOKEN || envConfig.DISCORD_BOT_TOKEN || '';
export const DISCORD_ONLY =
  (process.env.DISCORD_ONLY || envConfig.DISCORD_ONLY) === 'true';

// DM allowlist — comma-separated Discord user IDs. Empty = allow all.
const allowedUsersRaw =
  process.env.ALLOWED_USERS || envConfig.ALLOWED_USERS || '';
export const ALLOWED_USERS: Set<string> = new Set(
  allowedUsersRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

// Observer — auto-compress conversations into prioritized observations
export const OBSERVER_ENABLED =
  (process.env.OBSERVER_ENABLED ?? envConfig.OBSERVER_ENABLED ?? 'true') !== 'false';
export const MIN_OBSERVER_MESSAGES = Math.max(
  1,
  parseInt(process.env.MIN_OBSERVER_MESSAGES || envConfig.MIN_OBSERVER_MESSAGES || '5', 10) || 5,
);

// Quality Tracker — JSONL conversation logging with implicit quality signals
export const QUALITY_TRACKER_ENABLED =
  (process.env.QUALITY_TRACKER_ENABLED ?? envConfig.QUALITY_TRACKER_ENABLED ?? 'true') !== 'false';

// Auto-Learner — detect corrections and log learnings
export const AUTO_LEARNER_ENABLED =
  (process.env.AUTO_LEARNER_ENABLED ?? envConfig.AUTO_LEARNER_ENABLED ?? 'true') !== 'false';

// Hindsight — auto post-mortem on failed conversations
export const HINDSIGHT_ENABLED =
  (process.env.HINDSIGHT_ENABLED ?? envConfig.HINDSIGHT_ENABLED ?? 'true') !== 'false';

// Workflow Router — deterministic routing between agent steps
export const ROUTER_ENABLED =
  (process.env.ROUTER_ENABLED ?? envConfig.ROUTER_ENABLED ?? 'true') !== 'false';
