/**
 * Admin server unit tests.
 *
 * Covers the security-critical pure functions:
 *   - constant-time bearer-token check
 *   - mintPairingToken: shape, randomness, TTL
 *   - tokenHash output shape
 *
 * Full end-to-end HTTP route tests would require a live socket + a
 * full DB fixture; those are deferred to the integration suite.
 *
 * NOTE on token format: the JWT-shape `<payload>.<hmac>` was replaced
 * with a 32-hex opaque random in the Telegram-compat fix (Telegram
 * caps `?start=<param>` at 64 bytes of [A-Z a-z 0-9 _ -], so dots and
 * long payloads silently get dropped). Forgery resistance now comes
 * from 16 bytes of CSPRNG entropy + DB single-use CAS — see the
 * `mintPairingToken` jsdoc.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  mintPairingToken,
  performDisconnectCleanup,
  tokenHash,
  validateCreateBody,
  verifyAdminBearer,
  type CreateAgentGroupBody,
} from './baget-admin-server.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';

const ADMIN_TOKEN = 'test-admin-token-1234567890abcdef';

describe('verifyAdminBearer', () => {
  it('accepts the exact bearer', () => {
    expect(verifyAdminBearer(`Bearer ${ADMIN_TOKEN}`, ADMIN_TOKEN)).toBe(true);
  });

  it('rejects a wrong bearer of the same length', () => {
    const wrong = 'X'.repeat(ADMIN_TOKEN.length);
    expect(verifyAdminBearer(`Bearer ${wrong}`, ADMIN_TOKEN)).toBe(false);
  });

  it('rejects a missing scheme', () => {
    expect(verifyAdminBearer(ADMIN_TOKEN, ADMIN_TOKEN)).toBe(false);
  });

  it('rejects empty / undefined', () => {
    expect(verifyAdminBearer(undefined, ADMIN_TOKEN)).toBe(false);
    expect(verifyAdminBearer('', ADMIN_TOKEN)).toBe(false);
  });

  it('rejects on length mismatch (does not match prefix)', () => {
    expect(verifyAdminBearer('Bearer short', ADMIN_TOKEN)).toBe(false);
    expect(verifyAdminBearer(`Bearer ${ADMIN_TOKEN}suffix`, ADMIN_TOKEN)).toBe(false);
  });

  it('rejects array-form headers (defends against weird proxies)', () => {
    // Express + Node sometimes hand back arrays; verifyAdminBearer expects a string only.
    expect(verifyAdminBearer([`Bearer ${ADMIN_TOKEN}`], ADMIN_TOKEN)).toBe(false);
  });
});

describe('mintPairingToken', () => {
  const baseArgs = {
    userId: 'u-1',
    companyId: 'c-1',
    agentGroupId: 'ag-1',
    adminToken: ADMIN_TOKEN,
    now: 1_700_000_000_000,
  };

  it('returns a 32-char lowercase hex token (Telegram-compat shape)', () => {
    const minted = mintPairingToken(baseArgs);
    expect(minted.rawToken).toMatch(/^[a-f0-9]{32}$/);
    expect(minted.rawToken.length).toBe(32);
  });

  it('contains no dots or non-ASCII chars (Telegram start param spec)', () => {
    const minted = mintPairingToken(baseArgs);
    // Telegram only allows [A-Z a-z 0-9 _ -]. Hex is a strict subset.
    expect(minted.rawToken).not.toContain('.');
    expect(minted.rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('mints distinct tokens on each call (CSPRNG)', () => {
    const a = mintPairingToken(baseArgs);
    const b = mintPairingToken(baseArgs);
    expect(a.rawToken).not.toBe(b.rawToken);
  });

  it('expiresAtMs is exactly 5 min in the future', () => {
    const minted = mintPairingToken(baseArgs);
    expect(minted.expiresAtMs - baseArgs.now).toBe(5 * 60 * 1000);
  });

  it('expiresAt is a valid ISO 8601 string', () => {
    const minted = mintPairingToken(baseArgs);
    // Date constructor parses ISO; if invalid it returns NaN.
    expect(Number.isFinite(new Date(minted.expiresAt).getTime())).toBe(true);
    expect(minted.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('ignores the (reserved) adminToken arg — same shape regardless', () => {
    // Reserved for future use; right now it's a no-op so the same args
    // produce two distinct (random) tokens, neither dependent on it.
    const a = mintPairingToken({ ...baseArgs, adminToken: 'token-A' });
    const b = mintPairingToken({ ...baseArgs, adminToken: 'token-B' });
    expect(a.rawToken).toMatch(/^[a-f0-9]{32}$/);
    expect(b.rawToken).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('tokenHash', () => {
  it('produces 64-char hex SHA256', () => {
    expect(tokenHash('hello')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(tokenHash('abc')).toBe(tokenHash('abc'));
  });

  it('hashes the new short tokens cleanly', () => {
    // The new mintPairingToken returns 32-hex tokens; tokenHash is
    // the hot path on /start consume. Sanity-check that it works.
    const sample = '0123456789abcdef0123456789abcdef';
    expect(tokenHash(sample)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('validateCreateBody — channelToken rules', () => {
  // The base body baget.ai's bridge sends. Each test mutates only the
  // channelToken field so the rule under test isn't shadowed by an
  // earlier rule failing first.
  function baseBody(overrides: Partial<CreateAgentGroupBody> = {}): CreateAgentGroupBody {
    return {
      userId: 'u-' + 'a'.repeat(36),
      companyId: 'c-' + 'b'.repeat(36),
      companyName: 'Acme Corp',
      teamMembers: {
        cos: 'Louis',
        developer: 'Tristan',
        marketing: 'Valentin',
        analyst: 'Chloé',
        design: 'Nicolas',
        ops: 'Théo',
      },
      channelTokenCredentialName: 'baget-channel-token-aaaaaaaa-bbbbbbbb',
      bagetApiBaseUrl: 'https://stg-app.baget.ai',
      ...overrides,
    };
  }

  // 32 random bytes → base64url (43 chars). The shape baget.ai's
  // mintChannelToken produces. Use a fixed valid sample so tests are
  // deterministic.
  const VALID_TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE';

  it('accepts a body with no channelToken (backwards-compat path)', () => {
    expect(validateCreateBody(baseBody())).toBeNull();
  });

  it('accepts a body with a well-formed channelToken', () => {
    expect(validateCreateBody(baseBody({ channelToken: VALID_TOKEN }))).toBeNull();
  });

  it('rejects a non-string channelToken', () => {
    // The body type says channelToken?: string but at runtime baget.ai
    // could send anything. Cast through unknown to simulate.
    const body = baseBody({ channelToken: 12345 as unknown as string });
    expect(validateCreateBody(body)).toContain('channelToken must be a string');
  });

  it('rejects a channelToken with invalid (non-base64url) characters', () => {
    // `+` and `/` are valid in base64 but NOT in base64url.
    const body = baseBody({ channelToken: 'A+/'.padEnd(43, 'a') });
    expect(validateCreateBody(body)).toContain('invalid characters');
  });

  it('rejects a channelToken below the minimum length (30 chars)', () => {
    const body = baseBody({ channelToken: 'tooShort' });
    expect(validateCreateBody(body)).toContain('out of range');
  });

  it('rejects a channelToken above the maximum length (256 chars)', () => {
    const body = baseBody({ channelToken: 'A'.repeat(257) });
    expect(validateCreateBody(body)).toContain('out of range');
  });

  it('still rejects bodies missing OTHER required fields when channelToken is OK', () => {
    // Sanity: the new rule didn't accidentally short-circuit the
    // existing required-field checks.
    const body = baseBody({
      channelToken: VALID_TOKEN,
      companyName: '',
    });
    expect(validateCreateBody(body)).toContain('Missing required field: companyName');
  });
});

describe('validateCreateBody — partial teamMembers (active-team-only)', () => {
  // Reuse the same baseBody pattern but vary teamMembers shape to
  // simulate apprenti / artisan / atelier founders whose dashboards
  // hire a different subset of specialists.
  function withTeam(team: Record<string, unknown>): CreateAgentGroupBody {
    return {
      userId: 'u-' + 'a'.repeat(36),
      companyId: 'c-' + 'b'.repeat(36),
      companyName: 'Acme Corp',
      teamMembers: team as never,
      channelTokenCredentialName: 'baget-channel-token-aaaaaaaa-bbbbbbbb',
      bagetApiBaseUrl: 'https://stg-app.baget.ai',
    };
  }

  it('accepts apprenti-shaped team (cos only)', () => {
    expect(validateCreateBody(withTeam({ cos: 'Raphaël' }))).toBeNull();
  });

  it('accepts artisan-shaped team (cos + 2 specialists)', () => {
    expect(
      validateCreateBody(
        withTeam({
          cos: 'Raphaël',
          developer: 'Valentin',
          marketing: 'Chloé',
        }),
      ),
    ).toBeNull();
  });

  it('accepts the full six-role payload (older baget.ai builds, atelier+)', () => {
    expect(
      validateCreateBody(
        withTeam({
          cos: 'Louis',
          developer: 'Tristan',
          marketing: 'Valentin',
          analyst: 'Chloé',
          design: 'Nicolas',
          ops: 'Théo',
        }),
      ),
    ).toBeNull();
  });

  it('accepts a team with explicit-null specialist (treated as absent)', () => {
    // Some serializers emit null for absent JSON fields. The validator
    // should treat null as "not hired" rather than rejecting the body.
    expect(
      validateCreateBody(
        withTeam({
          cos: 'Raphaël',
          analyst: null,
        }),
      ),
    ).toBeNull();
  });

  it('rejects when cos is missing', () => {
    expect(validateCreateBody(withTeam({}))).toContain('teamMembers.cos must be a non-empty string');
  });

  it('rejects when cos is empty string', () => {
    expect(validateCreateBody(withTeam({ cos: '' }))).toContain('teamMembers.cos must be a non-empty string');
  });

  it('rejects when cos is whitespace-only', () => {
    expect(validateCreateBody(withTeam({ cos: '   ' }))).toContain('teamMembers.cos must be a non-empty string');
  });

  it('rejects when an OPTIONAL specialist is sent with the wrong type', () => {
    // Founder hired analyst on the dashboard but the dashboard side
    // serialized the value as a number — caller bug, not "absent."
    expect(
      validateCreateBody(
        withTeam({
          cos: 'Raphaël',
          analyst: 12345,
        }),
      ),
    ).toContain('teamMembers.analyst must be a non-empty string when present');
  });

  it('rejects when an optional specialist is an empty string', () => {
    // Empty string ≠ absent — could mean the dashboard sent a hired
    // specialist whose name field is corrupt. Surface the error.
    expect(
      validateCreateBody(
        withTeam({
          cos: 'Raphaël',
          developer: '',
        }),
      ),
    ).toContain('teamMembers.developer must be a non-empty string when present');
  });

  it('rejects when an optional specialist is whitespace-only', () => {
    expect(
      validateCreateBody(
        withTeam({
          cos: 'Raphaël',
          marketing: '   ',
        }),
      ),
    ).toContain('teamMembers.marketing must be a non-empty string when present');
  });

  it('rejects when teamMembers is not an object', () => {
    expect(validateCreateBody(withTeam('not-an-object' as unknown as Record<string, unknown>))).toContain(
      'teamMembers must be an object',
    );
  });

  it('rejects unknown role keys (dashboard typo / unsynced new role)', () => {
    // Catches a class of silent data loss: dashboard adds a `producer`
    // role before the fork knows about it. Without this check, the
    // value would persist but be dropped at render time with no signal.
    const result = validateCreateBody(
      withTeam({
        cos: 'Raphaël',
        producer: 'Anaïs',
      }),
    );
    expect(result).toContain('teamMembers.producer is not a known role');
  });
});

// ─── performDisconnectCleanup ──────────────────────────────────────
//
// Pins the regression that PR #4's first attempt missed. Sam's bot
// kept replying after Disconnect because the DELETE handler had a
// pre-existing `if (existing.archived_at) return early` short-circuit
// that prevented the new unbind/deny/kill logic from running on
// already-archived groups. The channel-approval flow re-introduces
// wiring under owner permissions in DMs (see comment in
// handleDeleteByTuple), so an already-archived group can still have
// LIVE wiring pointing at it. Running the cleanup again is the only
// way to recover.
describe('performDisconnectCleanup', () => {
  const NOW_ISO = '2026-05-03T15:55:00.000Z';
  const FIRST_DISCONNECT_ISO = '2026-05-03T12:00:00.000Z';

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at, user_id, company_id)
       VALUES ('ag-1', 'Acme', 'baget-acme', '2026-01-01T00:00:00Z', 'u-1', 'c-1')`,
    ).run();
  });

  afterEach(() => {
    closeDb();
  });

  function insertMg(id: string): void {
    getDb()
      .prepare(
        `INSERT INTO messaging_groups
           (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'baget-telegram', ?, ?, 0, 'public', '2026-04-01T00:00:00Z')`,
      )
      .run(id, `tg-${id}`, `chat-${id}`);
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

  function getMg(id: string): { denied_at: string | null } | undefined {
    return getDb().prepare('SELECT denied_at FROM messaging_groups WHERE id = ?').get(id) as
      | { denied_at: string | null }
      | undefined;
  }

  function countWiring(agentGroupId: string): number {
    return (
      getDb()
        .prepare('SELECT COUNT(*) AS n FROM messaging_group_agents WHERE agent_group_id = ?')
        .get(agentGroupId) as { n: number }
    ).n;
  }

  function getArchivedAt(agentGroupId: string): string | null {
    return (
      (getDb().prepare('SELECT archived_at FROM agent_groups WHERE id = ?').get(agentGroupId) as {
        archived_at: string | null;
      }).archived_at ?? null
    );
  }

  it('first-time disconnect: archives, unbinds, and stamps denied_at', () => {
    insertMg('mg-1');
    insertWiring('mga-1', 'mg-1', 'ag-1');

    const result = performDisconnectCleanup('ag-1', {
      wasAlreadyArchived: false,
      nowIso: NOW_ISO,
      reason: 'unit test — first disconnect',
    });

    expect(result.unbound).toBe(1);
    expect(result.denied).toBe(1);
    expect(result.killedRunners).toBe(0); // no fake runner registered
    expect(getMg('mg-1')?.denied_at).toBe(NOW_ISO);
    expect(getArchivedAt('ag-1')).toBe(NOW_ISO);
    expect(countWiring('ag-1')).toBe(0);
  });

  // The actual regression test. Reproduces Sam's stuck state:
  // archived_at is set (founder disconnected once before), but the
  // channel-approval flow re-created the wiring after the archive.
  // The second disconnect MUST clean it up — that's exactly what the
  // missing-from-PR-#4 short-circuit was preventing.
  it('re-disconnect with stuck wiring: cleans up unbind+deny+kill, preserves original archive timestamp', () => {
    // Simulate the post-bug, pre-fix state: agent_group archived
    // earlier; wiring re-introduced afterward via channel-approval.
    getDb().prepare('UPDATE agent_groups SET archived_at = ? WHERE id = ?').run(FIRST_DISCONNECT_ISO, 'ag-1');
    insertMg('mg-1');
    insertWiring('mga-1', 'mg-1', 'ag-1'); // the rogue wiring

    const result = performDisconnectCleanup('ag-1', {
      wasAlreadyArchived: true,
      nowIso: NOW_ISO,
      reason: 'unit test — recovery from stuck state',
    });

    // Cleanup happened.
    expect(result.unbound).toBe(1);
    expect(result.denied).toBe(1);
    expect(countWiring('ag-1')).toBe(0);
    expect(getMg('mg-1')?.denied_at).toBe(NOW_ISO);
    // BUT the archive timestamp is the ORIGINAL one — re-running
    // the cleanup must not bump it (forensic stability).
    expect(getArchivedAt('ag-1')).toBe(FIRST_DISCONNECT_ISO);
  });

  it('re-disconnect with no stuck state: still safe (token, deny, kill all no-op)', () => {
    getDb().prepare('UPDATE agent_groups SET archived_at = ? WHERE id = ?').run(FIRST_DISCONNECT_ISO, 'ag-1');
    // No messaging_groups, no wiring — clean already-archived state.

    const result = performDisconnectCleanup('ag-1', {
      wasAlreadyArchived: true,
      nowIso: NOW_ISO,
      reason: 'unit test — clean re-disconnect',
    });

    expect(result.unbound).toBe(0);
    expect(result.denied).toBe(0);
    expect(result.killedRunners).toBe(0);
    expect(getArchivedAt('ag-1')).toBe(FIRST_DISCONNECT_ISO);
  });
});
