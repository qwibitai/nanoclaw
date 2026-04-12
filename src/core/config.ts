import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'AGENT_ROOT',
  'ASSISTANT_NAME',
  'ONECLI_URL',
  'TZ',
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'MEMORY_SQLITE_PATH',
  'MEMORY_PROVIDER',
  'AGENT_MEMORY_ROOT',
  'OPENAI_API_KEY',
  'OPENAI_DAILY_EMBED_LIMIT',
  'MEMORY_EMBED_MODEL',
  'MEMORY_EMBED_PROVIDER',
  'MEMORY_CHUNK_SIZE',
  'MEMORY_CHUNK_OVERLAP',
  'MEMORY_RETRIEVAL_LIMIT',
  'MEMORY_RETRIEVAL_MIN_SCORE',
  'MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS',
  'MEMORY_MMR_LAMBDA',
  'MEMORY_RRF_LEXICAL_WEIGHT',
  'MEMORY_RRF_VECTOR_WEIGHT',
  'MEMORY_SOURCE_TYPE_BOOSTS',
  'MEMORY_REFLECTION_MIN_CONFIDENCE',
  'MEMORY_REFLECTION_MAX_FACTS_PER_TURN',
  'MEMORY_SCOPE_POLICY',
  'MEMORY_RETENTION_PIN_THRESHOLD',
  'MEMORY_ITEM_MAX_PER_GROUP',
  'MEMORY_SEMANTIC_DEDUP_ENABLED',
  'MEMORY_SEMANTIC_DEDUP_THRESHOLD',
  'MEMORY_GLOBAL_KNOWLEDGE_DIR',
  'MEMORY_MAX_GLOBAL_CHUNKS',
  'MEMORY_USAGE_FEEDBACK_ENABLED',
  'MEMORY_CONFIDENCE_BOOST_ON_USE',
  'MEMORY_CONFIDENCE_DECAY_ON_UNUSED',
  'MEMORY_USAGE_DECAY_INTERVAL_TURNS',
  'MEMORY_CONSOLIDATION_ENABLED',
  'MEMORY_CONSOLIDATION_MIN_ITEMS',
  'MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD',
  'MEMORY_CONSOLIDATION_MODEL',
  'MEMORY_CONSOLIDATION_MAX_CLUSTERS',
  'MEMORY_DREAMING_ENABLED',
  'MEMORY_DREAMING_CRON',
  'MEMORY_DREAMING_PROMOTION_THRESHOLD',
  'MEMORY_DREAMING_DECAY_THRESHOLD',
  'MEMORY_DREAMING_MIN_RECALLS',
  'MEMORY_DREAMING_MIN_UNIQUE_QUERIES',
  'MEMORY_DREAMING_CONFIDENCE_BOOST',
  'MEMORY_DREAMING_CONFIDENCE_DECAY',
  'MEMORY_EMBED_BATCH_SIZE',
  'MEMORY_VECTOR_DIMENSIONS',
  'MEMORY_MAX_CHUNKS_PER_GROUP',
  'MEMORY_CHUNK_RETENTION_DAYS',
  'MEMORY_MAX_EVENTS',
  'MEMORY_MAX_PROCEDURES_PER_GROUP',
  'PERMISSION_APPROVAL_TIMEOUT_MS',
  'TELEGRAM_PERMISSION_APPROVER_IDS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const HOME_DIR = process.env.HOME || os.homedir();
const AGENT_ROOT_RAW =
  process.env.AGENT_ROOT?.trim() || envConfig.AGENT_ROOT?.trim() || '';
const DEFAULT_AGENT_ROOT = path.join(HOME_DIR, 'myclaw');
export const AGENT_ROOT = path.resolve(AGENT_ROOT_RAW || DEFAULT_AGENT_ROOT);
const RUNTIME_ROOT = AGENT_ROOT;

export const SENDER_ALLOWLIST_PATH = path.join(
  AGENT_ROOT,
  'sender-allowlist.json',
);
export const SCHEDULER_JOBS_JSON_PATH = path.join(
  AGENT_ROOT,
  'scheduler-jobs.json',
);
export const STORE_DIR = path.resolve(RUNTIME_ROOT, 'store');
export const GROUPS_DIR = path.resolve(RUNTIME_ROOT, 'groups');
export const DATA_DIR = path.resolve(RUNTIME_ROOT, 'data');
const MEMORY_SQLITE_PATH_RAW =
  process.env.MEMORY_SQLITE_PATH ||
  envConfig.MEMORY_SQLITE_PATH ||
  'store/memory.db';
export const MEMORY_SQLITE_PATH = path.isAbsolute(MEMORY_SQLITE_PATH_RAW)
  ? path.resolve(MEMORY_SQLITE_PATH_RAW)
  : path.resolve(RUNTIME_ROOT, MEMORY_SQLITE_PATH_RAW);
export const MEMORY_PROVIDER =
  process.env.MEMORY_PROVIDER || envConfig.MEMORY_PROVIDER || 'sqlite';
export const AGENT_MEMORY_ROOT =
  process.env.AGENT_MEMORY_ROOT ||
  envConfig.AGENT_MEMORY_ROOT ||
  path.join(AGENT_ROOT, 'agent-memory');
const MEMORY_GLOBAL_KNOWLEDGE_DIR_RAW =
  process.env.MEMORY_GLOBAL_KNOWLEDGE_DIR ||
  envConfig.MEMORY_GLOBAL_KNOWLEDGE_DIR ||
  '';
function resolveOptionalPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(RUNTIME_ROOT, trimmed);
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes')
    return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no')
    return false;
  return fallback;
}

function parseSourceTypeBoosts(
  raw: string | undefined,
  fallback: Record<string, number>,
): Record<string, number> {
  if (!raw?.trim()) return { ...fallback };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return { ...fallback };
    const merged: Record<string, number> = { ...fallback };
    for (const [key, value] of Object.entries(parsed)) {
      const boost = Number(value);
      if (!Number.isFinite(boost) || boost <= 0) continue;
      merged[key] = boost;
    }
    return merged;
  } catch {
    return { ...fallback };
  }
}

export const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || envConfig.OPENAI_API_KEY || null;
export const OPENAI_DAILY_EMBED_LIMIT = Math.max(
  0,
  parseInt(
    process.env.OPENAI_DAILY_EMBED_LIMIT ||
      envConfig.OPENAI_DAILY_EMBED_LIMIT ||
      '500',
    10,
  ),
); // 0 = unlimited
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
export const MEMORY_RETRIEVAL_MIN_SCORE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_RETRIEVAL_MIN_SCORE ||
        envConfig.MEMORY_RETRIEVAL_MIN_SCORE ||
        '0.005',
    ) || 0.005,
  ),
);
export const MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS = Math.max(
  1,
  parseFloat(
    process.env.MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS ||
      envConfig.MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS ||
      '45',
  ) || 45,
);
export const MEMORY_MMR_LAMBDA = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_MMR_LAMBDA || envConfig.MEMORY_MMR_LAMBDA || '0.7',
    ) || 0.7,
  ),
);
export const MEMORY_RRF_LEXICAL_WEIGHT = Math.max(
  0,
  parseFloat(
    process.env.MEMORY_RRF_LEXICAL_WEIGHT ||
      envConfig.MEMORY_RRF_LEXICAL_WEIGHT ||
      '1.0',
  ) || 1.0,
);
export const MEMORY_RRF_VECTOR_WEIGHT = Math.max(
  0,
  parseFloat(
    process.env.MEMORY_RRF_VECTOR_WEIGHT ||
      envConfig.MEMORY_RRF_VECTOR_WEIGHT ||
      '1.0',
  ) || 1.0,
);
const DEFAULT_MEMORY_SOURCE_TYPE_BOOSTS: Record<string, number> = {
  claude_md: 1.3,
  local_doc: 1.2,
  knowledge_doc: 1.4,
  conversation: 1.0,
};
export const MEMORY_SOURCE_TYPE_BOOSTS = parseSourceTypeBoosts(
  process.env.MEMORY_SOURCE_TYPE_BOOSTS || envConfig.MEMORY_SOURCE_TYPE_BOOSTS,
  DEFAULT_MEMORY_SOURCE_TYPE_BOOSTS,
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
export const MEMORY_RETENTION_PIN_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_RETENTION_PIN_THRESHOLD ||
        envConfig.MEMORY_RETENTION_PIN_THRESHOLD ||
        '0.92',
    ) || 0.92,
  ),
);
export const MEMORY_ITEM_MAX_PER_GROUP = Math.max(
  100,
  parseInt(
    process.env.MEMORY_ITEM_MAX_PER_GROUP ||
      envConfig.MEMORY_ITEM_MAX_PER_GROUP ||
      '2000',
    10,
  ) || 2000,
);
export const MEMORY_SEMANTIC_DEDUP_ENABLED = parseBooleanEnv(
  process.env.MEMORY_SEMANTIC_DEDUP_ENABLED ||
    envConfig.MEMORY_SEMANTIC_DEDUP_ENABLED,
  true,
);
export const MEMORY_SEMANTIC_DEDUP_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_SEMANTIC_DEDUP_THRESHOLD ||
        envConfig.MEMORY_SEMANTIC_DEDUP_THRESHOLD ||
        '0.88',
    ) || 0.88,
  ),
);
export const MEMORY_GLOBAL_KNOWLEDGE_DIR = resolveOptionalPath(
  MEMORY_GLOBAL_KNOWLEDGE_DIR_RAW ||
    (AGENT_MEMORY_ROOT ? path.join(AGENT_MEMORY_ROOT, 'knowledge') : ''),
);
export const MEMORY_MAX_GLOBAL_CHUNKS = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_GLOBAL_CHUNKS ||
      envConfig.MEMORY_MAX_GLOBAL_CHUNKS ||
      '3000',
    10,
  ) || 3000,
);
export const MEMORY_USAGE_FEEDBACK_ENABLED = parseBooleanEnv(
  process.env.MEMORY_USAGE_FEEDBACK_ENABLED ||
    envConfig.MEMORY_USAGE_FEEDBACK_ENABLED,
  true,
);
export const MEMORY_CONFIDENCE_BOOST_ON_USE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONFIDENCE_BOOST_ON_USE ||
        envConfig.MEMORY_CONFIDENCE_BOOST_ON_USE ||
        '0.02',
    ) || 0.02,
  ),
);
export const MEMORY_CONFIDENCE_DECAY_ON_UNUSED = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONFIDENCE_DECAY_ON_UNUSED ||
        envConfig.MEMORY_CONFIDENCE_DECAY_ON_UNUSED ||
        '0.01',
    ) || 0.01,
  ),
);
export const MEMORY_USAGE_DECAY_INTERVAL_TURNS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_USAGE_DECAY_INTERVAL_TURNS ||
      envConfig.MEMORY_USAGE_DECAY_INTERVAL_TURNS ||
      '20',
    10,
  ) || 20,
);
export const MEMORY_CONSOLIDATION_ENABLED = parseBooleanEnv(
  process.env.MEMORY_CONSOLIDATION_ENABLED ||
    envConfig.MEMORY_CONSOLIDATION_ENABLED,
  false,
);
export const MEMORY_CONSOLIDATION_MIN_ITEMS = Math.max(
  2,
  parseInt(
    process.env.MEMORY_CONSOLIDATION_MIN_ITEMS ||
      envConfig.MEMORY_CONSOLIDATION_MIN_ITEMS ||
      '50',
    10,
  ) || 50,
);
export const MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD ||
        envConfig.MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD ||
        '0.8',
    ) || 0.8,
  ),
);
export const MEMORY_DREAMING_ENABLED = parseBooleanEnv(
  process.env.MEMORY_DREAMING_ENABLED || envConfig.MEMORY_DREAMING_ENABLED,
  false,
);
export const MEMORY_DREAMING_CRON =
  process.env.MEMORY_DREAMING_CRON ||
  envConfig.MEMORY_DREAMING_CRON ||
  '0 3 * * *';
export const MEMORY_DREAMING_PROMOTION_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_PROMOTION_THRESHOLD ||
        envConfig.MEMORY_DREAMING_PROMOTION_THRESHOLD ||
        '0.55',
    ) || 0.55,
  ),
);
export const MEMORY_DREAMING_DECAY_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_DECAY_THRESHOLD ||
        envConfig.MEMORY_DREAMING_DECAY_THRESHOLD ||
        '0.15',
    ) || 0.15,
  ),
);
export const MEMORY_DREAMING_MIN_RECALLS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_DREAMING_MIN_RECALLS ||
      envConfig.MEMORY_DREAMING_MIN_RECALLS ||
      '3',
    10,
  ) || 3,
);
export const MEMORY_DREAMING_MIN_UNIQUE_QUERIES = Math.max(
  1,
  parseInt(
    process.env.MEMORY_DREAMING_MIN_UNIQUE_QUERIES ||
      envConfig.MEMORY_DREAMING_MIN_UNIQUE_QUERIES ||
      '2',
    10,
  ) || 2,
);
export const MEMORY_DREAMING_CONFIDENCE_BOOST = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_CONFIDENCE_BOOST ||
        envConfig.MEMORY_DREAMING_CONFIDENCE_BOOST ||
        '0.05',
    ) || 0.05,
  ),
);
export const MEMORY_DREAMING_CONFIDENCE_DECAY = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_CONFIDENCE_DECAY ||
        envConfig.MEMORY_DREAMING_CONFIDENCE_DECAY ||
        '0.03',
    ) || 0.03,
  ),
);
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
export const PERMISSION_APPROVAL_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(
    process.env.PERMISSION_APPROVAL_TIMEOUT_MS ||
      envConfig.PERMISSION_APPROVAL_TIMEOUT_MS ||
      '300000',
    10,
  ) || 300_000,
);
function parseIdAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set<string>();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}
export const TELEGRAM_PERMISSION_APPROVER_IDS = parseIdAllowlist(
  process.env.TELEGRAM_PERMISSION_APPROVER_IDS ||
    envConfig.TELEGRAM_PERMISSION_APPROVER_IDS,
);
export const MEMORY_CONSOLIDATION_MAX_CLUSTERS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_CONSOLIDATION_MAX_CLUSTERS ||
      envConfig.MEMORY_CONSOLIDATION_MAX_CLUSTERS ||
      '10',
    10,
  ) || 10,
);

export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE ||
    process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
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
export const MEMORY_CONSOLIDATION_MODEL =
  process.env.MEMORY_CONSOLIDATION_MODEL ||
  envConfig.MEMORY_CONSOLIDATION_MODEL ||
  CLAUDE_MODEL ||
  ANTHROPIC_MODEL ||
  '';

export type DefaultModelSource = 'ANTHROPIC_MODEL' | 'CLAUDE_MODEL' | 'unset';
export type EffectiveModelSource =
  | 'group.agentConfig.model'
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
      source: 'group.agentConfig.model',
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

// Timezone for scheduler jobs, message formatting, etc.
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
