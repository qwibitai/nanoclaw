import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordUsage, RecordUsageDeps } from './record-usage.js';
import type { UsageData } from './types.js';

describe('recordUsage', () => {
  // INVARIANT: recordUsage inserts one row per model when modelUsage has entries,
  // or a single aggregate row when zero or multiple models are present.
  // It also updates case cost/time when a caseId is provided.

  let deps: RecordUsageDeps;
  let insertedRecords: Array<Record<string, unknown>>;

  beforeEach(() => {
    insertedRecords = [];
    deps = {
      getGroupUsageCategory: vi.fn().mockReturnValue('default'),
      detectAuthMode: vi.fn().mockReturnValue('api-key'),
      insertUsageRecord: vi.fn((record) => insertedRecords.push(record)),
      addCaseCost: vi.fn(),
      addCaseTime: vi.fn(),
    };
  });

  function makeUsage(overrides: Partial<UsageData> = {}): UsageData {
    return {
      totalCostUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreateTokens: 100,
      durationMs: 3000,
      durationApiMs: 2500,
      numTurns: 2,
      modelUsage: {},
      ...overrides,
    };
  }

  it('inserts single model row when exactly one model in modelUsage', () => {
    const usage = makeUsage({
      modelUsage: {
        'claude-sonnet-4-20250514': {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
        },
      },
    });

    recordUsage(deps, usage, 'test-group', 'telegram');

    expect(deps.insertUsageRecord).toHaveBeenCalledTimes(1);
    const record = insertedRecords[0];
    expect(record.model).toBe('claude-sonnet-4-20250514');
    expect(record.input_tokens).toBe(1000);
    expect(record.output_tokens).toBe(500);
    expect(record.cache_read_tokens).toBe(200);
    expect(record.cache_create_tokens).toBe(100);
    expect(record.cost_usd).toBe(0.05);
  });

  it('inserts aggregate row when zero models in modelUsage', () => {
    const usage = makeUsage({ modelUsage: {} });

    recordUsage(deps, usage, 'test-group', 'telegram');

    expect(deps.insertUsageRecord).toHaveBeenCalledTimes(1);
    const record = insertedRecords[0];
    expect(record.model).toBeNull();
    expect(record.input_tokens).toBe(1000);
    expect(record.output_tokens).toBe(500);
  });

  it('inserts aggregate row when multiple models in modelUsage', () => {
    const usage = makeUsage({
      modelUsage: {
        'claude-sonnet-4-20250514': {
          inputTokens: 600,
          outputTokens: 300,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 50,
        },
        'claude-haiku-3-20240307': {
          inputTokens: 400,
          outputTokens: 200,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 50,
        },
      },
    });

    recordUsage(deps, usage, 'test-group', 'whatsapp');

    expect(deps.insertUsageRecord).toHaveBeenCalledTimes(1);
    const record = insertedRecords[0];
    // Multiple models joined
    expect(record.model).toContain('claude-sonnet');
    expect(record.model).toContain('claude-haiku');
    // Uses aggregate tokens from UsageData
    expect(record.input_tokens).toBe(1000);
  });

  it('passes groupFolder, category, source, and authMode to the record', () => {
    (deps.getGroupUsageCategory as ReturnType<typeof vi.fn>).mockReturnValue(
      'premium',
    );
    (deps.detectAuthMode as ReturnType<typeof vi.fn>).mockReturnValue('oauth');
    const usage = makeUsage({ modelUsage: {} });

    recordUsage(deps, usage, 'my-group', 'slack');

    const record = insertedRecords[0];
    expect(record.group_folder).toBe('my-group');
    expect(record.category).toBe('premium');
    expect(record.source).toBe('slack');
    expect(record.auth_mode).toBe('oauth');
  });

  it('passes sessionId and caseId when provided', () => {
    const usage = makeUsage({ modelUsage: {} });

    recordUsage(deps, usage, 'g', 'tg', 'sess-123', 'case-456');

    const record = insertedRecords[0];
    expect(record.session_id).toBe('sess-123');
    expect(record.case_id).toBe('case-456');
  });

  it('defaults sessionId and caseId to null when not provided', () => {
    const usage = makeUsage({ modelUsage: {} });

    recordUsage(deps, usage, 'g', 'tg');

    const record = insertedRecords[0];
    expect(record.session_id).toBeNull();
    expect(record.case_id).toBeNull();
  });

  it('updates case cost when caseId is provided and cost > 0', () => {
    const usage = makeUsage({ totalCostUsd: 0.12, modelUsage: {} });

    recordUsage(deps, usage, 'g', 'tg', undefined, 'case-1');

    expect(deps.addCaseCost).toHaveBeenCalledWith('case-1', 0.12);
  });

  it('does not update case cost when cost is 0', () => {
    const usage = makeUsage({ totalCostUsd: 0, modelUsage: {} });

    recordUsage(deps, usage, 'g', 'tg', undefined, 'case-1');

    expect(deps.addCaseCost).not.toHaveBeenCalled();
  });

  it('updates case time when caseId is provided and durationMs > 0', () => {
    const usage = makeUsage({ durationMs: 5000, modelUsage: {} });

    recordUsage(deps, usage, 'g', 'tg', undefined, 'case-1');

    expect(deps.addCaseTime).toHaveBeenCalledWith('case-1', 5000);
  });

  it('does not update case time when durationMs is undefined', () => {
    const usage = makeUsage({ durationMs: undefined, modelUsage: {} });

    recordUsage(deps, usage, 'g', 'tg', undefined, 'case-1');

    expect(deps.addCaseTime).not.toHaveBeenCalled();
  });

  it('does not update case cost/time when no caseId', () => {
    const usage = makeUsage({
      totalCostUsd: 1.0,
      durationMs: 10000,
      modelUsage: {},
    });

    recordUsage(deps, usage, 'g', 'tg');

    expect(deps.addCaseCost).not.toHaveBeenCalled();
    expect(deps.addCaseTime).not.toHaveBeenCalled();
  });

  it('handles optional duration fields as null', () => {
    const usage = makeUsage({
      durationMs: undefined,
      durationApiMs: undefined,
      numTurns: undefined,
      modelUsage: {},
    });

    recordUsage(deps, usage, 'g', 'tg');

    const record = insertedRecords[0];
    expect(record.duration_ms).toBeNull();
    expect(record.duration_api_ms).toBeNull();
    expect(record.num_turns).toBeNull();
  });
});
