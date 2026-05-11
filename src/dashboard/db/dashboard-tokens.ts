import { getDb } from '../../db/connection.js';

export interface DashboardTokenRecord {
  id: number;
  user_id: string;
  token_hmac: string;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
}

export function issueDashboardToken(userId: string, tokenHmac: string, ttlHours: number): DashboardTokenRecord {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
  const issuedAt = now.toISOString();
  return getDb()
    .prepare(
      `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
       VALUES (@user_id, @token_hmac, @issued_at, @expires_at)
       RETURNING *`,
    )
    .get({ user_id: userId, token_hmac: tokenHmac, issued_at: issuedAt, expires_at: expiresAt }) as DashboardTokenRecord;
}

export function consumeDashboardToken(tokenHmac: string): DashboardTokenRecord | null {
  return (
    (getDb()
      .prepare(
        `UPDATE dashboard_tokens
         SET used_at = datetime('now')
         WHERE token_hmac = @token_hmac
           AND used_at IS NULL
           AND expires_at > datetime('now')
         RETURNING *`,
      )
      .get({ token_hmac: tokenHmac }) as DashboardTokenRecord | undefined) ?? null
  );
}

/**
 * Prune dashboard_tokens rows. Called from the host sweep tick (post-build QA
 * fix SF-6 — without this the table grew unbounded as every /dashboard-token
 * invocation added a row that was never reaped).
 *
 * Retention: 1 day past the token's `expires_at`. The grace period preserves
 * "expired" rows briefly so an operator chasing an issue can confirm a token was
 * issued; production cookies are tied to fresh tokens that get consumed quickly.
 */
export function pruneDashboardTokens(): void {
  getDb()
    .prepare(`DELETE FROM dashboard_tokens WHERE expires_at < datetime('now', '-1 day')`)
    .run();
}
