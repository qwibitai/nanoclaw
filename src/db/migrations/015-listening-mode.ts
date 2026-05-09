/**
 * Per-channel listening mode + jibrain capture flags.
 *
 * Adds three columns to `messaging_groups`:
 *
 *   listening_mode TEXT NOT NULL DEFAULT 'attentive'
 *     'attentive' — normal: agent dispatches on engage rules (today's behavior).
 *     'silent'    — observer-only: never engage an agent, only capture for jibrain.
 *     'intake'    — same as silent, but the channel is an explicit knowledge feed.
 *
 *   confidential_intake INTEGER NOT NULL DEFAULT 0
 *     1 = jibrain shared-intake hook is suppressed for this channel (the content
 *         is sensitive; route via the per-workstream confidential path instead).
 *     The jibrain-intake module reads this column and skips the hook when set.
 *
 *   capture_mode TEXT NOT NULL DEFAULT 'standalone'
 *     'standalone' — one intake .md per per-{channel,sender} burst (default).
 *     'digest'     — daily aggregated digest .md per channel (lurker channels).
 *     Forwarded to the hook script as its 5th positional arg, mirroring v1's
 *     joi-sd4 behaviour.
 *
 * Re-introduces the v1 channel-config concepts that the 2.0 rewrite dropped
 * along with the YAML loader. Without these columns the router has no per-
 * channel signal for "capture but don't engage", so the jibrain hook stayed
 * unwired after the v2 cutover (jibot-code-91f, fix nanoclaw-91y).
 *
 * ALTER TABLE ADD COLUMN is FK-safe and idempotent via the PRAGMA guard.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'listening-mode',
  up: (db: Database.Database) => {
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('listening_mode')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN listening_mode TEXT NOT NULL DEFAULT 'attentive'`);
    }
    if (!have.has('confidential_intake')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN confidential_intake INTEGER NOT NULL DEFAULT 0`);
    }
    if (!have.has('capture_mode')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN capture_mode TEXT NOT NULL DEFAULT 'standalone'`);
    }
  },
};
