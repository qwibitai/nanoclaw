import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'ComplaintBot';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Tenant configuration
export const TENANT_CONFIG_PATH =
  process.env.TENANT_CONFIG_PATH ||
  path.resolve(PROJECT_ROOT, 'config', 'tenant.yaml');
export const CLAUDE_CODE_OAUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN || '';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'constituency-bot',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

function safeParseInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'constituency-bot-agent:latest';
export const CONTAINER_TIMEOUT = safeParseInt(
  process.env.CONTAINER_TIMEOUT,
  1800000,
);
export const CONTAINER_MAX_OUTPUT_SIZE = safeParseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE,
  10485760,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = safeParseInt(process.env.IDLE_TIMEOUT, 1800000); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  safeParseInt(process.env.MAX_CONCURRENT_CONTAINERS, 5),
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Concurrency limiter for fire-and-forget direct handlers (complaint + voice)
export const MAX_CONCURRENT_DIRECT_HANDLERS = Math.max(
  1,
  safeParseInt(process.env.MAX_CONCURRENT_DIRECT_HANDLERS, 10),
);

// Outgoing message queue cap (drop oldest when exceeded)
export const MAX_OUTGOING_QUEUE_SIZE = Math.max(
  10,
  safeParseInt(process.env.MAX_OUTGOING_QUEUE_SIZE, 1000),
);

// Reconnection backoff: initial delay (ms), max attempts, and max delay (ms)
export const RECONNECT_INITIAL_DELAY_MS = safeParseInt(
  process.env.RECONNECT_INITIAL_DELAY_MS,
  5000,
);
export const RECONNECT_MAX_ATTEMPTS = safeParseInt(
  process.env.RECONNECT_MAX_ATTEMPTS,
  10,
);
export const RECONNECT_MAX_DELAY_MS = safeParseInt(
  process.env.RECONNECT_MAX_DELAY_MS,
  300000, // 5 minutes
);

// Complaint handler (in-process Agent SDK, no container)
export const COMPLAINT_MODEL =
  process.env.COMPLAINT_MODEL || 'claude-sonnet-4-5-20250929';
export const COMPLAINT_MAX_TURNS = safeParseInt(
  process.env.COMPLAINT_MAX_TURNS,
  10,
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
