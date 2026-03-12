import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'RESIDENTIAL_PROXY_URL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Session management
export const SESSION_IDLE_RESET_HOURS = parseInt(
  process.env.SESSION_IDLE_RESET_HOURS || '2',
  10,
);
export const THREAD_SESSION_IDLE_HOURS = parseInt(
  process.env.THREAD_SESSION_IDLE_HOURS || '2',
  10,
);
export const SESSION_SWEEP_INTERVAL = 5 * 60 * 1000; // 5 min
export const THREAD_DEBOUNCE_MS = 1000; // 1s batch window for rapid messages

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

export const ATTACHMENTS_DIR = path.resolve(DATA_DIR, 'attachments');
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB
export const ATTACHMENT_CLEANUP_HOURS = 72;

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
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '8', 10) || 8,
);
export const MAX_THREADS_PER_GROUP = Math.max(
  1,
  parseInt(process.env.MAX_THREADS_PER_GROUP || '3', 10) || 3,
);
export const WORKTREES_DIR = path.resolve(DATA_DIR, 'worktrees');
export const GROUP_THREAD_KEY = '__group__';

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Default model for the agent container. Per-group overrides live in
// ContainerConfig.model; per-message overrides via "-m opus" (sticky) or "-m1 opus" (one-shot).
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-6';

// Map short aliases to full model IDs
export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

// Patterns to detect model override in a message.
// Sticky flag: "-m opus" — sets model for rest of session; "-m default" clears
export const MODEL_FLAG_PATTERN =
  /(?:^|\s)-m\s+(opus|sonnet|haiku|default|reset)\b/i;
// One-shot flag: "-m1 opus" — just this invocation, doesn't stick
export const MODEL_ONESHOT_PATTERN = /(?:^|\s)-m1\s+(opus|sonnet|haiku)\b/i;

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

/** Build a trigger pattern for a specific assistant name. */
export function buildTriggerPattern(name: string): RegExp {
  return new RegExp(`^@${escapeRegex(name)}\\b`, 'i');
}

/** Resolve per-group assistant name, falling back to global default. */
export function resolveAssistantName(containerConfig?: {
  assistantName?: string;
}): string {
  return containerConfig?.assistantName || ASSISTANT_NAME;
}

// --- Thread JID parsing utilities ---

export interface ParsedThreadJid {
  channel: 'dc' | 'slack';
  parentId: string;
  threadId: string;
}

const THREAD_JID_RE = /^(dc|slack):([^:]+):thread:(.+)$/;

/** Parse a thread JID into its components, or return null for non-thread JIDs. */
export function parseThreadJid(jid: string): ParsedThreadJid | null {
  const match = jid.match(THREAD_JID_RE);
  if (!match) return null;
  return {
    channel: match[1] as 'dc' | 'slack',
    parentId: match[2],
    threadId: match[3],
  };
}

/** Extract parent JID from a thread JID, or return the JID unchanged. */
export function getParentJid(jid: string): string {
  const parsed = parseThreadJid(jid);
  return parsed ? `${parsed.channel}:${parsed.parentId}` : jid;
}

// External Claude Code plugin directory (e.g. davekim917/bootstrap)
// Skills and agents are synced into each group's .claude/ before container runs
export const PLUGIN_DIR =
  process.env.PLUGIN_DIR || path.join(HOME_DIR, 'bootstrap');

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Residential proxy for browser automation (bypasses datacenter IP geo-fencing)
export const RESIDENTIAL_PROXY_URL =
  process.env.RESIDENTIAL_PROXY_URL || envConfig.RESIDENTIAL_PROXY_URL;
