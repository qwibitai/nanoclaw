/**
 * Denial-cache helpers for the approvals primitive.
 *
 * Agent-initiated approvals (`requestApproval({ dedupeDenials: true })`)
 * record a denial row when the admin clicks Reject. A subsequent identical
 * request within `DENIAL_TTL_SECONDS` short-circuits with a `notifyAgent`
 * instead of waking the admin again.
 *
 * Hash inputs are canonicalized (sorted keys) so payload key order doesn't
 * change the hash. Action + canonical(payload) is the cache key, scoped by
 * agent_group_id so two groups asking for the same install don't share
 * decisions.
 */
import crypto from 'crypto';

import { getDb } from '../../db/index.js';

/** TTL within which a fresh identical request is suppressed. 24h. */
export const DENIAL_TTL_SECONDS = 24 * 60 * 60;

/** Rows older than this are deleted by the periodic sweep. 7 days. */
export const DENIAL_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface RecentDenial {
  agent_group_id: string;
  action_hash: string;
  denied_at: number;
  denied_by: string;
}

/**
 * Stable hash for `(action, payload)`. Canonicalizes the payload object so
 * key insertion order doesn't change the hash. Non-objects are serialized
 * directly.
 */
export function hashAction(action: string, payload: unknown): string {
  const canonical = canonicalize(payload);
  const h = crypto.createHash('sha256');
  h.update(action);
  h.update('\x00');
  h.update(JSON.stringify(canonical));
  return h.digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export function recordDenial(agentGroupId: string, actionHash: string, deniedBy: string, nowSeconds?: number): void {
  const ts = nowSeconds ?? Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO recent_denials (agent_group_id, action_hash, denied_at, denied_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_group_id, action_hash) DO UPDATE SET
         denied_at = excluded.denied_at,
         denied_by = excluded.denied_by`,
    )
    .run(agentGroupId, actionHash, ts, deniedBy);
}

/**
 * Returns the most recent denial row for `(agentGroupId, actionHash)` if
 * younger than `ttlSeconds`, else null.
 */
export function findRecentDenial(
  agentGroupId: string,
  actionHash: string,
  ttlSeconds: number = DENIAL_TTL_SECONDS,
  nowSeconds?: number,
): RecentDenial | null {
  const cutoff = (nowSeconds ?? Math.floor(Date.now() / 1000)) - ttlSeconds;
  const row = getDb()
    .prepare(
      `SELECT agent_group_id, action_hash, denied_at, denied_by
       FROM recent_denials
       WHERE agent_group_id = ? AND action_hash = ? AND denied_at >= ?`,
    )
    .get(agentGroupId, actionHash, cutoff) as RecentDenial | undefined;
  return row ?? null;
}

/** Delete rows older than `maxAgeSeconds`. Returns the number deleted. */
export function cleanupOldDenials(
  maxAgeSeconds: number = DENIAL_MAX_AGE_SECONDS,
  nowSeconds?: number,
): number {
  const cutoff = (nowSeconds ?? Math.floor(Date.now() / 1000)) - maxAgeSeconds;
  const r = getDb().prepare('DELETE FROM recent_denials WHERE denied_at < ?').run(cutoff);
  return Number(r.changes);
}
