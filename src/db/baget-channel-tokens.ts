/**
 * Per-(user, company) channel-token storage — see migration 015 for the
 * full architecture context.
 *
 * Single-process callsites:
 *   - `src/baget-admin-server.ts` writes (UPSERT) on POST /baget/agent-groups
 *     and POST /baget/agent-groups/bind-telegram. Re-pair from the
 *     dashboard rotates the token (the prior persisted_at is stamped into
 *     rotated_from_at so the audit timeline survives).
 *   - `src/container-runner.ts` reads on every spawnSingleProcessRunner
 *     and injects the value into the child Bun runner's env as
 *     BAGET_CHANNEL_TOKEN. The agent-runner's baget-mcp tools read it
 *     from process.env directly.
 *   - `src/baget-admin-server.ts` deletes on DELETE /baget/agent-groups
 *     so an archived group's token dies before the archive stamp lands.
 *
 * Logging discipline:
 *   `tokenValue` MUST NEVER be logged. Helper signatures intentionally
 *   omit it from any debug-friendly return shape. Callers serialize only
 *   `agentGroupId` and `persistedAt` for telemetry.
 */
import { getDb } from './connection.js';

export interface ChannelTokenRow {
  agent_group_id: string;
  token_value: string;
  persisted_at: string;
  rotated_from_at: string | null;
}

/**
 * Result of a single-row read at spawn time. Bundles the raw bearer
 * with the safe-to-log metadata so the spawn path runs ONE prepared-
 * statement walk, not two — and the breadcrumb describes the same
 * generation that's about to be injected (no TOCTOU window between a
 * separate value read and a separate metadata read).
 */
export interface ChannelTokenReadResult {
  /** Raw bearer to inject as `BAGET_CHANNEL_TOKEN`. NEVER log. */
  tokenValue: string;
  /** ISO timestamp the row was written/last rotated to. Safe to log. */
  persistedAt: string;
  /** ISO of the prior persisted_at when this is a rotation, else null. Safe to log. */
  rotatedFromAt: string | null;
}

/**
 * UPSERT the channel token for an agent_group. On conflict (re-pair or
 * rotation), the prior `persisted_at` is preserved into `rotated_from_at`
 * so the audit timeline survives. Single statement — atomic by
 * better-sqlite3 default.
 *
 * Caller contract: `tokenValue` is the plaintext bearer baget.ai minted
 * via `rotateChannelToken`. Never log it. Validation of length/charset
 * is the caller's responsibility (validateCreateBody in
 * baget-admin-server.ts already enforces base64url + 30..256 chars).
 *
 * The persisted_at timestamp is generated inside the helper by default
 * so callers can't accidentally pass a numeric ms-epoch instead of an
 * ISO string. Tests can pass an explicit `now: Date` for deterministic
 * audit-chain assertions — the type-checker rejects ms-epoch numbers
 * at the call site, which is the footgun the original `now: string`
 * design invited.
 */
export function upsertChannelToken(args: {
  agentGroupId: string;
  tokenValue: string;
  now?: Date;
}): void {
  const persistedAt = (args.now ?? new Date()).toISOString();
  getDb()
    .prepare(
      `INSERT INTO baget_channel_tokens (agent_group_id, token_value, persisted_at, rotated_from_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(agent_group_id) DO UPDATE SET
         rotated_from_at = baget_channel_tokens.persisted_at,
         token_value     = excluded.token_value,
         persisted_at    = excluded.persisted_at`,
    )
    .run(args.agentGroupId, args.tokenValue, persistedAt);
}

/**
 * Spawn-time atomic read: returns the bearer + safe-to-log metadata in
 * one SELECT, or null when no token exists for this agent_group. NEVER
 * log the `tokenValue` field of the return; the `persistedAt` /
 * `rotatedFromAt` fields are explicitly safe.
 *
 * Folding metadata into the same SELECT prevents the post-rotation
 * TOCTOU window where the spawn path could read the new value but log
 * the old metadata (or vice versa).
 */
export function getChannelToken(agentGroupId: string): ChannelTokenReadResult | null {
  const row = getDb()
    .prepare(
      'SELECT token_value, persisted_at, rotated_from_at FROM baget_channel_tokens WHERE agent_group_id = ?',
    )
    .get(agentGroupId) as
    | { token_value: string; persisted_at: string; rotated_from_at: string | null }
    | undefined;
  if (!row) return null;
  return {
    tokenValue: row.token_value,
    persistedAt: row.persisted_at,
    rotatedFromAt: row.rotated_from_at,
  };
}

/**
 * Hard-delete on agent_group archive (called from the admin DELETE
 * handler). Returns the change count — 0 is fine when the founder never
 * supplied a channel token (pre-bridge baget.ai builds).
 *
 * In production this is the load-bearing cleanup path: agent_groups
 * uses soft-delete via archived_at, NOT row delete, so the FK CASCADE
 * in migration 015 only fires under operator hard-delete (cleanup
 * scripts). Don't rely on the cascade in normal flows.
 */
export function deleteChannelToken(agentGroupId: string): number {
  const r = getDb().prepare('DELETE FROM baget_channel_tokens WHERE agent_group_id = ?').run(agentGroupId);
  return r.changes;
}
