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
  'CONTROL_PLANE_URL',
  'AGENT_KEY',
  'CONTROL_PLANE_POLL_INTERVAL_MS',
  'CONTROL_PLANE_HEARTBEAT_INTERVAL_MS',
  'CONTROL_PLANE_GROUP_FOLDER',
  'CONTROL_PLANE_CONTEXT_MODE',
  'CONTROL_PLANE_INCLUDE_BACKLOG',
  'CONTROL_PLANE_SUCCESS_STATUS',
  'CONTROL_PLANE_FAILURE_STATUS',
  'CONTROL_PLANE_ENABLED',
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
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const CONTROL_PLANE_URL =
  process.env.CONTROL_PLANE_URL || envConfig.CONTROL_PLANE_URL;
export const AGENT_KEY = process.env.AGENT_KEY || envConfig.AGENT_KEY;
export const CONTROL_PLANE_POLL_INTERVAL_MS = Math.max(
  1000,
  parseInt(
    process.env.CONTROL_PLANE_POLL_INTERVAL_MS ||
      envConfig.CONTROL_PLANE_POLL_INTERVAL_MS ||
      '10000',
    10,
  ) || 10000,
);
export const CONTROL_PLANE_HEARTBEAT_INTERVAL_MS = Math.max(
  1000,
  parseInt(
    process.env.CONTROL_PLANE_HEARTBEAT_INTERVAL_MS ||
      envConfig.CONTROL_PLANE_HEARTBEAT_INTERVAL_MS ||
      '30000',
    10,
  ) || 30000,
);
export const CONTROL_PLANE_GROUP_FOLDER =
  process.env.CONTROL_PLANE_GROUP_FOLDER ||
  envConfig.CONTROL_PLANE_GROUP_FOLDER;
export const CONTROL_PLANE_CONTEXT_MODE =
  (process.env.CONTROL_PLANE_CONTEXT_MODE ||
    envConfig.CONTROL_PLANE_CONTEXT_MODE ||
    'group') === 'isolated'
    ? 'isolated'
    : 'group';
export const CONTROL_PLANE_INCLUDE_BACKLOG =
  (
    process.env.CONTROL_PLANE_INCLUDE_BACKLOG ||
    envConfig.CONTROL_PLANE_INCLUDE_BACKLOG ||
    'false'
  ).toLowerCase() === 'true';
export const CONTROL_PLANE_SUCCESS_STATUS =
  process.env.CONTROL_PLANE_SUCCESS_STATUS ||
  envConfig.CONTROL_PLANE_SUCCESS_STATUS ||
  'review';
export const CONTROL_PLANE_FAILURE_STATUS =
  process.env.CONTROL_PLANE_FAILURE_STATUS ||
  envConfig.CONTROL_PLANE_FAILURE_STATUS;
export const CONTROL_PLANE_ENABLED =
  (
    process.env.CONTROL_PLANE_ENABLED ||
    envConfig.CONTROL_PLANE_ENABLED ||
    'false'
  ).toLowerCase() === 'true';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

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
