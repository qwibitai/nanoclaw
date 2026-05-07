import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerStoreResult } from './rrf.js';

function makeStore(
  storeId: string,
  facts: Array<{ id: string; content: string; createdAt?: string }>,
  failed = false,
): PerStoreResult {
  return { storeId, facts, failed };
}

// Helper to import rrf with a specific env var value via module isolation.
async function importRrfWithBoost(boostValue: string | undefined): Promise<typeof import('./rrf.js')> {
  if (boostValue !== undefined) {
    process.env.MEMORY_RECALL_RRF_RECENCY_BOOST = boostValue;
  } else {
    delete process.env.MEMORY_RECALL_RRF_RECENCY_BOOST;
  }
  vi.resetModules();
  return import('./rrf.js');
}

describe('mergeAndRerank', () => {
  let mergeAndRerank: (typeof import('./rrf.js'))['mergeAndRerank'];

  beforeEach(async () => {
    delete process.env.MEMORY_RECALL_RRF_RECENCY_BOOST;
    vi.resetModules();
    const mod = await import('./rrf.js');
    mergeAndRerank = mod.mergeAndRerank;
  });

  afterEach(() => {
    delete process.env.MEMORY_RECALL_RRF_RECENCY_BOOST;
    vi.resetModules();
  });

  it('test_rrf_basic', () => {
    const a = { id: 'factA', content: 'A' };
    const b = { id: 'factB', content: 'B' };
    const c = { id: 'factC', content: 'C' };

    const result = mergeAndRerank([makeStore('s1', [a, b]), makeStore('s2', [b, c])], 10);

    // factB ranks first: 1/61 + 1/62 ≈ 0.0325
    // factA second: 1/61 ≈ 0.0164
    // factC third: 1/62 ≈ 0.0161
    expect(result[0].id).toBe('factB');
    expect(result[1].id).toBe('factA');
    expect(result[2].id).toBe('factC');
    expect(result).toHaveLength(3);
  });

  it('test_dedupe_by_fact_id', () => {
    const x = { id: 'X', content: 'content X' };
    const y = { id: 'Y', content: 'content Y' };

    const result = mergeAndRerank([makeStore('s1', [x, y]), makeStore('s2', [y, x])], 10);

    const ids = result.map((f) => f.id);
    expect(ids.filter((id) => id === 'X')).toHaveLength(1);
    expect(ids.filter((id) => id === 'Y')).toHaveLength(1);
    expect(result).toHaveLength(2);
  });

  it('test_recency_boost_default', () => {
    const now = new Date().toISOString();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // Both facts at rank 0 in separate single-fact stores, so equal base RRF scores
    const result = mergeAndRerank(
      [
        makeStore('s1', [{ id: 'new-fact', content: 'new', createdAt: now }]),
        makeStore('s2', [{ id: 'old-fact', content: 'old', createdAt: ninetyDaysAgo }]),
      ],
      10,
    );

    const newFact = result.find((f) => f.id === 'new-fact')!;
    const oldFact = result.find((f) => f.id === 'old-fact')!;
    expect(newFact.score).toBeGreaterThan(oldFact.score);
    // With default boost=0.1: new ≈ 1.1x old (within 1%)
    const ratio = newFact.score / oldFact.score;
    expect(ratio).toBeGreaterThan(1.09);
    expect(ratio).toBeLessThan(1.11);
  });

  it('test_failed_store_excluded', () => {
    const a = { id: 'factA', content: 'A' };
    const b = { id: 'factB', content: 'B' };

    const result = mergeAndRerank(
      [
        makeStore('s1', [a], false),
        makeStore('s2', [b], true), // failed
      ],
      10,
    );

    expect(result.map((f) => f.id)).toContain('factA');
    expect(result.map((f) => f.id)).not.toContain('factB');
  });

  it('test_top_n_truncation', () => {
    const facts = Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, content: `content ${i}` }));

    const result = mergeAndRerank([makeStore('s1', facts)], 10);

    expect(result).toHaveLength(10);
    // Top 10 are ranks 0..9 from input (highest RRF scores)
    for (let i = 0; i < 10; i++) {
      expect(result[i].id).toBe(`f${i}`);
    }
  });

  it('test_empty_input_returns_empty', () => {
    expect(mergeAndRerank([], 10)).toEqual([]);
  });

  it('test_missing_created_at_no_multiplier', () => {
    const withDate = { id: 'dated', content: 'dated', createdAt: new Date().toISOString() };
    const withoutDate = { id: 'nodated', content: 'nodated' };

    const result = mergeAndRerank([makeStore('s1', [withDate]), makeStore('s2', [withoutDate])], 10);

    const dated = result.find((f) => f.id === 'dated')!;
    const nodated = result.find((f) => f.id === 'nodated')!;
    expect(dated.score).toBeGreaterThan(nodated.score);
  });
});

describe('MEMORY_RECALL_RRF_RECENCY_BOOST env var', () => {
  afterEach(() => {
    delete process.env.MEMORY_RECALL_RRF_RECENCY_BOOST;
    vi.resetModules();
  });

  it('test_recency_boost_disabled', async () => {
    const { mergeAndRerank: merge } = await importRrfWithBoost('0');

    const now = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const result = merge(
      [
        makeStore('s1', [{ id: 'new', content: 'new', createdAt: now }]),
        makeStore('s2', [{ id: 'old', content: 'old', createdAt: old }]),
      ],
      10,
    );

    const newFact = result.find((f) => f.id === 'new')!;
    const oldFact = result.find((f) => f.id === 'old')!;
    // With boost=0, both same base RRF score (rank 0 in each single-fact store = 1/61)
    expect(newFact.score).toBeCloseTo(oldFact.score, 5);
  });

  it('test_invalid_boost_throws_at_module_load', async () => {
    await expect(importRrfWithBoost('not-a-number')).rejects.toThrow('MEMORY_RECALL_RRF_RECENCY_BOOST');
  });

  it('test_out_of_range_boost_clamped_with_warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { mergeAndRerank: merge } = await importRrfWithBoost('2.0');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MEMORY_RECALL_RRF_RECENCY_BOOST'));

    // Clamped to 1.0 — module still works
    const result = merge([makeStore('s1', [{ id: 'f1', content: 'c' }])], 10);
    expect(result).toHaveLength(1);

    warnSpy.mockRestore();
  });
});
