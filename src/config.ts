import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
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

// Solo Vault configuration for encrypted secret storage.
// Set SOLO_VAULT_TOKEN env var to a service-scoped read token to enable
// vault-based credential fetching. When not set, secrets fall back to .env.
// See: https://api.vault.jeffreykeyser.net
// Routes: GET /v1/secrets/:project/:env/:key
export const SOLO_VAULT_URL =
  process.env.SOLO_VAULT_URL || 'https://api.vault.jeffreykeyser.net';
export const SOLO_VAULT_TOKEN = process.env.SOLO_VAULT_TOKEN;
export const SOLO_VAULT_PROJECT =
  process.env.SOLO_VAULT_PROJECT || 'nanoclaw';
export const SOLO_VAULT_ENV = process.env.SOLO_VAULT_ENV || 'production';
export const SOLO_VAULT_TTL = 5 * 60 * 1000; // 5 minute cache TTL

// RabbitMQ connection for cron-service subscription.
// The cron-service at cron.jeffreykeyser.net publishes CronJobTriggered
// events to the cron.jobs exchange. NanoClaw subscribes to receive triggers.
export const RABBITMQ_URL =
  process.env.RABBITMQ_URL || 'amqp://localhost:5672';

// Agency HQ integration for task dispatch and stall detection.
// The dispatch loop polls for ready tasks and enqueues them for execution.
// The stall detector finds in-progress tasks that haven't been updated.
export const AGENCY_HQ_URL =
  process.env.AGENCY_HQ_URL || 'http://localhost:3040';
export const DISPATCH_LOOP_INTERVAL = 60_000;
export const STALL_DETECTOR_INTERVAL = 15 * 60_000;
export const STALL_THRESHOLD_MS = 15 * 60_000;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
