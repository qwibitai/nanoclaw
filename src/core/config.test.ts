import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadConfigWithEnv(env: {
  ANTHROPIC_MODEL?: string;
  CLAUDE_MODEL?: string;
}) {
  vi.resetModules();
  if (env.ANTHROPIC_MODEL === undefined) {
    delete process.env.ANTHROPIC_MODEL;
  } else {
    process.env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL;
  }
  if (env.CLAUDE_MODEL === undefined) {
    delete process.env.CLAUDE_MODEL;
  } else {
    process.env.CLAUDE_MODEL = env.CLAUDE_MODEL;
  }
  vi.doMock('./env.js', () => ({
    readEnvFile: () => ({}),
  }));
  return import('./config.js');
}

afterEach(() => {
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.CLAUDE_MODEL;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  vi.resetModules();
  vi.doUnmock('./env.js');
});

describe('model config precedence', () => {
  it('uses ANTHROPIC_MODEL when only ANTHROPIC_MODEL is set', async () => {
    const cfg = await loadConfigWithEnv({ ANTHROPIC_MODEL: 'opus' });
    expect(cfg.getDefaultModelConfig()).toEqual({
      model: 'opus',
      source: 'ANTHROPIC_MODEL',
    });
  });

  it('uses CLAUDE_MODEL when only CLAUDE_MODEL is set', async () => {
    const cfg = await loadConfigWithEnv({ CLAUDE_MODEL: 'sonnet' });
    expect(cfg.getDefaultModelConfig()).toEqual({
      model: 'sonnet',
      source: 'CLAUDE_MODEL',
    });
  });

  it('prefers ANTHROPIC_MODEL when both env vars are set', async () => {
    const cfg = await loadConfigWithEnv({
      ANTHROPIC_MODEL: 'opus',
      CLAUDE_MODEL: 'sonnet',
    });
    expect(cfg.getDefaultModelConfig()).toEqual({
      model: 'opus',
      source: 'ANTHROPIC_MODEL',
    });
  });

  it('prefers group override over env defaults', async () => {
    const cfg = await loadConfigWithEnv({
      ANTHROPIC_MODEL: 'sonnet',
      CLAUDE_MODEL: 'haiku',
    });
    expect(cfg.getEffectiveModelConfig('opus')).toEqual({
      model: 'opus',
      source: 'group.agentConfig.model',
    });
  });

  // --- Coverage for line 541: getDefaultModelConfig returns unset ---

  it('returns unset source when neither ANTHROPIC_MODEL nor CLAUDE_MODEL is set', async () => {
    const cfg = await loadConfigWithEnv({});
    const result = cfg.getDefaultModelConfig();
    expect(result).toEqual({ source: 'unset' });
    expect(result.model).toBeUndefined();
  });

  // --- Coverage for line 555: getEffectiveModelConfig falls back to default ---

  it('getEffectiveModelConfig falls back to default when group model is empty', async () => {
    const cfg = await loadConfigWithEnv({ ANTHROPIC_MODEL: 'opus' });
    // Empty string group model should fall back to env default
    expect(cfg.getEffectiveModelConfig('')).toEqual({
      model: 'opus',
      source: 'ANTHROPIC_MODEL',
    });
  });

  it('getEffectiveModelConfig falls back to default when group model is whitespace', async () => {
    const cfg = await loadConfigWithEnv({ CLAUDE_MODEL: 'sonnet' });
    expect(cfg.getEffectiveModelConfig('  ')).toEqual({
      model: 'sonnet',
      source: 'CLAUDE_MODEL',
    });
  });

  it('getEffectiveModelConfig falls back to unset when no models configured', async () => {
    const cfg = await loadConfigWithEnv({});
    expect(cfg.getEffectiveModelConfig(undefined)).toEqual({
      source: 'unset',
    });
  });
});

// --- Coverage for line 597: resolveConfigTimezone fallback to UTC ---

describe('timezone resolution', () => {
  it('TIMEZONE is a valid string', async () => {
    const cfg = await loadConfigWithEnv({});
    // TIMEZONE should always resolve to something valid
    expect(typeof cfg.TIMEZONE).toBe('string');
    expect(cfg.TIMEZONE.length).toBeGreaterThan(0);
  });

  it('buildTriggerPattern creates case-insensitive word-boundary regex', async () => {
    const cfg = await loadConfigWithEnv({});
    const pattern = cfg.buildTriggerPattern('@TestBot');
    expect(pattern.test('@TestBot hello')).toBe(true);
    expect(pattern.test('@testbot hello')).toBe(true);
    expect(pattern.test('hello @TestBot')).toBe(false);
  });

  it('getTriggerPattern uses default when trigger is empty', async () => {
    const cfg = await loadConfigWithEnv({});
    const pattern = cfg.getTriggerPattern('');
    // Should use DEFAULT_TRIGGER
    expect(pattern).toBeInstanceOf(RegExp);
  });

  it('getTriggerPattern uses provided trigger', async () => {
    const cfg = await loadConfigWithEnv({});
    const pattern = cfg.getTriggerPattern('@CustomBot');
    expect(pattern.test('@CustomBot hey')).toBe(true);
  });
});

// --- Helper that can set any env vars for a fresh config import ---

async function loadConfigWithAllEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.doMock('./env.js', () => ({
    readEnvFile: () => ({}),
  }));
  return import('./config.js');
}

// --- Coverage for parseBooleanEnv: all branches ---

describe('parseBooleanEnv all branches', () => {
  it('returns true for recognized truthy value "1"', async () => {
    // MEMORY_CONSOLIDATION_ENABLED defaults to false; override to '1'
    const cfg = await loadConfigWithAllEnv({
      MEMORY_CONSOLIDATION_ENABLED: '1',
    });
    expect(cfg.MEMORY_CONSOLIDATION_ENABLED).toBe(true);
  });

  it('returns true for recognized truthy value "true"', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_CONSOLIDATION_ENABLED: 'true',
    });
    expect(cfg.MEMORY_CONSOLIDATION_ENABLED).toBe(true);
  });

  it('returns true for recognized truthy value "yes"', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_CONSOLIDATION_ENABLED: 'YES',
    });
    expect(cfg.MEMORY_CONSOLIDATION_ENABLED).toBe(true);
  });

  it('returns false for recognized falsy value "0"', async () => {
    // MEMORY_SEMANTIC_DEDUP_ENABLED defaults to true; override to '0'
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SEMANTIC_DEDUP_ENABLED: '0',
    });
    expect(cfg.MEMORY_SEMANTIC_DEDUP_ENABLED).toBe(false);
  });

  it('returns false for recognized falsy value "false"', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SEMANTIC_DEDUP_ENABLED: 'false',
    });
    expect(cfg.MEMORY_SEMANTIC_DEDUP_ENABLED).toBe(false);
  });

  it('returns false for recognized falsy value "no"', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SEMANTIC_DEDUP_ENABLED: 'NO',
    });
    expect(cfg.MEMORY_SEMANTIC_DEDUP_ENABLED).toBe(false);
  });

  it('returns fallback (true) when env value is an unrecognized string', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SEMANTIC_DEDUP_ENABLED: 'maybe',
    });
    expect(cfg.MEMORY_SEMANTIC_DEDUP_ENABLED).toBe(true);
  });

  it('returns fallback (false) when env value is unrecognized for a false-default field', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_CONSOLIDATION_ENABLED: 'sometimes',
    });
    expect(cfg.MEMORY_CONSOLIDATION_ENABLED).toBe(false);
  });
});

// --- Coverage for lines 122-133: parseSourceTypeBoosts ---

describe('parseSourceTypeBoosts', () => {
  it('parses valid JSON and merges with defaults', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SOURCE_TYPE_BOOSTS: JSON.stringify({
        claude_md: 2.0,
        custom_source: 3.5,
      }),
    });
    // claude_md should be overridden, others should keep defaults
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.claude_md).toBe(2.0);
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.custom_source).toBe(3.5);
    // Defaults should still be present
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.local_doc).toBe(1.2);
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.knowledge_doc).toBe(1.4);
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.conversation).toBe(1.0);
  });

  it('returns fallback for invalid JSON', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SOURCE_TYPE_BOOSTS: 'not-json{{{',
    });
    // Should fall back to defaults (catch branch, line 133)
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.claude_md).toBe(1.3);
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.local_doc).toBe(1.2);
  });

  it('skips non-finite and non-positive boost values', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SOURCE_TYPE_BOOSTS: JSON.stringify({
        claude_md: -1, // negative, skip
        local_doc: 0, // zero, skip (boost <= 0)
        knowledge_doc: Infinity, // not finite, skip
        conversation: 'abc', // NaN, skip
        custom: 5.0, // valid
      }),
    });
    // Skipped values should remain at defaults
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.claude_md).toBe(1.3);
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.local_doc).toBe(1.2);
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.knowledge_doc).toBe(1.4);
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.conversation).toBe(1.0);
    // Valid override
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.custom).toBe(5.0);
  });

  it('returns fallback when env is empty string', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SOURCE_TYPE_BOOSTS: '',
    });
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.claude_md).toBe(1.3);
  });

  it('returns fallback when parsed value is not an object', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_SOURCE_TYPE_BOOSTS: '"just a string"',
    });
    // JSON.parse("\"just a string\"") returns a string, not object → fallback
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.claude_md).toBe(1.3);
  });
});

// --- Coverage for line 597: resolveConfigTimezone fallback to UTC ---

// --- Coverage for all process.env || envConfig || default branches ---

describe('config env overrides for branch coverage', () => {
  it('exercises process.env branch for all config variables', async () => {
    const cfg = await loadConfigWithAllEnv({
      ASSISTANT_NAME: 'TestBot',
      MEMORY_SQLITE_PATH: '/tmp/test-memory.db',
      MEMORY_PROVIDER: 'test-provider',
      AGENT_MEMORY_ROOT: '/tmp/agent-memory',
      OPENAI_API_KEY: 'test-api-key',
      OPENAI_DAILY_EMBED_LIMIT: '100',
      MEMORY_EMBED_MODEL: 'test-embed-model',
      MEMORY_EMBED_PROVIDER: 'test-embed-provider',
      MEMORY_CHUNK_SIZE: '2000',
      MEMORY_CHUNK_OVERLAP: '300',
      MEMORY_RETRIEVAL_LIMIT: '5',
      MEMORY_RETRIEVAL_MIN_SCORE: '0.01',
      MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS: '30',
      MEMORY_MMR_LAMBDA: '0.5',
      MEMORY_RRF_LEXICAL_WEIGHT: '2.0',
      MEMORY_RRF_VECTOR_WEIGHT: '2.0',
      MEMORY_SOURCE_TYPE_BOOSTS: JSON.stringify({ claude_md: 2.0 }),
      MEMORY_REFLECTION_MIN_CONFIDENCE: '0.5',
      MEMORY_REFLECTION_MAX_FACTS_PER_TURN: '3',
      MEMORY_SCOPE_POLICY: 'global',
      MEMORY_RETENTION_PIN_THRESHOLD: '0.95',
      MEMORY_ITEM_MAX_PER_GROUP: '3000',
      MEMORY_SEMANTIC_DEDUP_ENABLED: 'true',
      MEMORY_SEMANTIC_DEDUP_THRESHOLD: '0.9',
      MEMORY_GLOBAL_KNOWLEDGE_DIR: '/tmp/knowledge',
      MEMORY_MAX_GLOBAL_CHUNKS: '5000',
      MEMORY_USAGE_FEEDBACK_ENABLED: 'true',
      MEMORY_CONFIDENCE_BOOST_ON_USE: '0.05',
      MEMORY_CONFIDENCE_DECAY_ON_UNUSED: '0.03',
      MEMORY_USAGE_DECAY_INTERVAL_TURNS: '10',
      MEMORY_CONSOLIDATION_ENABLED: 'true',
      MEMORY_CONSOLIDATION_MIN_ITEMS: '100',
      MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD: '0.9',
      MEMORY_CONSOLIDATION_MODEL: 'test-model',
      MEMORY_CONSOLIDATION_MAX_CLUSTERS: '20',
      MEMORY_DREAMING_ENABLED: 'true',
      MEMORY_DREAMING_CRON: '0 4 * * *',
      MEMORY_DREAMING_PROMOTION_THRESHOLD: '0.6',
      MEMORY_DREAMING_DECAY_THRESHOLD: '0.2',
      MEMORY_DREAMING_MIN_RECALLS: '5',
      MEMORY_DREAMING_MIN_UNIQUE_QUERIES: '3',
      MEMORY_DREAMING_CONFIDENCE_BOOST: '0.1',
      MEMORY_DREAMING_CONFIDENCE_DECAY: '0.05',
      MEMORY_EMBED_BATCH_SIZE: '32',
      MEMORY_VECTOR_DIMENSIONS: '1536',
      MEMORY_MAX_CHUNKS_PER_GROUP: '8000',
      MEMORY_CHUNK_RETENTION_DAYS: '90',
      MEMORY_MAX_EVENTS: '30000',
      MEMORY_MAX_PROCEDURES_PER_GROUP: '1000',
      AGENT_TIMEOUT: '3600000',
      CONTAINER_TIMEOUT: '3600000',
      AGENT_MAX_OUTPUT_SIZE: '20971520',
      CONTAINER_MAX_OUTPUT_SIZE: '20971520',
      ONECLI_URL: 'http://test-onecli',
      MAX_MESSAGES_PER_PROMPT: '20',
      IDLE_TIMEOUT: '900000',
      MAX_CONCURRENT_CONTAINERS: '10',
    });

    expect(cfg.ASSISTANT_NAME).toBe('TestBot');
    expect(cfg.MEMORY_PROVIDER).toBe('test-provider');
    expect(cfg.AGENT_MEMORY_ROOT).toBe('/tmp/agent-memory');
    expect(cfg.OPENAI_API_KEY).toBe('test-api-key');
    expect(cfg.OPENAI_DAILY_EMBED_LIMIT).toBe(100);
    expect(cfg.MEMORY_EMBED_MODEL).toBe('test-embed-model');
    expect(cfg.MEMORY_EMBED_PROVIDER).toBe('test-embed-provider');
    expect(cfg.MEMORY_CHUNK_SIZE).toBe(2000);
    expect(cfg.MEMORY_CHUNK_OVERLAP).toBe(300);
    expect(cfg.MEMORY_RETRIEVAL_LIMIT).toBe(5);
    expect(cfg.MEMORY_RETRIEVAL_MIN_SCORE).toBe(0.01);
    expect(cfg.MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS).toBe(30);
    expect(cfg.MEMORY_MMR_LAMBDA).toBe(0.5);
    expect(cfg.MEMORY_RRF_LEXICAL_WEIGHT).toBe(2.0);
    expect(cfg.MEMORY_RRF_VECTOR_WEIGHT).toBe(2.0);
    expect(cfg.MEMORY_SOURCE_TYPE_BOOSTS.claude_md).toBe(2.0);
    expect(cfg.MEMORY_REFLECTION_MIN_CONFIDENCE).toBe(0.5);
    expect(cfg.MEMORY_REFLECTION_MAX_FACTS_PER_TURN).toBe(3);
    expect(cfg.MEMORY_SCOPE_POLICY).toBe('global');
    expect(cfg.MEMORY_RETENTION_PIN_THRESHOLD).toBe(0.95);
    expect(cfg.MEMORY_ITEM_MAX_PER_GROUP).toBe(3000);
    expect(cfg.MEMORY_SEMANTIC_DEDUP_ENABLED).toBe(true);
    expect(cfg.MEMORY_SEMANTIC_DEDUP_THRESHOLD).toBe(0.9);
    expect(cfg.MEMORY_GLOBAL_KNOWLEDGE_DIR).toBe('/tmp/knowledge');
    expect(cfg.MEMORY_MAX_GLOBAL_CHUNKS).toBe(5000);
    expect(cfg.MEMORY_USAGE_FEEDBACK_ENABLED).toBe(true);
    expect(cfg.MEMORY_CONFIDENCE_BOOST_ON_USE).toBe(0.05);
    expect(cfg.MEMORY_CONFIDENCE_DECAY_ON_UNUSED).toBe(0.03);
    expect(cfg.MEMORY_USAGE_DECAY_INTERVAL_TURNS).toBe(10);
    expect(cfg.MEMORY_CONSOLIDATION_ENABLED).toBe(true);
    expect(cfg.MEMORY_CONSOLIDATION_MIN_ITEMS).toBe(100);
    expect(cfg.MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD).toBe(0.9);
    expect(cfg.MEMORY_CONSOLIDATION_MODEL).toBe('test-model');
    expect(cfg.MEMORY_CONSOLIDATION_MAX_CLUSTERS).toBe(20);
    expect(cfg.MEMORY_DREAMING_ENABLED).toBe(true);
    expect(cfg.MEMORY_DREAMING_CRON).toBe('0 4 * * *');
    expect(cfg.MEMORY_DREAMING_PROMOTION_THRESHOLD).toBe(0.6);
    expect(cfg.MEMORY_DREAMING_DECAY_THRESHOLD).toBe(0.2);
    expect(cfg.MEMORY_DREAMING_MIN_RECALLS).toBe(5);
    expect(cfg.MEMORY_DREAMING_MIN_UNIQUE_QUERIES).toBe(3);
    expect(cfg.MEMORY_DREAMING_CONFIDENCE_BOOST).toBe(0.1);
    expect(cfg.MEMORY_DREAMING_CONFIDENCE_DECAY).toBe(0.05);
    expect(cfg.MEMORY_EMBED_BATCH_SIZE).toBe(32);
    expect(cfg.MEMORY_VECTOR_DIMENSIONS).toBe(1536);
    expect(cfg.MEMORY_MAX_CHUNKS_PER_GROUP).toBe(8000);
    expect(cfg.MEMORY_CHUNK_RETENTION_DAYS).toBe(90);
    expect(cfg.MEMORY_MAX_EVENTS).toBe(30000);
    expect(cfg.MEMORY_MAX_PROCEDURES_PER_GROUP).toBe(1000);
    expect(cfg.AGENT_TIMEOUT).toBe(3600000);
    expect(cfg.AGENT_MAX_OUTPUT_SIZE).toBe(20971520);
    expect(cfg.ONECLI_URL).toBe('http://test-onecli');
    expect(cfg.MAX_MESSAGES_PER_PROMPT).toBe(20);
    expect(cfg.IDLE_TIMEOUT).toBe(900000);
    expect(cfg.MAX_CONCURRENT_CONTAINERS).toBe(10);
  });

  it('exercises envConfig branch for config variables', async () => {
    // Clear all process.env overrides so envConfig values are used
    vi.resetModules();
    // Delete all the env vars we might have set
    const envKeys = [
      'ASSISTANT_NAME', 'MEMORY_SQLITE_PATH', 'MEMORY_PROVIDER',
      'AGENT_MEMORY_ROOT', 'OPENAI_API_KEY', 'OPENAI_DAILY_EMBED_LIMIT',
      'MEMORY_EMBED_MODEL', 'MEMORY_EMBED_PROVIDER', 'MEMORY_CHUNK_SIZE',
      'MEMORY_CHUNK_OVERLAP', 'MEMORY_RETRIEVAL_LIMIT', 'MEMORY_RETRIEVAL_MIN_SCORE',
      'MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS', 'MEMORY_MMR_LAMBDA',
      'MEMORY_RRF_LEXICAL_WEIGHT', 'MEMORY_RRF_VECTOR_WEIGHT',
      'MEMORY_SOURCE_TYPE_BOOSTS', 'MEMORY_REFLECTION_MIN_CONFIDENCE',
      'MEMORY_REFLECTION_MAX_FACTS_PER_TURN', 'MEMORY_SCOPE_POLICY',
      'MEMORY_RETENTION_PIN_THRESHOLD', 'MEMORY_ITEM_MAX_PER_GROUP',
      'MEMORY_SEMANTIC_DEDUP_ENABLED', 'MEMORY_SEMANTIC_DEDUP_THRESHOLD',
      'MEMORY_GLOBAL_KNOWLEDGE_DIR', 'MEMORY_MAX_GLOBAL_CHUNKS',
      'MEMORY_USAGE_FEEDBACK_ENABLED', 'MEMORY_CONFIDENCE_BOOST_ON_USE',
      'MEMORY_CONFIDENCE_DECAY_ON_UNUSED', 'MEMORY_USAGE_DECAY_INTERVAL_TURNS',
      'MEMORY_CONSOLIDATION_ENABLED', 'MEMORY_CONSOLIDATION_MIN_ITEMS',
      'MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD', 'MEMORY_CONSOLIDATION_MODEL',
      'MEMORY_CONSOLIDATION_MAX_CLUSTERS', 'MEMORY_DREAMING_ENABLED',
      'MEMORY_DREAMING_CRON', 'MEMORY_DREAMING_PROMOTION_THRESHOLD',
      'MEMORY_DREAMING_DECAY_THRESHOLD', 'MEMORY_DREAMING_MIN_RECALLS',
      'MEMORY_DREAMING_MIN_UNIQUE_QUERIES', 'MEMORY_DREAMING_CONFIDENCE_BOOST',
      'MEMORY_DREAMING_CONFIDENCE_DECAY', 'MEMORY_EMBED_BATCH_SIZE',
      'MEMORY_VECTOR_DIMENSIONS', 'MEMORY_MAX_CHUNKS_PER_GROUP',
      'MEMORY_CHUNK_RETENTION_DAYS', 'MEMORY_MAX_EVENTS',
      'MEMORY_MAX_PROCEDURES_PER_GROUP', 'AGENT_TIMEOUT', 'CONTAINER_TIMEOUT',
      'AGENT_MAX_OUTPUT_SIZE', 'CONTAINER_MAX_OUTPUT_SIZE', 'ONECLI_URL',
      'MAX_MESSAGES_PER_PROMPT', 'IDLE_TIMEOUT', 'MAX_CONCURRENT_CONTAINERS',
      'ANTHROPIC_MODEL', 'CLAUDE_MODEL',
    ];
    for (const key of envKeys) {
      delete process.env[key];
    }
    vi.doMock('./env.js', () => ({
      readEnvFile: () => ({
        ASSISTANT_NAME: 'EnvBot',
        MEMORY_PROVIDER: 'env-provider',
        AGENT_MEMORY_ROOT: '/tmp/env-memory',
        OPENAI_API_KEY: 'env-api-key',
        OPENAI_DAILY_EMBED_LIMIT: '200',
        MEMORY_EMBED_MODEL: 'env-embed-model',
        MEMORY_EMBED_PROVIDER: 'env-embed-provider',
        MEMORY_CHUNK_SIZE: '1800',
        MEMORY_CHUNK_OVERLAP: '200',
        MEMORY_RETRIEVAL_LIMIT: '12',
        MEMORY_RETRIEVAL_MIN_SCORE: '0.02',
        MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS: '60',
        MEMORY_MMR_LAMBDA: '0.6',
        MEMORY_RRF_LEXICAL_WEIGHT: '1.5',
        MEMORY_RRF_VECTOR_WEIGHT: '1.5',
        MEMORY_SOURCE_TYPE_BOOSTS: JSON.stringify({ local_doc: 2.0 }),
        MEMORY_REFLECTION_MIN_CONFIDENCE: '0.8',
        MEMORY_REFLECTION_MAX_FACTS_PER_TURN: '4',
        MEMORY_SCOPE_POLICY: 'shared',
        MEMORY_RETENTION_PIN_THRESHOLD: '0.93',
        MEMORY_ITEM_MAX_PER_GROUP: '2500',
        MEMORY_SEMANTIC_DEDUP_ENABLED: 'false',
        MEMORY_SEMANTIC_DEDUP_THRESHOLD: '0.85',
        MEMORY_GLOBAL_KNOWLEDGE_DIR: '/tmp/env-knowledge',
        MEMORY_MAX_GLOBAL_CHUNKS: '4000',
        MEMORY_USAGE_FEEDBACK_ENABLED: 'false',
        MEMORY_CONFIDENCE_BOOST_ON_USE: '0.04',
        MEMORY_CONFIDENCE_DECAY_ON_UNUSED: '0.02',
        MEMORY_USAGE_DECAY_INTERVAL_TURNS: '15',
        MEMORY_CONSOLIDATION_ENABLED: 'true',
        MEMORY_CONSOLIDATION_MIN_ITEMS: '75',
        MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD: '0.85',
        MEMORY_CONSOLIDATION_MODEL: 'env-model',
        MEMORY_CONSOLIDATION_MAX_CLUSTERS: '15',
        MEMORY_DREAMING_ENABLED: 'true',
        MEMORY_DREAMING_CRON: '0 2 * * *',
        MEMORY_DREAMING_PROMOTION_THRESHOLD: '0.65',
        MEMORY_DREAMING_DECAY_THRESHOLD: '0.1',
        MEMORY_DREAMING_MIN_RECALLS: '4',
        MEMORY_DREAMING_MIN_UNIQUE_QUERIES: '4',
        MEMORY_DREAMING_CONFIDENCE_BOOST: '0.08',
        MEMORY_DREAMING_CONFIDENCE_DECAY: '0.04',
        MEMORY_EMBED_BATCH_SIZE: '24',
        MEMORY_VECTOR_DIMENSIONS: '2048',
        MEMORY_MAX_CHUNKS_PER_GROUP: '7000',
        MEMORY_CHUNK_RETENTION_DAYS: '60',
        MEMORY_MAX_EVENTS: '25000',
        MEMORY_MAX_PROCEDURES_PER_GROUP: '750',
        ONECLI_URL: 'http://env-onecli',
        ANTHROPIC_MODEL: 'env-opus',
        CLAUDE_MODEL: 'env-sonnet',
        MEMORY_SQLITE_PATH: '/tmp/env-memory.db',
      }),
    }));
    const cfg = await import('./config.js');

    expect(cfg.ASSISTANT_NAME).toBe('EnvBot');
    expect(cfg.MEMORY_PROVIDER).toBe('env-provider');
    expect(cfg.OPENAI_API_KEY).toBe('env-api-key');
    expect(cfg.OPENAI_DAILY_EMBED_LIMIT).toBe(200);
    expect(cfg.MEMORY_EMBED_MODEL).toBe('env-embed-model');
    expect(cfg.MEMORY_EMBED_PROVIDER).toBe('env-embed-provider');
    expect(cfg.MEMORY_CHUNK_SIZE).toBe(1800);
    expect(cfg.MEMORY_CHUNK_OVERLAP).toBe(200);
    expect(cfg.MEMORY_RETRIEVAL_LIMIT).toBe(12);
    expect(cfg.MEMORY_SCOPE_POLICY).toBe('shared');
    expect(cfg.MEMORY_CONSOLIDATION_ENABLED).toBe(true);
    expect(cfg.MEMORY_CONSOLIDATION_MODEL).toBe('env-model');
    expect(cfg.MEMORY_DREAMING_CRON).toBe('0 2 * * *');
    expect(cfg.ONECLI_URL).toBe('http://env-onecli');
    expect(cfg.ANTHROPIC_MODEL).toBe('env-opus');
    expect(cfg.CLAUDE_MODEL).toBe('env-sonnet');
  });
});

describe('config fallback branches for parseInt/parseFloat || default', () => {
  it('triggers fallback when parseInt returns 0 (falsy)', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_CHUNK_SIZE: '0',
      MEMORY_CHUNK_OVERLAP: '0',
      MEMORY_RETRIEVAL_LIMIT: '0',
      MEMORY_RETRIEVAL_MIN_SCORE: '0',
      MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS: '0',
      MEMORY_MMR_LAMBDA: '0',
      MEMORY_RRF_LEXICAL_WEIGHT: '0',
      MEMORY_RRF_VECTOR_WEIGHT: '0',
      MEMORY_REFLECTION_MIN_CONFIDENCE: '0',
      MEMORY_REFLECTION_MAX_FACTS_PER_TURN: '0',
      MEMORY_RETENTION_PIN_THRESHOLD: '0',
      MEMORY_ITEM_MAX_PER_GROUP: '0',
      MEMORY_SEMANTIC_DEDUP_THRESHOLD: '0',
      MEMORY_MAX_GLOBAL_CHUNKS: '0',
      MEMORY_CONFIDENCE_BOOST_ON_USE: '0',
      MEMORY_CONFIDENCE_DECAY_ON_UNUSED: '0',
      MEMORY_USAGE_DECAY_INTERVAL_TURNS: '0',
      MEMORY_CONSOLIDATION_MIN_ITEMS: '0',
      MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD: '0',
      MEMORY_CONSOLIDATION_MAX_CLUSTERS: '0',
      MEMORY_DREAMING_PROMOTION_THRESHOLD: '0',
      MEMORY_DREAMING_DECAY_THRESHOLD: '0',
      MEMORY_DREAMING_MIN_RECALLS: '0',
      MEMORY_DREAMING_MIN_UNIQUE_QUERIES: '0',
      MEMORY_DREAMING_CONFIDENCE_BOOST: '0',
      MEMORY_DREAMING_CONFIDENCE_DECAY: '0',
      MEMORY_EMBED_BATCH_SIZE: '0',
      MEMORY_VECTOR_DIMENSIONS: '0',
      MEMORY_MAX_CHUNKS_PER_GROUP: '0',
      MEMORY_CHUNK_RETENTION_DAYS: '0',
      MEMORY_MAX_EVENTS: '0',
      MEMORY_MAX_PROCEDURES_PER_GROUP: '0',
      MAX_MESSAGES_PER_PROMPT: '0',
      MAX_CONCURRENT_CONTAINERS: '0',
    });

    // All numeric configs should use their fallback defaults (clamped by Math.max)
    expect(cfg.MEMORY_CHUNK_SIZE).toBe(1400); // fallback 1400, Math.max(300, 1400)
    expect(cfg.MEMORY_CHUNK_OVERLAP).toBe(240);
    expect(cfg.MEMORY_RETRIEVAL_LIMIT).toBe(8);
    expect(cfg.MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS).toBe(45);
    expect(cfg.MEMORY_REFLECTION_MAX_FACTS_PER_TURN).toBe(6);
    expect(cfg.MEMORY_CONSOLIDATION_MAX_CLUSTERS).toBe(10);
    expect(cfg.MAX_MESSAGES_PER_PROMPT).toBe(10);
    expect(cfg.MAX_CONCURRENT_CONTAINERS).toBe(5);
    expect(cfg.MEMORY_EMBED_BATCH_SIZE).toBe(16);
    expect(cfg.MEMORY_VECTOR_DIMENSIONS).toBe(3072);
    expect(cfg.MEMORY_MAX_CHUNKS_PER_GROUP).toBe(6000);
    expect(cfg.MEMORY_CHUNK_RETENTION_DAYS).toBe(120);
    expect(cfg.MEMORY_MAX_EVENTS).toBe(20000);
    expect(cfg.MEMORY_MAX_PROCEDURES_PER_GROUP).toBe(500);
    expect(cfg.MEMORY_CONSOLIDATION_MIN_ITEMS).toBe(50);
    expect(cfg.MEMORY_ITEM_MAX_PER_GROUP).toBe(2000);
    expect(cfg.MEMORY_MAX_GLOBAL_CHUNKS).toBe(3000);
    expect(cfg.MEMORY_USAGE_DECAY_INTERVAL_TURNS).toBe(20);
    expect(cfg.MEMORY_DREAMING_MIN_RECALLS).toBe(3);
    expect(cfg.MEMORY_DREAMING_MIN_UNIQUE_QUERIES).toBe(2);
  });

  it('triggers fallback when parseFloat returns 0 (falsy) for float configs', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_RETRIEVAL_MIN_SCORE: '0',
      MEMORY_MMR_LAMBDA: '0',
      MEMORY_RRF_LEXICAL_WEIGHT: '0',
      MEMORY_RRF_VECTOR_WEIGHT: '0',
      MEMORY_REFLECTION_MIN_CONFIDENCE: '0',
      MEMORY_RETENTION_PIN_THRESHOLD: '0',
      MEMORY_SEMANTIC_DEDUP_THRESHOLD: '0',
      MEMORY_CONFIDENCE_BOOST_ON_USE: '0',
      MEMORY_CONFIDENCE_DECAY_ON_UNUSED: '0',
      MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD: '0',
      MEMORY_DREAMING_PROMOTION_THRESHOLD: '0',
      MEMORY_DREAMING_DECAY_THRESHOLD: '0',
      MEMORY_DREAMING_CONFIDENCE_BOOST: '0',
      MEMORY_DREAMING_CONFIDENCE_DECAY: '0',
    });

    // Float configs with 0 should trigger || fallback then Math.max/Math.min clamp
    expect(cfg.MEMORY_RETRIEVAL_MIN_SCORE).toBe(0.005);
    expect(cfg.MEMORY_MMR_LAMBDA).toBe(0.7);
    expect(cfg.MEMORY_RRF_LEXICAL_WEIGHT).toBe(1.0);
    expect(cfg.MEMORY_RRF_VECTOR_WEIGHT).toBe(1.0);
    expect(cfg.MEMORY_REFLECTION_MIN_CONFIDENCE).toBe(0.7);
    expect(cfg.MEMORY_RETENTION_PIN_THRESHOLD).toBe(0.92);
    expect(cfg.MEMORY_SEMANTIC_DEDUP_THRESHOLD).toBe(0.88);
    expect(cfg.MEMORY_CONFIDENCE_BOOST_ON_USE).toBe(0.02);
    expect(cfg.MEMORY_CONFIDENCE_DECAY_ON_UNUSED).toBe(0.01);
    expect(cfg.MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD).toBe(0.8);
    expect(cfg.MEMORY_DREAMING_PROMOTION_THRESHOLD).toBe(0.55);
    expect(cfg.MEMORY_DREAMING_DECAY_THRESHOLD).toBe(0.15);
    expect(cfg.MEMORY_DREAMING_CONFIDENCE_BOOST).toBe(0.05);
    expect(cfg.MEMORY_DREAMING_CONFIDENCE_DECAY).toBe(0.03);
  });
});

describe('resolveOptionalPath branches', () => {
  it('returns empty string when input is empty or whitespace', async () => {
    // When MEMORY_GLOBAL_KNOWLEDGE_DIR and AGENT_MEMORY_ROOT are both empty,
    // resolveOptionalPath gets '' which triggers the !trimmed early return
    const cfg = await loadConfigWithAllEnv({
      MEMORY_GLOBAL_KNOWLEDGE_DIR: undefined,
      AGENT_MEMORY_ROOT: undefined,
    });
    expect(cfg.MEMORY_GLOBAL_KNOWLEDGE_DIR).toBe('');
  });

  it('resolves relative path relative to PROJECT_ROOT', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_GLOBAL_KNOWLEDGE_DIR: 'relative/path',
    });
    // Should resolve relative to PROJECT_ROOT (process.cwd())
    expect(cfg.MEMORY_GLOBAL_KNOWLEDGE_DIR).toContain('relative/path');
    expect(cfg.MEMORY_GLOBAL_KNOWLEDGE_DIR).not.toBe('relative/path');
  });

  it('resolves AGENT_MEMORY_ROOT/knowledge fallback for MEMORY_GLOBAL_KNOWLEDGE_DIR', async () => {
    const cfg = await loadConfigWithAllEnv({
      MEMORY_GLOBAL_KNOWLEDGE_DIR: undefined,
      AGENT_MEMORY_ROOT: '/tmp/agent-root',
    });
    // Should fallback to AGENT_MEMORY_ROOT/knowledge
    expect(cfg.MEMORY_GLOBAL_KNOWLEDGE_DIR).toBe('/tmp/agent-root/knowledge');
  });
});

describe('HOME fallback', () => {
  it('uses os.homedir() when HOME is not set', async () => {
    const originalHome = process.env.HOME;
    delete process.env.HOME;
    vi.resetModules();
    vi.doMock('./env.js', () => ({
      readEnvFile: () => ({}),
    }));
    try {
      const cfg = await import('./config.js');
      // NANOCLAW_CONFIG_DIR should still be defined (using os.homedir())
      expect(typeof cfg.NANOCLAW_CONFIG_DIR).toBe('string');
      expect(cfg.NANOCLAW_CONFIG_DIR.length).toBeGreaterThan(0);
    } finally {
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      }
    }
  });
});

describe('resolveConfigTimezone fallback to UTC', () => {
  it('falls back to UTC when all timezone candidates are invalid', async () => {
    const originalTZ = process.env.TZ;
    // Set TZ to an invalid timezone
    process.env.TZ = 'Invalid/Timezone';

    vi.resetModules();
    vi.doMock('./env.js', () => ({
      readEnvFile: () => ({ TZ: 'Also/Invalid' }),
    }));
    // Mock isValidTimezone to return false for everything except 'UTC'
    vi.doMock('./timezone.js', () => ({
      isValidTimezone: (tz: string) => tz === 'UTC',
    }));

    try {
      const cfg = await import('./config.js');
      expect(cfg.TIMEZONE).toBe('UTC');
    } finally {
      vi.doUnmock('./timezone.js');
      if (originalTZ !== undefined) {
        process.env.TZ = originalTZ;
      } else {
        delete process.env.TZ;
      }
    }
  });
});
