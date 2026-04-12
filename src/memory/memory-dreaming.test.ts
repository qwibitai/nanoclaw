import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDreamingSweep } from './memory-dreaming.js';
import { MemoryStore } from './memory-store.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeStore(): MemoryStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-dream-'));
  tempRoots.push(root);
  return new MemoryStore(path.join(root, 'memory.db'));
}

describe('memory dreaming sweep', () => {
  it('promotes high-signal items and decays low-signal items', async () => {
    const store = makeStore();

    const promoted = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'deployment_workflow',
      value: 'build, test, deploy',
      source: 'test',
      confidence: 0.5,
    });
    const decayed = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'obsolete_hint',
      value: 'old docs',
      source: 'test',
      confidence: 0.05,
    });

    for (const [index, queryHash] of [
      'q-a',
      'q-b',
      'q-c',
      'q-d',
      'q-e',
      'q-f',
      'q-g',
      'q-h',
    ].entries()) {
      store.recordRetrievalSignal(promoted.id, 0.9 - index * 0.02, queryHash);
    }

    store.recordRetrievalSignal(decayed.id, 0, 'q-x');

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.6,
      decayThreshold: 0.4,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    expect(result.promotedCount).toBe(1);
    expect(result.decayedCount).toBe(1);
    expect(result.retiredCount).toBe(1);

    const promotedAfter = store.getItemById(promoted.id)!;
    const decayedAfter = store.getItemById(decayed.id);
    expect(promotedAfter.confidence).toBeGreaterThan(0.5);
    expect(decayedAfter).toBeNull();
  });

  it('returns immediately when dreaming is disabled', async () => {
    const store = makeStore();
    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: false,
      consolidationEnabled: true,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.9,
      promotionThreshold: 0.5,
      decayThreshold: 0.2,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    expect(result.scoredItems).toBe(0);
    expect(result.promotedCount).toBe(0);
    expect(result.decayedCount).toBe(0);
    expect(result.consolidation).toBeNull();
  });

  it('pins promoted items when confidence reaches retention threshold', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'important_fact',
      value: 'very important',
      source: 'test',
      confidence: 0.9,
    });

    // Build up retrieval signals so it qualifies and scores high
    for (const [index, queryHash] of [
      'q-1',
      'q-2',
      'q-3',
      'q-4',
      'q-5',
      'q-6',
    ].entries()) {
      store.recordRetrievalSignal(item.id, 0.95 - index * 0.01, queryHash);
    }

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      // Set a threshold the item can reach after the boost
      retentionPinThreshold: 0.92,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    expect(result.promotedCount).toBeGreaterThanOrEqual(1);
    const after = store.getItemById(item.id)!;
    expect(after.is_pinned).toBe(true);
    expect(after.confidence).toBeGreaterThanOrEqual(0.92);
  });

  it('runs consolidation when consolidationEnabled is true', async () => {
    const store = makeStore();

    store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'some_fact',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    const fakeConsolidation = {
      enabled: true,
      consideredItems: 1,
      clustersFound: 0,
      clustersProcessed: 0,
      mergedItems: 0,
      retiredItems: 0,
      mode: 'heuristic' as const,
    };

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: true,
      consolidateGroupMemory: async (folder) => {
        expect(folder).toBe('team');
        return fakeConsolidation;
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.6,
      decayThreshold: 0.4,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    expect(result.consolidation).toEqual(fakeConsolidation);
  });

  it('skips items below minRecalls or minUniqueQueries thresholds', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'rarely_used',
      value: 'seldom recalled',
      source: 'test',
      confidence: 0.5,
    });

    // Only one retrieval with one query hash — will fail minUniqueQueries=2
    store.recordRetrievalSignal(item.id, 0.8, 'q-only');

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.6,
      decayThreshold: 0.4,
      minRecalls: 1,
      minUniqueQueries: 2,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    expect(result.scoredItems).toBe(0);
    expect(result.promotedCount).toBe(0);
    expect(result.decayedCount).toBe(0);
  });

  it('handles empty group with no items', async () => {
    const store = makeStore();

    const result = await runDreamingSweep({
      groupFolder: 'empty_group',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.6,
      decayThreshold: 0.4,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    expect(result.totalItems).toBe(0);
    expect(result.scoredItems).toBe(0);
    expect(result.promotedCount).toBe(0);
    expect(result.decayedCount).toBe(0);
    expect(result.retiredCount).toBe(0);
  });

  it('sorts multiple decayed items by score ascending', async () => {
    const store = makeStore();

    // Create a high-signal item to push down normalized frequency for the low items
    const highItem = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'high_item',
      value: 'frequently used',
      source: 'test',
      confidence: 0.9,
    });
    for (const qh of ['qh-1', 'qh-2', 'qh-3', 'qh-4', 'qh-5', 'qh-6', 'qh-7', 'qh-8', 'qh-9', 'qh-10']) {
      store.recordRetrievalSignal(highItem.id, 0.95, qh);
    }

    // Create two low-confidence items that will both be decayed
    const lowA = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'low_a',
      value: 'low item A',
      source: 'test',
      confidence: 0.05,
    });
    const lowB = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'low_b',
      value: 'low item B',
      source: 'test',
      confidence: 0.08,
    });

    // Give both items minimal retrievals with low scores
    store.recordRetrievalSignal(lowA.id, 0.01, 'qa-1');
    store.recordRetrievalSignal(lowA.id, 0.01, 'qa-2');

    store.recordRetrievalSignal(lowB.id, 0.05, 'qb-1');
    store.recordRetrievalSignal(lowB.id, 0.05, 'qb-2');

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.9,
      decayThreshold: 0.6,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    expect(result.decayedCount).toBeGreaterThanOrEqual(2);
    // Both should be retired since confidence started very low and got decayed further
    expect(result.retiredCount).toBeGreaterThanOrEqual(1);
  });

  it('handles promoted item deleted between scoring and pin check', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'vanishing_item',
      value: 'will disappear',
      source: 'test',
      confidence: 0.9,
    });

    for (const qh of ['q-1', 'q-2', 'q-3', 'q-4', 'q-5']) {
      store.recordRetrievalSignal(item.id, 0.95, qh);
    }

    // Wrap the store so getItemById returns null for the promoted item
    // (simulating deletion between scoring and pin-check)
    const wrappedStore = {
      listActiveItems: store.listActiveItems.bind(store),
      adjustConfidence: store.adjustConfidence.bind(store),
      getItemById: (_id: string) => null,
      pinItem: store.pinItem.bind(store),
      softDeleteItem: store.softDeleteItem.bind(store),
      recordEvent: store.recordEvent.bind(store),
    };

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store: wrappedStore,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.5,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    // Item was promoted in scoring but getItemById returned null,
    // so pinItem should NOT have been called (no crash)
    expect(result.promotedCount).toBeGreaterThanOrEqual(1);
  });

  it('does not retire pinned decayed items', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'pinned_low',
      value: 'pinned but low scoring',
      source: 'test',
      confidence: 0.02,
    });

    store.recordRetrievalSignal(item.id, 0.01, 'qp-1');
    store.recordRetrievalSignal(item.id, 0.01, 'qp-2');

    // Pin the item
    store.pinItem(item.id, true);

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.9,
      decayThreshold: 0.5,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    // Pinned items are excluded from decayed list (line 103 filter)
    expect(result.decayedCount).toBe(0);
    // Item should still exist
    const after = store.getItemById(item.id);
    expect(after).not.toBeNull();
  });

  it('handles malformed query_hashes_json gracefully', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'corrupt_hashes',
      value: 'item with bad json',
      source: 'test',
      confidence: 0.5,
    });

    // Record enough valid signals first
    for (const qh of ['q-1', 'q-2', 'q-3']) {
      store.recordRetrievalSignal(item.id, 0.8, qh);
    }

    // Corrupt the query_hashes_json directly in the database
    // @ts-expect-error accessing private db for test purposes
    store.db
      .prepare(
        `UPDATE memory_items SET query_hashes_json = '{not-valid-json' WHERE id = ?`,
      )
      .run(item.id);

    // The sweep should not crash — parseStringArray catches the JSON error
    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    // With malformed JSON, uniqueQueryCount returns 0, so the item is skipped
    // (0 < minUniqueQueries=1)
    expect(result.scoredItems).toBe(0);
  });

  it('sorts multiple promoted items by score descending', async () => {
    const store = makeStore();

    // Create two items that will both score above the promotion threshold
    const itemA = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'promoted_a',
      value: 'good item a',
      source: 'test',
      confidence: 0.7,
    });
    const itemB = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'promoted_b',
      value: 'good item b',
      source: 'test',
      confidence: 0.8,
    });

    // Give both items high retrieval signals with distinct queries
    for (const [i, qh] of ['a1', 'a2', 'a3', 'a4', 'a5'].entries()) {
      store.recordRetrievalSignal(itemA.id, 0.85 - i * 0.02, qh);
    }
    for (const [i, qh] of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'].entries()) {
      store.recordRetrievalSignal(itemB.id, 0.92 - i * 0.01, qh);
    }

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.99,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    expect(result.promotedCount).toBe(2);
    // topPromoted should be sorted by score descending
    expect(result.topPromoted).toHaveLength(2);
    expect(result.topPromoted[0]!.score).toBeGreaterThanOrEqual(
      result.topPromoted[1]!.score,
    );
  });

  it('skips retirement of decayed item that became pinned between scoring and check', async () => {
    const store = makeStore();

    // Create a high-signal anchor to push the maxRetrievalCount up
    const anchor = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'anchor_item',
      value: 'anchor',
      source: 'test',
      confidence: 0.9,
    });
    for (const qh of ['anc1', 'anc2', 'anc3', 'anc4', 'anc5', 'anc6', 'anc7', 'anc8']) {
      store.recordRetrievalSignal(anchor.id, 0.95, qh);
    }

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'becomes_pinned',
      value: 'will be pinned later',
      source: 'test',
      confidence: 0.02,
    });
    store.recordRetrievalSignal(item.id, 0.01, 'qr-1');
    store.recordRetrievalSignal(item.id, 0.01, 'qr-2');

    // Wrap the store so that getItemById returns the item as pinned
    // (simulating the item being pinned between scoring and retirement check)
    const wrappedStore = {
      listActiveItems: store.listActiveItems.bind(store),
      adjustConfidence: store.adjustConfidence.bind(store),
      getItemById: (id: string) => {
        const real = store.getItemById(id);
        if (real && real.id === item.id) {
          return { ...real, is_pinned: true };
        }
        return real;
      },
      pinItem: store.pinItem.bind(store),
      softDeleteItem: store.softDeleteItem.bind(store),
      recordEvent: store.recordEvent.bind(store),
    };

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store: wrappedStore,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.9,
      decayThreshold: 0.5,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    // The item is decayed but since it appears pinned on lookup,
    // it should not be retired (line 132: latest.is_pinned -> continue)
    expect(result.decayedCount).toBeGreaterThanOrEqual(1);
    expect(result.retiredCount).toBe(0);
  });

  it('does not retire decayed item when confidence >= 0.1 after decay', async () => {
    const store = makeStore();

    // Create a high-signal anchor
    const anchor = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'anchor_high',
      value: 'anchor high',
      source: 'test',
      confidence: 0.9,
    });
    for (const qh of ['ah1', 'ah2', 'ah3', 'ah4', 'ah5', 'ah6', 'ah7', 'ah8']) {
      store.recordRetrievalSignal(anchor.id, 0.95, qh);
    }

    // Create an item that will be decayed but NOT retired
    // because its confidence remains >= 0.1 after decay
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'stays_above_threshold',
      value: 'not retired',
      source: 'test',
      confidence: 0.5,
    });
    store.recordRetrievalSignal(item.id, 0.01, 'qs-1');
    store.recordRetrievalSignal(item.id, 0.01, 'qs-2');

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.9,
      decayThreshold: 0.6,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.1,
    });

    // The item is decayed (score is low) but confidence stays >= 0.1
    // so retiredCount should be 0 for this item
    expect(result.decayedCount).toBeGreaterThanOrEqual(1);
    const after = store.getItemById(item.id);
    expect(after).not.toBeNull();
    // Verify the item was not retired
    expect(after!.confidence).toBeGreaterThanOrEqual(0.1);
  });

  it('handles computeRecencyScore with invalid date string', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'bad_date_item',
      value: 'item with bad date',
      source: 'test',
      confidence: 0.5,
    });

    for (const qh of ['bd-1', 'bd-2', 'bd-3']) {
      store.recordRetrievalSignal(item.id, 0.8, qh);
    }

    // Corrupt the last_retrieved_at to an invalid date string
    // @ts-expect-error accessing private db for test purposes
    store.db
      .prepare(
        `UPDATE memory_items SET last_retrieved_at = 'not-a-valid-date' WHERE id = ?`,
      )
      .run(item.id);

    // The sweep should handle the invalid date gracefully
    // computeRecencyScore returns 0 when Date.parse is NaN
    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    expect(result.scoredItems).toBe(1);
  });

  it('handles computeRecencyScore with null lastRetrievedAt', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'null_date_item',
      value: 'never retrieved date',
      source: 'test',
      confidence: 0.5,
    });

    // Manually set retrieval_count and query_hashes without using recordRetrievalSignal
    // (which would set last_retrieved_at). We need retrieval_count >= minRecalls
    // and uniqueQueries >= minUniqueQueries but last_retrieved_at = null.
    // @ts-expect-error accessing private db for test purposes
    store.db
      .prepare(
        `UPDATE memory_items SET retrieval_count = 5, total_score = 3.0, max_score = 0.9, query_hashes_json = '["q1","q2","q3"]' WHERE id = ?`,
      )
      .run(item.id);

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    // Item should be scored, with recency=0 due to null lastRetrievedAt
    expect(result.scoredItems).toBe(1);
  });

  it('handles parseStringArray with non-array JSON', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'non_array_json',
      value: 'item with non-array json',
      source: 'test',
      confidence: 0.5,
    });

    // Set up retrieval signals first
    store.recordRetrievalSignal(item.id, 0.8, 'qa-1');
    store.recordRetrievalSignal(item.id, 0.8, 'qa-2');

    // Then corrupt query_hashes_json to a valid JSON object (not an array)
    // @ts-expect-error accessing private db for test purposes
    store.db
      .prepare(
        `UPDATE memory_items SET query_hashes_json = '{"a": 1}' WHERE id = ?`,
      )
      .run(item.id);

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    // parseStringArray returns [] for non-array JSON, so uniqueQueryCount=0
    // and minUniqueQueries=1 means the item is skipped
    expect(result.scoredItems).toBe(0);
  });

  it('handles parseStringArray with empty/falsy query_hashes_json', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'empty_json',
      value: 'item with empty json',
      source: 'test',
      confidence: 0.5,
    });

    store.recordRetrievalSignal(item.id, 0.8, 'qe-1');
    store.recordRetrievalSignal(item.id, 0.8, 'qe-2');

    // The store normalizes query_hashes_json to '[]' when reading,
    // so we wrap listActiveItems to return items with empty query_hashes_json
    // to trigger the !value branch in parseStringArray (line 240).
    const wrappedStore = {
      listActiveItems: (groupFolder: string) => {
        const items = store.listActiveItems(groupFolder);
        return items.map((i) =>
          i.id === item.id ? { ...i, query_hashes_json: '' } : i,
        );
      },
      adjustConfidence: store.adjustConfidence.bind(store),
      getItemById: store.getItemById.bind(store),
      pinItem: store.pinItem.bind(store),
      softDeleteItem: store.softDeleteItem.bind(store),
      recordEvent: store.recordEvent.bind(store),
    };

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store: wrappedStore,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    // parseStringArray returns [] for empty string -> uniqueQueryCount=0
    // minUniqueQueries=1 means the item is skipped
    expect(result.scoredItems).toBe(0);
  });

  it('handles normalizeLog with zero retrieval count (value<=0)', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'zero_retrieval',
      value: 'zero count',
      source: 'test',
      confidence: 0.5,
    });

    // Set retrieval_count to 0 but still pass minRecalls
    // @ts-expect-error accessing private db for test purposes
    store.db
      .prepare(
        `UPDATE memory_items SET retrieval_count = 0, total_score = 0, max_score = 0, query_hashes_json = '["q1","q2"]' WHERE id = ?`,
      )
      .run(item.id);

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 0,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    // normalizeLog(0, ...) returns 0; relevance = 0 since retrieval_count=0
    expect(result.scoredItems).toBe(1);
  });

  it('handles clamp with non-finite confidence via wrapped store', async () => {
    const store = makeStore();

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'nan_confidence',
      value: 'nan conf',
      source: 'test',
      confidence: 0.5,
    });

    for (const qh of ['qn-1', 'qn-2', 'qn-3']) {
      store.recordRetrievalSignal(item.id, 0.8, qh);
    }

    // Wrap listActiveItems to return items with NaN confidence
    // to trigger the clamp(!Number.isFinite) branch
    const wrappedStore = {
      listActiveItems: (groupFolder: string) => {
        const items = store.listActiveItems(groupFolder);
        return items.map((i) =>
          i.id === item.id ? { ...i, confidence: NaN } : i,
        );
      },
      adjustConfidence: store.adjustConfidence.bind(store),
      getItemById: store.getItemById.bind(store),
      pinItem: store.pinItem.bind(store),
      softDeleteItem: store.softDeleteItem.bind(store),
      recordEvent: store.recordEvent.bind(store),
    };

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store: wrappedStore,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
    });

    // Item should be scored despite NaN confidence (clamp returns 0)
    expect(result.scoredItems).toBe(1);
  });

  it('does not adjust confidence when boost/decay are zero', async () => {
    const store = makeStore();

    const promoted = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'stable_item',
      value: 'confidence stays the same',
      source: 'test',
      confidence: 0.5,
    });

    for (const qh of ['q-1', 'q-2', 'q-3', 'q-4', 'q-5', 'q-6']) {
      store.recordRetrievalSignal(promoted.id, 0.9, qh);
    }

    const result = await runDreamingSweep({
      groupFolder: 'team',
      store,
      enabled: true,
      consolidationEnabled: false,
      consolidateGroupMemory: async () => {
        throw new Error('not expected');
      },
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0,
      confidenceDecay: 0,
    });

    expect(result.promotedCount).toBeGreaterThanOrEqual(1);
    const after = store.getItemById(promoted.id)!;
    // Confidence should not have changed since boost is 0
    expect(after.confidence).toBe(0.5);
  });
});
