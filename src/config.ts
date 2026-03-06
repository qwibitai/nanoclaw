import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
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
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

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
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// --- Swarm (Agent Teams) configuration ---
// Optional Telegram bot pool tokens (comma-separated). If populated,
// swarm features auto-enable unless TELEGRAM_SWARM_ENABLED is explicitly set.
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// Toggle swarm features on/off. Default: enabled when TELEGRAM_BOT_POOL is non-empty.
export const TELEGRAM_SWARM_ENABLED =
  (process.env.TELEGRAM_SWARM_ENABLED || 'false') === 'true' ||
  TELEGRAM_BOT_POOL.length > 0;

// Runtime defaults for swarm behavior. These may be overridden via env vars.
export const SWARM_NUM_AGENTS = Math.max(
  1,
  parseInt(process.env.SWARM_NUM_AGENTS || '3', 10) || 3,
);

// Aggregation policy: one of 'synthesize' | 'send_all' | 'majority_vote' | 'select_best' | 'first_response' | 'quorum'
export const SWARM_POLICY = (
  process.env.SWARM_POLICY || 'synthesize'
).toLowerCase();

// How long (ms) to wait for subagents before aggregating/returning partial results
export const SWARM_TIMEOUT_MS = parseInt(
  process.env.SWARM_TIMEOUT_MS || '10000',
  10,
);

// Whether to keep raw subagent outputs (for audit or optional display)
export const SWARM_KEEP_RAW =
  (process.env.SWARM_KEEP_RAW || 'false') === 'true';

// Quorum size for 'quorum' policy. If not set, defaults to ceil(SWARM_NUM_AGENTS/2).
export const SWARM_QUORUM_K = Math.max(
  1,
  parseInt(process.env.SWARM_QUORUM_K || String(Math.ceil(SWARM_NUM_AGENTS / 2)), 10),
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Whether to enable LLM-based synthesis. Default: false (opt-in via env)
export const SWARM_USE_LLM = (process.env.SWARM_USE_LLM || 'false').toLowerCase();

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
