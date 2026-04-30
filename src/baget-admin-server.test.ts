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

import { mintPairingToken, tokenHash, verifyAdminBearer } from './baget-admin-server.js';

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
