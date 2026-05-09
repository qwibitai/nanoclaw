import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  cleanupOldDenials,
  DENIAL_MAX_AGE_SECONDS,
  DENIAL_TTL_SECONDS,
  findRecentDenial,
  hashAction,
  recordDenial,
} from './recent-denials.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('hashAction', () => {
  it('is deterministic for same action + payload', () => {
    const a = hashAction('install_plugin', { plugin_spec: 'foo@bar' });
    const b = hashAction('install_plugin', { plugin_spec: 'foo@bar' });
    expect(a).toBe(b);
  });

  it('is independent of object key order', () => {
    const a = hashAction('install_plugin', { plugin_spec: 'foo@bar', reason: 'why' });
    const b = hashAction('install_plugin', { reason: 'why', plugin_spec: 'foo@bar' });
    expect(a).toBe(b);
  });

  it('is independent of nested key order', () => {
    const a = hashAction('install_plugin', { source: { source: 'github', repo: 'a/b', ref: 'main' } });
    const b = hashAction('install_plugin', { source: { ref: 'main', repo: 'a/b', source: 'github' } });
    expect(a).toBe(b);
  });

  it('differs when action differs', () => {
    expect(hashAction('install_plugin', { x: 1 })).not.toBe(hashAction('uninstall_plugin', { x: 1 }));
  });

  it('differs when payload differs', () => {
    expect(hashAction('install_plugin', { x: 1 })).not.toBe(hashAction('install_plugin', { x: 2 }));
  });

  it('preserves array order in hash (arrays are not sorted)', () => {
    expect(hashAction('a', { items: [1, 2, 3] })).not.toBe(hashAction('a', { items: [3, 2, 1] }));
  });
});

describe('recordDenial / findRecentDenial', () => {
  it('returns null when no denial recorded', () => {
    expect(findRecentDenial('group-a', hashAction('foo', {}))).toBeNull();
  });

  it('finds a fresh denial', () => {
    const h = hashAction('install_plugin', { plugin_spec: 'foo@bar' });
    recordDenial('group-a', h, 'admin:1');
    const found = findRecentDenial('group-a', h);
    expect(found).not.toBeNull();
    expect(found?.denied_by).toBe('admin:1');
  });

  it('does not return a denial older than TTL', () => {
    const h = hashAction('install_plugin', { plugin_spec: 'foo@bar' });
    const tooOld = Math.floor(Date.now() / 1000) - DENIAL_TTL_SECONDS - 60;
    recordDenial('group-a', h, 'admin:1', tooOld);
    expect(findRecentDenial('group-a', h)).toBeNull();
  });

  it('returns a denial right at TTL edge (not yet expired)', () => {
    const h = hashAction('install_plugin', { plugin_spec: 'foo@bar' });
    const now = Math.floor(Date.now() / 1000);
    recordDenial('group-a', h, 'admin:1', now - DENIAL_TTL_SECONDS + 5);
    expect(findRecentDenial('group-a', h, DENIAL_TTL_SECONDS, now)).not.toBeNull();
  });

  it('scopes denials by agent_group_id', () => {
    const h = hashAction('install_plugin', { plugin_spec: 'foo@bar' });
    recordDenial('group-a', h, 'admin:1');
    expect(findRecentDenial('group-b', h)).toBeNull();
  });

  it('upserts on duplicate (agent_group_id, action_hash)', () => {
    const h = hashAction('install_plugin', { plugin_spec: 'foo@bar' });
    const t1 = Math.floor(Date.now() / 1000) - 100;
    const t2 = Math.floor(Date.now() / 1000);
    recordDenial('group-a', h, 'admin:1', t1);
    recordDenial('group-a', h, 'admin:2', t2);
    const found = findRecentDenial('group-a', h);
    expect(found?.denied_at).toBe(t2);
    expect(found?.denied_by).toBe('admin:2');
  });
});

describe('cleanupOldDenials', () => {
  it('deletes rows older than max age, keeps newer ones', () => {
    const now = Math.floor(Date.now() / 1000);
    const h1 = hashAction('a', { i: 1 });
    const h2 = hashAction('a', { i: 2 });
    recordDenial('g', h1, 'u', now - DENIAL_MAX_AGE_SECONDS - 1000);
    recordDenial('g', h2, 'u', now - 60);
    const deleted = cleanupOldDenials(DENIAL_MAX_AGE_SECONDS, now);
    expect(deleted).toBe(1);
    // h2 still findable (within TTL)
    expect(findRecentDenial('g', h2, DENIAL_TTL_SECONDS, now)).not.toBeNull();
    // h1 gone
    expect(findRecentDenial('g', h1, DENIAL_MAX_AGE_SECONDS + 10000, now)).toBeNull();
  });

  it('returns 0 when no rows are stale', () => {
    const h = hashAction('a', {});
    recordDenial('g', h, 'u');
    expect(cleanupOldDenials()).toBe(0);
  });
});
