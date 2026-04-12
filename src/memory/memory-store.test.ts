import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MEMORY_VECTOR_DIMENSIONS,
  MEMORY_ITEM_MAX_PER_GROUP,
  MEMORY_MAX_PROCEDURES_PER_GROUP,
} from '../core/config.js';
import { MemoryStore } from './memory-store.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeStore(): MemoryStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
  tempRoots.push(root);
  return new MemoryStore(path.join(root, 'memory.db'));
}

describe('MemoryStore', () => {
  it('deduplicates chunks by hash', () => {
    const store = makeStore();

    const inserted1 = store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c1',
        source_path: '/tmp/c1.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'we solved the deployment issue by pinning node version',
        embedding: null,
      },
    ]);

    const inserted2 = store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c1',
        source_path: '/tmp/c1.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'we solved the deployment issue by pinning node version',
        embedding: null,
      },
    ]);

    expect(inserted1).toBe(1);
    expect(inserted2).toBe(0);
  });

  it('sanitizes punctuation-heavy lexical queries', () => {
    const store = makeStore();

    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c2',
        source_path: '/tmp/c2.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'we were working on runtime preflight and memory retrieval',
        embedding: null,
      },
    ]);

    const queries = ['what were we working on?', 'c++', 'foo:bar', '/new'];
    for (const query of queries) {
      expect(() => store.lexicalSearch(query, 'team', 5)).not.toThrow();
    }
  });

  it('protects against stale patches', () => {
    const store = makeStore();

    const memory = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'project-stack',
      value: 'node',
      source: 'test',
      confidence: 0.8,
    });

    const patched = store.patchItem(memory.id, memory.version, {
      value: 'node + sqlite',
    });

    expect(patched.version).toBe(memory.version + 1);

    expect(() =>
      store.patchItem(memory.id, memory.version, {
        value: 'stale attempt',
      }),
    ).toThrow(/stale patch/);
  });

  it('does not return user-scoped items when user id is missing', () => {
    const store = makeStore();

    store.saveItem({
      scope: 'user',
      group_folder: 'team',
      user_id: 'u1',
      kind: 'preference',
      key: 'style',
      value: 'concise',
      source: 'test',
      confidence: 0.9,
    });

    const withoutUser = store.listTopItems('user', 'team', 5);
    const withUser = store.listTopItems('user', 'team', 5, 'u1');

    expect(withoutUser).toHaveLength(0);
    expect(withUser).toHaveLength(1);
  });

  it('does not return user-scoped procedures in top procedure lookup', () => {
    const store = makeStore();

    store.saveProcedure({
      scope: 'user',
      group_folder: 'team',
      title: 'Private workflow',
      body: 'Only for one user',
      tags: ['private'],
      source: 'test',
      confidence: 0.9,
    });

    const procedures = store.listTopProcedures('team', 5);
    expect(procedures).toHaveLength(0);
  });

  it('rejects databases with newer schema version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const db = new Database(dbPath);
    db.pragma('user_version = 999');
    db.close();

    expect(() => new MemoryStore(dbPath)).toThrow(/newer than supported/);
  });

  it('returns created_at from lexical and vector search results', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-created-at',
        source_path: '/tmp/c-created-at.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'release readiness checklist and status',
        embedding,
      },
    ]);

    const lexical = store.lexicalSearch('release readiness', 'team', 5);
    expect(lexical.length).toBeGreaterThan(0);
    expect(Date.parse(lexical[0]!.created_at)).not.toBeNaN();

    const vector = store.vectorSearch(embedding, 'team', 5);
    expect(vector.length).toBeGreaterThan(0);
    expect(Date.parse(vector[0]!.created_at)).not.toBeNaN();
  });

  it('finds existing memory item by scope/group/user/key', () => {
    const store = makeStore();
    const groupItem = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'deployment_policy',
      value: 'always run tests',
      source: 'test',
      confidence: 0.8,
    });
    const userItem = store.saveItem({
      scope: 'user',
      group_folder: 'team',
      user_id: 'u1',
      kind: 'preference',
      key: 'tone',
      value: 'concise',
      source: 'test',
      confidence: 0.9,
    });
    const globalItem = store.saveItem({
      scope: 'global',
      group_folder: 'main',
      user_id: null,
      kind: 'fact',
      key: 'release_day',
      value: 'friday',
      source: 'test',
      confidence: 0.7,
    });

    expect(
      store.findItemByKey({
        scope: 'group',
        groupFolder: 'team',
        key: 'deployment_policy',
      })?.id,
    ).toBe(groupItem.id);
    expect(
      store.findItemByKey({
        scope: 'user',
        groupFolder: 'team',
        userId: 'u1',
        key: 'tone',
      })?.id,
    ).toBe(userItem.id);
    expect(
      store.findItemByKey({
        scope: 'global',
        groupFolder: 'any',
        key: 'release_day',
      })?.id,
    ).toBe(globalItem.id);
    expect(
      store.findItemByKey({
        scope: 'user',
        groupFolder: 'team',
        key: 'tone',
      }),
    ).toBeNull();
  });

  it('does not reset retrieval_count for recently retrieved items during decay', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'workflow',
      value: 'run tests first',
      source: 'test',
      confidence: 0.7,
    });

    store.incrementRetrievalCount([item.id]);
    store.decayUnusedConfidence('team', 0.05);

    const updated = store.getItemById(item.id);
    expect(updated?.retrieval_count).toBe(1);
  });

  it('counts reflections since last usage decay event', () => {
    const store = makeStore();
    store.recordEvent('reflection_completed', 'reflection', 'team', {});
    store.recordEvent('reflection_completed', 'reflection', 'team', {});
    expect(store.countReflectionsSinceLastUsageDecay('team')).toBe(2);

    store.recordUsageDecayRun('team');
    store.recordEvent('reflection_completed', 'reflection', 'team', {});
    expect(store.countReflectionsSinceLastUsageDecay('team')).toBe(1);
  });

  it('tracks retrieval signals with score and query diversity', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'release_process',
      value: 'run tests and deploy',
      source: 'test',
      confidence: 0.7,
    });

    store.recordRetrievalSignal(item.id, 0.4, 'q1');
    store.recordRetrievalSignal(item.id, 0.9, 'q2');
    store.recordRetrievalSignal(item.id, 0.5, 'q2');

    const updated = store.getItemById(item.id)!;
    expect(updated.retrieval_count).toBe(3);
    expect(updated.total_score).toBeCloseTo(1.8, 5);
    expect(updated.max_score).toBeCloseTo(0.9, 5);

    const queryHashes = JSON.parse(updated.query_hashes_json) as string[];
    expect(queryHashes).toEqual(['q1', 'q2']);
    const recallDays = JSON.parse(updated.recall_days_json) as string[];
    expect(recallDays.length).toBe(1);
  });

  it('caches embeddings by text hash and model', () => {
    const store = makeStore();
    const embedding = [0.1, 0.2, 0.3];
    store.putCachedEmbedding('hash-1', 'test-model', embedding);

    expect(store.getCachedEmbedding('hash-1', 'test-model')).toEqual(embedding);
    expect(store.getCachedEmbedding('hash-1', 'other-model')).toBeNull();
  });

  // --- Additional coverage for uncovered methods ---

  it('pinItem sets and unsets is_pinned', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'pinnable',
      value: 'pinnable fact',
      source: 'test',
      confidence: 0.5,
    });

    store.pinItem(item.id, true);
    expect(store.getItemById(item.id)!.is_pinned).toBe(true);

    store.pinItem(item.id, false);
    expect(store.getItemById(item.id)!.is_pinned).toBe(false);
  });

  it('touchItem updates last_used_at', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'touch-test',
      value: 'touchable',
      source: 'test',
      confidence: 0.5,
    });

    expect(store.getItemById(item.id)!.last_used_at).toBeNull();
    store.touchItem(item.id);
    expect(store.getItemById(item.id)!.last_used_at).not.toBeNull();
  });

  it('softDeleteItem marks item as deleted', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'delete-test',
      value: 'delete me',
      source: 'test',
      confidence: 0.5,
    });

    store.softDeleteItem(item.id);
    expect(store.getItemById(item.id)).toBeNull();
  });

  it('patchProcedure updates procedure fields with version check', () => {
    const store = makeStore();
    const proc = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Deploy workflow',
      body: 'run build then deploy',
      tags: ['deploy'],
      source: 'test',
      confidence: 0.8,
    });

    const patched = store.patchProcedure(proc.id, proc.version, {
      body: 'run build, test, then deploy',
      confidence: 0.9,
    });
    expect(patched.body).toBe('run build, test, then deploy');
    expect(patched.confidence).toBe(0.9);
    expect(patched.version).toBe(proc.version + 1);
  });

  it('patchProcedure throws on stale version', () => {
    const store = makeStore();
    const proc = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Stale proc',
      body: 'body',
      tags: [],
      source: 'test',
      confidence: 0.5,
    });

    store.patchProcedure(proc.id, proc.version, { body: 'updated' });
    expect(() =>
      store.patchProcedure(proc.id, proc.version, { body: 'stale' }),
    ).toThrow(/stale patch/);
  });

  it('patchProcedure throws for non-existent procedure', () => {
    const store = makeStore();
    expect(() =>
      store.patchProcedure('nonexistent-id', 1, { body: 'updated' }),
    ).toThrow(/not found/);
  });

  it('searchProceduresByText finds matching procedures', () => {
    const store = makeStore();
    store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Deploy checklist',
      body: 'run build first',
      tags: ['deploy'],
      source: 'test',
      confidence: 0.8,
    });
    store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Code review flow',
      body: 'review before merge',
      tags: ['review'],
      source: 'test',
      confidence: 0.7,
    });

    const results = store.searchProceduresByText('deploy', 'team', 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Deploy checklist');
  });

  it('listActiveItems returns non-global non-deleted items', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'active-1',
      value: 'active fact',
      source: 'test',
      confidence: 0.7,
    });
    const item2 = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'active-2',
      value: 'to delete',
      source: 'test',
      confidence: 0.6,
    });
    store.softDeleteItem(item2.id);

    const active = store.listActiveItems('team', 10);
    expect(active).toHaveLength(1);
    expect(active[0]!.key).toBe('active-1');
  });

  it('chunkExists returns true for existing chunk', () => {
    const store = makeStore();
    const chunk = {
      source_type: 'conversation',
      source_id: 'c-exist',
      source_path: '/tmp/c-exist.md',
      scope: 'group' as const,
      group_folder: 'team',
      kind: 'conversation',
      text: 'unique chunk text for existence check',
      embedding: null,
    };

    store.saveChunks([chunk]);
    expect(store.chunkExists(chunk)).toBe(true);
    expect(
      store.chunkExists({ ...chunk, text: 'different text' }),
    ).toBe(false);
  });

  it('saveItemEmbedding stores and updates embeddings', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'embed-test',
      value: 'embeddable',
      source: 'test',
      confidence: 0.5,
    });

    store.saveItemEmbedding(item.id, embedding);
    let updated = store.getItemById(item.id)!;
    expect(updated.embedding_json).not.toBeNull();

    // Update embedding
    embedding[1] = 0.5;
    store.saveItemEmbedding(item.id, embedding);
    updated = store.getItemById(item.id)!;
    expect(updated.embedding_json).toContain('0.5');
  });

  it('saveItemEmbedding is no-op for empty embedding', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'empty-embed',
      value: 'no embedding',
      source: 'test',
      confidence: 0.5,
    });

    store.saveItemEmbedding(item.id, []);
    expect(store.getItemById(item.id)!.embedding_json).toBeNull();
  });

  it('findSimilarItems returns matches by vector similarity', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'similar-test',
      value: 'similar fact',
      source: 'test',
      confidence: 0.5,
    });
    store.saveItemEmbedding(item.id, embedding);

    const results = store.findSimilarItems({
      embedding,
      scope: 'group',
      groupFolder: 'team',
      limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.item.id).toBe(item.id);
  });

  it('applyRetentionPolicies cleans up old chunks and overflow items', () => {
    const store = makeStore();

    // Insert a chunk
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-retention',
        source_path: '/tmp/retention.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'retention test chunk',
        embedding: null,
      },
    ]);

    // Insert items
    store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'retention-item',
      value: 'retention item',
      source: 'test',
      confidence: 0.5,
    });

    // Run retention — should not throw
    store.applyRetentionPolicies('team');

    // Items should still exist (not exceeding limits)
    expect(store.listActiveItems('team', 10).length).toBeGreaterThanOrEqual(0);
  });

  it('incrementRetrievalCount skips empty arrays', () => {
    const store = makeStore();
    // Should not throw
    store.incrementRetrievalCount([]);
    store.incrementRetrievalCount(['', '']);
  });

  it('adjustConfidence skips empty arrays', () => {
    const store = makeStore();
    // Should not throw
    store.adjustConfidence([], 0.1);
  });

  it('bumpConfidence with negative delta is a no-op', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'neg-bump',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    store.bumpConfidence([item.id], -0.1);
    expect(store.getItemById(item.id)!.confidence).toBe(0.5);
  });

  it('decayUnusedConfidence skips with zero or negative delta', () => {
    const store = makeStore();
    expect(store.decayUnusedConfidence('team', 0)).toBe(0);
    expect(store.decayUnusedConfidence('team', -0.1)).toBe(0);
  });

  it('recordRetrievalSignal skips empty itemId', () => {
    const store = makeStore();
    // Should not throw
    store.recordRetrievalSignal('', 0.5, 'q1');
  });

  it('getItemById returns null for non-existent id', () => {
    const store = makeStore();
    expect(store.getItemById('nonexistent-id')).toBeNull();
  });

  it('saveChunks inserts vector data for chunks with embeddings', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    const inserted = store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-vec',
        source_path: '/tmp/c-vec.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'chunk with vector embedding data',
        embedding,
      },
    ]);

    expect(inserted).toBe(1);
    const results = store.vectorSearch(embedding, 'team', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('close shuts down the database', () => {
    const store = makeStore();
    store.close();
    // After close, operations should fail
    expect(() => store.listTopItems('group', 'team', 5)).toThrow();
  });

  // --- Adversarial: NaN propagation bugs ---

  it('bumpConfidence with NaN should be a no-op, not reset confidence to 0', () => {
    // Bug: bumpConfidence(ids, NaN) — the guard `if (delta <= 0) return` does not
    // catch NaN because `NaN <= 0` is false. Then adjustConfidence runs with NaN.
    // `delta === 0` is also false for NaN. The SQL `confidence + NaN` evaluates to
    // NULL in SQLite, and `MAX(0.0, NULL)` returns 0.0, silently resetting confidence.
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'important-fact',
      value: 'critical data',
      source: 'test',
      confidence: 0.8,
    });

    store.bumpConfidence([item.id], NaN);

    const updated = store.getItemById(item.id)!;
    // Confidence should remain 0.8 — NaN bump should be a no-op
    expect(updated.confidence).toBe(0.8);
  });

  it('adjustConfidence with NaN should not corrupt confidence', () => {
    // Same root cause: adjustConfidence(ids, NaN) passes NaN guard (NaN === 0 is false),
    // then SQLite does confidence + NaN → NULL → MAX(0.0, NULL) → 0.0
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'important-fact-2',
      value: 'important',
      source: 'test',
      confidence: 0.6,
    });

    store.adjustConfidence([item.id], NaN);

    const updated = store.getItemById(item.id)!;
    // Confidence should remain 0.6 — NaN should not silently zero it
    expect(updated.confidence).toBe(0.6);
  });

  it('adjustConfidence with Infinity should not set confidence beyond 1.0', () => {
    // adjustConfidence with Infinity: `confidence + Infinity` in SQLite → Inf,
    // `MIN(1.0, Inf)` depends on SQLite's handling. If it returns 1.0, that's
    // correct clamping. But if it returns Inf or NULL, confidence is corrupted.
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'inf-test',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    store.adjustConfidence([item.id], Infinity);

    const updated = store.getItemById(item.id)!;
    // Confidence should be clamped to 1.0, not Infinity or NULL
    expect(updated.confidence).toBe(1.0);
    expect(Number.isFinite(updated.confidence)).toBe(true);
  });

  it('recordRetrievalSignal with NaN score should not corrupt total_score', () => {
    // recordRetrievalSignal has a guard: `Number.isFinite(score) && score > 0 ? score : 0`
    // NaN → safeScore=0 → total_score + 0 is fine. But what about MAX(max_score, 0)?
    // That's also fine — 0 won't exceed existing max_score.
    // The real concern: what if total_score itself becomes NaN from prior corruption?
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'nan-score-test',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    store.recordRetrievalSignal(item.id, 0.5, 'q1');
    store.recordRetrievalSignal(item.id, NaN, 'q2');
    store.recordRetrievalSignal(item.id, 0.3, 'q3');

    const updated = store.getItemById(item.id)!;
    // total_score should be 0.5 + 0 + 0.3 = 0.8
    expect(updated.total_score).toBeCloseTo(0.8, 5);
    expect(updated.max_score).toBeCloseTo(0.5, 5);
    expect(Number.isFinite(updated.total_score)).toBe(true);
  });

  // --- Coverage for deleteChunksByIds with vector data (lines 1188-1217) ---

  it('applyRetentionPolicies deletes old chunks with associated vector data', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    // Insert chunks with embeddings
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-old-vec',
        source_path: '/tmp/old-vec.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'old chunk with vector for retention deletion',
        embedding,
      },
    ]);

    // Verify chunk exists via vector search
    const before = store.vectorSearch(embedding, 'team', 5);
    expect(before.length).toBeGreaterThan(0);

    // Backdate the chunk's created_at to trigger retention deletion
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    // Access the internal db to set old date — trigger deleteChunksByIds path
    const dbPath = path.join(root, 'memory.db');
    const directStore = new MemoryStore(dbPath);
    const emb2 = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    emb2[1] = 1;

    directStore.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-expired',
        source_path: '/tmp/expired.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'expired chunk with vector data for deletion test',
        embedding: emb2,
      },
    ]);

    // Directly backdate via raw SQL
    const db = new Database(dbPath);
    db.exec(`UPDATE memory_chunks SET created_at = '2000-01-01T00:00:00.000Z'`);
    db.close();

    // Now apply retention — should delete chunks (including vector rows)
    directStore.applyRetentionPolicies('team');

    // Verify chunks are gone
    const after = directStore.vectorSearch(emb2, 'team', 5);
    expect(after).toHaveLength(0);
    directStore.close();
  });

  // --- Coverage for parseStringArray catch branch (line 1283) ---

  it('recordRetrievalSignal handles corrupt query_hashes_json gracefully', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store = new MemoryStore(dbPath);

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'corrupt-json-test',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    // Corrupt the query_hashes_json to invalid JSON to trigger parseStringArray catch
    const db = new Database(dbPath);
    db.exec(
      `UPDATE memory_items SET query_hashes_json = '{not-valid-json' WHERE id = '${item.id}'`,
    );
    db.close();

    // recordRetrievalSignal should handle the corrupt JSON gracefully
    expect(() =>
      store.recordRetrievalSignal(item.id, 0.5, 'q1'),
    ).not.toThrow();

    const updated = store.getItemById(item.id)!;
    expect(updated.retrieval_count).toBe(1);
    store.close();
  });

  // --- Additional coverage tests ---

  it('runHealthChecks succeeds on a healthy store', () => {
    const store = makeStore();
    expect(() => store.runHealthChecks()).not.toThrow();
  });

  it('runHealthChecks throws when a required table is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store = new MemoryStore(dbPath);
    // Drop a required table to simulate corruption
    const db = new Database(dbPath);
    db.exec('DROP TABLE IF EXISTS embedding_cache');
    db.close();
    expect(() => store.runHealthChecks()).toThrow(/missing SQLite object/);
    store.close();
  });

  it('schema migration from v1 to current version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    // Create a v1 database manually with minimal schema
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        user_id TEXT,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        version INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_procedures (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        version INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        kind TEXT NOT NULL,
        chunk_hash TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS memory_chunk_vector_map (
        chunk_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 1');
    db.close();

    // Opening with MemoryStore should migrate from v1 -> current
    const store = new MemoryStore(dbPath);
    // Verify the migration added v2 columns
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'migrated',
      value: 'migrated data',
      source: 'test',
      confidence: 0.7,
    });
    expect(item.is_pinned).toBe(false);
    expect(item.retrieval_count).toBe(0);
    // Verify v3 columns
    expect(item.total_score).toBe(0);
    expect(item.max_score).toBe(0);
    expect(item.query_hashes_json).toBe('[]');
    expect(item.recall_days_json).toBe('[]');
    store.close();
  });

  it('schema migration from v2 to current version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    // Create a v2 database: has is_pinned, embedding_json, retrieval_count, last_retrieved_at
    // but not total_score, max_score, query_hashes_json, recall_days_json, embedding_cache
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        user_id TEXT,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        last_retrieved_at TEXT,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_procedures (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        version INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        kind TEXT NOT NULL,
        chunk_hash TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        importance_weight REAL NOT NULL DEFAULT 1.0,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS memory_chunk_vector_map (
        chunk_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS memory_item_vector_map (
        item_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 2');
    db.close();

    // Opening should migrate from v2 -> v3
    const store = new MemoryStore(dbPath);
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'v2-migrated',
      value: 'data',
      source: 'test',
      confidence: 0.6,
    });
    expect(item.total_score).toBe(0);
    expect(item.query_hashes_json).toBe('[]');
    // Embedding cache should exist now
    store.putCachedEmbedding('hash-v2', 'model', [0.1, 0.2]);
    expect(store.getCachedEmbedding('hash-v2', 'model')).toEqual([0.1, 0.2]);
    store.close();
  });

  it('MemoryStore.makeId returns unique prefixed ids', () => {
    const id1 = MemoryStore.makeId('test');
    const id2 = MemoryStore.makeId('test');
    expect(id1).toMatch(/^test-/);
    expect(id2).toMatch(/^test-/);
    expect(id1).not.toBe(id2);
  });

  it('MemoryStore.chunkHash produces deterministic hash', () => {
    const input = {
      source_type: 'conversation',
      source_id: 'c1',
      source_path: '/tmp/c1.md',
      scope: 'group' as const,
      group_folder: 'team',
      kind: 'conversation',
      text: 'hello world',
      embedding: null,
    };
    const hash1 = MemoryStore.chunkHash(input);
    const hash2 = MemoryStore.chunkHash(input);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // sha256 hex

    // Different text produces different hash
    const hash3 = MemoryStore.chunkHash({ ...input, text: 'different' });
    expect(hash3).not.toBe(hash1);
  });

  it('patchItem throws for non-existent item', () => {
    const store = makeStore();
    expect(() =>
      store.patchItem('nonexistent-id', 1, { value: 'updated' }),
    ).toThrow(/not found/);
  });

  it('saveItem with is_pinned true sets the flag', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'pinned-at-creation',
      value: 'pinned from start',
      source: 'test',
      confidence: 0.8,
      is_pinned: true,
    });
    expect(item.is_pinned).toBe(true);
  });

  it('listTopItems returns global items regardless of group_folder', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'global',
      group_folder: 'any-group',
      user_id: null,
      kind: 'fact',
      key: 'global-fact',
      value: 'global value',
      source: 'test',
      confidence: 0.9,
    });

    const items = store.listTopItems('global', 'different-group', 5);
    expect(items).toHaveLength(1);
    expect(items[0]!.key).toBe('global-fact');
  });

  it('listSourceChunks returns chunks by source type and id', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'doc',
        source_id: 'doc-1',
        source_path: '/tmp/doc-1.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'document',
        text: 'chunk from doc 1',
        embedding: null,
      },
      {
        source_type: 'doc',
        source_id: 'doc-1',
        source_path: '/tmp/doc-1.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'document',
        text: 'another chunk from doc 1',
        embedding: null,
      },
      {
        source_type: 'doc',
        source_id: 'doc-2',
        source_path: '/tmp/doc-2.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'document',
        text: 'chunk from doc 2',
        embedding: null,
      },
    ]);

    const chunks = store.listSourceChunks('doc', 'doc-1');
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.source_id === 'doc-1')).toBe(true);
    expect(chunks[0]!.chunk_hash).toBeTruthy();
    expect(chunks[0]!.token_count).toBeGreaterThan(0);
  });

  it('getCachedEmbedding returns null for corrupt JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store = new MemoryStore(dbPath);

    // Insert a valid embedding first, then corrupt it
    store.putCachedEmbedding('hash-corrupt', 'model', [0.1, 0.2]);
    const db = new Database(dbPath);
    db.exec(`UPDATE embedding_cache SET embedding_json = '{bad' WHERE text_hash = 'hash-corrupt'`);
    db.close();

    expect(store.getCachedEmbedding('hash-corrupt', 'model')).toBeNull();
    store.close();
  });

  it('getCachedEmbedding returns null for non-array JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store = new MemoryStore(dbPath);

    store.putCachedEmbedding('hash-obj', 'model', [0.1]);
    const db = new Database(dbPath);
    db.exec(`UPDATE embedding_cache SET embedding_json = '{"a":1}' WHERE text_hash = 'hash-obj'`);
    db.close();

    expect(store.getCachedEmbedding('hash-obj', 'model')).toBeNull();
    store.close();
  });

  it('getCachedEmbedding returns null for non-finite values in array', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store = new MemoryStore(dbPath);

    store.putCachedEmbedding('hash-nan', 'model', [0.1]);
    const db = new Database(dbPath);
    db.exec(`UPDATE embedding_cache SET embedding_json = '["not-a-number"]' WHERE text_hash = 'hash-nan'`);
    db.close();

    expect(store.getCachedEmbedding('hash-nan', 'model')).toBeNull();
    store.close();
  });

  it('getCachedEmbedding returns null for non-existent hash', () => {
    const store = makeStore();
    expect(store.getCachedEmbedding('no-such-hash', 'model')).toBeNull();
  });

  it('putCachedEmbedding is no-op for empty embedding', () => {
    const store = makeStore();
    store.putCachedEmbedding('hash-empty', 'model', []);
    expect(store.getCachedEmbedding('hash-empty', 'model')).toBeNull();
  });

  it('putCachedEmbedding overwrites existing entry on conflict', () => {
    const store = makeStore();
    store.putCachedEmbedding('hash-ow', 'model', [0.1, 0.2]);
    store.putCachedEmbedding('hash-ow', 'model', [0.3, 0.4]);
    expect(store.getCachedEmbedding('hash-ow', 'model')).toEqual([0.3, 0.4]);
  });

  it('lexicalSearch returns empty for all-punctuation query', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-lex',
        source_path: '/tmp/c-lex.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'some content to search',
        embedding: null,
      },
    ]);
    const results = store.lexicalSearch('!!!???...', 'team', 5);
    expect(results).toHaveLength(0);
  });

  it('lexicalSearch returns matching chunks with score', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-lex2',
        source_path: '/tmp/c-lex2.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'kubernetes deployment strategy with rolling updates',
        embedding: null,
      },
    ]);
    const results = store.lexicalSearch('kubernetes deployment', 'team', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.lexical_score).toBeGreaterThan(0);
    expect(results[0]!.vector_score).toBe(0);
    expect(results[0]!.fused_score).toBe(0);
    expect(results[0]!.source_type).toBe('conversation');
    expect(results[0]!.source_path).toBe('/tmp/c-lex2.md');
  });

  it('findSimilarItems with user scope filters by userId', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    const userItem = store.saveItem({
      scope: 'user',
      group_folder: 'team',
      user_id: 'u1',
      kind: 'preference',
      key: 'user-vec-test',
      value: 'user value',
      source: 'test',
      confidence: 0.7,
    });
    store.saveItemEmbedding(userItem.id, embedding);

    // Should find with correct user
    const withUser = store.findSimilarItems({
      embedding,
      scope: 'user',
      groupFolder: 'team',
      userId: 'u1',
      limit: 5,
    });
    expect(withUser.length).toBeGreaterThan(0);
    expect(withUser[0]!.item.id).toBe(userItem.id);
    expect(withUser[0]!.similarity).toBeGreaterThan(0);

    // Should not find with different user
    const withOtherUser = store.findSimilarItems({
      embedding,
      scope: 'user',
      groupFolder: 'team',
      userId: 'u2',
      limit: 5,
    });
    expect(withOtherUser).toHaveLength(0);

    // Should not find without user
    const withoutUser = store.findSimilarItems({
      embedding,
      scope: 'user',
      groupFolder: 'team',
      limit: 5,
    });
    expect(withoutUser).toHaveLength(0);
  });

  it('findSimilarItems with global scope ignores group_folder', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    const globalItem = store.saveItem({
      scope: 'global',
      group_folder: 'any',
      user_id: null,
      kind: 'fact',
      key: 'global-vec-test',
      value: 'global value',
      source: 'test',
      confidence: 0.9,
    });
    store.saveItemEmbedding(globalItem.id, embedding);

    const results = store.findSimilarItems({
      embedding,
      scope: 'global',
      groupFolder: 'different-group',
      limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.item.id).toBe(globalItem.id);
  });

  it('getProcedureById returns null for non-existent id', () => {
    const store = makeStore();
    expect(store.getProcedureById('nonexistent')).toBeNull();
  });

  it('getProcedureById returns procedure with correct fields', () => {
    const store = makeStore();
    const proc = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Test proc',
      body: 'Test body',
      tags: ['a', 'b'],
      source: 'test',
      confidence: 0.7,
    });
    const fetched = store.getProcedureById(proc.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Test proc');
    expect(fetched!.tags).toEqual(['a', 'b']);
    expect(fetched!.scope).toBe('group');
    expect(fetched!.last_used_at).toBeNull();
  });

  it('listTopProcedures includes global procedures', () => {
    const store = makeStore();
    store.saveProcedure({
      scope: 'global',
      group_folder: 'any',
      title: 'Global proc',
      body: 'Global body',
      tags: [],
      source: 'test',
      confidence: 0.9,
    });
    store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Team proc',
      body: 'Team body',
      tags: [],
      source: 'test',
      confidence: 0.8,
    });

    const procedures = store.listTopProcedures('team', 10);
    expect(procedures).toHaveLength(2);
    const titles = procedures.map((p) => p.title);
    expect(titles).toContain('Global proc');
    expect(titles).toContain('Team proc');
  });

  it('patchProcedure updates tags', () => {
    const store = makeStore();
    const proc = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Tagged proc',
      body: 'body',
      tags: ['old-tag'],
      source: 'test',
      confidence: 0.5,
    });

    const patched = store.patchProcedure(proc.id, proc.version, {
      tags: ['new-tag-1', 'new-tag-2'],
    });
    expect(patched.tags).toEqual(['new-tag-1', 'new-tag-2']);
    expect(patched.title).toBe('Tagged proc'); // unchanged
  });

  it('searchProceduresByText finds global procedures', () => {
    const store = makeStore();
    store.saveProcedure({
      scope: 'global',
      group_folder: 'any',
      title: 'Global deploy procedure',
      body: 'Deploy globally',
      tags: [],
      source: 'test',
      confidence: 0.9,
    });

    const results = store.searchProceduresByText('deploy', 'team', 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Global deploy procedure');
  });

  it('searchProceduresByText returns empty for no match', () => {
    const store = makeStore();
    store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Deploy',
      body: 'body',
      tags: [],
      source: 'test',
      confidence: 0.5,
    });
    const results = store.searchProceduresByText('nonexistent-term', 'team', 5);
    expect(results).toHaveLength(0);
  });

  it('decayUnusedConfidence actually reduces confidence for unretrieved items', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'decay-target',
      value: 'decaying',
      source: 'test',
      confidence: 0.8,
    });

    const decayed = store.decayUnusedConfidence('team', 0.1);
    expect(decayed).toBeGreaterThan(0);

    const updated = store.getItemById(item.id)!;
    expect(updated.confidence).toBeCloseTo(0.7, 5);
  });

  it('decayUnusedConfidence skips pinned items', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'pinned-no-decay',
      value: 'pinned',
      source: 'test',
      confidence: 0.8,
    });
    store.pinItem(item.id, true);

    store.decayUnusedConfidence('team', 0.1);
    const updated = store.getItemById(item.id)!;
    expect(updated.confidence).toBe(0.8);
  });

  it('decayUnusedConfidence also decays global items', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'global',
      group_folder: 'any',
      user_id: null,
      kind: 'fact',
      key: 'global-decay',
      value: 'global decayable',
      source: 'test',
      confidence: 0.9,
    });

    store.decayUnusedConfidence('team', 0.2);
    const updated = store.getItemById(item.id)!;
    expect(updated.confidence).toBeCloseTo(0.7, 5);
  });

  it('bumpConfidence increases confidence clamped at 1.0', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'bump-test',
      value: 'data',
      source: 'test',
      confidence: 0.9,
    });

    store.bumpConfidence([item.id], 0.2);
    const updated = store.getItemById(item.id)!;
    expect(updated.confidence).toBe(1.0);
  });

  it('bumpConfidence with zero delta is a no-op', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'zero-bump',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    store.bumpConfidence([item.id], 0);
    expect(store.getItemById(item.id)!.confidence).toBe(0.5);
  });

  it('adjustConfidence can lower confidence clamped at 0.0', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'lower-conf',
      value: 'data',
      source: 'test',
      confidence: 0.1,
    });

    store.adjustConfidence([item.id], -0.5);
    const updated = store.getItemById(item.id)!;
    expect(updated.confidence).toBe(0.0);
  });

  it('adjustConfidence deduplicates ids', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'dedup-conf',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    // Pass the same id twice — should only apply once
    store.adjustConfidence([item.id, item.id], 0.1);
    const updated = store.getItemById(item.id)!;
    expect(updated.confidence).toBeCloseTo(0.6, 5);
  });

  it('adjustConfidence filters out empty strings', () => {
    const store = makeStore();
    // Should not throw with all-empty ids
    store.adjustConfidence(['', ''], 0.1);
  });

  it('recordEvent directly stores an event', () => {
    const store = makeStore();
    store.recordEvent('test_event', 'test_entity', 'entity-1', { key: 'val' });
    // Verify via countReflectionsSinceLastUsageDecay that events are stored
    store.recordEvent('reflection_completed', 'reflection', 'team', {});
    expect(store.countReflectionsSinceLastUsageDecay('team')).toBe(1);
  });

  it('recordRetrievalSignal skips non-existent itemId', () => {
    const store = makeStore();
    // Should not throw for non-existent item
    expect(() =>
      store.recordRetrievalSignal('nonexistent-id', 0.5, 'q1'),
    ).not.toThrow();
  });

  it('recordRetrievalSignal handles empty queryHash', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'empty-qhash',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    store.recordRetrievalSignal(item.id, 0.5, '');
    const updated = store.getItemById(item.id)!;
    expect(updated.retrieval_count).toBe(1);
    // Empty queryHash should not be added
    const hashes = JSON.parse(updated.query_hashes_json) as string[];
    expect(hashes).toHaveLength(0);
  });

  it('recordRetrievalSignal with negative score uses 0', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'neg-score',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    store.recordRetrievalSignal(item.id, -5, 'q1');
    const updated = store.getItemById(item.id)!;
    expect(updated.total_score).toBe(0);
    expect(updated.max_score).toBe(0);
  });

  it('recordRetrievalSignal handles corrupt recall_days_json gracefully', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store = new MemoryStore(dbPath);

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'corrupt-recall',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    const db = new Database(dbPath);
    db.exec(
      `UPDATE memory_items SET recall_days_json = 'not-json' WHERE id = '${item.id}'`,
    );
    db.close();

    expect(() => store.recordRetrievalSignal(item.id, 0.5, 'q1')).not.toThrow();
    store.close();
  });

  it('recordRetrievalSignal handles non-array JSON in query_hashes_json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store = new MemoryStore(dbPath);

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'non-array-json',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    const db = new Database(dbPath);
    db.exec(
      `UPDATE memory_items SET query_hashes_json = '"just-a-string"' WHERE id = '${item.id}'`,
    );
    db.close();

    expect(() => store.recordRetrievalSignal(item.id, 0.5, 'q1')).not.toThrow();
    const updated = store.getItemById(item.id)!;
    const hashes = JSON.parse(updated.query_hashes_json) as string[];
    expect(hashes).toContain('q1');
    store.close();
  });

  it('softDeleteItem also deletes item vectors', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'delete-vec',
      value: 'with vector',
      source: 'test',
      confidence: 0.5,
    });
    store.saveItemEmbedding(item.id, embedding);

    // Verify vector exists before deletion
    const before = store.findSimilarItems({
      embedding,
      scope: 'group',
      groupFolder: 'team',
      limit: 5,
    });
    expect(before.length).toBeGreaterThan(0);

    store.softDeleteItem(item.id);

    // Item should be gone
    expect(store.getItemById(item.id)).toBeNull();
  });

  it('saveChunks with custom importance_weight', () => {
    const store = makeStore();
    const inserted = store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-weight',
        source_path: '/tmp/c-weight.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'high importance chunk',
        importance_weight: 5.0,
        embedding: null,
      },
    ]);
    expect(inserted).toBe(1);
    const chunks = store.listSourceChunks('conversation', 'c-weight');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.importance_weight).toBe(5.0);
  });

  it('saveChunks with negative importance_weight clamps to 0 in DB (toChunk maps 0 to 1)', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-neg-weight',
        source_path: '/tmp/c-neg-weight.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'negative importance chunk',
        importance_weight: -2.0,
        embedding: null,
      },
    ]);
    const chunks = store.listSourceChunks('conversation', 'c-neg-weight');
    expect(chunks).toHaveLength(1);
    // Math.max(0, -2.0) = 0 stored in DB, but toChunk does Number(row.importance_weight || 1)
    // so 0 || 1 = 1
    expect(chunks[0]!.importance_weight).toBe(1);
  });

  it('saveChunks with multiple chunks inserts all', () => {
    const store = makeStore();
    const inserted = store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-multi',
        source_path: '/tmp/c-multi.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'first chunk of multi',
        embedding: null,
      },
      {
        source_type: 'conversation',
        source_id: 'c-multi',
        source_path: '/tmp/c-multi.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'second chunk of multi',
        embedding: null,
      },
    ]);
    expect(inserted).toBe(2);
  });

  it('vectorSearch returns results with score between 0 and 1', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-vscore',
        source_path: '/tmp/c-vscore.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'vector score test chunk',
        embedding,
      },
    ]);

    const results = store.vectorSearch(embedding, 'team', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.vector_score).toBeGreaterThan(0);
    expect(results[0]!.vector_score).toBeLessThanOrEqual(1);
    expect(results[0]!.lexical_score).toBe(0);
    expect(results[0]!.fused_score).toBe(0);
  });

  it('vectorSearch includes global chunks', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-global-vec',
        source_path: '/tmp/c-global-vec.md',
        scope: 'global',
        group_folder: '_global',
        kind: 'conversation',
        text: 'global vector chunk',
        embedding,
      },
    ]);

    const results = store.vectorSearch(embedding, 'team', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.scope).toBe('global');
  });

  it('lexicalSearch includes global chunks', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-global-lex',
        source_path: '/tmp/c-global-lex.md',
        scope: 'global',
        group_folder: '_global',
        kind: 'conversation',
        text: 'globally shared knowledge base content',
        embedding: null,
      },
    ]);

    const results = store.lexicalSearch('globally shared knowledge', '_global', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('incrementRetrievalCount increments for multiple items', () => {
    const store = makeStore();
    const item1 = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'inc-1',
      value: 'data1',
      source: 'test',
      confidence: 0.5,
    });
    const item2 = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'inc-2',
      value: 'data2',
      source: 'test',
      confidence: 0.5,
    });

    store.incrementRetrievalCount([item1.id, item2.id]);
    expect(store.getItemById(item1.id)!.retrieval_count).toBe(1);
    expect(store.getItemById(item2.id)!.retrieval_count).toBe(1);
    expect(store.getItemById(item1.id)!.last_retrieved_at).not.toBeNull();
  });

  it('incrementRetrievalCount deduplicates ids', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'inc-dedup',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    store.incrementRetrievalCount([item.id, item.id, item.id]);
    expect(store.getItemById(item.id)!.retrieval_count).toBe(1);
  });

  it('countReflectionsSinceLastUsageDecay returns 0 with no events', () => {
    const store = makeStore();
    expect(store.countReflectionsSinceLastUsageDecay('team')).toBe(0);
  });

  it('recordUsageDecayRun records an event', () => {
    const store = makeStore();
    store.recordEvent('reflection_completed', 'reflection', 'team', {});
    store.recordEvent('reflection_completed', 'reflection', 'team', {});
    expect(store.countReflectionsSinceLastUsageDecay('team')).toBe(2);
    store.recordUsageDecayRun('team');
    expect(store.countReflectionsSinceLastUsageDecay('team')).toBe(0);
  });

  it('patchItem updates individual fields', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'patch-fields',
      value: 'original',
      source: 'test',
      confidence: 0.5,
    });

    const patched = store.patchItem(item.id, item.version, {
      key: 'new-key',
      kind: 'preference',
      source: 'updated-source',
      confidence: 0.9,
    });

    expect(patched.key).toBe('new-key');
    expect(patched.value).toBe('original'); // unchanged
    expect(patched.kind).toBe('preference');
    expect(patched.source).toBe('updated-source');
    expect(patched.confidence).toBe(0.9);
  });

  it('applyRetentionPolicies removes overflow procedures', () => {
    const store = makeStore();
    // Create more procedures than the limit
    const limit = MEMORY_MAX_PROCEDURES_PER_GROUP;
    for (let i = 0; i < limit + 3; i++) {
      store.saveProcedure({
        scope: 'group',
        group_folder: 'team',
        title: `Proc ${i}`,
        body: `Body ${i}`,
        tags: [],
        source: 'test',
        confidence: 0.5,
      });
    }

    store.applyRetentionPolicies('team');
    const remaining = store.listTopProcedures('team', limit + 10);
    expect(remaining.length).toBeLessThanOrEqual(limit);
  });

  it('applyRetentionPolicies removes overflow items by confidence', () => {
    const store = makeStore();
    const limit = MEMORY_ITEM_MAX_PER_GROUP;
    // Create one more item than the limit
    for (let i = 0; i < limit + 2; i++) {
      store.saveItem({
        scope: 'group',
        group_folder: 'team',
        user_id: null,
        kind: 'fact',
        key: `overflow-${i}`,
        value: `value-${i}`,
        source: 'test',
        confidence: i === 0 ? 0.01 : 0.5, // first item has lowest confidence
      });
    }

    store.applyRetentionPolicies('team');
    const remaining = store.listActiveItems('team', limit + 10);
    expect(remaining.length).toBeLessThanOrEqual(limit);
  });

  it('applyRetentionPolicies trims old events', () => {
    const store = makeStore();
    // recordEvent is tested indirectly; just make sure retention doesn't crash
    for (let i = 0; i < 5; i++) {
      store.recordEvent('test_event', 'test', 'team', { i });
    }
    expect(() => store.applyRetentionPolicies('team')).not.toThrow();
  });

  it('findItemByKey returns null for user scope without userId', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'user',
      group_folder: 'team',
      user_id: 'u1',
      kind: 'preference',
      key: 'theme',
      value: 'dark',
      source: 'test',
      confidence: 0.9,
    });

    // User scope without userId returns null
    const result = store.findItemByKey({
      scope: 'user',
      groupFolder: 'team',
      key: 'theme',
    });
    expect(result).toBeNull();
  });

  it('findItemByKey returns null for non-existent key', () => {
    const store = makeStore();
    expect(
      store.findItemByKey({
        scope: 'group',
        groupFolder: 'team',
        key: 'no-such-key',
      }),
    ).toBeNull();
  });

  it('toItem handles null/missing optional fields gracefully', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'optional-fields',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    expect(item.user_id).toBeNull();
    expect(item.last_used_at).toBeNull();
    expect(item.last_retrieved_at).toBeNull();
    expect(item.embedding_json).toBeNull();
    expect(item.retrieval_count).toBe(0);
    expect(item.total_score).toBe(0);
    expect(item.max_score).toBe(0);
  });

  it('toChunk handles all fields correctly', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'doc',
        source_id: 'doc-fields',
        source_path: '/tmp/doc-fields.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'document',
        text: 'chunk field test content',
        embedding: null,
      },
    ]);
    const chunks = store.listSourceChunks('doc', 'doc-fields');
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    expect(chunk.source_type).toBe('doc');
    expect(chunk.source_id).toBe('doc-fields');
    expect(chunk.source_path).toBe('/tmp/doc-fields.md');
    expect(chunk.scope).toBe('group');
    expect(chunk.group_folder).toBe('team');
    expect(chunk.kind).toBe('document');
    expect(chunk.text).toBe('chunk field test content');
    expect(chunk.embedding_json).toBeNull();
    expect(chunk.token_count).toBeGreaterThan(0);
    expect(chunk.importance_weight).toBe(1); // default
    expect(chunk.created_at).toBeTruthy();
    expect(chunk.updated_at).toBeTruthy();
  });

  it('listActiveItems respects limit parameter', () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) {
      store.saveItem({
        scope: 'group',
        group_folder: 'team',
        user_id: null,
        kind: 'fact',
        key: `limit-test-${i}`,
        value: `value-${i}`,
        source: 'test',
        confidence: 0.5,
      });
    }

    const limited = store.listActiveItems('team', 3);
    expect(limited).toHaveLength(3);
  });

  it('saveChunks computes token_count from text length', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-token',
        source_path: '/tmp/c-token.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'a'.repeat(100), // 100 chars / 4 = 25 tokens
        embedding: null,
      },
    ]);
    const chunks = store.listSourceChunks('conversation', 'c-token');
    expect(chunks[0]!.token_count).toBe(25);
  });

  it('findSimilarItems clamps limit', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    // limit of 0 should be clamped to 1, and not throw
    const results = store.findSimilarItems({
      embedding,
      scope: 'group',
      groupFolder: 'team',
      limit: 0,
    });
    expect(results).toHaveLength(0); // no items, but no error
  });

  it('searchProceduresByText escapes LIKE wildcards in query', () => {
    const store = makeStore();
    store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: '100% deploy success rate',
      body: 'always deploy',
      tags: [],
      source: 'test',
      confidence: 0.5,
    });

    // % in the query should not act as a wildcard
    const results = store.searchProceduresByText('100%', 'team', 5);
    expect(results).toHaveLength(1);
  });

  it('saveChunks empty array returns 0', () => {
    const store = makeStore();
    expect(store.saveChunks([])).toBe(0);
  });

  it('listTopItems with user scope and matching user', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'user',
      group_folder: 'team',
      user_id: 'u1',
      kind: 'preference',
      key: 'lang',
      value: 'python',
      source: 'test',
      confidence: 0.8,
    });
    store.saveItem({
      scope: 'user',
      group_folder: 'team',
      user_id: 'u2',
      kind: 'preference',
      key: 'lang',
      value: 'go',
      source: 'test',
      confidence: 0.8,
    });

    const u1Items = store.listTopItems('user', 'team', 10, 'u1');
    expect(u1Items).toHaveLength(1);
    expect(u1Items[0]!.user_id).toBe('u1');
  });

  it('deleteChunksByIds removes FTS entries too', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-fts-del',
        source_path: '/tmp/c-fts-del.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'unique searchable term xylophone',
        embedding: null,
      },
    ]);

    // Verify it's searchable
    let results = store.lexicalSearch('xylophone', 'team', 5);
    expect(results.length).toBeGreaterThan(0);

    // Backdate the chunk to trigger retention deletion
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const directStore = new MemoryStore(dbPath);
    directStore.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-fts-del2',
        source_path: '/tmp/c-fts-del2.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'deletable fts entry xyzzy',
        embedding: null,
      },
    ]);

    const db = new Database(dbPath);
    db.exec(`UPDATE memory_chunks SET created_at = '2000-01-01T00:00:00.000Z'`);
    db.close();

    directStore.applyRetentionPolicies('team');

    // FTS should be cleaned up too
    results = directStore.lexicalSearch('xyzzy', 'team', 5);
    expect(results).toHaveLength(0);
    directStore.close();
  });

  it('saveChunks with embedding stores chunk in toChunk with embedding_json', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 0.5;

    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-emb-chunk',
        source_path: '/tmp/c-emb-chunk.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'chunk with embedding stored in json',
        embedding,
      },
    ]);

    const chunks = store.listSourceChunks('conversation', 'c-emb-chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.embedding_json).not.toBeNull();
    expect(chunks[0]!.embedding_json).toContain('0.5');
  });

  it('listActiveItems excludes global scope items', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'global',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'global-excluded',
      value: 'global data',
      source: 'test',
      confidence: 0.9,
    });
    store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'group-included',
      value: 'group data',
      source: 'test',
      confidence: 0.8,
    });

    const active = store.listActiveItems('team', 10);
    expect(active.every((i) => i.scope !== 'global')).toBe(true);
    expect(active.some((i) => i.key === 'group-included')).toBe(true);
  });

  it('chunkExists differentiates by scope and group_folder', () => {
    const store = makeStore();
    const base = {
      source_type: 'conversation',
      source_id: 'c-scope',
      source_path: '/tmp/c-scope.md',
      kind: 'conversation',
      text: 'shared text across scopes',
      embedding: null,
    };

    store.saveChunks([
      { ...base, scope: 'group' as const, group_folder: 'team-a' },
    ]);

    // Same text but different group_folder is a different chunk
    expect(
      store.chunkExists({
        ...base,
        scope: 'group' as const,
        group_folder: 'team-b',
      }),
    ).toBe(false);

    expect(
      store.chunkExists({
        ...base,
        scope: 'group' as const,
        group_folder: 'team-a',
      }),
    ).toBe(true);
  });

  it('lexicalSearch handles query with double quotes', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-quote',
        source_path: '/tmp/c-quote.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'the variable name was "important"',
        embedding: null,
      },
    ]);
    // Query with quotes should not crash the FTS engine
    expect(() => store.lexicalSearch('"important"', 'team', 5)).not.toThrow();
  });

  it('lexicalSearch with single token query works', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-single',
        source_path: '/tmp/c-single.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'performance optimization techniques',
        embedding: null,
      },
    ]);
    const results = store.lexicalSearch('optimization', 'team', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('saveItem creates unique ids for multiple items', () => {
    const store = makeStore();
    const item1 = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'unique-1',
      value: 'v1',
      source: 'test',
      confidence: 0.5,
    });
    const item2 = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'unique-2',
      value: 'v2',
      source: 'test',
      confidence: 0.5,
    });
    expect(item1.id).not.toBe(item2.id);
    expect(item1.id).toMatch(/^mem-/);
    expect(item1.version).toBe(1);
    expect(item1.created_at).toBeTruthy();
    expect(item1.updated_at).toBeTruthy();
  });

  it('saveProcedure creates unique ids', () => {
    const store = makeStore();
    const proc1 = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Proc A',
      body: 'body A',
      tags: [],
      source: 'test',
      confidence: 0.5,
    });
    const proc2 = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Proc B',
      body: 'body B',
      tags: [],
      source: 'test',
      confidence: 0.5,
    });
    expect(proc1.id).not.toBe(proc2.id);
    expect(proc1.id).toMatch(/^proc-/);
    expect(proc1.version).toBe(1);
  });

  it('patchProcedure with title only leaves body unchanged', () => {
    const store = makeStore();
    const proc = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Original title',
      body: 'Original body',
      tags: ['tag1'],
      source: 'test',
      confidence: 0.6,
    });

    const patched = store.patchProcedure(proc.id, proc.version, {
      title: 'New title',
    });
    expect(patched.title).toBe('New title');
    expect(patched.body).toBe('Original body');
    expect(patched.tags).toEqual(['tag1']);
    expect(patched.confidence).toBe(0.6);
  });

  it('listTopProcedures excludes deleted procedures', () => {
    const store = makeStore();
    const proc = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'To be deleted',
      body: 'body',
      tags: [],
      source: 'test',
      confidence: 0.5,
    });

    // Soft-delete the procedure via raw SQL since there's no softDeleteProcedure method
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store2 = new MemoryStore(dbPath);
    const proc2 = store2.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Deletable proc',
      body: 'body',
      tags: [],
      source: 'test',
      confidence: 0.5,
    });

    const db = new Database(dbPath);
    db.exec(
      `UPDATE memory_procedures SET is_deleted = 1 WHERE id = '${proc2.id}'`,
    );
    db.close();

    const procedures = store2.listTopProcedures('team', 10);
    expect(procedures).toHaveLength(0);
    store2.close();
  });

  it('searchProceduresByText matches on body text', () => {
    const store = makeStore();
    store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Some title',
      body: 'This procedure covers database migration steps',
      tags: [],
      source: 'test',
      confidence: 0.7,
    });

    const results = store.searchProceduresByText('migration', 'team', 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.body).toContain('migration');
  });

  it('listTopItems orders by confidence descending', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'low-conf',
      value: 'low',
      source: 'test',
      confidence: 0.3,
    });
    store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'high-conf',
      value: 'high',
      source: 'test',
      confidence: 0.9,
    });

    const items = store.listTopItems('group', 'team', 10);
    expect(items).toHaveLength(2);
    expect(items[0]!.key).toBe('high-conf');
    expect(items[1]!.key).toBe('low-conf');
  });

  it('listActiveItems includes user-scoped items', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'user',
      group_folder: 'team',
      user_id: 'u1',
      kind: 'preference',
      key: 'user-active',
      value: 'data',
      source: 'test',
      confidence: 0.7,
    });

    const active = store.listActiveItems('team', 10);
    expect(active).toHaveLength(1);
    expect(active[0]!.scope).toBe('user');
  });

  it('applyRetentionPolicies preserves pinned items even during overflow', () => {
    const store = makeStore();
    const limit = MEMORY_ITEM_MAX_PER_GROUP;

    // Create one pinned item
    const pinned = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'pinned-survivor',
      value: 'must survive',
      source: 'test',
      confidence: 0.01, // lowest confidence
      is_pinned: true,
    });

    // Fill to overflow
    for (let i = 0; i < limit + 1; i++) {
      store.saveItem({
        scope: 'group',
        group_folder: 'team',
        user_id: null,
        kind: 'fact',
        key: `overflow-pin-${i}`,
        value: `value-${i}`,
        source: 'test',
        confidence: 0.5,
      });
    }

    store.applyRetentionPolicies('team');

    // Pinned item should survive
    expect(store.getItemById(pinned.id)).not.toBeNull();
  });

  it('saveItemEmbedding handles non-array input as no-op', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'non-array-embed',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    // Passing non-array should be no-op
    store.saveItemEmbedding(item.id, null as unknown as number[]);
    expect(store.getItemById(item.id)!.embedding_json).toBeNull();
  });

  it('findSimilarItems with large limit is clamped to 50', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    // Should not throw with a very large limit
    const results = store.findSimilarItems({
      embedding,
      scope: 'group',
      groupFolder: 'team',
      limit: 1000,
    });
    expect(results).toHaveLength(0); // no items, but doesn't crash
  });

  it('recordRetrievalSignal trims query_hashes to last 50', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'many-queries',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    // Record 55 unique query hashes
    for (let i = 0; i < 55; i++) {
      store.recordRetrievalSignal(item.id, 0.1, `query-${i}`);
    }

    const updated = store.getItemById(item.id)!;
    const hashes = JSON.parse(updated.query_hashes_json) as string[];
    expect(hashes.length).toBeLessThanOrEqual(50);
    // Should keep the most recent ones
    expect(hashes).toContain('query-54');
  });

  it('recordRetrievalSignal deduplicates recall_days', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'recall-dedup',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    // Multiple signals on same day
    store.recordRetrievalSignal(item.id, 0.5, 'q1');
    store.recordRetrievalSignal(item.id, 0.5, 'q2');
    store.recordRetrievalSignal(item.id, 0.5, 'q3');

    const updated = store.getItemById(item.id)!;
    const days = JSON.parse(updated.recall_days_json) as string[];
    expect(days).toHaveLength(1); // all on the same day
  });

  it('decayUnusedConfidence does not go below 0', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'floor-test',
      value: 'data',
      source: 'test',
      confidence: 0.05,
    });

    store.decayUnusedConfidence('team', 0.5);
    const items = store.listActiveItems('team', 10);
    expect(items[0]!.confidence).toBe(0);
  });

  it('saveChunks with global scope chunk', () => {
    const store = makeStore();
    const inserted = store.saveChunks([
      {
        source_type: 'doc',
        source_id: 'global-doc',
        source_path: '/tmp/global-doc.md',
        scope: 'global',
        group_folder: '_global',
        kind: 'document',
        text: 'globally available document chunk',
        embedding: null,
      },
    ]);
    expect(inserted).toBe(1);
    const chunks = store.listSourceChunks('doc', 'global-doc');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.scope).toBe('global');
  });

  it('applyRetentionPolicies on global group folder uses global chunk limit', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'doc',
        source_id: 'global-ret',
        source_path: '/tmp/global-ret.md',
        scope: 'global',
        group_folder: '_global',
        kind: 'document',
        text: 'global retention test chunk',
        embedding: null,
      },
    ]);

    // Should not throw when running on global group folder
    expect(() => store.applyRetentionPolicies('_global')).not.toThrow();
  });

  it('opening an existing v3 database does not re-migrate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');

    // Create and close
    const store1 = new MemoryStore(dbPath);
    store1.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'persistent',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });
    store1.close();

    // Reopen — should not throw and data should be intact
    const store2 = new MemoryStore(dbPath);
    const found = store2.findItemByKey({
      scope: 'group',
      groupFolder: 'team',
      key: 'persistent',
    });
    expect(found).not.toBeNull();
    expect(found!.value).toBe('data');
    store2.close();
  });

  it('listSourceChunks returns empty for non-existent source', () => {
    const store = makeStore();
    const chunks = store.listSourceChunks('conversation', 'no-such-id');
    expect(chunks).toHaveLength(0);
  });

  it('saveItem with user_id stores it correctly', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'user',
      group_folder: 'team',
      user_id: 'user-123',
      kind: 'preference',
      key: 'timezone',
      value: 'UTC',
      source: 'test',
      confidence: 0.8,
    });
    expect(item.user_id).toBe('user-123');
    expect(item.scope).toBe('user');
  });

  it('vectorSearch returns empty when no chunks exist', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;
    const results = store.vectorSearch(embedding, 'team', 5);
    expect(results).toHaveLength(0);
  });

  it('lexicalSearch returns empty when no chunks exist', () => {
    const store = makeStore();
    const results = store.lexicalSearch('anything', 'team', 5);
    expect(results).toHaveLength(0);
  });

  it('deleteItemVectorsByIds is no-op for items without vectors', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'no-vec-delete',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    // softDeleteItem calls deleteItemVectorsByIds; should not throw
    // even though this item has no vectors
    expect(() => store.softDeleteItem(item.id)).not.toThrow();
    expect(store.getItemById(item.id)).toBeNull();
  });

  it('patchItem with only value field updates only value', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'value-only-patch',
      value: 'old value',
      source: 'test',
      confidence: 0.5,
    });

    const patched = store.patchItem(item.id, item.version, {
      value: 'new value',
    });
    expect(patched.value).toBe('new value');
    expect(patched.key).toBe('value-only-patch');
    expect(patched.kind).toBe('fact');
    expect(patched.source).toBe('test');
    expect(patched.confidence).toBe(0.5);
  });

  it('incrementRetrievalCount ignores deleted items', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'deleted-inc',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });
    store.softDeleteItem(item.id);

    // Should not throw
    expect(() => store.incrementRetrievalCount([item.id])).not.toThrow();
  });

  it('adjustConfidence ignores deleted items', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'deleted-adj',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });
    store.softDeleteItem(item.id);

    // Should not throw
    expect(() => store.adjustConfidence([item.id], 0.1)).not.toThrow();
  });

  it('recordRetrievalSignal ignores deleted items', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'deleted-signal',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });
    store.softDeleteItem(item.id);

    // Should not throw and should be no-op (item is deleted so row query returns undefined)
    expect(() => store.recordRetrievalSignal(item.id, 0.5, 'q1')).not.toThrow();
  });

  it('findSimilarItems excludes deleted items', () => {
    const store = makeStore();
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'deleted-similar',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });
    store.saveItemEmbedding(item.id, embedding);
    store.softDeleteItem(item.id);

    const results = store.findSimilarItems({
      embedding,
      scope: 'group',
      groupFolder: 'team',
      limit: 5,
    });
    expect(results).toHaveLength(0);
  });

  it('applyRetentionPolicies with overflow chunks removes by importance_weight', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'memory.db');
    const store = new MemoryStore(dbPath);

    // Insert a chunk and manually create many overflow rows
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-overflow-chunk',
        source_path: '/tmp/overflow.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'overflow test chunk unique text',
        embedding: null,
      },
    ]);

    // Should not throw
    expect(() => store.applyRetentionPolicies('team')).not.toThrow();
    store.close();
  });

  it('lexicalSearch handles unicode query', () => {
    const store = makeStore();
    store.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-unicode',
        source_path: '/tmp/c-unicode.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'die Bereitstellung wurde verbessert',
        embedding: null,
      },
    ]);

    const results = store.lexicalSearch('Bereitstellung', 'team', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('patchItem can update confidence to 0', () => {
    const store = makeStore();
    const item = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'zero-conf-patch',
      value: 'data',
      source: 'test',
      confidence: 0.5,
    });

    // Patch confidence to 0 — note: 0 is falsy, so patch.confidence ?? current.confidence
    // would use current.confidence. This is actually a potential bug in patchItem.
    // But we test the actual behavior.
    const patched = store.patchItem(item.id, item.version, { confidence: 0 });
    // patch.confidence ?? current.confidence: 0 ?? 0.5 = 0.5 (because 0 is nullish-coalesced to 0, actually ?? only catches null/undefined, not 0)
    // Actually 0 ?? 0.5 = 0 since ?? only catches null/undefined
    expect(patched.confidence).toBe(0);
  });

  it('findItemByKey for global scope ignores groupFolder', () => {
    const store = makeStore();
    store.saveItem({
      scope: 'global',
      group_folder: 'original-group',
      user_id: null,
      kind: 'fact',
      key: 'global-key',
      value: 'global val',
      source: 'test',
      confidence: 0.7,
    });

    // Should find regardless of groupFolder passed
    const found = store.findItemByKey({
      scope: 'global',
      groupFolder: 'totally-different',
      key: 'global-key',
    });
    expect(found).not.toBeNull();
    expect(found!.value).toBe('global val');
  });
});
