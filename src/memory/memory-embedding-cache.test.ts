import { afterEach, describe, expect, it, vi } from 'vitest';

import { CachedEmbeddingProvider } from './memory-embedding-cache.js';
import { EmbeddingProvider } from './memory-embeddings.js';

function makeInner(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider & { calls: number; embedManyCalls: number } {
  const tracker = {
    calls: 0,
    embedManyCalls: 0,
    isEnabled: () => true,
    validateConfiguration: () => undefined,
    embedOne: async (text: string) => {
      tracker.calls += 1;
      return [text.length];
    },
    embedMany: async (texts: string[]) => {
      tracker.embedManyCalls += 1;
      return texts.map((t) => [t.length]);
    },
    ...overrides,
  };
  return tracker;
}

function makeStore() {
  const cache = new Map<string, number[]>();
  return {
    cache,
    getCachedEmbedding: (textHash: string, model: string) =>
      cache.get(`${model}:${textHash}`) || null,
    putCachedEmbedding: (textHash: string, model: string, embedding: number[]) => {
      cache.set(`${model}:${textHash}`, embedding);
    },
  };
}

describe('CachedEmbeddingProvider', () => {
  it('caches single text embeddings', async () => {
    const inner = makeInner();
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    const first = await provider.embedOne('hello');
    const second = await provider.embedOne('hello');

    expect(first).toEqual([5]);
    expect(second).toEqual([5]);
    expect(inner.calls).toBe(1);
  });

  it('delegates isEnabled to inner provider', () => {
    const inner = makeInner({ isEnabled: () => false });
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    expect(provider.isEnabled()).toBe(false);
  });

  it('delegates validateConfiguration to inner provider', () => {
    const fn = vi.fn();
    const inner = makeInner({ validateConfiguration: fn });
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    provider.validateConfiguration();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('batches only cache misses and preserves order', async () => {
    const inner = makeInner();
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    const firstPass = await provider.embedMany(['alpha', 'beta', 'alpha']);
    expect(firstPass).toEqual([[5], [4], [5]]);
    expect(inner.embedManyCalls).toBe(1);

    const secondPass = await provider.embedMany(['alpha', 'beta']);
    expect(secondPass).toEqual([[5], [4]]);
    expect(inner.embedManyCalls).toBe(1);
  });

  it('returns empty array for empty input to embedMany', async () => {
    const inner = makeInner();
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    const result = await provider.embedMany([]);
    expect(result).toEqual([]);
    expect(inner.embedManyCalls).toBe(0);
  });

  it('deduplicates identical uncached texts in a single embedMany call', async () => {
    const inner = makeInner();
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    // Three identical uncached texts. The inner provider should only see one unique text.
    const result = await provider.embedMany(['dup', 'dup', 'dup']);
    expect(result).toEqual([[3], [3], [3]]);
    expect(inner.embedManyCalls).toBe(1);
  });

  it('throws when inner embedMany returns wrong number of vectors', async () => {
    const inner = makeInner({
      embedMany: async (_texts: string[]) => {
        // Return fewer embeddings than requested
        return [[1]];
      },
    });
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    await expect(
      provider.embedMany(['a', 'b', 'c']),
    ).rejects.toThrow(/returned 1 vectors for 3 uncached texts/);
  });

  it('throws when an embedding is missing (undefined) in the inner result', async () => {
    const inner = makeInner({
      embedMany: async (texts: string[]) => {
        // Return array with undefined entries (cast to bypass type check)
        return texts.map(() => undefined) as unknown as number[][];
      },
    });
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    await expect(
      provider.embedMany(['x']),
    ).rejects.toThrow(/missing embedding at index 0/);
  });

  it('enforces daily embed budget only on uncached API calls', async () => {
    const inner = makeInner();
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');
    await expect(
      provider.embedMany(
        Array.from({ length: 10_000 }, (_, index) => `value-${index}`),
      ),
    ).rejects.toThrow(/Daily embed budget exceeded/);
    expect(inner.embedManyCalls).toBe(0);
  });

  it('enforces daily embed budget for embedOne', async () => {
    // Module-level dailyApiCalls accumulates across tests.
    // Previous tests consumed 8 calls (1+2+1+3+1), limit is 500.
    // Fill the remaining budget so the next embedOne exceeds it.
    const inner = makeInner();
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    // 500 - 8 = 492 more calls to reach exactly 500
    await provider.embedMany(
      Array.from({ length: 492 }, (_, i) => `budget-fill-${i}`),
    );

    // Now dailyApiCalls === 500. embedOne adds 1 => 501 > 500, so budget exceeded.
    await expect(provider.embedOne('trigger-budget-exceeded')).rejects.toThrow(
      /Daily embed budget exceeded/,
    );
  });

  it('resets daily budget when the date changes', async () => {
    // At this point dailyApiCalls === 500, budget is exhausted for today.
    const inner = makeInner();
    const store = makeStore();
    const provider = new CachedEmbeddingProvider(inner, store, 'test-model');

    // Confirm budget is exhausted
    await expect(provider.embedOne('still-today')).rejects.toThrow(
      /Daily embed budget exceeded/,
    );

    // Simulate a new day by faking the system time to tomorrow
    vi.useFakeTimers();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    vi.setSystemTime(tomorrow);

    try {
      // Budget should be reset - this call should succeed
      const result = await provider.embedOne('after-date-reset');
      expect(result).toEqual([16]); // 'after-date-reset'.length === 16
    } finally {
      vi.useRealTimers();
    }
  });
});
