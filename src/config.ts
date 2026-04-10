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
export const OUTPUT_POLL_INTERVAL = parseInt(
  process.env.OUTPUT_POLL_INTERVAL || '250',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IPC_FALLBACK_POLL_INTERVAL = 5000;
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
export const SOLO_VAULT_PROJECT = process.env.SOLO_VAULT_PROJECT || 'nanoclaw';
export const SOLO_VAULT_ENV = process.env.SOLO_VAULT_ENV || 'production';
export const SOLO_VAULT_TTL = 5 * 60 * 1000; // 5 minute cache TTL

// Pantry Manager integration for manual item entry and nudge engine seeding.
// Set PANTRY_MANAGER_URL to override the default local endpoint.
export const PANTRY_MANAGER_URL =
  process.env.PANTRY_MANAGER_URL || 'http://localhost:3052';

// RabbitMQ connection for cron-service subscription.
// The cron-service at cron.jeffreykeyser.net publishes CronJobTriggered
// events to the cron.jobs exchange. NanoClaw subscribes to receive triggers.
export const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

// Agency HQ integration for task dispatch and stall detection.
// The dispatch loop polls for ready tasks and enqueues them for execution.
// The stall detector finds in-progress tasks that haven't been updated.
export const AGENCY_HQ_URL =
  process.env.AGENCY_HQ_URL || 'http://localhost:3040';
export const DISPATCH_LOOP_INTERVAL = 60_000;
export const STALL_DETECTOR_INTERVAL = 15 * 60_000;
export const STALL_THRESHOLD_MS = 15 * 60_000;
/** Orphaned in-progress tasks older than this are reconciled back to ready on startup. */
export const DISPATCH_ORPHAN_THRESHOLD_MS = parseInt(
  process.env.DISPATCH_ORPHAN_THRESHOLD_MS || String(5 * 60_000),
  10,
);
/** dispatch_blocked_until penalty applied to reconciled orphan tasks (default: 5 min). */
export const DISPATCH_ORPHAN_PENALTY_MS = parseInt(
  process.env.DISPATCH_ORPHAN_PENALTY_MS || String(5 * 60_000),
  10,
);
/** How long to wait for in-flight dispatch workers to finish on SIGTERM before reverting them (default: 30s). */
export const DISPATCH_DRAIN_TIMEOUT_MS = parseInt(
  process.env.DISPATCH_DRAIN_TIMEOUT_MS || String(30_000),
  10,
);

// Auto-compact: automatically trigger /compact when context usage exceeds threshold.
// Opt-in — disabled by default to preserve existing behavior.
export const AUTO_COMPACT_ENABLED =
  (process.env.AUTO_COMPACT_ENABLED || 'false') === 'true';
export const AUTO_COMPACT_THRESHOLD = Math.min(
  1,
  Math.max(0, parseFloat(process.env.AUTO_COMPACT_THRESHOLD || '0.8')),
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Provider-agnostic agent runner configuration.
// AGENT_RUNNER_BACKEND selects the CLI backend (default: claude).
// AGENT_CLI_BIN overrides the binary name/path for the selected backend.
export const AGENT_RUNNER_BACKEND =
  process.env.AGENT_RUNNER_BACKEND || 'claude';
export const AGENT_CLI_BIN = process.env.AGENT_CLI_BIN || 'claude';
