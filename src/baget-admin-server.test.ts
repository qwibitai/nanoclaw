/**
 * Admin server unit tests.
 *
 * Covers the security-critical pure functions:
 *   - constant-time bearer-token check
 *   - HMAC token mint + verify (incl. tampering, wrong key, malformed)
 *   - tokenHash output shape
 *
 * Full end-to-end HTTP route tests would require a live socket + a
 * full DB fixture; those are deferred to the integration suite.
 */
import { describe, expect, it } from 'vitest';

import { mintPairingToken, tokenHash, verifyAdminBearer, verifyPairingTokenHmac } from './baget-admin-server.js';

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

describe('mintPairingToken / verifyPairingTokenHmac', () => {
  const baseArgs = {
    userId: 'u-1',
    companyId: 'c-1',
    agentGroupId: 'ag-1',
    adminToken: ADMIN_TOKEN,
    now: 1_700_000_000_000,
  };

  it('round-trips a fresh token', () => {
    const minted = mintPairingToken(baseArgs);
    expect(minted.rawToken).toContain('.');
    expect(verifyPairingTokenHmac(minted.rawToken, ADMIN_TOKEN)).toBe(true);
  });

  it('mints distinct tokens even with identical inputs (nonce)', () => {
    const a = mintPairingToken(baseArgs);
    const b = mintPairingToken(baseArgs);
    expect(a.rawToken).not.toBe(b.rawToken);
  });

  it('rejects a tampered payload (HMAC mismatch)', () => {
    const minted = mintPairingToken(baseArgs);
    const [payload, hmac] = minted.rawToken.split('.');
    const tampered = `${payload}aXX.${hmac}`;
    expect(verifyPairingTokenHmac(tampered, ADMIN_TOKEN)).toBe(false);
  });

  it('rejects a tampered HMAC tail', () => {
    const minted = mintPairingToken(baseArgs);
    const [payload, hmac] = minted.rawToken.split('.');
    const flipped = hmac.startsWith('A') ? 'B' + hmac.slice(1) : 'A' + hmac.slice(1);
    expect(verifyPairingTokenHmac(`${payload}.${flipped}`, ADMIN_TOKEN)).toBe(false);
  });

  it('rejects a token signed by a different admin token', () => {
    const minted = mintPairingToken(baseArgs);
    expect(verifyPairingTokenHmac(minted.rawToken, 'different-token-different-token')).toBe(false);
  });

  it('returns false on malformed input', () => {
    expect(verifyPairingTokenHmac('no-dot-here', ADMIN_TOKEN)).toBe(false);
    expect(verifyPairingTokenHmac('.', ADMIN_TOKEN)).toBe(false);
    expect(verifyPairingTokenHmac('', ADMIN_TOKEN)).toBe(false);
    // Empty halves
    expect(verifyPairingTokenHmac('payload.', ADMIN_TOKEN)).toBe(false);
    expect(verifyPairingTokenHmac('.hmac', ADMIN_TOKEN)).toBe(false);
  });

  it('expiresAtMs is in the future', () => {
    const minted = mintPairingToken(baseArgs);
    expect(minted.expiresAtMs).toBeGreaterThan(baseArgs.now);
    // 5-minute TTL per spec
    expect(minted.expiresAtMs - baseArgs.now).toBe(5 * 60 * 1000);
  });
});

describe('tokenHash', () => {
  it('produces 64-char hex SHA256', () => {
    expect(tokenHash('hello')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(tokenHash('abc')).toBe(tokenHash('abc'));
  });
});
