import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { MEMORY_VECTOR_DIMENSIONS } from '../core/config.js';
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
});
