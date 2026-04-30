/**
 * Pairing-token storage with single-use semantics.
 *
 * Wire format: the raw token is `<payload>.<hmac>` where payload is a
 * URL-safe base64 of `{ userId, companyId, agentGroupId, exp }` and hmac
 * is HMAC-SHA256 over the payload using BAGET_ADMIN_TOKEN as the key.
 * The hmac defends against forged tokens; the DB row defends against
 * replay (single-use) and stamps the exp authoritatively (so a tampered
 * exp in the payload doesn't help — the DB is the source of truth).
 *
 * The DB stores ONLY the SHA256 of the raw token. A DB compromise
 * doesn't leak live tokens (they would still need to be re-derived,
 * which requires BAGET_ADMIN_TOKEN to forge the hmac AND the original
 * payload). A token compromise (e.g. log leak) can be revoked by
 * deleting the row.
 *
 * Consumption is a CAS UPDATE: `WHERE used_at IS NULL` makes it atomic
 * without a transaction. Two concurrent /start calls with the same
 * token race on the UPDATE — exactly one sees `changes() === 1`.
 */
import { createHash } from 'crypto';

import { getDb } from './connection.js';

export interface PairingTokenRow {
  token_sha256: string;
  user_id: string;
  company_id: string;
  agent_group_id: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/** SHA256 hex of the raw token. The hot-path hash, called on mint + consume. */
export function hashPairingToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function insertPairingToken(row: {
  rawToken: string;
  userId: string;
  companyId: string;
  agentGroupId: string;
  expiresAt: string;
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO baget_pairing_tokens
         (token_sha256, user_id, company_id, agent_group_id, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(hashPairingToken(row.rawToken), row.userId, row.companyId, row.agentGroupId, row.expiresAt, row.createdAt);
}

export type ConsumePairingTokenResult =
  | { ok: true; row: PairingTokenRow }
  | { ok: false; reason: 'unknown' | 'expired' | 'already_used' };

/**
 * Atomic CAS consume. Returns the row metadata on success; never returns
 * the same row twice for concurrent callers. The order of failure-mode
 * checks matters: we look up first to distinguish "unknown" from "used"
 * (operationally useful for log triage), then do the CAS to settle the
 * race. If the SELECT-then-UPDATE window races with another consume,
 * the UPDATE catches it (`changes() === 0`) and returns `already_used`.
 */
export function consumePairingToken(rawToken: string, now: string): ConsumePairingTokenResult {
  const hash = hashPairingToken(rawToken);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT token_sha256, user_id, company_id, agent_group_id, expires_at, used_at, created_at
         FROM baget_pairing_tokens
        WHERE token_sha256 = ?`,
    )
    .get(hash) as PairingTokenRow | undefined;

  if (!row) return { ok: false, reason: 'unknown' };
  if (row.used_at !== null) return { ok: false, reason: 'already_used' };
  if (row.expires_at <= now) return { ok: false, reason: 'expired' };

  const result = db
    .prepare(
      `UPDATE baget_pairing_tokens
          SET used_at = ?
        WHERE token_sha256 = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(now, hash, now);

  if (result.changes !== 1) {
    // Lost the race to a concurrent consume.
    return { ok: false, reason: 'already_used' };
  }
  return { ok: true, row: { ...row, used_at: now } };
}

/**
 * Periodic sweep: drop rows whose expires_at has passed AND haven't been
 * consumed. Used rows linger for audit (their used_at marks the pairing
 * event in the timeline). Caller decides cadence — see baget-admin-server.
 */
export function sweepExpiredPairingTokens(now: string): number {
  const r = getDb().prepare('DELETE FROM baget_pairing_tokens WHERE expires_at <= ? AND used_at IS NULL').run(now);
  return r.changes;
}
