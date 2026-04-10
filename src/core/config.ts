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
  'AGENT_RUNTIME',
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'MEMORY_SQLITE_PATH',
  'OPENAI_API_KEY',
  'MEMORY_EMBED_MODEL',
  'MEMORY_EMBED_PROVIDER',
  'MEMORY_CHUNK_SIZE',
  'MEMORY_CHUNK_OVERLAP',
  'MEMORY_RETRIEVAL_LIMIT',
  'MEMORY_REFLECTION_MIN_CONFIDENCE',
  'MEMORY_REFLECTION_MAX_FACTS_PER_TURN',
  'MEMORY_SCOPE_POLICY',
  'MEMORY_EMBED_BATCH_SIZE',
  'MEMORY_VECTOR_DIMENSIONS',
  'MEMORY_MAX_CHUNKS_PER_GROUP',
  'MEMORY_CHUNK_RETENTION_DAYS',
  'MEMORY_MAX_EVENTS',
  'MEMORY_MAX_PROCEDURES_PER_GROUP',
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
export const NANOCLAW_CONFIG_DIR = path.join(HOME_DIR, '.config', 'nanoclaw');

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  NANOCLAW_CONFIG_DIR,
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  NANOCLAW_CONFIG_DIR,
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MEMORY_SQLITE_PATH = path.resolve(
  PROJECT_ROOT,
  process.env.MEMORY_SQLITE_PATH ||
    envConfig.MEMORY_SQLITE_PATH ||
    'store/memory.db',
);
export const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || envConfig.OPENAI_API_KEY || null;
export const MEMORY_EMBED_MODEL =
  process.env.MEMORY_EMBED_MODEL ||
  envConfig.MEMORY_EMBED_MODEL ||
  'text-embedding-3-large';
export const MEMORY_EMBED_PROVIDER =
  process.env.MEMORY_EMBED_PROVIDER ||
  envConfig.MEMORY_EMBED_PROVIDER ||
  'openai';
export const MEMORY_CHUNK_SIZE = Math.max(
  300,
  parseInt(
    process.env.MEMORY_CHUNK_SIZE || envConfig.MEMORY_CHUNK_SIZE || '1400',
    10,
  ) || 1400,
);
export const MEMORY_CHUNK_OVERLAP = Math.max(
  0,
  parseInt(
    process.env.MEMORY_CHUNK_OVERLAP || envConfig.MEMORY_CHUNK_OVERLAP || '240',
    10,
  ) || 240,
);
export const MEMORY_RETRIEVAL_LIMIT = Math.max(
  1,
  parseInt(
    process.env.MEMORY_RETRIEVAL_LIMIT ||
      envConfig.MEMORY_RETRIEVAL_LIMIT ||
      '8',
    10,
  ) || 8,
);
export const MEMORY_REFLECTION_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_REFLECTION_MIN_CONFIDENCE ||
        envConfig.MEMORY_REFLECTION_MIN_CONFIDENCE ||
        '0.7',
    ) || 0.7,
  ),
);
export const MEMORY_REFLECTION_MAX_FACTS_PER_TURN = Math.max(
  1,
  parseInt(
    process.env.MEMORY_REFLECTION_MAX_FACTS_PER_TURN ||
      envConfig.MEMORY_REFLECTION_MAX_FACTS_PER_TURN ||
      '6',
    10,
  ) || 6,
);
export const MEMORY_SCOPE_POLICY =
  process.env.MEMORY_SCOPE_POLICY || envConfig.MEMORY_SCOPE_POLICY || 'group';
export const MEMORY_EMBED_BATCH_SIZE = Math.max(
  1,
  parseInt(
    process.env.MEMORY_EMBED_BATCH_SIZE ||
      envConfig.MEMORY_EMBED_BATCH_SIZE ||
      '16',
    10,
  ) || 16,
);
export const MEMORY_VECTOR_DIMENSIONS = Math.max(
  128,
  parseInt(
    process.env.MEMORY_VECTOR_DIMENSIONS ||
      envConfig.MEMORY_VECTOR_DIMENSIONS ||
      '3072',
    10,
  ) || 3072,
);
export const MEMORY_MAX_CHUNKS_PER_GROUP = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_CHUNKS_PER_GROUP ||
      envConfig.MEMORY_MAX_CHUNKS_PER_GROUP ||
      '6000',
    10,
  ) || 6000,
);
export const MEMORY_CHUNK_RETENTION_DAYS = Math.max(
  7,
  parseInt(
    process.env.MEMORY_CHUNK_RETENTION_DAYS ||
      envConfig.MEMORY_CHUNK_RETENTION_DAYS ||
      '120',
    10,
  ) || 120,
);
export const MEMORY_MAX_EVENTS = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_EVENTS || envConfig.MEMORY_MAX_EVENTS || '20000',
    10,
  ) || 20000,
);
export const MEMORY_MAX_PROCEDURES_PER_GROUP = Math.max(
  20,
  parseInt(
    process.env.MEMORY_MAX_PROCEDURES_PER_GROUP ||
      envConfig.MEMORY_MAX_PROCEDURES_PER_GROUP ||
      '500',
    10,
  ) || 500,
);

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export type AgentRuntime = 'container' | 'host';

function normalizeAgentRuntime(value?: string): AgentRuntime | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'container';
  if (normalized === 'host') return 'host';
  if (normalized === 'container') return 'container';
  return null;
}

export const AGENT_RUNTIME_RAW =
  process.env.AGENT_RUNTIME || envConfig.AGENT_RUNTIME;
const resolvedAgentRuntime = normalizeAgentRuntime(AGENT_RUNTIME_RAW);
export const AGENT_RUNTIME_INVALID =
  resolvedAgentRuntime === null ? AGENT_RUNTIME_RAW : undefined;
export const AGENT_RUNTIME = resolvedAgentRuntime ?? 'container';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
function normalizeModelValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const ANTHROPIC_MODEL = normalizeModelValue(
  process.env.ANTHROPIC_MODEL || envConfig.ANTHROPIC_MODEL,
);
export const CLAUDE_MODEL = normalizeModelValue(
  process.env.CLAUDE_MODEL || envConfig.CLAUDE_MODEL,
);

export type DefaultModelSource = 'ANTHROPIC_MODEL' | 'CLAUDE_MODEL' | 'unset';
export type EffectiveModelSource =
  | 'group.containerConfig.model'
  | DefaultModelSource;

export function getDefaultModelConfig(): {
  model?: string;
  source: DefaultModelSource;
} {
  if (ANTHROPIC_MODEL) {
    return { model: ANTHROPIC_MODEL, source: 'ANTHROPIC_MODEL' };
  }
  if (CLAUDE_MODEL) {
    return { model: CLAUDE_MODEL, source: 'CLAUDE_MODEL' };
  }
  return { source: 'unset' };
}

export function getEffectiveModelConfig(groupModel?: string): {
  model?: string;
  source: EffectiveModelSource;
} {
  const normalizedGroupModel = normalizeModelValue(groupModel);
  if (normalizedGroupModel) {
    return {
      model: normalizedGroupModel,
      source: 'group.containerConfig.model',
    };
  }
  return getDefaultModelConfig();
}

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
