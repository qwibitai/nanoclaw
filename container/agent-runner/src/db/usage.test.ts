import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import { recordUsage, type UsageRecord } from './usage.js';

beforeEach(() => {
  initTestSessionDb();
});

interface UsageRow {
  id: number;
  ts: string;
  sdk_session_id: string | null;
  model: string | null;
  num_turns: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number;
  result_subtype: string | null;
}

const SAMPLE: UsageRecord = {
  sdkSessionId: 'sdk-abc',
  model: 'claude-sonnet-4-6',
  numTurns: 3,
  durationMs: 1234,
  inputTokens: 100,
  outputTokens: 200,
  cacheCreationInputTokens: 50,
  cacheReadInputTokens: 25,
  totalCostUsd: 0.1234,
  resultSubtype: 'success',
};

function tableExists(name: string): boolean {
  const row = getOutboundDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

function rows(): UsageRow[] {
  return getOutboundDb().prepare('SELECT * FROM usage_log ORDER BY id').all() as UsageRow[];
}

describe('usage — recordUsage', () => {
  test('creates the table on first call', () => {
    expect(tableExists('usage_log')).toBe(false);
    recordUsage(SAMPLE);
    expect(tableExists('usage_log')).toBe(true);
  });

  test('inserts a row preserving every field', () => {
    recordUsage(SAMPLE);
    const all = rows();
    expect(all).toHaveLength(1);
    const r = all[0];
    expect(r.sdk_session_id).toBe('sdk-abc');
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.num_turns).toBe(3);
    expect(r.duration_ms).toBe(1234);
    expect(r.input_tokens).toBe(100);
    expect(r.output_tokens).toBe(200);
    expect(r.cache_creation_input_tokens).toBe(50);
    expect(r.cache_read_input_tokens).toBe(25);
    expect(r.total_cost_usd).toBeCloseTo(0.1234, 6);
    expect(r.result_subtype).toBe('success');
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('multiple calls append rows in order', () => {
    recordUsage({ ...SAMPLE, sdkSessionId: 'first', totalCostUsd: 0.01 });
    recordUsage({ ...SAMPLE, sdkSessionId: 'second', totalCostUsd: 0.02 });
    recordUsage({ ...SAMPLE, sdkSessionId: 'third', totalCostUsd: 0.03 });
    const all = rows();
    expect(all.map((r) => r.sdk_session_id)).toEqual(['first', 'second', 'third']);
  });

  test('handles null model and null sdk session id', () => {
    recordUsage({ ...SAMPLE, model: null, sdkSessionId: null });
    const r = rows()[0];
    expect(r.model).toBeNull();
    expect(r.sdk_session_id).toBeNull();
  });

  test('zero-cost / zero-token rows are written verbatim (e.g. error before tokens consumed)', () => {
    recordUsage({
      sdkSessionId: 'aborted',
      model: null,
      numTurns: 0,
      durationMs: 12,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
      resultSubtype: 'error_during_execution',
    });
    const r = rows()[0];
    expect(r.total_cost_usd).toBe(0);
    expect(r.input_tokens).toBe(0);
    expect(r.result_subtype).toBe('error_during_execution');
  });

  test('idempotent across fresh connections — no module-level cache leak', () => {
    // First connection: write a row.
    recordUsage(SAMPLE);
    expect(rows()).toHaveLength(1);

    // initTestSessionDb (via beforeEach in real runs) replaces the connection.
    // Simulate that here within a single test to lock in the invariant.
    initTestSessionDb();

    // Without the fix this would throw "no such table: usage_log" because a
    // cached "already ensured" flag would skip CREATE TABLE on the new conn.
    expect(() => recordUsage(SAMPLE)).not.toThrow();
    expect(rows()).toHaveLength(1);
  });

  test('idx_usage_log_ts index is created', () => {
    recordUsage(SAMPLE);
    const idx = getOutboundDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .get('idx_usage_log_ts') as { name?: string } | undefined;
    expect(idx?.name).toBe('idx_usage_log_ts');
  });
});
