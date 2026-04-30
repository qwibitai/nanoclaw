import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  consumePairingToken,
  hashPairingToken,
  insertPairingToken,
  sweepExpiredPairingTokens,
} from './baget-pairing-tokens.js';
import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  // Seed an agent_group the tokens will reference.
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, created_at, user_id, company_id)
     VALUES ('ag-1', 'Acme', 'baget-aaaaaaaa-bbbbbbbb', '2026-01-01T00:00:00Z',
             'u-1', 'c-1')`,
  ).run();
});

afterEach(() => {
  closeDb();
});

describe('hashPairingToken', () => {
  it('produces stable SHA256 hex', () => {
    const a = hashPairingToken('hello');
    const b = hashPairingToken('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs across distinct inputs', () => {
    expect(hashPairingToken('a')).not.toBe(hashPairingToken('b'));
  });
});

describe('insertPairingToken + consumePairingToken', () => {
  function freshlyMint(token: string, exp: string): void {
    insertPairingToken({
      rawToken: token,
      userId: 'u-1',
      companyId: 'c-1',
      agentGroupId: 'ag-1',
      expiresAt: exp,
      createdAt: '2026-04-30T10:00:00Z',
    });
  }

  it('consume succeeds once and only once', () => {
    freshlyMint('TOKEN_A', '2030-01-01T00:00:00Z');
    const r1 = consumePairingToken('TOKEN_A', '2026-04-30T10:00:00Z');
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.row.user_id).toBe('u-1');
      expect(r1.row.agent_group_id).toBe('ag-1');
    }

    const r2 = consumePairingToken('TOKEN_A', '2026-04-30T10:00:00Z');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('already_used');
  });

  it('rejects unknown tokens', () => {
    const r = consumePairingToken('NEVER_MINTED', '2026-04-30T10:00:00Z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown');
  });

  it('rejects expired tokens', () => {
    freshlyMint('TOKEN_B', '2020-01-01T00:00:00Z');
    const r = consumePairingToken('TOKEN_B', '2026-04-30T10:00:00Z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('CAS prevents double-consume under simulated race', () => {
    // Simulate by manually flipping the row to used_at, then consume again.
    freshlyMint('TOKEN_C', '2030-01-01T00:00:00Z');
    const hash = hashPairingToken('TOKEN_C');
    getDb()
      .prepare('UPDATE baget_pairing_tokens SET used_at = ? WHERE token_sha256 = ?')
      .run('2026-04-30T10:00:00Z', hash);
    const r = consumePairingToken('TOKEN_C', '2026-04-30T10:00:01Z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already_used');
  });
});

describe('sweepExpiredPairingTokens', () => {
  it('drops expired unused rows but keeps used ones', () => {
    insertPairingToken({
      rawToken: 'EXPIRED_UNUSED',
      userId: 'u-1',
      companyId: 'c-1',
      agentGroupId: 'ag-1',
      expiresAt: '2020-01-01T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z',
    });
    insertPairingToken({
      rawToken: 'EXPIRED_USED',
      userId: 'u-1',
      companyId: 'c-1',
      agentGroupId: 'ag-1',
      expiresAt: '2020-01-01T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z',
    });
    getDb()
      .prepare('UPDATE baget_pairing_tokens SET used_at = ? WHERE token_sha256 = ?')
      .run('2020-01-02T00:00:00Z', hashPairingToken('EXPIRED_USED'));
    insertPairingToken({
      rawToken: 'FRESH',
      userId: 'u-1',
      companyId: 'c-1',
      agentGroupId: 'ag-1',
      expiresAt: '2030-01-01T00:00:00Z',
      createdAt: '2026-04-30T10:00:00Z',
    });

    const dropped = sweepExpiredPairingTokens('2026-04-30T10:00:00Z');
    expect(dropped).toBe(1);
    const remaining = getDb().prepare('SELECT token_sha256 FROM baget_pairing_tokens').all() as Array<{
      token_sha256: string;
    }>;
    expect(remaining.length).toBe(2);
    const remainingHashes = new Set(remaining.map((r) => r.token_sha256));
    expect(remainingHashes.has(hashPairingToken('EXPIRED_USED'))).toBe(true);
    expect(remainingHashes.has(hashPairingToken('FRESH'))).toBe(true);
  });
});
