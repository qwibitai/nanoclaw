/**
 * Pre-minted Telegram bot pool — supports the multi-company pairing
 * model. Telegram has a hard constraint: one (bot, user) pair maps to
 * exactly one DM. So if a founder runs N companies, they need N bots
 * to get N separate chats. We pre-mint a small pool via @BotFather
 * (operator does this once), then assign one bot to each company at
 * bind time.
 *
 * Schema:
 *   - `bot_username` (PK) — `@BotFather` issued, lowercase, e.g.
 *     `baget_team_alpha_bot`. Stored without the `@`.
 *   - `bot_token_value` — the live bot token. Treated as a secret;
 *     never logged. Rotated only by re-seeding (operator-only).
 *   - `webhook_secret` — the value Telegram echoes back as
 *     `X-Telegram-Bot-Api-Secret-Token` on every webhook delivery.
 *     Per-bot so a leak of one bot's secret doesn't compromise the
 *     others. 32 bytes hex (64 chars) when minted by the seed
 *     endpoint; pre-supplied secrets pass through unchanged.
 *   - `status` — `available` | `assigned`. Atomic flip in the assign
 *     helper: `UPDATE … WHERE status = 'available'` keyed by the
 *     candidate row's username. CAS-shape; concurrent calls race on
 *     `changes()` and exactly one wins per row.
 *   - `assigned_agent_group_id` — FK to `agent_groups(id)`. Partial
 *     UNIQUE index enforces 1:1 (one bot per agent_group). On agent
 *     hard-delete the FK SET NULL clears the link without dropping
 *     the row — operator can re-assign that bot to another group
 *     after operator review.
 *   - `assigned_at` / `webhook_registered_at` — ISO timestamps.
 *     `webhook_registered_at` is a register-once gate: setWebhook is
 *     called the first time a bot is assigned, then never again
 *     (Telegram allows re-setting, but the URL contains the username
 *     which is immutable, so the only legitimate re-register is on
 *     env-var rotation — out of scope for this migration).
 *
 * Indexes:
 *   - `idx_bot_pool_assigned_agent_group` — partial UNIQUE on the FK
 *     column. Two agent_groups can't both hold the same bot (and the
 *     assign helper's transaction ensures we never even try). When
 *     `assigned_agent_group_id IS NULL` (status='available') the
 *     index doesn't apply, so any number of free bots can coexist.
 *   - `idx_bot_pool_available` — partial filtered index on
 *     `(status, created_at)` WHERE `status = 'available'`. Used by
 *     `assignNextAvailableBot` to pick the oldest free bot in O(1)
 *     even when the table grows past a few dozen entries. FIFO so an
 *     operator who notices a "weird" bot can re-add it last and
 *     drain it to the bottom.
 *
 * What this migration does NOT do:
 *   - Does not back-fill anything for the legacy global
 *     `TELEGRAM_BOT_TOKEN` deployment (Vela). That bot is intentionally
 *     OUTSIDE the pool — its agent_group has no row here, the adapter
 *     falls back to `cfg.botToken` for outbound, and its webhook lands
 *     on the pre-existing `/api/channels/telegram/webhook` route.
 *   - Does not enforce a minimum pool size. The bind handler returns
 *     `503 pool_exhausted` when no `available` row exists; operator
 *     responds by POSTing to `/baget/bot-pool/seed` with more bots.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'baget-bot-pool',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS baget_bot_pool (
        bot_username             TEXT PRIMARY KEY,
        bot_token_value          TEXT NOT NULL,
        webhook_secret           TEXT NOT NULL,
        status                   TEXT NOT NULL CHECK (status IN ('available', 'assigned')),
        assigned_agent_group_id  TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        assigned_at              TEXT,
        webhook_registered_at    TEXT,
        created_at               TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_pool_assigned_agent_group
        ON baget_bot_pool(assigned_agent_group_id)
        WHERE assigned_agent_group_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_bot_pool_available
        ON baget_bot_pool(status, created_at)
        WHERE status = 'available';
    `);
  },
};
