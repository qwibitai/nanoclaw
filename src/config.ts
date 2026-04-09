import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
]);

export const DEFAULT_ASSISTANT_NAME = 'LearnClaw';

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME ||
  envConfig.ASSISTANT_NAME ||
  DEFAULT_ASSISTANT_NAME;
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

function resolveConfigDir(): string {
  const preferredDir = path.join(HOME_DIR, '.config', 'learnclaw');
  const legacyDir = path.join(HOME_DIR, '.config', 'nanoclaw');
  if (fs.existsSync(preferredDir) || !fs.existsSync(legacyDir)) {
    return preferredDir;
  }
  return legacyDir;
}

const CONFIG_DIR = resolveConfigDir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  CONFIG_DIR,
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  CONFIG_DIR,
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

// AI provider selection:
//   anthropic   — direct Anthropic API (default, uses Claude Agent SDK)
//   openrouter  — OpenRouter gateway (Claude or other models via Anthropic-compat API)
//   openai      — OpenAI-compatible endpoint (Ollama, Grok, Groq, Together, etc.)
export type AgentProvider = 'anthropic' | 'openrouter' | 'openai';
export const AGENT_PROVIDER: AgentProvider = (() => {
  const v = (process.env.AGENT_PROVIDER || 'anthropic').toLowerCase();
  if (v === 'openrouter' || v === 'openai') return v;
  return 'anthropic';
})();
// Model to use. For openrouter/openai providers this is required.
// e.g. "anthropic/claude-3.5-sonnet", "meta-llama/llama-3.1-70b", "ollama/llama3.1"
export const AGENT_MODEL = process.env.AGENT_MODEL || '';
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
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
