/**
 * Baget Telegram bot-pool helpers — see migration 016 for the schema
 * + design context.
 *
 * Lifecycle (per bot row):
 *
 *   seedBotPoolEntry()    — operator inserts via /baget/bot-pool/seed.
 *                           status='available', no FK, no assigned_at.
 *   assignNextAvailableBot(agentGroupId)
 *                          — bind handler picks the oldest available
 *                            row, atomically flips status→'assigned',
 *                            stamps FK + assigned_at. Returns the row
 *                            so the bind handler can register the
 *                            webhook + setMyName.
 *   markWebhookRegistered(username, ts)
 *                          — first-bind-only: records that Telegram
 *                            accepted setWebhook for this URL. Skipped
 *                            on subsequent re-binds of the same group.
 *   getBotPoolEntryByAgentGroup(agentGroupId)
 *                          — adapter outbound path: looks up the
 *                            assigned bot to source the right token +
 *                            URL. Returns undefined for legacy
 *                            (non-pool) groups; adapter falls back to
 *                            cfg.botToken.
 *   getBotPoolEntryByUsername(username)
 *                          — webhook handler: secret-token check vs
 *                            the per-bot stored secret + agent_group
 *                            routing.
 *   releaseBot(agentGroupId)
 *                          — disconnect handler: flips status back to
 *                            'available' + clears the FK so the next
 *                            bind reuses this bot. Webhook stays
 *                            registered (Telegram accepts re-set
 *                            without restart, and the URL contains
 *                            the username — immutable per pool row).
 *   countAvailableBots()    — observability + 503 gate.
 *
 * Concurrency: every state transition is a single CAS UPDATE wrapped
 * in `getDb().transaction(...)` so two parallel binds against an
 * empty pool can never both grab the same row. The non-trivial case
 * is `assignNextAvailableBot`: SELECT-then-UPDATE under WAL would
 * race, so we wrap them in one transaction and the UPDATE's WHERE
 * clause re-asserts `status = 'available'` to defeat any reader that
 * snuck in between. better-sqlite3 transactions are synchronous, so
 * the race window is bounded to actual concurrent host calls — which
 * the bind endpoint receives one-at-a-time anyway, but we don't rely
 * on that.
 *
 * Logging discipline:
 *   `bot_token_value` and `webhook_secret` are SECRETS. Helper
 *   signatures intentionally omit them from any debug-friendly return
 *   shape unless a caller specifically needs the value (assign, get,
 *   webhook-handler lookup). NEVER include either in error messages,
 *   log fields, or telemetry breadcrumbs.
 */
import { getDb } from './connection.js';

export interface BotPoolRow {
  bot_username: string;
  bot_token_value: string;
  webhook_secret: string;
  status: 'available' | 'assigned';
  assigned_agent_group_id: string | null;
  assigned_at: string | null;
  webhook_registered_at: string | null;
  created_at: string;
}

/**
 * Outcome of `seedBotPoolEntry`. `inserted` means a brand-new pool
 * row landed; `rotated` means the username was already known and we
 * UPDATEd `bot_token_value` + `webhook_secret` (the @BotFather
 * token-rotation flow). The seed admin endpoint surfaces these as
 * counts so the operator can tell which bots needed rotation.
 *
 * IMPORTANT: rotation does NOT touch `status`,
 * `assigned_agent_group_id`, `assigned_at`, `webhook_registered_at`,
 * or `created_at`. An assigned bot whose token rotates stays
 * assigned to its company; the founder's chat seamlessly continues
 * once the new token propagates.
 */
export type SeedOutcome = 'inserted' | 'rotated';

/**
 * Upsert a bot into the pool. Caller validates the token via
 * Telegram `getMe` before calling this — we trust the supplied
 * `botUsername` matches the token at insert time.
 *
 * Idempotent on the username PK with sane rotation semantics:
 *
 *   - First seed of a username → INSERT a fresh `'available'` row.
 *     Returns `'inserted'`.
 *
 *   - Re-seed of an existing username → UPDATE the credentials
 *     (`bot_token_value`, `webhook_secret`) only. `status`,
 *     `assigned_agent_group_id`, `assigned_at`, and
 *     `webhook_registered_at` are preserved so an in-use bot whose
 *     @BotFather token was rotated keeps serving its founder. Returns
 *     `'rotated'`.
 *
 * The original design used `INSERT OR IGNORE` and treated re-seeds
 * as "skipped" no-ops — that broke the operator's documented
 * rotation flow (token changes in BotFather, re-seed left stale
 * credentials in the DB, bot 401'd silently on every webhook /
 * outbound until manual intervention). Codex P1 catch.
 */
export function seedBotPoolEntry(args: {
  botUsername: string;
  botTokenValue: string;
  webhookSecret: string;
  createdAt: string;
}): SeedOutcome {
  const db = getDb();
  // Wrap the existence check + upsert in one transaction so the
  // outcome flag matches the actual write (no TOCTOU window where a
  // racing seed lands between the SELECT and the INSERT). Since
  // better-sqlite3 transactions serialize on the same handle and
  // /baget/bot-pool/seed is operator-only / low-frequency, the
  // transaction overhead is negligible.
  return db.transaction((): SeedOutcome => {
    const existed = db
      .prepare('SELECT 1 AS one FROM baget_bot_pool WHERE bot_username = ?')
      .get(args.botUsername) as { one: number } | undefined;
    db.prepare(
      `INSERT INTO baget_bot_pool
         (bot_username, bot_token_value, webhook_secret, status,
          assigned_agent_group_id, assigned_at, webhook_registered_at, created_at)
       VALUES (?, ?, ?, 'available', NULL, NULL, NULL, ?)
       ON CONFLICT(bot_username) DO UPDATE SET
         bot_token_value = excluded.bot_token_value,
         webhook_secret  = excluded.webhook_secret`,
    ).run(args.botUsername, args.botTokenValue, args.webhookSecret, args.createdAt);
    return existed ? 'rotated' : 'inserted';
  })();
}

/**
 * Atomic assignment. Returns the bot row that was just assigned, or
 * null if the pool has no available bots.
 *
 * Re-entrancy: if `agentGroupId` already has a bot assigned, this is
 * a no-op that returns the existing row. The bind handler relies on
 * that for idempotency — second bind for the same group returns the
 * same bot, never a fresh one.
 *
 * Concurrency model:
 *   The host runs as a single Node process (Railway service), and
 *   better-sqlite3 transactions serialize synchronously on the
 *   single DB handle, so two parallel calls into THIS function from
 *   the same process can never overlap. The SELECT + UPDATE pair
 *   inside the transaction is therefore race-free against in-process
 *   concurrency.
 *
 *   The FK partial UNIQUE index `idx_bot_pool_assigned_agent_group`
 *   is the second-line guarantee for two cases that fall outside the
 *   in-process serialization:
 *     1. A future horizontally-scaled deployment with multiple
 *        Node processes hitting the same SQLite file (not the
 *        current shape, but defense in depth).
 *     2. A re-entrant call from the same process where the previous
 *        bind's row insertion happened OUTSIDE this function (e.g.
 *        operator manual UPDATE) — the unique-constraint violation
 *        still makes "two bots assigned to one agent_group"
 *        impossible.
 *   On `SQLITE_CONSTRAINT_UNIQUE` from the UPDATE we catch and
 *   re-read the existing assignment (the conflict is itself the
 *   evidence that another caller already won).
 */
export function assignNextAvailableBot(agentGroupId: string): BotPoolRow | null {
  const db = getDb();
  const SELECT_BY_AGENT = db.prepare(
    `SELECT bot_username, bot_token_value, webhook_secret, status,
            assigned_agent_group_id, assigned_at, webhook_registered_at, created_at
       FROM baget_bot_pool
      WHERE assigned_agent_group_id = ?`,
  );
  return db.transaction((): BotPoolRow | null => {
    // 0. If this group already has a bot, return it (idempotent).
    const existing = SELECT_BY_AGENT.get(agentGroupId) as BotPoolRow | undefined;
    if (existing) return existing;

    // 1. Pick the oldest available bot. The partial filtered index
    //    `idx_bot_pool_available` makes this O(1) past the first row.
    const candidate = db
      .prepare(
        `SELECT bot_username
           FROM baget_bot_pool
          WHERE status = 'available'
          ORDER BY created_at ASC
          LIMIT 1`,
      )
      .get() as { bot_username: string } | undefined;
    if (!candidate) return null;

    // 2. Flip the row to 'assigned' and stamp the FK. The WHERE
    //    clause re-asserts `status='available'` so any prior change
    //    on this row (concurrent process winning the race) fails
    //    this UPDATE with changes=0. The FK partial UNIQUE index
    //    fires only if a DIFFERENT bot was already assigned to this
    //    same agent_group — see the catch below.
    const assignedAt = new Date().toISOString();
    let result: { changes: number };
    try {
      result = db
        .prepare(
          `UPDATE baget_bot_pool
              SET status                  = 'assigned',
                  assigned_agent_group_id = ?,
                  assigned_at             = ?
            WHERE bot_username = ? AND status = 'available'`,
        )
        .run(agentGroupId, assignedAt, candidate.bot_username);
    } catch (err) {
      // SQLITE_CONSTRAINT_UNIQUE: another caller raced and assigned
      // a (different) bot to this same agent_group between our
      // step-0 lookup and step-2 write. Re-read and return their
      // assignment — preserves the function's idempotency contract
      // from the caller's perspective. (Single-process callers
      // can't hit this; cross-process or operator-manual writes
      // can.)
      const code = (err as { code?: string }).code ?? '';
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const racedExisting = SELECT_BY_AGENT.get(agentGroupId) as BotPoolRow | undefined;
        if (racedExisting) return racedExisting;
      }
      throw err;
    }
    if (result.changes !== 1) return null;

    // 3. Read back the freshly-assigned row.
    return db
      .prepare(
        `SELECT bot_username, bot_token_value, webhook_secret, status,
                assigned_agent_group_id, assigned_at, webhook_registered_at, created_at
           FROM baget_bot_pool
          WHERE bot_username = ?`,
      )
      .get(candidate.bot_username) as BotPoolRow;
  })();
}

/**
 * Release the bot back to the pool. Called by the disconnect handlers
 * after the agent_group is archived + chats are unbound.
 *
 * Returns the username that was released (for logging) or null if
 * the agent_group had no bot assigned. The latter is the legacy /
 * Vela case — agent_group never went through pool assignment, so
 * there's nothing to release.
 *
 * Webhook stays registered. Telegram's setWebhook semantics allow
 * idempotent re-set; the cost of "leaving" the registration is one
 * orphan URL on Telegram's side until the next bind for that bot
 * lands (and even then, we register-once and skip if
 * webhook_registered_at is non-null). On operator bot retirement,
 * Telegram's bot deletion is the authoritative cleanup.
 */
export function releaseBot(agentGroupId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT bot_username
         FROM baget_bot_pool
        WHERE assigned_agent_group_id = ?`,
    )
    .get(agentGroupId) as { bot_username: string } | undefined;
  if (!row) return null;
  const result = db
    .prepare(
      `UPDATE baget_bot_pool
          SET status                  = 'available',
              assigned_agent_group_id = NULL,
              assigned_at             = NULL
        WHERE bot_username = ? AND assigned_agent_group_id = ?`,
    )
    .run(row.bot_username, agentGroupId);
  if (result.changes !== 1) return null;
  return row.bot_username;
}

/**
 * Lookup by agent_group. Returns undefined when this group has no
 * pool assignment — the adapter then falls back to cfg.botToken
 * (legacy / Vela path).
 */
export function getBotPoolEntryByAgentGroup(agentGroupId: string): BotPoolRow | undefined {
  return getDb()
    .prepare(
      `SELECT bot_username, bot_token_value, webhook_secret, status,
              assigned_agent_group_id, assigned_at, webhook_registered_at, created_at
         FROM baget_bot_pool
        WHERE assigned_agent_group_id = ?`,
    )
    .get(agentGroupId) as BotPoolRow | undefined;
}

/**
 * Lookup by username. The per-bot webhook route (`/api/channels/
 * telegram/bot/:botUsername/webhook`) uses this to verify the
 * incoming `X-Telegram-Bot-Api-Secret-Token` against the stored
 * `webhook_secret` and to resolve which `agent_group_id` should
 * route the update.
 */
export function getBotPoolEntryByUsername(botUsername: string): BotPoolRow | undefined {
  return getDb()
    .prepare(
      `SELECT bot_username, bot_token_value, webhook_secret, status,
              assigned_agent_group_id, assigned_at, webhook_registered_at, created_at
         FROM baget_bot_pool
        WHERE bot_username = ?`,
    )
    .get(botUsername) as BotPoolRow | undefined;
}

/**
 * Register-once gate: stamp `webhook_registered_at` after Telegram
 * accepts the setWebhook call. The bind handler reads
 * `webhook_registered_at` first; if non-null, skip the API call
 * because the URL has the (immutable) username and won't change.
 */
export function markWebhookRegistered(botUsername: string, registeredAt: string): void {
  getDb()
    .prepare(
      `UPDATE baget_bot_pool
          SET webhook_registered_at = ?
        WHERE bot_username = ?`,
    )
    .run(registeredAt, botUsername);
}

/**
 * Pool depth gauge — used by the bind handler to return
 * `503 pool_exhausted` cleanly + by the seed endpoint's response so
 * the operator sees the new total.
 */
export function countAvailableBots(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM baget_bot_pool WHERE status = 'available'`)
    .get() as { n: number };
  return row.n;
}
