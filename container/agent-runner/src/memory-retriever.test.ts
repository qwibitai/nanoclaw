import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } from './memory-retriever.js';
import type { RetrievalConfig, RetrievalResult } from './memory-retriever.js';
import type { MemoryStore, MemoryEntry, MemorySearchResult } from './memory-store.js';
import type { Embedder } from './memory-embedder.js';

// ============================================================================
// Test Helpers
// ============================================================================

const FIXED_NOW = new Date('2026-01-15T12:00:00Z').getTime();
const DAY_MS = 86_400_000;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? 'test-id',
    text: overrides.text ?? 'Test memory text here',
    vector: overrides.vector ?? [1, 0, 0],
    category: overrides.category ?? 'fact',
    scope: overrides.scope ?? 'global',
    importance: overrides.importance ?? 0.7,
    timestamp: overrides.timestamp ?? FIXED_NOW,
    metadata: overrides.metadata ?? '{}',
  };
}

function makeSearchResult(
  entry: Partial<MemoryEntry> = {},
  score = 0.8,
): MemorySearchResult {
  return { entry: makeEntry(entry), score };
}

/**
 * Minimal mock of the Embedder class.
 * Only the methods the retriever actually calls are mocked:
 * - embedQuery (used for query embedding)
 * The rest are stubs to satisfy the type.
 */
function mockEmbedder(dims = 3): Embedder {
  const vec = Array.from({ length: dims }, () => 0.5);
  return {
    embedQuery: vi.fn().mockResolvedValue(vec),
    embedPassage: vi.fn().mockResolvedValue(vec),
    embed: vi.fn().mockResolvedValue(vec),
    embedBatch: vi.fn().mockResolvedValue([vec]),
    embedBatchQuery: vi.fn().mockResolvedValue([vec]),
    embedBatchPassage: vi.fn().mockResolvedValue([vec]),
    dimensions: dims,
    model: 'test-model',
    keyCount: 1,
    cacheStats: { size: 0, hits: 0, misses: 0, hitRate: 'N/A', keyCount: 1 },
    test: vi.fn().mockResolvedValue({ success: true, dimensions: dims }),
  } as unknown as Embedder;
}

/**
 * Minimal mock of MemoryStore.
 * Only methods the retriever calls are mocked:
 * - vectorSearch, bm25Search, filterExistingIds
 * - hasFtsSupport, hasFtsIndex, canUseFts (read-only properties)
 */
function mockStore(
  vectorResults: MemorySearchResult[] = [],
  bm25Results: MemorySearchResult[] = [],
): MemoryStore {
  return {
    vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    bm25Search: vi.fn().mockResolvedValue(bm25Results),
    filterExistingIds: vi.fn().mockResolvedValue(new Set(bm25Results.map(r => r.entry.id))),
    hasFtsSupport: true,
    hasFtsIndex: true,
    canUseFts: true,
  } as unknown as MemoryStore;
}

/** Build a config with all time-dependent and optional stages disabled by default. */
function makeConfig(overrides: Partial<RetrievalConfig> = {}): RetrievalConfig {
  return {
    ...DEFAULT_RETRIEVAL_CONFIG,
    rerank: 'none',
    filterNoise: false,
    recencyHalfLifeDays: 0,
    recencyWeight: 0,
    timeDecayHalfLifeDays: 0,
    lengthNormAnchor: 0,
    hardMinScore: 0,
    ...overrides,
  };
}

/** Access private scoring methods for direct unit testing. */
function getPrivate(retriever: MemoryRetriever) {
  const r = retriever as any;
  return {
    applyRecencyBoost: r.applyRecencyBoost.bind(r) as (results: RetrievalResult[]) => RetrievalResult[],
    applyImportanceWeight: r.applyImportanceWeight.bind(r) as (results: RetrievalResult[]) => RetrievalResult[],
    applyTimeDecay: r.applyTimeDecay.bind(r) as (results: RetrievalResult[]) => RetrievalResult[],
    applyLengthNormalization: r.applyLengthNormalization.bind(r) as (results: RetrievalResult[]) => RetrievalResult[],
    applyMMRDiversity: r.applyMMRDiversity.bind(r) as (results: RetrievalResult[], threshold?: number) => RetrievalResult[],
  };
}

/** Build a RetrievalResult from a MemorySearchResult (adds required `sources` field). */
function toRetrievalResult(sr: MemorySearchResult): RetrievalResult {
  return {
    ...sr,
    sources: { vector: { score: sr.score, rank: 1 } },
  };
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ============================================================================
// Tests: Direct Scoring Functions (unit tests via private access)
// ============================================================================

describe('applyRecencyBoost (direct)', () => {
  it('adds exponentially decaying boost to recent entries', () => {
    const config = makeConfig({ recencyHalfLifeDays: 14, recencyWeight: 0.10 });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results = [
      toRetrievalResult(makeSearchResult({ id: 'now', timestamp: FIXED_NOW }, 0.5)),
      toRetrievalResult(makeSearchResult({ id: '7d', timestamp: FIXED_NOW - 7 * DAY_MS }, 0.5)),
      toRetrievalResult(makeSearchResult({ id: '14d', timestamp: FIXED_NOW - 14 * DAY_MS }, 0.5)),
      toRetrievalResult(makeSearchResult({ id: '28d', timestamp: FIXED_NOW - 28 * DAY_MS }, 0.5)),
    ];

    const boosted = fns.applyRecencyBoost(results);

    // All should be boosted above base score
    expect(boosted.every(r => r.score > 0.5)).toBe(true);

    // Ordered by recency (most recent = most boost)
    const scores = boosted.map(r => ({ id: r.entry.id, score: r.score }));
    const nowScore = scores.find(s => s.id === 'now')!.score;
    const d7Score = scores.find(s => s.id === '7d')!.score;
    const d14Score = scores.find(s => s.id === '14d')!.score;
    const d28Score = scores.find(s => s.id === '28d')!.score;

    expect(nowScore).toBeGreaterThan(d7Score);
    expect(d7Score).toBeGreaterThan(d14Score);
    expect(d14Score).toBeGreaterThan(d28Score);

    // Verify the actual formula: boost = exp(-ageDays / halfLife) * weight
    // At 0 days: boost = exp(0) * 0.10 = 0.10 → score = 0.5 + 0.10 = 0.60
    expect(nowScore).toBeCloseTo(0.60, 2);
    // At 14 days (= halfLife): boost = exp(-1) * 0.10 ≈ 0.0368 → score ≈ 0.5368
    expect(d14Score).toBeCloseTo(0.5 + Math.exp(-1) * 0.10, 2);
  });

  it('is a no-op when recencyHalfLifeDays is 0', () => {
    const config = makeConfig({ recencyHalfLifeDays: 0, recencyWeight: 0.10 });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results = [toRetrievalResult(makeSearchResult({ id: 'a' }, 0.7))];
    const boosted = fns.applyRecencyBoost(results);
    expect(boosted[0].score).toBe(0.7);
  });
});

describe('applyImportanceWeight (direct)', () => {
  it('scales score by importance factor', () => {
    const config = makeConfig();
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results = [
      toRetrievalResult(makeSearchResult({ id: 'high', importance: 1.0 }, 0.8)),
      toRetrievalResult(makeSearchResult({ id: 'mid', importance: 0.5 }, 0.8)),
      toRetrievalResult(makeSearchResult({ id: 'low', importance: 0.0 }, 0.8)),
    ];

    const weighted = fns.applyImportanceWeight(results);
    const highScore = weighted.find((r: RetrievalResult) => r.entry.id === 'high')!.score;
    const midScore = weighted.find((r: RetrievalResult) => r.entry.id === 'mid')!.score;
    const lowScore = weighted.find((r: RetrievalResult) => r.entry.id === 'low')!.score;

    // Formula: score *= (0.7 + 0.3 * importance)
    // importance=1.0 → factor=1.0, importance=0.5 → factor=0.85, importance=0.0 → factor=0.7
    expect(highScore).toBeCloseTo(0.8 * 1.0, 4);
    expect(midScore).toBeCloseTo(0.8 * 0.85, 4);
    expect(lowScore).toBeCloseTo(0.8 * 0.7, 4);
  });

  it('defaults to importance 0.7 when undefined', () => {
    const config = makeConfig();
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const entry = makeEntry({ importance: undefined as any });
    const results = [{ entry, score: 0.8, sources: { vector: { score: 0.8, rank: 1 } } } as RetrievalResult];
    const weighted = fns.applyImportanceWeight(results);
    // factor = 0.7 + 0.3 * 0.7 = 0.91
    expect(weighted[0].score).toBeCloseTo(0.8 * 0.91, 4);
  });
});

describe('applyTimeDecay (direct)', () => {
  it('applies multiplicative penalty with 0.5 floor', () => {
    const config = makeConfig({ timeDecayHalfLifeDays: 30 });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results = [
      toRetrievalResult(makeSearchResult({ id: 'fresh', timestamp: FIXED_NOW }, 0.8)),
      toRetrievalResult(makeSearchResult({ id: '30d', timestamp: FIXED_NOW - 30 * DAY_MS }, 0.8)),
      toRetrievalResult(makeSearchResult({ id: '365d', timestamp: FIXED_NOW - 365 * DAY_MS }, 0.8)),
    ];

    const decayed = fns.applyTimeDecay(results);
    const freshScore = decayed.find((r: RetrievalResult) => r.entry.id === 'fresh')!.score;
    const d30Score = decayed.find((r: RetrievalResult) => r.entry.id === '30d')!.score;
    const d365Score = decayed.find((r: RetrievalResult) => r.entry.id === '365d')!.score;

    // At 0 days: factor = 0.5 + 0.5 * exp(0) = 1.0 → no penalty
    expect(freshScore).toBeCloseTo(0.8, 4);
    // At 30 days (= halfLife): factor = 0.5 + 0.5 * exp(-1) ≈ 0.684
    expect(d30Score).toBeCloseTo(0.8 * (0.5 + 0.5 * Math.exp(-1)), 2);
    // At 365 days: factor approaches floor of 0.5
    expect(d365Score).toBeGreaterThanOrEqual(0.8 * 0.5 - 0.01);
    expect(d365Score).toBeLessThan(0.8 * 0.55);
  });

  it('is a no-op when timeDecayHalfLifeDays is 0', () => {
    const config = makeConfig({ timeDecayHalfLifeDays: 0 });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results = [
      toRetrievalResult(makeSearchResult({ id: 'old', timestamp: FIXED_NOW - 365 * DAY_MS }, 0.8)),
    ];
    const decayed = fns.applyTimeDecay(results);
    expect(decayed[0].score).toBe(0.8);
  });

  it('extends half-life for frequently accessed memories', () => {
    const config = makeConfig({
      timeDecayHalfLifeDays: 30,
      reinforcementFactor: 0.5,
      maxHalfLifeMultiplier: 3,
    });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const age = 30 * DAY_MS;
    const frequentMeta = JSON.stringify({ _accessCount: 20, _lastAccessedAt: FIXED_NOW - DAY_MS });
    const rareMeta = JSON.stringify({ _accessCount: 0 });

    const results = [
      toRetrievalResult(makeSearchResult({ id: 'frequent', timestamp: FIXED_NOW - age, metadata: frequentMeta }, 0.8)),
      toRetrievalResult(makeSearchResult({ id: 'rare', timestamp: FIXED_NOW - age, metadata: rareMeta }, 0.8)),
    ];

    const decayed = fns.applyTimeDecay(results);
    const freqScore = decayed.find((r: RetrievalResult) => r.entry.id === 'frequent')!.score;
    const rareScore = decayed.find((r: RetrievalResult) => r.entry.id === 'rare')!.score;
    expect(freqScore).toBeGreaterThan(rareScore);
  });
});

describe('applyLengthNormalization (direct)', () => {
  it('does not penalize entries shorter than anchor', () => {
    const config = makeConfig({ lengthNormAnchor: 500 });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results = [
      toRetrievalResult(makeSearchResult({ id: 'short', text: 'A short entry.' }, 0.8)),
    ];
    const normalized = fns.applyLengthNormalization(results);
    // 14 chars < 500 anchor → ratio < 1 → clamped to 1 → factor = 1.0
    expect(normalized[0].score).toBeCloseTo(0.8, 4);
  });

  it('penalizes entries longer than anchor', () => {
    const config = makeConfig({ lengthNormAnchor: 500 });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const longText = 'word '.repeat(1000); // 5000 chars
    const results = [
      toRetrievalResult(makeSearchResult({ id: 'long', text: longText }, 0.8)),
    ];
    const normalized = fns.applyLengthNormalization(results);
    // 5000/500 = 10 → log2(10) ≈ 3.32 → factor = 1/(1+0.5*3.32) ≈ 0.376
    const expectedFactor = 1 / (1 + 0.5 * Math.log2(10));
    expect(normalized[0].score).toBeCloseTo(0.8 * expectedFactor, 2);
  });

  it('is a no-op when anchor is 0', () => {
    const config = makeConfig({ lengthNormAnchor: 0 });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results = [
      toRetrievalResult(makeSearchResult({ id: 'a', text: 'x'.repeat(10000) }, 0.8)),
    ];
    const normalized = fns.applyLengthNormalization(results);
    expect(normalized[0].score).toBe(0.8);
  });
});

describe('applyMMRDiversity (direct)', () => {
  it('defers near-duplicate vectors to end of results', () => {
    const config = makeConfig();
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const vec = [1, 0, 0];
    const results: RetrievalResult[] = [
      toRetrievalResult(makeSearchResult({ id: 'a', vector: vec }, 0.9)),
      toRetrievalResult(makeSearchResult({ id: 'b', vector: vec }, 0.85)),   // duplicate of a
      toRetrievalResult(makeSearchResult({ id: 'c', vector: [0, 1, 0] }, 0.8)), // different
    ];

    const diverse = fns.applyMMRDiversity(results, 0.85);
    const ids = diverse.map((r: RetrievalResult) => r.entry.id);

    // a is selected first (highest score)
    // c is selected next (different vector)
    // b is deferred (duplicate of a)
    expect(ids).toEqual(['a', 'c', 'b']);
  });

  it('keeps all entries when vectors are diverse', () => {
    const config = makeConfig();
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results: RetrievalResult[] = [
      toRetrievalResult(makeSearchResult({ id: 'a', vector: [1, 0, 0] }, 0.9)),
      toRetrievalResult(makeSearchResult({ id: 'b', vector: [0, 1, 0] }, 0.85)),
      toRetrievalResult(makeSearchResult({ id: 'c', vector: [0, 0, 1] }, 0.8)),
    ];

    const diverse = fns.applyMMRDiversity(results, 0.85);
    const ids = diverse.map((r: RetrievalResult) => r.entry.id);
    // Original order preserved — none deferred
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('returns single-element arrays unchanged', () => {
    const config = makeConfig();
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    const fns = getPrivate(retriever);

    const results = [toRetrievalResult(makeSearchResult({ id: 'a' }, 0.9))];
    const diverse = fns.applyMMRDiversity(results, 0.85);
    expect(diverse).toHaveLength(1);
    expect(diverse[0].entry.id).toBe('a');
  });
});

// ============================================================================
// Tests: Pipeline Integration
// ============================================================================

describe('MemoryRetriever — vector-only pipeline', () => {
  it('returns results from vector search', async () => {
    const results = [
      makeSearchResult({ id: 'a', text: 'Memory A' }, 0.9),
      makeSearchResult({ id: 'b', text: 'Memory B' }, 0.7),
    ];
    const store = mockStore(results);
    const embedder = mockEmbedder();
    const retriever = new MemoryRetriever(store, embedder, makeConfig({ mode: 'vector' }));

    const out = await retriever.retrieve({ query: 'test', limit: 5 });
    expect(out.length).toBe(2);
    expect(embedder.embedQuery).toHaveBeenCalledWith('test');
  });

  it('filters by category', async () => {
    const results = [
      makeSearchResult({ id: 'a', category: 'fact' }, 0.9),
      makeSearchResult({ id: 'b', category: 'preference' }, 0.8),
    ];
    const store = mockStore(results);
    const retriever = new MemoryRetriever(store, mockEmbedder(), makeConfig({ mode: 'vector' }));

    const out = await retriever.retrieve({ query: 'test', limit: 5, category: 'fact' });
    expect(out.every(r => r.entry.category === 'fact')).toBe(true);
  });

  it('clamps limit to [1, 20]', async () => {
    const results = Array.from({ length: 25 }, (_, i) =>
      makeSearchResult({ id: `id-${i}`, text: `Memory ${i} text entry` }, 0.9 - i * 0.01),
    );
    const store = mockStore(results);
    const retriever = new MemoryRetriever(store, mockEmbedder(), makeConfig({ mode: 'vector' }));

    const out = await retriever.retrieve({ query: 'test', limit: 100 });
    expect(out.length).toBeLessThanOrEqual(20);

    const out2 = await retriever.retrieve({ query: 'test', limit: 0 });
    expect(out2.length).toBeGreaterThanOrEqual(1);
  });

  it('applies hardMinScore filter', async () => {
    const results = [
      makeSearchResult({ id: 'good', text: 'Good result text' }, 0.8),
      makeSearchResult({ id: 'bad', text: 'Bad result text here' }, 0.2),
    ];
    const store = mockStore(results);
    const config = makeConfig({ mode: 'vector', hardMinScore: 0.5 });
    const retriever = new MemoryRetriever(store, mockEmbedder(), config);

    const out = await retriever.retrieve({ query: 'test', limit: 5 });
    expect(out.every(r => r.score >= 0.5)).toBe(true);
    expect(out.find(r => r.entry.id === 'bad')).toBeUndefined();
  });

  it('returns empty array when all results are below minScore', async () => {
    const results = [
      makeSearchResult({ id: 'a', text: 'Low score entry' }, 0.1),
    ];
    const store = mockStore(results);
    const config = makeConfig({ mode: 'vector', hardMinScore: 0.5 });
    const retriever = new MemoryRetriever(store, mockEmbedder(), config);

    const out = await retriever.retrieve({ query: 'test', limit: 5 });
    expect(out).toEqual([]);
  });
});

// ============================================================================
// Tests: Hybrid Retrieval (Score Fusion)
// ============================================================================

describe('MemoryRetriever — hybrid mode (score fusion)', () => {
  it('boosts entries found by both vector and BM25', async () => {
    const vectorOnly = makeSearchResult({ id: 'v-only', text: 'Vector only result' }, 0.8);
    const both = makeSearchResult({ id: 'both', text: 'Found by both searches' }, 0.8);
    const bm25Both = makeSearchResult({ id: 'both', text: 'Found by both searches' }, 0.6);

    const store = mockStore([vectorOnly, both], [bm25Both]);
    const retriever = new MemoryRetriever(store, mockEmbedder(), makeConfig({ mode: 'hybrid' }));

    const out = await retriever.retrieve({ query: 'test', limit: 5 });
    const bothScore = out.find(r => r.entry.id === 'both')!.score;
    const vOnlyScore = out.find(r => r.entry.id === 'v-only')!.score;
    expect(bothScore).toBeGreaterThan(vOnlyScore);
  });

  it('includes BM25-only results', async () => {
    const vectorResult = makeSearchResult({ id: 'v1', text: 'Vector match entry' }, 0.8);
    const bm25Only = makeSearchResult({ id: 'bm25-only', text: 'Exact keyword match' }, 0.6);

    const store = mockStore([vectorResult], [bm25Only]);
    const retriever = new MemoryRetriever(store, mockEmbedder(), makeConfig({ mode: 'hybrid' }));

    const out = await retriever.retrieve({ query: 'test', limit: 5 });
    expect(out.find(r => r.entry.id === 'bm25-only')).toBeDefined();
  });

  it('filters ghost BM25 entries via filterExistingIds', async () => {
    const bm25Ghost = makeSearchResult({ id: 'ghost', text: 'Stale index entry text' }, 0.7);
    const store = mockStore([], [bm25Ghost]);
    // Ghost: filterExistingIds returns empty set
    (store.filterExistingIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Set());
    const retriever = new MemoryRetriever(store, mockEmbedder(), makeConfig({ mode: 'hybrid' }));

    const out = await retriever.retrieve({ query: 'test', limit: 5 });
    expect(out.find(r => r.entry.id === 'ghost')).toBeUndefined();
  });

  it('keeps BM25-only results when filterExistingIds throws (fail-open)', async () => {
    const bm25Result = makeSearchResult({ id: 'bm25', text: 'BM25 keyword match text' }, 0.6);
    const store = mockStore([], [bm25Result]);
    (store.filterExistingIds as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const retriever = new MemoryRetriever(store, mockEmbedder(), makeConfig({ mode: 'hybrid' }));

    const out = await retriever.retrieve({ query: 'test', limit: 5 });
    // Fail-open: result should still be present
    expect(out.find(r => r.entry.id === 'bm25')).toBeDefined();
  });
});

// ============================================================================
// Tests: Trace / Telemetry
// ============================================================================

describe('MemoryRetriever — trace and telemetry', () => {
  it('produces execution trace with pipeline stages', async () => {
    const results = [makeSearchResult({ id: 'a', text: 'Test result entry' }, 0.8)];
    const store = mockStore(results);
    const retriever = new MemoryRetriever(store, mockEmbedder(), makeConfig({ mode: 'vector' }));

    const { results: out, trace } = await retriever.retrieveWithTrace({
      query: 'test',
      limit: 5,
    });
    expect(out.length).toBe(1);
    expect(trace.query).toBe('test');
    expect(trace.stages.length).toBeGreaterThan(0);
    expect(trace.totalElapsedMs).toBeGreaterThanOrEqual(0);

    const stageNames = trace.stages.map(s => s.name);
    expect(stageNames).toContain('embed_query');
    expect(stageNames).toContain('vector_search');
  });

  it('accumulates telemetry across multiple calls', async () => {
    const store = mockStore([makeSearchResult({ text: 'Result text entry' }, 0.8)]);
    const retriever = new MemoryRetriever(store, mockEmbedder(), makeConfig({ mode: 'vector' }));

    await retriever.retrieve({ query: 'q1', limit: 5 });
    await retriever.retrieve({ query: 'q2', limit: 5 });

    const telemetry = retriever.getTelemetry();
    expect(telemetry.totalRequests).toBe(2);
    expect(telemetry.totalResults).toBeGreaterThanOrEqual(2);
  });

  it('tracks skipped requests', () => {
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), makeConfig());
    retriever.recordSkippedRequest('auto-recall', 'cooldown');
    retriever.recordSkippedRequest('auto-recall', 'cooldown');

    const telemetry = retriever.getTelemetry();
    expect(telemetry.skippedRequests).toBe(2);
    expect(telemetry.skipReasons['cooldown']).toBe(2);
  });
});

// ============================================================================
// Tests: Config Management
// ============================================================================

describe('MemoryRetriever — config', () => {
  it('can update config at runtime', () => {
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), makeConfig());
    retriever.updateConfig({ recencyWeight: 0.5 });
    expect(retriever.getConfig().recencyWeight).toBe(0.5);
  });

  it('preserves other config fields when updating', () => {
    const config = makeConfig({ mode: 'hybrid', minScore: 0.3 });
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), config);
    retriever.updateConfig({ recencyWeight: 0.5 });
    expect(retriever.getConfig().mode).toBe('hybrid');
    expect(retriever.getConfig().minScore).toBe(0.3);
  });

  it('returns a copy, not a reference', () => {
    const retriever = new MemoryRetriever(mockStore(), mockEmbedder(), makeConfig());
    const config1 = retriever.getConfig();
    const config2 = retriever.getConfig();
    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);
  });
});
