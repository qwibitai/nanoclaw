import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { MemoryStore, ValidationError } from './memory-mcp-stdio.js';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:', 'telegram_main');
  });

  afterEach(() => {
    store.close();
  });

  it('writes and reads a record roundtrip', () => {
    const res = store.write({
      key: 'nanoclaw.appdata_path',
      value: '/mnt/cache/appdata/nanoclaw',
      tags: 'infra,paths',
      source: 'gary',
    });
    expect(res).toEqual({ key: 'nanoclaw.appdata_path', action: 'inserted' });

    const rec = store.read('nanoclaw.appdata_path');
    expect(rec).not.toBeNull();
    expect(rec!.group_folder).toBe('telegram_main');
    expect(rec!.key).toBe('nanoclaw.appdata_path');
    expect(rec!.value).toBe('/mnt/cache/appdata/nanoclaw');
    expect(rec!.tags).toBe('infra,paths');
    expect(rec!.source).toBe('gary');
    expect(rec!.created_at).toBeTruthy();
    expect(rec!.updated_at).toBeTruthy();
  });

  it('returns null for a missing key', () => {
    expect(store.read('does.not.exist')).toBeNull();
  });

  it('upserts on conflicting key (updates value)', () => {
    store.write({ key: 'server.syd.ip', value: '10.0.0.1' });
    const second = store.write({
      key: 'server.syd.ip',
      value: '10.0.0.42',
      tags: 'network',
    });
    expect(second.action).toBe('updated');

    const rec = store.read('server.syd.ip');
    expect(rec!.value).toBe('10.0.0.42');
    expect(rec!.tags).toBe('network');
  });

  it('FTS search returns the right record by value content', () => {
    store.write({ key: 'a', value: 'the quick brown fox', tags: 'animal' });
    store.write({
      key: 'b',
      value: 'lazy dogs sleep in the sun',
      tags: 'animal',
    });
    store.write({ key: 'c', value: 'completely unrelated', tags: 'misc' });

    const hits = store.search({ query: 'fox' });
    expect(hits.map((r) => r.key)).toEqual(['a']);

    const animalHits = store.search({ query: 'animal' });
    expect(animalHits.map((r) => r.key).sort()).toEqual(['a', 'b']);
  });

  it('FTS search respects limit cap', () => {
    for (let i = 0; i < 5; i++) {
      store.write({ key: `k.${i}`, value: 'shared keyword here' });
    }
    const hits = store.search({ query: 'keyword', limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it('deletes a record', () => {
    store.write({ key: 'temp', value: 'bye' });
    expect(store.delete('temp')).toBe(true);
    expect(store.read('temp')).toBeNull();
    expect(store.delete('temp')).toBe(false);
  });

  it('lists entries filtered by tag', () => {
    store.write({ key: 'one', value: 'v1', tags: 'infra,paths' });
    store.write({ key: 'two', value: 'v2', tags: 'infra,network' });
    store.write({ key: 'three', value: 'v3', tags: 'misc' });

    const infra = store.list({ tag: 'infra' });
    expect(infra.map((r) => r.key).sort()).toEqual(['one', 'two']);

    const paths = store.list({ tag: 'paths' });
    expect(paths.map((r) => r.key)).toEqual(['one']);

    // 'pat' is a substring of 'paths' — must not false-match
    const partial = store.list({ tag: 'pat' });
    expect(partial).toEqual([]);
  });

  it('lists all entries when no tag is provided', () => {
    store.write({ key: 'a', value: '1' });
    store.write({ key: 'b', value: '2' });
    const all = store.list({});
    expect(all.map((r) => r.key).sort()).toEqual(['a', 'b']);
  });

  it('rejects malformed keys', () => {
    expect(() => store.write({ key: '', value: 'x' })).toThrow(ValidationError);
    expect(() => store.write({ key: 'bad key', value: 'x' })).toThrow(
      ValidationError,
    );
    expect(() => store.write({ key: 'bad/key', value: 'x' })).toThrow(
      ValidationError,
    );
    const longKey = 'a'.repeat(129);
    expect(() => store.write({ key: longKey, value: 'x' })).toThrow(
      ValidationError,
    );
  });

  it('rejects oversized values', () => {
    const huge = 'x'.repeat(64 * 1024 + 1);
    expect(() => store.write({ key: 'big', value: huge })).toThrow(
      ValidationError,
    );
  });

  it('rejects oversized tags', () => {
    const huge = 'a'.repeat(513);
    expect(() => store.write({ key: 'ok', value: 'x', tags: huge })).toThrow(
      ValidationError,
    );
  });

  it('rejects empty search query', () => {
    expect(() => store.search({ query: '' })).toThrow(ValidationError);
    expect(() => store.search({ query: '   ' })).toThrow(ValidationError);
  });

  it('rejects malformed group_folder', () => {
    expect(() => new MemoryStore(':memory:', '')).toThrow(ValidationError);
    expect(() => new MemoryStore(':memory:', 'bad group')).toThrow(
      ValidationError,
    );
    expect(() => new MemoryStore(':memory:', 'bad/slash')).toThrow(
      ValidationError,
    );
  });
});

describe('MemoryStore group isolation', () => {
  // Two stores sharing one in-memory DB would require shared connection —
  // better-sqlite3 ':memory:' opens a private DB per instance. Use a temp file.
  const tmpPath = `/tmp/memory-test-${process.pid}-${Date.now()}.db`;
  let a: MemoryStore;
  let b: MemoryStore;

  beforeEach(() => {
    a = new MemoryStore(tmpPath, 'telegram_main');
    b = new MemoryStore(tmpPath, 'whatsapp_family');
  });

  afterEach(async () => {
    a.close();
    b.close();
    const fs = await import('fs');
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(tmpPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  it('groups see only their own writes on read', () => {
    a.write({ key: 'shared.key', value: 'from A' });
    b.write({ key: 'shared.key', value: 'from B' });

    expect(a.read('shared.key')!.value).toBe('from A');
    expect(b.read('shared.key')!.value).toBe('from B');
  });

  it('groups see only their own results on search', () => {
    a.write({ key: 'a.one', value: 'apple banana' });
    b.write({ key: 'b.one', value: 'apple cherry' });

    const hitsA = a.search({ query: 'apple' });
    expect(hitsA.map((r) => r.key)).toEqual(['a.one']);

    const hitsB = b.search({ query: 'apple' });
    expect(hitsB.map((r) => r.key)).toEqual(['b.one']);
  });

  it('groups see only their own entries on list', () => {
    a.write({ key: 'a.only', value: 'x' });
    b.write({ key: 'b.only', value: 'y' });

    expect(a.list({}).map((r) => r.key)).toEqual(['a.only']);
    expect(b.list({}).map((r) => r.key)).toEqual(['b.only']);
  });

  it("delete in one group doesn't affect the other", () => {
    a.write({ key: 'shared.key', value: 'A' });
    b.write({ key: 'shared.key', value: 'B' });

    expect(a.delete('shared.key')).toBe(true);
    expect(a.read('shared.key')).toBeNull();
    expect(b.read('shared.key')!.value).toBe('B');
  });
});
