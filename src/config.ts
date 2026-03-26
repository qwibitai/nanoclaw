import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Isaac';
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
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Token limits and management
// Approximate token count: characters / 4 for English text (Claude models)
// These are conservative estimates; actual token count varies by language/content
export const TOKEN_ESTIMATE_FACTOR = 4;

// Model context window limits (in tokens) - update when switching models
// https://docs.anthropic.com/en/docs/about-claude/models#overview
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'stepfun/step-3.5-flash:free': 8192, // Based on observed API limit
  'anthropic/claude-haiku-4.5': 200000,
  'anthropic/claude-sonnet-4.5': 200000,
  'anthropic/claude-opus-4.5': 200000,
};

// Get model name from environment
const modelFromEnv = process.env.NANOCLAW_MODEL || 'anthropic/claude-haiku-4.5';

// Parse model name to find base model identifier (remove provider prefixes/suffixes)
function getBaseModelName(model: string): string {
  // Handle formats: "provider/model:tag", "model:tag", "model"
  const cleanModel = model.split(':')[0]; // Remove tag
  if (cleanModel.includes('/')) {
    // Provider prefix: "anthropic/claude-3-5-haiku-20241022"
    return cleanModel.split('/')[1];
  }
  return cleanModel;
}

export const ACTIVE_MODEL = modelFromEnv;
export const MODEL_CONTEXT_LIMIT = MODEL_CONTEXT_LIMITS[getBaseModelName(modelFromEnv)] || 8192;
export { MODEL_CONTEXT_LIMITS }; // Export for token manager validation

// Token management settings
export const TOKEN_WARNING_THRESHOLD = parseFloat(
  process.env.TOKEN_WARNING_THRESHOLD || '0.8'
); // Warn at 80% of limit
export const TOKEN_AUTO_TRIM_PERCENT = parseInt(
  process.env.TOKEN_AUTO_TRIM_PERCENT || '20',
  10
); // Auto-trim oldest % when exceeded (0 = disabled)
export const TOKEN_MAX_MESSAGES = parseInt(
  process.env.TOKEN_MAX_MESSAGES || '100',
  10
); // Hard cap on message count
export const TOKEN_DAILY_CONFIG_CHECK = process.env.TOKEN_DAILY_CONFIG_CHECK === 'true';

// Utility: estimate token count from XML-formatted message
export function estimateTokenCount(text: string): number {
  // RFC 2797 says "roughly 4 characters per token" for English
  // Using 4:1 ratio as a safe overestimate
  return Math.ceil(text.length / TOKEN_ESTIMATE_FACTOR);
}
