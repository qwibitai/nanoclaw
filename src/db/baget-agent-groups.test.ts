/**
 * Unit tests for `unbindMessagingGroupsForAgent`.
 *
 * The disconnect bug Sam reported (founder clicks Disconnect → bot keeps
 * replying) had three root causes; the DB-level half is covered here:
 *
 *   - The DELETE on `messaging_group_agents` was correct and is verified.
 *   - The MISSING update to `messaging_groups.denied_at` was the actual
 *     bug for DM-style channels (`isMention === true` → router fell into
 *     the `channelRequestGate` path which can re-create the wiring).
 *
 * These tests pin the behavior so a future refactor can't silently
 * drop the deny stamp without breaking a red test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { unbindMessagingGroupsForAgent } from './baget-agent-groups.js';
import { runMigrations } from './migrations/index.js';

const NOW_ISO = '2026-05-03T12:00:00.000Z';
const EARLIER_ISO = '2026-04-01T08:00:00.000Z';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  // Two agent groups so the cross-isolation test has a control row.
  // ag-1 is the one we'll disconnect; ag-2 is the "must not be touched"
  // baseline.
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, created_at, user_id, company_id)
     VALUES
       ('ag-1', 'Acme', 'baget-acme', '2026-01-01T00:00:00Z', 'u-1', 'c-1'),
       ('ag-2', 'Beta', 'baget-beta', '2026-01-01T00:00:00Z', 'u-2', 'c-2')`,
  ).run();
});

afterEach(() => {
  closeDb();
});

function insertMessagingGroup(id: string, opts: { deniedAt?: string | null } = {}): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at, denied_at)
       VALUES (?, 'baget-telegram', ?, ?, 0, 'public', ?, ?)`,
    )
    .run(id, `tg-${id}`, `chat-${id}`, '2026-04-01T00:00:00Z', opts.deniedAt ?? null);
}

function insertWiring(mgaId: string, mgId: string, agId: string): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, '2026-04-01T00:00:00Z')`,
    )
    .run(mgaId, mgId, agId);
}

function getMessagingGroup(id: string): { id: string; denied_at: string | null } | undefined {
  return getDb().prepare('SELECT id, denied_at FROM messaging_groups WHERE id = ?').get(id) as
    | { id: string; denied_at: string | null }
    | undefined;
}

function countWiringFor(agentGroupId: string): number {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messaging_group_agents WHERE agent_group_id = ?')
    .get(agentGroupId) as { n: number };
  return r.n;
}

describe('unbindMessagingGroupsForAgent', () => {
  it('drops the wiring AND stamps denied_at on the bound chat (the disconnect bug fix)', () => {
    insertMessagingGroup('mg-1');
    insertWiring('mga-1', 'mg-1', 'ag-1');

    const result = unbindMessagingGroupsForAgent('ag-1', NOW_ISO);

    expect(result).toEqual({ unbound: 1, denied: 1 });
    // Wiring row gone.
    expect(countWiringFor('ag-1')).toBe(0);
    // Messaging group row stays (history preserved) but is now denied.
    const mg = getMessagingGroup('mg-1');
    expect(mg).toBeDefined();
    expect(mg?.denied_at).toBe(NOW_ISO);
  });

  it('returns zeros and does nothing when no wiring exists', () => {
    insertMessagingGroup('mg-1'); // exists but not wired to ag-1
    const result = unbindMessagingGroupsForAgent('ag-1', NOW_ISO);
    expect(result).toEqual({ unbound: 0, denied: 0 });
    expect(getMessagingGroup('mg-1')?.denied_at).toBeNull();
  });

  it('does not touch chats wired to a different agent_group', () => {
    insertMessagingGroup('mg-1');
    insertMessagingGroup('mg-2');
    insertWiring('mga-1', 'mg-1', 'ag-1');
    insertWiring('mga-2', 'mg-2', 'ag-2');

    const result = unbindMessagingGroupsForAgent('ag-1', NOW_ISO);

    expect(result).toEqual({ unbound: 1, denied: 1 });
    // ag-1's chat is denied.
    expect(getMessagingGroup('mg-1')?.denied_at).toBe(NOW_ISO);
    // ag-2's chat is untouched.
    expect(getMessagingGroup('mg-2')?.denied_at).toBeNull();
    expect(countWiringFor('ag-2')).toBe(1);
  });

  it('preserves an earlier denied_at — does NOT overwrite (idempotency on second disconnect)', () => {
    // Channel-approval flow already denied this chat last week; today's
    // disconnect must drop the wiring but leave the original deny
    // timestamp intact for postmortem traceability.
    insertMessagingGroup('mg-1', { deniedAt: EARLIER_ISO });
    insertWiring('mga-1', 'mg-1', 'ag-1');

    const result = unbindMessagingGroupsForAgent('ag-1', NOW_ISO);

    expect(result.unbound).toBe(1);
    expect(result.denied).toBe(0); // already denied — no UPDATE applied
    expect(getMessagingGroup('mg-1')?.denied_at).toBe(EARLIER_ISO);
  });

  it('handles an agent wired to multiple chats — every chat gets denied', () => {
    insertMessagingGroup('mg-1');
    insertMessagingGroup('mg-2');
    insertWiring('mga-1', 'mg-1', 'ag-1');
    insertWiring('mga-2', 'mg-2', 'ag-1');

    const result = unbindMessagingGroupsForAgent('ag-1', NOW_ISO);

    expect(result).toEqual({ unbound: 2, denied: 2 });
    expect(getMessagingGroup('mg-1')?.denied_at).toBe(NOW_ISO);
    expect(getMessagingGroup('mg-2')?.denied_at).toBe(NOW_ISO);
  });

  // ──── Shared-chat (multi-agent) edge case ────
  //
  // The schema lets a single chat be wired to multiple agent_groups
  // (UNIQUE on the pair, not on `messaging_group_id`). If we
  // unconditionally stamped `denied_at` on every chat this agent was
  // wired to, disconnecting agent A would silently mute the OTHER
  // agent's traffic on a chat both share — at `router.ts` line 194,
  // with no UI signal. The UPDATE's `NOT EXISTS` clause guards
  // against that.
  //
  // Baget today is 1:1 (one founder = one agent), so this case is
  // theoretical for the disconnect flow. The test exists to pin the
  // semantics and prevent future refactors from regressing into the
  // "stamp everything" behavior.
  it('does NOT stamp denied_at on a chat that still has another agent wired (shared-chat guard)', () => {
    insertMessagingGroup('mg-shared');
    insertMessagingGroup('mg-only-on-ag-1');
    insertWiring('mga-1a', 'mg-shared', 'ag-1');
    insertWiring('mga-1b', 'mg-shared', 'ag-2'); // also wired to ag-2 — this is what makes it "shared"
    insertWiring('mga-1c', 'mg-only-on-ag-1', 'ag-1');

    const result = unbindMessagingGroupsForAgent('ag-1', NOW_ISO);

    // Both of ag-1's wirings dropped (mg-shared and mg-only-on-ag-1).
    expect(result.unbound).toBe(2);
    // Only mg-only-on-ag-1 was orphaned — that's the only one that
    // gets stamped. mg-shared still has ag-2 serving it, so it MUST
    // stay non-denied.
    expect(result.denied).toBe(1);
    expect(getMessagingGroup('mg-shared')?.denied_at).toBeNull();
    expect(getMessagingGroup('mg-only-on-ag-1')?.denied_at).toBe(NOW_ISO);
    // ag-2's wiring on mg-shared survives — that's the whole point of
    // the guard (ag-2 keeps serving its chat).
    expect(countWiringFor('ag-2')).toBe(1);
  });
});
