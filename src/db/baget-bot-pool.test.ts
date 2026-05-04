/**
 * Tests for the bot-pool persistence layer.
 *
 * Coverage rationale:
 *
 *   - Migration shape: table + indexes + the orphan-trigger from
 *     migration 017 all land. Smoke test that a fresh DB after
 *     `runMigrations` exposes the right schema.
 *   - `seedBotPoolEntry` rotation semantics (Codex P1): re-seed of
 *     an existing username UPDATEs credentials, returns 'rotated',
 *     leaves status / FK / timestamps intact.
 *   - `assignNextAvailableBot` race protection (Gemini medium):
 *     idempotent on already-assigned groups; FIFO oldest-available
 *     pick; FK UNIQUE conflict converts to a re-read of the existing
 *     assignment (the documented contract Gemini flagged as
 *     unimplemented).
 *   - `releaseBot` happy path + the orphan trigger (Codex P2): hard
 *     DELETE on `agent_groups` flips the pool row back to
 *     'available' automatically, restoring pool capacity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from './index.js';
import {
  assignNextAvailableBot,
  countAvailableBots,
  getBotPoolEntryByAgentGroup,
  getBotPoolEntryByUsername,
  markWebhookRegistered,
  releaseBot,
  seedBotPoolEntry,
} from './baget-bot-pool.js';
import { createBagetAgentGroup } from './baget-agent-groups.js';

const NOW = '2026-05-04T09:00:00.000Z';

function nowIso(offsetMs = 0): string {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

function seedAgentGroup(id: string): void {
  createBagetAgentGroup({
    id,
    name: id,
    folder: id,
    user_id: `user-${id}`,
    company_id: `company-${id}`,
    baget_team_members: JSON.stringify({ cos: 'Louis' }),
    created_at: NOW,
  });
}

describe('baget_bot_pool migration shape', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('creates table + indexes + orphan trigger', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('baget_bot_pool')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toEqual(
      [
        'assigned_agent_group_id',
        'assigned_at',
        'bot_token_value',
        'bot_username',
        'created_at',
        'status',
        'webhook_registered_at',
        'webhook_secret',
      ].sort(),
    );

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='baget_bot_pool'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((r) => r.name);
    expect(indexNames).toContain('idx_bot_pool_assigned_agent_group');
    expect(indexNames).toContain('idx_bot_pool_available');

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='baget_bot_pool'")
      .all() as Array<{ name: string }>;
    const triggerNames = triggers.map((r) => r.name);
    expect(triggerNames).toContain('trg_bot_pool_release_on_orphan');
  });
});

describe('seedBotPoolEntry rotation semantics (Codex P1)', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('first seed inserts a fresh available row', () => {
    const outcome = seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 'token-A',
      webhookSecret: 'secret-A',
      createdAt: NOW,
    });
    expect(outcome).toBe('inserted');

    const row = getBotPoolEntryByUsername('baget_alpha_bot');
    expect(row).toMatchObject({
      bot_username: 'baget_alpha_bot',
      bot_token_value: 'token-A',
      webhook_secret: 'secret-A',
      status: 'available',
      assigned_agent_group_id: null,
      assigned_at: null,
      webhook_registered_at: null,
      created_at: NOW,
    });
  });

  it('re-seed updates credentials but preserves status, FK, timestamps', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 'token-A-old',
      webhookSecret: 'secret-A-old',
      createdAt: NOW,
    });
    // Assign + register webhook so we can verify those fields survive the rotation.
    assignNextAvailableBot('ag-alpha');
    markWebhookRegistered('baget_alpha_bot', nowIso(1000));

    const outcome = seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 'token-A-new',
      webhookSecret: 'secret-A-new',
      createdAt: nowIso(2000), // would-be created_at, must be ignored on rotate
    });
    expect(outcome).toBe('rotated');

    const row = getBotPoolEntryByUsername('baget_alpha_bot');
    expect(row).toMatchObject({
      bot_username: 'baget_alpha_bot',
      bot_token_value: 'token-A-new', // rotated
      webhook_secret: 'secret-A-new', // rotated
      status: 'assigned', // preserved
      assigned_agent_group_id: 'ag-alpha', // preserved
      created_at: NOW, // preserved (NOT clobbered to nowIso(2000))
    });
    expect(row?.assigned_at).not.toBeNull();
    expect(row?.webhook_registered_at).not.toBeNull();
  });
});

describe('assignNextAvailableBot race protection (Gemini medium)', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('returns null when pool is empty', () => {
    seedAgentGroup('ag-alpha');
    expect(assignNextAvailableBot('ag-alpha')).toBeNull();
  });

  it('FIFO picks the oldest available bot', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_youngest_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(2000),
    });
    seedBotPoolEntry({
      botUsername: 'baget_oldest_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(0),
    });
    seedBotPoolEntry({
      botUsername: 'baget_middle_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });

    const assigned = assignNextAvailableBot('ag-alpha');
    expect(assigned?.bot_username).toBe('baget_oldest_bot');
  });

  it('is idempotent for an already-assigned agent_group', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    seedBotPoolEntry({
      botUsername: 'baget_beta_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });

    const first = assignNextAvailableBot('ag-alpha');
    const second = assignNextAvailableBot('ag-alpha');
    expect(first?.bot_username).toBe('baget_alpha_bot');
    expect(second?.bot_username).toBe('baget_alpha_bot');
    // Pool depth unchanged: only one bot was consumed.
    expect(countAvailableBots()).toBe(1);
  });

  it('different agent_groups get different bots in FIFO order', () => {
    seedAgentGroup('ag-alpha');
    seedAgentGroup('ag-beta');
    seedBotPoolEntry({
      botUsername: 'baget_first_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(0),
    });
    seedBotPoolEntry({
      botUsername: 'baget_second_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });

    expect(assignNextAvailableBot('ag-alpha')?.bot_username).toBe('baget_first_bot');
    expect(assignNextAvailableBot('ag-beta')?.bot_username).toBe('baget_second_bot');
    expect(countAvailableBots()).toBe(0);
  });

  it('idempotent path returns existing assignment even when bot was pre-assigned out-of-band', () => {
    // Mirror the cross-process race: another writer assigned bot-X
    // to ag-alpha out-of-band (manual operator UPDATE, future
    // multi-process deployment, etc.) between our step-0 lookup
    // (which would be empty for ag-alpha if the writer raced after)
    // and step-2 write. The function's step-0 SELECT will see the
    // out-of-band assignment AND return it without trying to assign
    // a different bot.
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_already_owned_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(0),
    });
    seedBotPoolEntry({
      botUsername: 'baget_fresh_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });
    // Manually pre-assign baget_already_owned_bot to ag-alpha
    // WITHOUT going through assignNextAvailableBot.
    const db = getDb();
    db.prepare(
      `UPDATE baget_bot_pool
          SET status = 'assigned',
              assigned_agent_group_id = ?,
              assigned_at = ?
        WHERE bot_username = ?`,
    ).run('ag-alpha', NOW, 'baget_already_owned_bot');

    const result = assignNextAvailableBot('ag-alpha');
    expect(result?.bot_username).toBe('baget_already_owned_bot');
    // baget_fresh_bot is still available — no double-assignment.
    expect(countAvailableBots()).toBe(1);
  });
});

describe('releaseBot + orphan-cleanup trigger (Codex P2)', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('releaseBot flips status back to available and clears FK', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    assignNextAvailableBot('ag-alpha');

    const released = releaseBot('ag-alpha');
    expect(released).toBe('baget_alpha_bot');

    const row = getBotPoolEntryByUsername('baget_alpha_bot');
    expect(row).toMatchObject({
      status: 'available',
      assigned_agent_group_id: null,
      assigned_at: null,
    });
  });

  it('releaseBot is a no-op (returns null) for groups without an assignment', () => {
    expect(releaseBot('ag-never-assigned')).toBeNull();
  });

  it('hard DELETE of agent_group auto-flips assigned bot back to available (orphan trigger)', () => {
    // The bug the trigger fixes: ON DELETE SET NULL nulls the FK,
    // but without the trigger, status stays 'assigned' and the row
    // becomes invisible to assignNextAvailableBot, permanently
    // shrinking pool capacity.
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    assignNextAvailableBot('ag-alpha');
    expect(countAvailableBots()).toBe(0);

    // Hard-delete the agent_group, simulating an operator cleanup
    // script that bypasses releaseBot.
    getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-alpha');

    const row = getBotPoolEntryByUsername('baget_alpha_bot');
    expect(row).toMatchObject({
      status: 'available', // trigger restored
      assigned_agent_group_id: null, // ON DELETE SET NULL
      assigned_at: null, // trigger cleared
    });
    expect(countAvailableBots()).toBe(1);
    // Pool can re-assign the now-orphan-cleaned bot to a new group.
    seedAgentGroup('ag-new');
    expect(assignNextAvailableBot('ag-new')?.bot_username).toBe('baget_alpha_bot');
  });
});

describe('observability + lookup helpers', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('countAvailableBots tracks pool depth across seed/assign/release', () => {
    expect(countAvailableBots()).toBe(0);
    seedBotPoolEntry({
      botUsername: 'a_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    seedBotPoolEntry({
      botUsername: 'b_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });
    expect(countAvailableBots()).toBe(2);

    seedAgentGroup('ag-alpha');
    assignNextAvailableBot('ag-alpha');
    expect(countAvailableBots()).toBe(1);

    releaseBot('ag-alpha');
    expect(countAvailableBots()).toBe(2);
  });

  it('getBotPoolEntryByAgentGroup returns the assigned row', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'a_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    assignNextAvailableBot('ag-alpha');

    const row = getBotPoolEntryByAgentGroup('ag-alpha');
    expect(row?.bot_username).toBe('a_bot');
    expect(row?.status).toBe('assigned');
  });

  it('getBotPoolEntryByAgentGroup returns undefined when no assignment exists', () => {
    expect(getBotPoolEntryByAgentGroup('ag-never-assigned')).toBeUndefined();
  });

  it('markWebhookRegistered stamps the timestamp', () => {
    seedBotPoolEntry({
      botUsername: 'a_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    expect(getBotPoolEntryByUsername('a_bot')?.webhook_registered_at).toBeNull();
    markWebhookRegistered('a_bot', nowIso(500));
    expect(getBotPoolEntryByUsername('a_bot')?.webhook_registered_at).toBe(nowIso(500));
  });
});
