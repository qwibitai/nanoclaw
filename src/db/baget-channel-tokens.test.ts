import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { archiveBagetAgentGroup, getBagetAgentGroupById } from './baget-agent-groups.js';
import {
  deleteChannelToken,
  getChannelToken,
  upsertChannelToken,
} from './baget-channel-tokens.js';
import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  // Seed two agent_groups so cross-row isolation tests have something to
  // contrast against. ag-2's only role is "control row that should not
  // change when ag-1 is mutated."
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, created_at, user_id, company_id)
     VALUES
       ('ag-1', 'Acme', 'baget-aaaaaaaa-bbbbbbbb', '2026-01-01T00:00:00Z', 'u-1', 'c-1'),
       ('ag-2', 'Beta', 'baget-cccccccc-dddddddd', '2026-01-01T00:00:00Z', 'u-2', 'c-2')`,
  ).run();
});

afterEach(() => {
  closeDb();
});

describe('upsertChannelToken (insert path)', () => {
  it('persists a fresh token row keyed by agent_group_id', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'token-aaaa' });
    const got = getChannelToken('ag-1');
    expect(got).not.toBeNull();
    expect(got?.tokenValue).toBe('token-aaaa');
    expect(got?.rotatedFromAt).toBeNull();
    // persistedAt is generated inside the helper; assert ISO shape.
    expect(got?.persistedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('returns null when the token does not exist', () => {
    expect(getChannelToken('ag-1')).toBeNull();
  });

  it('keeps tokens isolated across agent_groups', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'token-A' });
    upsertChannelToken({ agentGroupId: 'ag-2', tokenValue: 'token-B' });
    expect(getChannelToken('ag-1')?.tokenValue).toBe('token-A');
    expect(getChannelToken('ag-2')?.tokenValue).toBe('token-B');
  });

  it('throws on FK violation (non-existent agent_group_id)', () => {
    // Belt-and-braces: the FK constraint in migration 015 is the only
    // guard against orphan tokens. If initTestDb / runMigrations ever
    // forgets `PRAGMA foreign_keys = ON`, this test catches the
    // regression immediately.
    expect(() =>
      upsertChannelToken({ agentGroupId: 'ag-does-not-exist', tokenValue: 'token-orphan' }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('upsertChannelToken (rotate path)', () => {
  // Deterministic clock for rotate tests — addresses Gemini MEDIUM
  // review finding ("upsertChannelToken bypasses test-injected now").
  // Each call advances a fixed second so rotated_from_at chains can
  // be asserted by exact equality without race-y wall-clock reads.
  const T0 = new Date('2026-04-30T10:00:00Z');
  const T1 = new Date('2026-04-30T10:00:01Z');
  const T2 = new Date('2026-04-30T10:00:02Z');

  it('overwrites the value and stamps rotated_from_at to the prior persisted_at', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'token-old', now: T0 });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'token-new', now: T1 });

    expect(getChannelToken('ag-1')).toEqual({
      tokenValue: 'token-new',
      persistedAt: T1.toISOString(),
      rotatedFromAt: T0.toISOString(),
    });
  });

  it('preserves rotated_from_at as the most recent prior persisted_at across multiple rotations', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't1', now: T0 });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't2', now: T1 });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't3', now: T2 });

    expect(getChannelToken('ag-1')).toEqual({
      tokenValue: 't3',
      persistedAt: T2.toISOString(),
      rotatedFromAt: T1.toISOString(),
    });
  });

  it('does not bleed rotation timestamps across agent_groups', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't1', now: T0 });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't2', now: T1 });
    upsertChannelToken({ agentGroupId: 'ag-2', tokenValue: 'first-for-ag2', now: T2 });
    expect(getChannelToken('ag-2')?.rotatedFromAt).toBeNull();
  });

  it('still stamps rotated_from_at when the same value is re-upserted (idempotent re-pair)', () => {
    // baget.ai may resend the same channelToken on retry. Documenting
    // that the audit chain still advances — operators reading the
    // rotated_from_at column should know "this row was touched again"
    // even though the secret is unchanged.
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'same-value', now: T0 });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'same-value', now: T1 });

    expect(getChannelToken('ag-1')).toEqual({
      tokenValue: 'same-value',
      persistedAt: T1.toISOString(),
      rotatedFromAt: T0.toISOString(),
    });
  });
});

describe('deleteChannelToken', () => {
  it('returns 1 when a row was deleted', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't' });
    expect(deleteChannelToken('ag-1')).toBe(1);
    expect(getChannelToken('ag-1')).toBeNull();
  });

  it('returns 0 when no row exists (idempotent)', () => {
    expect(deleteChannelToken('ag-1')).toBe(0);
    expect(deleteChannelToken('ag-1')).toBe(0);
  });

  it('does not affect tokens for other agent_groups', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'A' });
    upsertChannelToken({ agentGroupId: 'ag-2', tokenValue: 'B' });
    expect(deleteChannelToken('ag-1')).toBe(1);
    expect(getChannelToken('ag-2')?.tokenValue).toBe('B');
  });

  it('clears rotated_from_at on delete + re-upsert (no stale audit chain)', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't1' });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't2' }); // would set rotated_from_at
    deleteChannelToken('ag-1');
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't3' });
    // After hard-delete, the row is fresh — rotated_from_at must be
    // null, not the stale t1->t2 rotation marker.
    expect(getChannelToken('ag-1')?.rotatedFromAt).toBeNull();
  });
});

describe('Soft-delete lifecycle (the production path)', () => {
  // The admin DELETE handler does NOT hard-delete agent_groups — it
  // calls deleteChannelToken() then archiveBagetAgentGroup() (stamps
  // archived_at). The token row goes away by EXPLICIT call, NOT by
  // FK CASCADE. This test mirrors that exact prod sequence so a
  // future refactor that drops the explicit deleteChannelToken() call
  // (mistakenly trusting CASCADE) gets caught immediately.
  it('explicit deleteChannelToken before archive: token gone, agent_group row preserved with archived_at', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'token' });
    expect(getChannelToken('ag-1')).not.toBeNull();

    // Sequence the admin DELETE handler runs (now wrapped in a
    // db.transaction in baget-admin-server.ts; outcome here is the
    // post-commit state).
    deleteChannelToken('ag-1');
    archiveBagetAgentGroup('ag-1', '2026-04-30T10:00:00Z');

    expect(getChannelToken('ag-1')).toBeNull();
    // Agent_group row still exists — soft-deleted, not hard-deleted.
    const ag = getBagetAgentGroupById('ag-1');
    expect(ag).toBeDefined();
    expect(ag?.archived_at).toBe('2026-04-30T10:00:00Z');
  });
});

describe('FK CASCADE on agent_groups hard-delete (operator cleanup path only)', () => {
  // The CASCADE only fires under operator-initiated hard-deletes
  // (manual cleanup scripts) — NOT the normal archive flow above.
  // Test it anyway because if the FK is silently disabled, orphan
  // tokens become possible the moment someone DOES hard-delete.
  it('drops the channel token when its agent_group is hard-deleted', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'token' });
    expect(getChannelToken('ag-1')?.tokenValue).toBe('token');
    getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-1');
    expect(getChannelToken('ag-1')).toBeNull();
  });
});
