import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'HIPPOCAMPUS_API_URL',
  'HIPPOCAMPUS_BUDGET_TOKENS',
  'HIPPOCAMPUS_TOP_K',
  'HIPPOCAMPUS_ENABLED',
  'NO_TRIGGER_REQUIRED_IN_DMS',
  'HAL_WORKSPACE_DIR',
  'OPENCLAW_AUTH_DIR',
  'HAL_ALLOWED_WHATSAPP_SENDER',
  'TZ',
  'CC_HOOK_TOKEN',
  'CC_WEBHOOK_TOKEN',
  'CC_WEBHOOK_HOST',
  'CC_WEBHOOK_PORT',
  'CC_WEBHOOK_BASE_URL',
  'CC_HOOKS_GROUP_JID',
  'CC_HOOKS_MODEL',
  'ADAM_WHATSAPP_JID',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Hal';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const NO_TRIGGER_REQUIRED_IN_DMS =
  (process.env.NO_TRIGGER_REQUIRED_IN_DMS ||
    envConfig.NO_TRIGGER_REQUIRED_IN_DMS ||
    'true') !== 'false';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();
const OPENCLAW_HOME = path.join(HOME_DIR, '.openclaw');

function resolveConfiguredPath(rawPath: string): string {
  if (rawPath === '~') return HOME_DIR;
  if (rawPath.startsWith('~/')) {
    return path.resolve(HOME_DIR, rawPath.slice(2));
  }
  return path.resolve(rawPath);
}

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
export const OPENCLAW_WORKSPACE_DIR = resolveConfiguredPath(
  process.env.HAL_WORKSPACE_DIR ||
    envConfig.HAL_WORKSPACE_DIR ||
    path.join(OPENCLAW_HOME, 'workspace'),
);
export const OPENCLAW_AUTH_DIR = resolveConfiguredPath(
  process.env.OPENCLAW_AUTH_DIR ||
    envConfig.OPENCLAW_AUTH_DIR ||
    path.join(OPENCLAW_HOME, 'store', 'auth'),
);
export const OPENCLAW_WORKSPACE_CONTAINER_PATH =
  '/workspace/openclaw-workspace';
export const HOST_TOOLS_CONTAINER_PATH = '/workspace/host-tools';
export const HAL_ALLOWED_WHATSAPP_SENDER =
  process.env.HAL_ALLOWED_WHATSAPP_SENDER ||
  envConfig.HAL_ALLOWED_WHATSAPP_SENDER ||
  '19493969849@s.whatsapp.net';

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
export const CC_WEBHOOK_HOST =
  process.env.CC_WEBHOOK_HOST || envConfig.CC_WEBHOOK_HOST || '0.0.0.0';
export const CC_WEBHOOK_PORT = parseInt(
  process.env.CC_WEBHOOK_PORT || envConfig.CC_WEBHOOK_PORT || '8787',
  10,
);
export const CC_HOOK_TOKEN =
  process.env.CC_HOOK_TOKEN ||
  envConfig.CC_HOOK_TOKEN ||
  process.env.CC_WEBHOOK_TOKEN ||
  envConfig.CC_WEBHOOK_TOKEN ||
  '';
// Backwards-compatible alias for older configs.
export const CC_WEBHOOK_TOKEN = CC_HOOK_TOKEN;
export const CC_HOOKS_GROUP_JID =
  process.env.CC_HOOKS_GROUP_JID || envConfig.CC_HOOKS_GROUP_JID || '';
export const CC_HOOKS_MODEL =
  process.env.CC_HOOKS_MODEL || envConfig.CC_HOOKS_MODEL || 'sonnet';
export const ADAM_WHATSAPP_JID =
  process.env.ADAM_WHATSAPP_JID || envConfig.ADAM_WHATSAPP_JID || '';
export const CC_WEBHOOK_PATH = '/hooks/cc';

const ccWebhookBaseUrl =
  process.env.CC_WEBHOOK_BASE_URL || envConfig.CC_WEBHOOK_BASE_URL;
const defaultWebhookBase = `http://localhost:${CC_WEBHOOK_PORT}`;
const normalizedWebhookBase = (ccWebhookBaseUrl || defaultWebhookBase).replace(
  /\/$/,
  '',
);
export const CC_WEBHOOK_URL = `${normalizedWebhookBase}${CC_WEBHOOK_PATH}`;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Defaults to Hal's home timezone; can be overridden via TZ.
export const TIMEZONE = process.env.TZ || envConfig.TZ || 'America/Los_Angeles';

const DEFAULT_HIPPOCAMPUS_PORT =
  process.env.HIPPOCAMPUS_PORT || process.env.PORT || '8000';

export const HIPPOCAMPUS_API_URL =
  process.env.HIPPOCAMPUS_API_URL ||
  envConfig.HIPPOCAMPUS_API_URL ||
  `http://localhost:${DEFAULT_HIPPOCAMPUS_PORT}`;
export const HIPPOCAMPUS_BUDGET_TOKENS = Math.max(
  256,
  parseInt(
    process.env.HIPPOCAMPUS_BUDGET_TOKENS ||
      envConfig.HIPPOCAMPUS_BUDGET_TOKENS ||
      '4096',
    10,
  ) || 4096,
);
export const HIPPOCAMPUS_TOP_K = Math.max(
  1,
  parseInt(
    process.env.HIPPOCAMPUS_TOP_K || envConfig.HIPPOCAMPUS_TOP_K || '10',
    10,
  ) || 10,
);
export const HIPPOCAMPUS_ENABLED =
  (process.env.HIPPOCAMPUS_ENABLED ||
    envConfig.HIPPOCAMPUS_ENABLED ||
    'true') !== 'false';
