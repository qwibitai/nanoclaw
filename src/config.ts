import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'GITHUB_TOKEN',
  'REGISTRY_URL',
  'TELEMETRY_URL',
  'TELEMETRY_REGISTRATION_TOKEN',
  'TELEMETRY_BOT_ID',
  'GROQ_API_KEY',
  'TELEGRAM_BOT_TOKEN',
]);

// Service Bot: expose GITHUB_TOKEN to process.env so container-runner can pass it
if (envConfig.GITHUB_TOKEN && !process.env.GITHUB_TOKEN) {
  process.env.GITHUB_TOKEN = envConfig.GITHUB_TOKEN;
}

// Service Bot: expose REGISTRY_URL for bot registry client
if (envConfig.REGISTRY_URL && !process.env.REGISTRY_URL) {
  process.env.REGISTRY_URL = envConfig.REGISTRY_URL;
}

// Service Bot: expose telemetry vars for container-runner → Docker → MCP servers
if (envConfig.TELEMETRY_URL && !process.env.TELEMETRY_URL) {
  process.env.TELEMETRY_URL = envConfig.TELEMETRY_URL;
}
if (
  envConfig.TELEMETRY_REGISTRATION_TOKEN &&
  !process.env.TELEMETRY_REGISTRATION_TOKEN
) {
  process.env.TELEMETRY_REGISTRATION_TOKEN =
    envConfig.TELEMETRY_REGISTRATION_TOKEN;
}

if (envConfig.TELEMETRY_BOT_ID && !process.env.TELEMETRY_BOT_ID) {
  process.env.TELEMETRY_BOT_ID = envConfig.TELEMETRY_BOT_ID;
}

// Service Bot: expose GROQ_API_KEY for audio transcription
if (envConfig.GROQ_API_KEY && !process.env.GROQ_API_KEY) {
  process.env.GROQ_API_KEY = envConfig.GROQ_API_KEY;
}

// Audio transcription: Telegram bot token for file downloads
if (envConfig.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN) {
  process.env.TELEGRAM_BOT_TOKEN = envConfig.TELEGRAM_BOT_TOKEN;
}

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
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@?${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
