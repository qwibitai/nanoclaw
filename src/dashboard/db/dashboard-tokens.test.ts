import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { consumeDashboardToken, issueDashboardToken } from './dashboard-tokens.js';

function now(): string {
  return new Date().toISOString();
}

function seedUser(id: string): void {
  getDb()
    .prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'test', NULL, ?)")
    .run(id, now());
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seedUser('u1');
  seedUser('u2');
});

afterEach(() => {
  closeDb();
});

describe('dashboard_tokens DAO', () => {
  it('test_issueDashboardToken_creates_row', () => {
    const record = issueDashboardToken('u1', 'hmac-abc', 24);
    expect(record.user_id).toBe('u1');
    expect(record.token_hmac).toBe('hmac-abc');
    expect(record.used_at).toBeNull();
    expect(record.id).toBeGreaterThan(0);

    const row = getDb()
      .prepare('SELECT * FROM dashboard_tokens WHERE token_hmac = ?')
      .get('hmac-abc') as { user_id: string; used_at: string | null } | undefined;
    expect(row?.user_id).toBe('u1');
    expect(row?.used_at).toBeNull();
  });

  it('test_issueDashboardToken_duplicate_hmac_throws', () => {
    issueDashboardToken('u1', 'hmac-abc', 24);
    expect(() => issueDashboardToken('u2', 'hmac-abc', 24)).toThrow();
  });

  it('test_consumeDashboardToken_valid', () => {
    issueDashboardToken('u1', 'hmac-x', 24);
    const record = consumeDashboardToken('hmac-x');
    expect(record).not.toBeNull();
    expect(record!.user_id).toBe('u1');
    expect(record!.used_at).not.toBeNull();

    const row = getDb()
      .prepare('SELECT used_at FROM dashboard_tokens WHERE token_hmac = ?')
      .get('hmac-x') as { used_at: string | null } | undefined;
    expect(row?.used_at).not.toBeNull();
  });

  it('test_consumeDashboardToken_already_used', () => {
    issueDashboardToken('u1', 'hmac-y', 24);
    consumeDashboardToken('hmac-y');
    const second = consumeDashboardToken('hmac-y');
    expect(second).toBeNull();
  });

  it('test_consumeDashboardToken_expired', () => {
    getDb()
      .prepare(
        `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
         VALUES ('u1', 'hmac-z', datetime('now', '-25 hours'), datetime('now', '-1 hour'))`,
      )
      .run();
    const result = consumeDashboardToken('hmac-z');
    expect(result).toBeNull();
  });

  it('test_consumeDashboardToken_concurrent_safety', () => {
    issueDashboardToken('u1', 'hmac-c', 24);
    // better-sqlite3 is synchronous; two sequential calls simulate concurrent attempts
    const r1 = consumeDashboardToken('hmac-c');
    const r2 = consumeDashboardToken('hmac-c');
    const successes = [r1, r2].filter((r) => r !== null);
    expect(successes).toHaveLength(1);
  });
});
