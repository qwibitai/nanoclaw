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
import { describe, expect, it } from 'vitest';

import {
  mintPairingToken,
  tokenHash,
  validateCreateBody,
  verifyAdminBearer,
  type CreateAgentGroupBody,
} from './baget-admin-server.js';

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
