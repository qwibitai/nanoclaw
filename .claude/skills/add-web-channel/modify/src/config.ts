import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'WHATSAPP_ENABLED',
  'GMAIL_NOTIFY_TO',
  'WEB_CHANNEL_ENABLED',
  'WEB_CHANNEL_REDIS_URL',
  'WEB_CHANNEL_SECRET',
  'HOST_AI_ENABLED',
  'PRIMARY_AI',
  'HOST_AI_VERBOSE',
  'HOST_FALLBACK_CHAIN',
  'KIMI_API_KEY',
  'KIMI_MODEL',
  'KIMI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'CRITICS_MODE',
  'CRITICS_TIMEOUT_MS',
  'CRITICS_MAX_MODELS',
  'OPENROUTER_CRITIC_MODELS',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL_GENERAL',
  'OPENROUTER_MODEL_CODE',
  'OPENROUTER_FAILURE_THRESHOLD',
  'OPENROUTER_COOLDOWN_MS',
  'OPENROUTER_HISTORY_MAX_MESSAGES',
  'OPENROUTER_HISTORY_MAX_CHARS',
  'TWITTER_SUMMARY_FILE',
  'TWITTER_SUMMARY_REFRESH_COMMAND',
  'TWITTER_SUMMARY_REFRESH_TIMEOUT_MS',
]);

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseList(
  value: string | undefined,
  defaultValue: string[],
): string[] {
  if (!value) return defaultValue;
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : defaultValue;
}

export type CriticsMode = 'off' | 'code-only' | 'paid' | 'always';

function parseCriticsMode(value: string | undefined): CriticsMode {
  const normalized = (value || '').trim().toLowerCase();
  if (
    normalized === 'off' ||
    normalized === 'code-only' ||
    normalized === 'paid' ||
    normalized === 'always'
  ) {
    return normalized;
  }
  return 'off';
}

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER = parseBoolean(
  process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER,
  false,
);
export type WhatsAppEnabledMode = 'true' | 'false' | 'auto';

function parseWhatsAppEnabled(value: string | undefined): WhatsAppEnabledMode {
  const normalized = (value || 'auto').trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return 'true';
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return 'false';
  }
  return 'auto';
}

export const WHATSAPP_ENABLED = parseWhatsAppEnabled(
  process.env.WHATSAPP_ENABLED || envConfig.WHATSAPP_ENABLED,
);
export const GMAIL_NOTIFY_TO =
  process.env.GMAIL_NOTIFY_TO || envConfig.GMAIL_NOTIFY_TO || '';
export const WEB_CHANNEL_ENABLED = parseBoolean(
  process.env.WEB_CHANNEL_ENABLED || envConfig.WEB_CHANNEL_ENABLED,
  false,
);
export const WEB_CHANNEL_REDIS_URL =
  process.env.WEB_CHANNEL_REDIS_URL || envConfig.WEB_CHANNEL_REDIS_URL || '';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// OpenRouter runtime (host-side default reply path)
export const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || envConfig.OPENROUTER_API_KEY || '';
export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ||
  envConfig.OPENROUTER_BASE_URL ||
  'https://openrouter.ai/api/v1';
export const OPENROUTER_MODEL_GENERAL =
  process.env.OPENROUTER_MODEL_GENERAL ||
  envConfig.OPENROUTER_MODEL_GENERAL ||
  'openrouter/free';
export const OPENROUTER_MODEL_CODE =
  process.env.OPENROUTER_MODEL_CODE ||
  envConfig.OPENROUTER_MODEL_CODE ||
  'openrouter/anthropic/claude-sonnet-4-5';
export const OPENROUTER_FAILURE_THRESHOLD = Math.max(
  1,
  parseInteger(
    process.env.OPENROUTER_FAILURE_THRESHOLD ||
      envConfig.OPENROUTER_FAILURE_THRESHOLD,
    3,
  ),
);
export const OPENROUTER_COOLDOWN_MS = Math.max(
  1_000,
  parseInteger(
    process.env.OPENROUTER_COOLDOWN_MS || envConfig.OPENROUTER_COOLDOWN_MS,
    600_000,
  ),
);
export const OPENROUTER_HISTORY_MAX_MESSAGES = Math.max(
  1,
  parseInteger(
    process.env.OPENROUTER_HISTORY_MAX_MESSAGES ||
      envConfig.OPENROUTER_HISTORY_MAX_MESSAGES,
    20,
  ),
);
export const OPENROUTER_HISTORY_MAX_CHARS = Math.max(
  200,
  parseInteger(
    process.env.OPENROUTER_HISTORY_MAX_CHARS ||
      envConfig.OPENROUTER_HISTORY_MAX_CHARS,
    6000,
  ),
);

// Host AI router (feature-flagged, default off for compatibility)
export const HOST_AI_ENABLED = parseBoolean(
  process.env.HOST_AI_ENABLED || envConfig.HOST_AI_ENABLED,
  false,
);
export const PRIMARY_AI =
  process.env.PRIMARY_AI || envConfig.PRIMARY_AI || 'openrouter';
export const HOST_AI_VERBOSE = parseBoolean(
  process.env.HOST_AI_VERBOSE || envConfig.HOST_AI_VERBOSE,
  false,
);
export const HOST_FALLBACK_CHAIN = parseList(
  process.env.HOST_FALLBACK_CHAIN || envConfig.HOST_FALLBACK_CHAIN,
  ['openrouter'],
);

export const KIMI_API_KEY =
  process.env.KIMI_API_KEY || envConfig.KIMI_API_KEY || '';
export const KIMI_MODEL =
  process.env.KIMI_MODEL || envConfig.KIMI_MODEL || 'kimi-k2-0711-preview';
export const KIMI_BASE_URL =
  process.env.KIMI_BASE_URL ||
  envConfig.KIMI_BASE_URL ||
  'https://api.moonshot.ai/v1';

export const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || envConfig.OPENAI_API_KEY || '';
export const OPENAI_MODEL =
  process.env.OPENAI_MODEL || envConfig.OPENAI_MODEL || 'gpt-4o';
export const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL ||
  envConfig.OPENAI_BASE_URL ||
  'https://api.openai.com/v1';

// Critics configuration
export const CRITICS_MODE = parseCriticsMode(
  process.env.CRITICS_MODE || envConfig.CRITICS_MODE,
);
export const CRITICS_TIMEOUT_MS = Math.max(
  5_000,
  parseInteger(
    process.env.CRITICS_TIMEOUT_MS || envConfig.CRITICS_TIMEOUT_MS,
    25_000,
  ),
);
export const CRITICS_MAX_MODELS = Math.max(
  1,
  parseInteger(
    process.env.CRITICS_MAX_MODELS || envConfig.CRITICS_MAX_MODELS,
    3,
  ),
);
export const OPENROUTER_CRITIC_MODELS = parseList(
  process.env.OPENROUTER_CRITIC_MODELS || envConfig.OPENROUTER_CRITIC_MODELS,
  [],
);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Optional host-side Twitter summary integration.
// If TWITTER_SUMMARY_FILE is missing, /twitter-summary returns guidance.
export const TWITTER_SUMMARY_FILE =
  process.env.TWITTER_SUMMARY_FILE ||
  envConfig.TWITTER_SUMMARY_FILE ||
  path.join(
    HOME_DIR,
    'Documents',
    'nanoclaw',
    'data',
    'twitter-list',
    'summary.txt',
  );
export const TWITTER_SUMMARY_REFRESH_COMMAND =
  process.env.TWITTER_SUMMARY_REFRESH_COMMAND ||
  envConfig.TWITTER_SUMMARY_REFRESH_COMMAND ||
  '';
export const TWITTER_SUMMARY_REFRESH_TIMEOUT_MS = Math.max(
  5_000,
  parseInteger(
    process.env.TWITTER_SUMMARY_REFRESH_TIMEOUT_MS ||
      envConfig.TWITTER_SUMMARY_REFRESH_TIMEOUT_MS,
    60_000,
  ),
);

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

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
