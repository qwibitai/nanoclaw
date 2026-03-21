import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_POOL',
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
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result

// Session lifecycle: how long to keep agent sessions alive
// IDLE: no activity for this long → expire session (free context window)
// MAX_AGE: absolute cap regardless of activity (prevents unbounded context growth)
export const SESSION_IDLE_MS = parseInt(
  process.env.SESSION_IDLE_MS || `${2 * 60 * 60 * 1000}`,
  10,
); // 2 hours
export const SESSION_MAX_AGE_MS = parseInt(
  process.env.SESSION_MAX_AGE_MS || `${4 * 60 * 60 * 1000}`,
  10,
); // 4 hours
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

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// Context assembler configuration
export const CONTEXT_PACKET_MAX_SIZE = parseInt(
  process.env.CONTEXT_PACKET_MAX_SIZE || '8000',
  10,
);

// Health monitor thresholds
export const HEALTH_MONITOR_INTERVAL = 60_000;
export const MAX_CONTAINER_SPAWNS_PER_HOUR = 30;
export const MAX_ERRORS_PER_HOUR = 20;

// Ollama classification
export const OLLAMA_HOST =
  process.env.OLLAMA_HOST || 'http://localhost:11434';
export const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || 'qwen3:8b';
export const OLLAMA_TIMEOUT = parseInt(
  process.env.OLLAMA_TIMEOUT || '30000',
  10,
);

// Event router
export const EVENT_ROUTER_ENABLED =
  (process.env.EVENT_ROUTER_ENABLED || 'true') === 'true';

// Gmail watcher
export const GMAIL_POLL_INTERVAL = parseInt(
  process.env.GMAIL_POLL_INTERVAL || '60000',
  10,
);
export const GMAIL_CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_PATH ||
  path.join(HOME_DIR, '.gmail-mcp', 'credentials.json');
export const GMAIL_ACCOUNT =
  process.env.GMAIL_ACCOUNT || 'mgandal@gmail.com';

// Calendar watcher
export const CALENDAR_POLL_INTERVAL = parseInt(
  process.env.CALENDAR_POLL_INTERVAL || '60000',
  10,
);
export const CALENDAR_NAMES = (
  process.env.CALENDAR_NAMES || 'MJG,Outlook,Gandal_Lab_Meetings'
)
  .split(',')
  .map((s) => s.trim());
export const CALENDAR_LOOKAHEAD_DAYS = parseInt(
  process.env.CALENDAR_LOOKAHEAD_DAYS || '7',
  10,
);

// Trust matrix
export const TRUST_MATRIX_PATH = path.join(DATA_DIR, 'trust.yaml');
