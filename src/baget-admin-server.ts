/**
 * Baget admin pairing server.
 *
 * One HTTP server, all routes behind a constant-time bearer-token
 * check against `BAGET_ADMIN_TOKEN`. Wire contract is documented in
 * BAGET-DEPLOY.md "Pairing contract: baget.ai ↔ baget-channel".
 *
 *   POST   /baget/agent-groups                       — create / refresh + mint pairing token
 *   POST   /baget/agent-groups/:groupId/refresh-prompt — re-render prompt only
 *   DELETE /baget/agent-groups/:groupId              — soft-delete by id (path-style)
 *   DELETE /baget/agent-groups                       — soft-delete by (userId, companyId) body
 *   GET    /baget/agent-groups/by-tuple              — status check for the dashboard pair modal
 *   GET    /healthz                                   — public, no auth
 *   POST   /api/channels/telegram/webhook             — registered by the
 *                                                       Baget Telegram channel
 *                                                       via `registerExtraRoute`
 *
 * Listens on `PORT` (Railway's convention) → falls back to
 * `BAGET_ADMIN_PORT` → 8443. Single HTTP listener for the whole service
 * because Railway routes one public port per service; channel adapters
 * register their webhook routes here via `registerExtraRoute()`.
 *
 * Design notes:
 *
 *   - **Idempotency.** `POST /baget/agent-groups` is idempotent on
 *     `(userId, companyId)` per the contract. The renderer
 *     (`provisionBagetGroup`) is already idempotent on the folder slug;
 *     this server tracks the (userId, companyId, agent_group_id) tuple
 *     in `agent_groups` and re-uses an existing row instead of inserting
 *     a duplicate. Re-pairing a previously-archived group resurrects it
 *     (clears `archived_at`).
 *
 *   - **Pairing token.** HMAC-SHA256 over `<payload>` using
 *     `BAGET_ADMIN_TOKEN` as the key. Payload is URL-safe base64 of
 *     `{ uid, cid, agid, exp }`. The DB stores ONLY the SHA256 of the
 *     concatenated `<payload>.<hmac>` so a leak of the row table doesn't
 *     leak live tokens (forging still requires the HMAC key).
 *
 *   - **Concurrency.** All routes serialize via SQLite — better-sqlite3
 *     is synchronous so two parallel POSTs against the same
 *     (userId, companyId) race only on the partial UNIQUE index, which
 *     rejects the second insert. The retry path catches it and falls
 *     through to the refresh branch.
 *
 *   - **Error format.** All non-2xx responses are
 *     `{ ok: false, error: <code>, message: <human> }` so the baget.ai
 *     bridge can branch on `error` programmatically.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import http from 'http';

import {
  archiveBagetAgentGroup,
  countMessagingGroupBindings,
  createBagetAgentGroup,
  firstBoundChatId,
  getBagetAgentGroup,
  getBagetAgentGroupById,
  unarchiveBagetAgentGroup,
  unbindMessagingGroupsForAgent,
  updateBagetTeamMembers,
} from './db/baget-agent-groups.js';
import { persistChannelTokenToOneCLI } from './baget-channel-secret.js';
import { killActiveSessionsForAgent } from './container-runner.js';
import { wipeSessionDataForAgentGroup } from './session-manager.js';
import { deleteChannelToken, upsertChannelToken } from './db/baget-channel-tokens.js';
import { getDb } from './db/connection.js';
import { insertPairingToken, sweepExpiredPairingTokens } from './db/baget-pairing-tokens.js';
import {
  ALL_ROLES,
  OPTIONAL_ROLES,
  provisionBagetGroup,
  type BagetTeamMembers,
} from './baget-pairing.js';
import {
  bindBagetTelegramChat,
  sendBagetTelegramFarewell,
  sendBagetTelegramWelcome,
} from './channels/baget-telegram-bind.js';
import { log } from './log.js';

// ── Auth ──

/**
 * Constant-time bearer-token check. Returns false on any malformed
 * header — we never log the supplied token (even truncated) because a
 * partial leak narrows brute-force time.
 */
export function verifyAdminBearer(headerValue: string | string[] | undefined, expectedToken: string): boolean {
  if (typeof headerValue !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!m) return false;
  const supplied = m[1];
  // timingSafeEqual requires equal-length buffers — pad both to the
  // longer of the two with constant zeros so we don't leak the expected
  // token's length on a length mismatch.
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  const max = Math.max(a.length, b.length);
  const ap = Buffer.alloc(max);
  const bp = Buffer.alloc(max);
  a.copy(ap);
  b.copy(bp);
  // If lengths differ, force a mismatch even when padded bytes happen
  // to align (zero-padded buffers can collide).
  const sameLen = a.length === b.length ? 1 : 0;
  return timingSafeEqual(ap, bp) && sameLen === 1;
}

// ── Pairing token mint ──

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Mint a single-use pairing token.
 *
 * Format: 32 lowercase hex chars (16 random bytes). Constraints:
 *
 *   1. Telegram's `?start=<param>` deep linking spec caps the param at
 *      **64 bytes** of `[A-Z a-z 0-9 _ -]` only — no `.`. The previous
 *      `<base64url-payload>.<base64url-hmac>` JWT shape was ~250 chars
 *      AND contained `.` (the separator). Telegram silently dropped the
 *      param, so `/start <token>` arrived as plain `/start` with no
 *      payload, and the channel adapter's regex never matched.
 *
 *   2. Defense-in-depth model:
 *      - **Replay**: the DB row's `used_at` CAS update (consumePairingToken
 *        in db/baget-pairing-tokens.ts) — atomic, single-use.
 *      - **Forgery**: the token is 16 bytes of CSPRNG entropy → 2^128
 *        guess space. A brute-force attacker would need ~10^36 attempts
 *        per token before the 5-min TTL expires. Telegram + Railway
 *        rate-limit incoming webhooks long before that.
 *
 *      The HMAC verify the previous design carried was redundant given
 *      these two layers — and not affordable under Telegram's 64-char
 *      limit. Dropped.
 *
 *   3. The DB still stores SHA256(rawToken) (not the raw token) so a
 *      DB compromise doesn't leak live tokens. Same shape as before.
 */
export function mintPairingToken(args: {
  userId: string;
  companyId: string;
  agentGroupId: string;
  /**
   * Reserved for future re-introduction of an HMAC layer (e.g. when
   * the channel moves to Slack/Discord which don't have Telegram's
   * 64-char constraint). Currently unused — left in the signature so
   * callers don't need to change when we re-add it.
   */
  adminToken?: string;
  now: number;
}): { rawToken: string; expiresAt: string; expiresAtMs: number } {
  void args.adminToken; // see jsdoc — reserved
  const expiresAtMs = args.now + PAIRING_TOKEN_TTL_MS;
  const rawToken = randomBytes(16).toString('hex'); // 32 hex chars
  return { rawToken, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs };
}

// ── Request types ──

export interface CreateAgentGroupBody {
  userId: string;
  companyId: string;
  companyName: string;
  /**
   * Per-founder team names. `cos` is required (every founder has one);
   * specialists (`developer | marketing | analyst | design | ops`) are
   * each optional and only present when the founder has actively-hired
   * that role on the dashboard. Older baget.ai builds may still send
   * the full six-role payload — both shapes are accepted, the renderer
   * gates each specialist block on its name being present. Missing
   * specialists are stripped from CLAUDE.local.md AND the persona
   * resolver falls back to the CoS persona if the model still tags a
   * reply with a role that's not on the founder's roster.
   */
  teamMembers: BagetTeamMembers;
  channelTokenCredentialName: string;
  /** Default https://app.baget.ai. Must match the founder's environment. */
  bagetApiBaseUrl: string;
  /**
   * Plaintext per-(user, company) bearer token from baget.ai's
   * `mintChannelToken`. UPSERTed into the local `baget_channel_tokens`
   * table keyed by agent_group_id (single-process mode — see
   * `src/db/baget-channel-tokens.ts` and migration 015 for the
   * architecture context). The host's `spawnSingleProcessRunner` reads
   * the row at every spawn and injects the value as
   * `BAGET_CHANNEL_TOKEN` env into the child Bun runner.
   *
   * Optional for backwards-compat: pre-bridge baget.ai builds (and
   * the legacy /start <token> path) don't supply it. When omitted,
   * the agent container starts without `BAGET_CHANNEL_TOKEN` and
   * the baget-mcp tools surface a clear "container not authenticated
   * to baget.ai — re-pair from the dashboard" error to the founder.
   * Once baget.ai's bridge code goes live in prod, future fork
   * versions can mark this required.
   *
   * NEVER log this. NEVER echo in error messages. Both persist
   * helpers (`upsertChannelToken` for SQLite,
   * `persistChannelTokenToOneCLI` for the docker-mode vault) log
   * only safe metadata — the value never leaves this function.
   *
   * Note: `channelTokenCredentialName` above is the OneCLI secret
   * name used by the docker-mode persist path. Single-process mode
   * keys by agent_group_id and ignores this field — but we still
   * require it on the wire because (a) docker-mode operators need
   * it, and (b) older bridge callers always send it.
   */
  channelToken?: string;
}

export interface CreateAgentGroupResponse {
  ok: true;
  agentGroupId: string;
  folder: string;
  telegramDeepLink: string;
  pairingTokenExpiresAt: string;
}

/**
 * Body for `POST /baget/agent-groups/bind-telegram` — direct-bind from
 * the baget.ai Login Widget OAuth flow, bypassing the deep-link
 * `/start <token>` UX. Same shape as Create plus the founder's
 * Telegram identity (verified by baget.ai's HMAC check on the widget
 * payload BEFORE this admin call).
 */
export interface BindTelegramBody extends CreateAgentGroupBody {
  /** Telegram user.id from the Login Widget payload. For 1:1 DMs this
   *  equals the chat.id (Telegram invariant), so we use it as both. */
  telegramUserId: number;
  /** Optional first_name from the Login Widget. Stored on the
   *  messaging_group row as the chat's display name. */
  telegramFirstName?: string;
}

export interface BindTelegramResponse {
  ok: true;
  agentGroupId: string;
  folder: string;
  /** True iff this call created a new messaging_group row. False when
   *  the founder had DMed the bot before binding (the row already
   *  existed and was upgraded in place). */
  messagingGroupCreated: boolean;
  /** True iff Telegram accepted the immediate welcome DM. */
  welcomeMessageDelivered: boolean;
  /** When true, baget.ai should prompt the founder to open the bot chat. */
  founderActionRequired: boolean;
  /** Canonical bot-chat URL baget.ai can surface when the founder still
   *  needs to open or re-open the shared bot. */
  telegramOpenUrl: string;
}

// ── Server ──

export interface BagetAdminServerConfig {
  port: number;
  /** Required — the bearer token baget.ai signs requests with. */
  adminToken: string;
  /** Telegram bot username, e.g. `baget_team_bot`. Used to build the deep link. */
  telegramBotUsername: string;
  /**
   * Telegram bot token. Required only when the bind-telegram endpoint
   * needs to send the welcome message. Optional so existing pure-admin
   * deployments don't have to set it; the bind-telegram route returns
   * `bot_token_unconfigured` when it's missing.
   */
  telegramBotToken?: string;
  /**
   * Override for the Telegram API base URL — tests inject this. Defaults
   * to `https://api.telegram.org`.
   */
  telegramApiBaseUrl?: string;
  /**
   * Override for the fetch implementation used to call Telegram. Tests
   * inject this; production uses the global `fetch`.
   */
  telegramFetchImpl?: typeof fetch;
  /**
   * Function the route handlers use to ULID/UUID a new agent group.
   * Wired as a parameter so tests can inject a deterministic generator.
   */
  generateAgentGroupId: () => string;
  /** Function returning current time. Wired as a parameter so tests can fix the clock. */
  now?: () => number;
}

/**
 * External-route registration. Lets the Baget Telegram channel adapter
 * (and any future adapter) share this server's HTTP listener instead of
 * binding its own port. Required for Railway: a single service has
 * exactly ONE public ingress port, so admin + webhook routes have to
 * land on the same port.
 *
 * The handler is responsible for writing the entire response (status,
 * headers, body). It receives the raw IncomingMessage / ServerResponse.
 * Returning a Promise that rejects is logged but otherwise ignored —
 * the registered handler must not leak the request thread.
 */
export type ExtraRouteMatcher = (method: string, url: string) => boolean;
export type ExtraRouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void;

const extraRoutes: Array<{ matcher: ExtraRouteMatcher; handler: ExtraRouteHandler }> = [];

/**
 * Register an extra route handler that the admin server will dispatch
 * BEFORE its own admin routes (but AFTER the auth check is bypassed —
 * extra routes manage their own auth). Returns an unregister function.
 */
export function registerExtraRoute(matcher: ExtraRouteMatcher, handler: ExtraRouteHandler): () => void {
  const entry = { matcher, handler };
  extraRoutes.push(entry);
  return () => {
    const i = extraRoutes.indexOf(entry);
    if (i >= 0) extraRoutes.splice(i, 1);
  };
}

export type BagetAdminServer = {
  listen(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Disconnect-cleanup primitive. Both DELETE handlers (path-style and
 * tuple-style) compose around this, so the recovery semantics live in
 * one place.
 *
 * Cleanly idempotent — every step here either no-ops or stays bounded
 * when called against an already-archived group with re-introduced
 * (stuck) state:
 *
 *   - `deleteChannelToken` — no-op if already gone.
 *   - `archiveBagetAgentGroup` — skipped on re-disconnect so the
 *     ORIGINAL archive timestamp is preserved (forensically valuable —
 *     "when did this founder first disconnect").
 *   - `unbindMessagingGroupsForAgent` — drops any wiring that re-
 *     appeared (the channel-approval re-bind path is the most likely
 *     re-introducer; see comment in handleDeleteByTuple) and stamps
 *     `denied_at` on every newly-orphaned chat. `denied_at` itself is
 *     guarded `WHERE denied_at IS NULL` so the original deny stamp
 *     also survives a re-run.
 *   - `killActiveSessionsForAgent` — SIGTERM by current `agentGroupId`
 *     filter; no-ops when nothing is running.
 *
 * Why this exists as its own function (instead of being inlined in
 * each handler): pinning the recovery semantics with a test. The
 * regression we fixed (rogue wiring sticking around because the
 * handler short-circuited on `archived_at`) is invisible from the
 * unit tests on the underlying helpers — it only surfaced in
 * production. Exporting + testing this function directly catches
 * future regressions where someone re-adds the short-circuit.
 *
 * Wrapped in a single SQLite transaction so an exception mid-DB
 * leaves no half-state. The kill is OUTSIDE the transaction on
 * purpose — a SIGTERM failure must not roll back the founder-
 * initiated unbind/deny (the founder asked to disconnect; we honor
 * that even if cleanup of in-flight processes throws).
 */
export function performDisconnectCleanup(
  agentGroupId: string,
  args: { wasAlreadyArchived: boolean; nowIso: string; reason: string },
): { tokenDeleted: number; unbound: number; denied: number; killedRunners: number } {
  const result = getDb().transaction(() => {
    const tokenDeleted = deleteChannelToken(agentGroupId);
    if (!args.wasAlreadyArchived) archiveBagetAgentGroup(agentGroupId, args.nowIso);
    const { unbound, denied } = unbindMessagingGroupsForAgent(agentGroupId, args.nowIso);
    return { tokenDeleted, unbound, denied };
  })();
  const killedRunners = killActiveSessionsForAgent(agentGroupId, args.reason);
  return { ...result, killedRunners };
}

export function createBagetAdminServer(config: BagetAdminServerConfig): BagetAdminServer {
  if (!config.adminToken || config.adminToken.length < 16) {
    throw new Error('BAGET_ADMIN_TOKEN must be at least 16 characters');
  }
  if (!config.telegramBotUsername) {
    throw new Error('BAGET_TELEGRAM_BOT_USERNAME is required');
  }

  const now = config.now ?? Date.now;
  let server: http.Server | null = null;

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Reject anything other than the documented routes.
    const method = (req.method || 'GET').toUpperCase();
    const url = req.url || '';

    // /healthz is intentionally public (Railway probes it) and returns
    // a 200 with no DB read so it stays cheap and never leaks state.
    if (method === 'GET' && url === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Extra routes (Baget Telegram webhook, etc.) — dispatched BEFORE
    // the bearer-auth gate because they bring their own auth (e.g. the
    // X-Telegram-Bot-Api-Secret-Token check). Each handler owns the
    // response. First match wins.
    for (const { matcher, handler } of extraRoutes) {
      if (matcher(method, url)) {
        await handler(req, res);
        return;
      }
    }

    // Auth FIRST — before reading the body, before logging the path.
    // Otherwise we'd give an attacker a free request log signal.
    if (!verifyAdminBearer(req.headers.authorization, config.adminToken)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Bearer token missing or invalid' });
      return;
    }

    // Route matching. Order is significant: by-tuple (status) is
    // matched BEFORE the path-style routes since `?userId=…&companyId=…`
    // is a query string, not a `:groupId` path segment, but bare-URL
    // matching of `/baget/agent-groups` (no segment) needs to land on
    // create OR by-tuple depending on method+query-presence.
    const urlNoQuery = url.split('?')[0];
    const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';

    // Status: GET /baget/agent-groups/by-tuple?userId=…&companyId=…
    // Lets the dashboard's pair modal flip from "waiting" to
    // "Connected ✓" once the founder taps the deep link in Telegram.
    if (method === 'GET' && urlNoQuery === '/baget/agent-groups/by-tuple') {
      await handleStatusByTuple(res, queryString);
      return;
    }

    if (method === 'POST' && urlNoQuery === '/baget/agent-groups') {
      await handleCreate(req, res);
      return;
    }
    // Direct-bind: provision agent_group + wire Telegram chat in one
    // call. Used by baget.ai's Login Widget callback after it has
    // verified the founder's Telegram authorization HMAC. Sidesteps
    // the deep-link `/start <token>` UX and the Telegram Desktop
    // payload-drop bug it suffers from. See bind-telegram body type.
    if (method === 'POST' && urlNoQuery === '/baget/agent-groups/bind-telegram') {
      await handleBindTelegram(req, res);
      return;
    }
    // Body-keyed DELETE /baget/agent-groups (with body { userId, companyId })
    // — matches the path-style DELETE /baget/agent-groups/:groupId
    // semantically but lets the baget.ai bridge skip the get-then-
    // delete dance (it doesn't track agent_group_id). Both shapes
    // route through the same archive logic.
    if (method === 'DELETE' && urlNoQuery === '/baget/agent-groups') {
      await handleDeleteByTuple(req, res);
      return;
    }
    const refreshMatch = /^\/baget\/agent-groups\/([^/]+)\/refresh-prompt$/.exec(urlNoQuery);
    if (method === 'POST' && refreshMatch) {
      await handleRefresh(req, res, refreshMatch[1]);
      return;
    }
    const deleteMatch = /^\/baget\/agent-groups\/([^/]+)$/.exec(urlNoQuery);
    if (method === 'DELETE' && deleteMatch) {
      await handleDelete(res, deleteMatch[1]);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found', message: `No route for ${method} ${url}` });
  }

  /**
   * Shared post-provision step: if baget.ai supplied `channelToken`,
   * UPSERT it into the per-agent_group row in `baget_channel_tokens`
   * (always — single-process spawn reads from there) AND persist into
   * the OneCLI vault when `RUNTIME=docker` (because docker-mode agent
   * containers can't read the host's SQLite file — the gateway proxy
   * is the load-bearing injection layer there). Returns true on
   * success (or when no token was supplied — backwards compat path);
   * returns false after writing a 500 response on either persist
   * path failing.
   *
   * Two-mode persist rationale:
   *   - SQLite always: `spawnSingleProcessRunner` reads from this
   *     table to populate `BAGET_CHANNEL_TOKEN` in child env. Even on
   *     a docker-mode host the SQLite write is harmless (docker spawn
   *     ignores it) and keeps the audit timeline consistent across
   *     runtime switches.
   *   - OneCLI on `RUNTIME=docker`: the gateway intercepts each
   *     agent container's outbound fetches and injects
   *     `Authorization: Bearer <token>` based on host-pattern + agent
   *     name. Without this branch, newly-paired groups in docker mode
   *     would silently lose their bearer (the Codex P1 catch on
   *     PR #3).
   *
   * Why agent_group_id (not credential-name / host-pattern) for the
   * SQLite path:
   *   In single-process mode the host injects directly into the
   *   child env at spawn time, keyed by agent_group_id — already the
   *   right granularity (1:1 with a (user, company) tuple via the
   *   partial UNIQUE index on agent_groups). The OneCLI fields stay
   *   request-required because the docker-mode persist still uses
   *   them.
   */
  async function maybePersistChannelToken(
    res: http.ServerResponse,
    body: CreateAgentGroupBody,
    agentGroupId: string,
    agentName: string,
  ): Promise<boolean> {
    if (!body.channelToken) {
      // Backwards-compat: pre-bridge baget.ai builds (and the legacy
      // /start <token> path) don't supply this. The agent container
      // starts without BAGET_CHANNEL_TOKEN and the baget-mcp tools
      // surface a clear error to the founder.
      return true;
    }

    // ── 1. SQLite UPSERT (always — single-process is the Baget path) ──
    try {
      upsertChannelToken({
        agentGroupId,
        tokenValue: body.channelToken,
      });
      log.info('Baget channel-token: persisted to SQLite', {
        agentGroupId,
        // Never log channelToken — the helper signature omits it from
        // any return shape, and we don't echo from the body either.
      });
    } catch (err) {
      // Catch-all because better-sqlite3 throws on disk-full / locked /
      // schema-mismatch / FK-violation. We log only the error CLASS +
      // CODE — never `err.message`. SQLite error messages can echo
      // bound parameter values when CHECK constraints or RAISE triggers
      // are present, and `tokenValue` is one of the bound parameters.
      // Today's schema has no CHECK / RAISE on this table, so the leak
      // vector is theoretical, but the principle ("don't log raw err
      // strings near a secret column") survives schema drift.
      const errCode = (err as { code?: string }).code ?? 'unknown';
      const errName = err instanceof Error ? err.constructor.name : typeof err;
      log.error('Baget channel-token: SQLite UPSERT failed', {
        agentGroupId,
        errCode,
        errName,
      });
      sendJson(res, 500, {
        ok: false,
        error: 'channel_token_persist_failed',
        message: 'Failed to persist channel token to local store',
      });
      return false;
    }

    // ── 2. OneCLI vault (docker-mode only) ──
    // Containers in docker mode can't read /app/data/v2.db — the
    // gateway proxy injects bearers via host-pattern matching. Keep
    // the original delete-then-create idempotency the helper provides.
    if (process.env.RUNTIME === 'docker') {
      let hostPattern: string;
      try {
        hostPattern = new URL(body.bagetApiBaseUrl).host;
      } catch {
        sendJson(res, 400, {
          ok: false,
          error: 'invalid_body',
          message: 'bagetApiBaseUrl must be a valid URL',
        });
        return false;
      }

      try {
        await persistChannelTokenToOneCLI({
          agentName,
          credentialName: body.channelTokenCredentialName,
          tokenValue: body.channelToken,
          hostPattern,
        });
      } catch {
        // The helper already logged the scrubbed error. The SQLite
        // row was committed above — don't roll it back; on retry the
        // upsert is idempotent and the OneCLI delete-then-create is
        // also idempotent. Returning 500 here means the docker-mode
        // caller knows the OneCLI side didn't land.
        sendJson(res, 500, {
          ok: false,
          error: 'channel_token_persist_failed',
          message: 'Failed to persist channel token to OneCLI vault',
        });
        return false;
      }
    }

    return true;
  }

  async function handleCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson<CreateAgentGroupBody>(req);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: body.error });
      return;
    }
    const validation = validateCreateBody(body.value);
    if (validation) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: validation });
      return;
    }
    const { userId, companyId, companyName, teamMembers, bagetApiBaseUrl, channelTokenCredentialName } = body.value;

    // 1. Idempotent provision: render CLAUDE.local.md + write
    //    runtime container.json under groups/<folder>/. Pure file IO,
    //    safe to re-run.
    let provisioned: ReturnType<typeof provisionBagetGroup>;
    try {
      provisioned = provisionBagetGroup({
        userId,
        companyId,
        companyName,
        teamMembers,
        bagetApiBaseUrl,
        channelTokenCredentialName,
      });
    } catch (err) {
      log.error('Baget provision failed', { userId, companyId, err });
      sendJson(res, 500, {
        ok: false,
        error: 'provision_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // 2. Insert / resurrect the agent_groups row. Idempotent on
    //    (userId, companyId) per the partial UNIQUE index.
    const teamMembersJson = JSON.stringify(teamMembers);
    const existing = getBagetAgentGroup(userId, companyId);
    let agentGroupId: string;
    if (existing) {
      agentGroupId = existing.id;
      if (existing.archived_at) {
        // Re-pair = fresh start. Kill any lingering runner first
        // (defense in depth — disconnect's killActiveSessionsForAgent
        // should have already done this, but a runner spawned in the
        // narrow window after disconnect would survive otherwise),
        // then wipe session DBs so Gemini's next turn doesn't inherit
        // tool-call history from before the disconnect (a 401 in old
        // history poisons subsequent retries even after the underlying
        // route is fixed).
        killActiveSessionsForAgent(existing.id, 'baget-create:repair-wipe-prep');
        wipeSessionDataForAgentGroup(existing.id);
        unarchiveBagetAgentGroup(existing.id);
      }
      // Always refresh team names — a re-pair after a rename should
      // pick up the new names without requiring a separate
      // refresh-prompt call.
      updateBagetTeamMembers(existing.id, teamMembersJson);
    } else {
      agentGroupId = config.generateAgentGroupId();
      try {
        createBagetAgentGroup({
          id: agentGroupId,
          name: companyName,
          folder: provisioned.folder,
          user_id: userId,
          company_id: companyId,
          baget_team_members: teamMembersJson,
          created_at: new Date(now()).toISOString(),
        });
      } catch (err) {
        // Race with a concurrent create — re-read and use the winner.
        const winner = getBagetAgentGroup(userId, companyId);
        if (!winner) {
          log.error('Baget create race had no winner', { userId, companyId, err });
          sendJson(res, 500, {
            ok: false,
            error: 'create_failed',
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        agentGroupId = winner.id;
      }
    }

    // 2b. Persist baget.ai's per-(user, company) bearer token into
    //     `baget_channel_tokens` so spawnSingleProcessRunner reads it
    //     as BAGET_CHANNEL_TOKEN env on every spawn. Skip silently
    //     when baget.ai didn't supply one (backwards-compat with
    //     pre-bridge builds and the legacy /start <token> path).
    if (!(await maybePersistChannelToken(res, body.value, agentGroupId, companyName))) {
      // The helper already wrote the 500 response. Note: the
      // agent_groups row above is committed and will get re-used on
      // a retry; the pairing token mint below is skipped on this
      // failure so a retried bind doesn't leak unused tokens.
      return;
    }

    // 3. Mint pairing token + store SHA256.
    const minted = mintPairingToken({
      userId,
      companyId,
      agentGroupId,
      adminToken: config.adminToken,
      now: now(),
    });
    insertPairingToken({
      rawToken: minted.rawToken,
      userId,
      companyId,
      agentGroupId,
      expiresAt: minted.expiresAt,
      createdAt: new Date(now()).toISOString(),
    });

    // 4. Opportunistic cleanup of expired tokens (fire and forget).
    sweepExpiredPairingTokens(new Date(now()).toISOString());

    const response: CreateAgentGroupResponse = {
      ok: true,
      agentGroupId,
      folder: provisioned.folder,
      telegramDeepLink: `https://t.me/${config.telegramBotUsername}?start=${minted.rawToken}`,
      pairingTokenExpiresAt: minted.expiresAt,
    };
    sendJson(res, 200, response);
  }

  /**
   * Provision the agent_group + directly bind a Telegram chat in one
   * call. The Login Widget on baget.ai gives us the founder's Telegram
   * user.id (== chat.id for 1:1 DMs) without needing the founder to
   * type `/start <token>` — sidestep for the Telegram Desktop deep-link
   * payload-drop quirk documented in the handoff.
   *
   * Auth: bearer-gated (admin token), same as `handleCreate`. baget.ai
   * is responsible for HMAC-verifying the Login Widget payload BEFORE
   * sending the founder's Telegram identity here. We trust the bearer.
   *
   * Idempotent on the canonical founder mapping:
   *   - re-calling with same tuple → same agent_group_id, same
   *     messaging_group_id, same founder-DM wiring, same welcome
   *     delivery report.
   *   - re-calling with the same Telegram chat for a different
   *     company/group replaces the old founder binding on that chat so
   *     delivery stays 1:1 and persona-safe.
   */
  async function handleBindTelegram(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!config.telegramBotToken) {
      log.error('bind-telegram called but telegramBotToken not configured on admin server');
      sendJson(res, 503, {
        ok: false,
        error: 'bot_token_unconfigured',
        message:
          'Direct-bind needs telegramBotToken on the admin server config. Set TELEGRAM_BOT_TOKEN in env and restart.',
      });
      return;
    }

    const body = await readJson<BindTelegramBody>(req);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: body.error });
      return;
    }
    const validation = validateBindTelegramBody(body.value);
    if (validation) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: validation });
      return;
    }
    const {
      userId,
      companyId,
      companyName,
      teamMembers,
      bagetApiBaseUrl,
      channelTokenCredentialName,
      telegramUserId,
      telegramFirstName,
    } = body.value;

    // 1. Idempotent provision: render CLAUDE.local.md + write
    //    runtime container.json under groups/<folder>/. Same call as
    //    handleCreate; pure file IO, safe to re-run.
    let provisioned: ReturnType<typeof provisionBagetGroup>;
    try {
      provisioned = provisionBagetGroup({
        userId,
        companyId,
        companyName,
        teamMembers,
        bagetApiBaseUrl,
        channelTokenCredentialName,
      });
    } catch (err) {
      log.error('Baget bind-telegram provision failed', { userId, companyId, err });
      sendJson(res, 500, {
        ok: false,
        error: 'provision_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // 2. Insert / resurrect the agent_groups row. Same logic as
    //    handleCreate — keeping inline to avoid a third caller of an
    //    extracted helper drifting from the create-side semantics.
    const teamMembersJson = JSON.stringify(teamMembers);
    const existing = getBagetAgentGroup(userId, companyId);
    let agentGroupId: string;
    if (existing) {
      agentGroupId = existing.id;
      if (existing.archived_at) {
        // Re-pair via Login-Widget direct-bind — same fresh-start
        // semantics as handleCreate's path. Kill any lingering runner
        // FIRST (open file handles to inbound.db would otherwise let
        // the Bun child read stale history through /proc/<pid>/fd
        // even after the dir is gone), then wipe session DBs so
        // Gemini's next turn starts with empty conversation context.
        killActiveSessionsForAgent(existing.id, 'baget-bind:repair-wipe-prep');
        wipeSessionDataForAgentGroup(existing.id);
        unarchiveBagetAgentGroup(existing.id);
      }
      updateBagetTeamMembers(existing.id, teamMembersJson);
    } else {
      agentGroupId = config.generateAgentGroupId();
      try {
        createBagetAgentGroup({
          id: agentGroupId,
          name: companyName,
          folder: provisioned.folder,
          user_id: userId,
          company_id: companyId,
          baget_team_members: teamMembersJson,
          created_at: new Date(now()).toISOString(),
        });
      } catch (err) {
        const winner = getBagetAgentGroup(userId, companyId);
        if (!winner) {
          log.error('Baget bind-telegram create race had no winner', { userId, companyId, err });
          sendJson(res, 500, {
            ok: false,
            error: 'create_failed',
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        agentGroupId = winner.id;
      }
    }

    // 2b. Persist baget.ai's per-(user, company) bearer token before
    //     we wire the Telegram chat. Order matters: if the token
    //     persist fails, we don't want a "bound chat" without the
    //     token to back its calls — the founder would DM the bot,
    //     get a useless reply, and not know why. Bail before bind.
    if (!(await maybePersistChannelToken(res, body.value, agentGroupId, companyName))) {
      // The helper already wrote the 500. The agent_groups row above
      // is committed; a retry will hit the existing row + UPSERT the
      // token (idempotent via INSERT … ON CONFLICT … DO UPDATE).
      return;
    }

    // 3. Wire the Telegram chat to the agent_group. For 1:1 DMs,
    //    chat.id == user.id (Telegram invariant), so we use
    //    telegramUserId as the chat.id. Idempotent.
    const bind = bindBagetTelegramChat({
      chatId: telegramUserId,
      agentGroupId,
      firstName: telegramFirstName ?? null,
    });
    if (!bind.ok) {
      log.error('Baget bind-telegram chat-bind failed', {
        userId,
        companyId,
        telegramUserId,
        reason: bind.reason,
      });
      sendJson(res, 500, {
        ok: false,
        error: 'bind_failed',
        message: `Chat-bind failed: ${bind.reason}`,
      });
      return;
    }

    // 4. Welcome the founder. Best-effort — failure here doesn't
    //    invalidate the bind (the rows above are already committed),
    //    but baget.ai needs the delivery result so it can surface an
    //    "open the bot chat" CTA instead of pretending the founder is
    //    already reachable.
    const welcome = await sendBagetTelegramWelcome({
      botToken: config.telegramBotToken,
      apiBaseUrl: config.telegramApiBaseUrl,
      fetchImpl: config.telegramFetchImpl,
      chatId: telegramUserId,
      teamMembers,
    });

    log.info('Baget bind-telegram: paired chat to agent_group via direct bind', {
      userId,
      companyId,
      telegramUserId,
      agentGroupId,
      messagingGroupId: bind.messagingGroupId,
      created: bind.created,
      welcomeMessageDelivered: welcome.ok,
      founderActionRequired: welcome.ok ? false : welcome.founderActionRequired,
    });

    const response: BindTelegramResponse = {
      ok: true,
      agentGroupId,
      folder: provisioned.folder,
      messagingGroupCreated: bind.created,
      welcomeMessageDelivered: welcome.ok,
      founderActionRequired: welcome.ok ? false : welcome.founderActionRequired,
      telegramOpenUrl: `https://t.me/${config.telegramBotUsername}`,
    };
    sendJson(res, 200, response);
  }

  async function handleRefresh(req: http.IncomingMessage, res: http.ServerResponse, groupId: string): Promise<void> {
    const body = await readJson<CreateAgentGroupBody>(req);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: body.error });
      return;
    }
    const validation = validateCreateBody(body.value);
    if (validation) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: validation });
      return;
    }
    // Refresh requires the row to already exist for this groupId.
    const existing = getBagetAgentGroup(body.value.userId, body.value.companyId);
    if (!existing || existing.id !== groupId) {
      sendJson(res, 404, {
        ok: false,
        error: 'group_not_found',
        message: `No Baget agent_group ${groupId} for the supplied (userId, companyId)`,
      });
      return;
    }
    try {
      provisionBagetGroup({
        userId: body.value.userId,
        companyId: body.value.companyId,
        companyName: body.value.companyName,
        teamMembers: body.value.teamMembers,
        bagetApiBaseUrl: body.value.bagetApiBaseUrl,
        channelTokenCredentialName: body.value.channelTokenCredentialName,
      });
    } catch (err) {
      log.error('Baget refresh failed', { groupId, err });
      sendJson(res, 500, {
        ok: false,
        error: 'refresh_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    updateBagetTeamMembers(groupId, JSON.stringify(body.value.teamMembers));
    sendJson(res, 200, { ok: true, agentGroupId: groupId, folder: existing.folder });
  }

  async function handleDelete(res: http.ServerResponse, groupId: string): Promise<void> {
    // Tenant guard: only Baget-provisioned rows (user_id IS NOT NULL)
    // can be archived through this endpoint. A baget.ai bug or
    // compromise that points DELETE at an unrelated agent_group_id
    // (e.g. a non-Baget legacy group) will get a 404 instead of
    // silently stamping `archived_at` on someone else's row.
    const existing = getBagetAgentGroupById(groupId);
    if (!existing || !existing.user_id) {
      sendJson(res, 404, {
        ok: false,
        error: 'group_not_found',
        message: `No Baget agent_group with id ${groupId}`,
      });
      return;
    }

    // Soft-delete the row + drop every chat→agent wiring it owns.
    // The rendered prompt + container.json stay on disk so a
    // future re-pair (POST /baget/agent-groups for the same user/co)
    // resurrects them. Without the unbind, post-archive DMs would
    // continue waking a runner against an archived group.
    //
    // Token-drop → archive → unbind, all wrapped in a single SQLite
    // transaction. better-sqlite3 transactions execute synchronously
    // so this is a true atomic unit of work — either all four
    // writes land or none do. Without the wrapper, an exception
    // mid-sequence (disk full, lock contention) could leave the token
    // gone but archived_at still NULL — the dashboard would show
    // "active" while the agent surfaces "re-pair" on every spawn.
    // baget.ai's resolveChannelToken is still the second-line
    // guarantee for any in-flight spawn that grabbed the token
    // microseconds before the transaction landed.
    const nowIso = new Date(now()).toISOString();
    const wasAlreadyArchived = Boolean(existing.archived_at);
    // Capture the bound Telegram chat id BEFORE running the cleanup
    // — performDisconnectCleanup drops the messaging_group_agents
    // row that firstBoundChatId joins through, so reading it after
    // would always return null.
    const farewellChatId = firstBoundChatId(groupId);
    const result = performDisconnectCleanup(groupId, {
      wasAlreadyArchived,
      nowIso,
      reason: 'founder disconnected via admin DELETE',
    });
    const farewellDelivered = await maybeSendFarewell(farewellChatId, groupId);
    sendJson(res, 200, {
      ok: true,
      agentGroupId: groupId,
      archived: !wasAlreadyArchived,
      unboundChats: result.unbound,
      deniedChats: result.denied,
      killedRunners: result.killedRunners,
      channelTokenDeleted: result.tokenDeleted > 0,
      farewellDelivered,
    });
  }

  /**
   * GET /baget/agent-groups/by-tuple?userId=…&companyId=…
   *
   * Status check for the dashboard's pair modal. Returns whether an
   * agent_group exists for this (user, company), and whether it's
   * been chat-bound (i.e., the founder completed `/start` on
   * Telegram). The modal polls this every ~2s during the 5-min
   * pairing window.
   *
   * Shape:
   *   { ok: true, paired: boolean, agentGroupId?: string,
   *     platformChatId?: string }
   *
   * - `paired: true` requires BOTH agent_group exists AND has at least
   *   one binding in `messaging_group_agents`. Just provisioning the
   *   group (POST /baget/agent-groups) is NOT pairing — only `/start`
   *   creates the binding.
   * - Archived groups return `paired: false` even if they have
   *   leftover binding rows (the unbind in handleDelete is best-
   *   effort; a stale row here would falsely show "paired" forever).
   */
  async function handleStatusByTuple(res: http.ServerResponse, queryString: string): Promise<void> {
    const params = new URLSearchParams(queryString);
    const userId = params.get('userId') ?? '';
    const companyId = params.get('companyId') ?? '';
    if (!userId || !companyId) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_query',
        message: 'userId and companyId query params are required',
      });
      return;
    }
    const existing = getBagetAgentGroup(userId, companyId);
    if (!existing || existing.archived_at) {
      sendJson(res, 200, { ok: true, paired: false });
      return;
    }
    const bindingCount = countMessagingGroupBindings(existing.id);
    if (bindingCount === 0) {
      sendJson(res, 200, {
        ok: true,
        paired: false,
        agentGroupId: existing.id,
      });
      return;
    }
    const platformChatId = firstBoundChatId(existing.id);
    sendJson(res, 200, {
      ok: true,
      paired: true,
      agentGroupId: existing.id,
      ...(platformChatId ? { platformChatId } : {}),
    });
  }

  /**
   * DELETE /baget/agent-groups (body: { userId, companyId })
   *
   * Tuple-keyed sibling of `DELETE /baget/agent-groups/:groupId`. The
   * dashboard tracks (user, company) but not agent_group_id; this
   * shape lets the bridge call DELETE in one round-trip instead of
   * the get-then-delete dance (re-provision to fetch the id, then
   * DELETE by id). Same archive logic, same response shape.
   *
   * Returns 200 with `archived: false` when there's no group for the
   * tuple (idempotent — the founder's intent is satisfied trivially
   * when there's nothing to disconnect).
   */
  async function handleDeleteByTuple(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson<{ userId?: string; companyId?: string }>(req);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: body.error });
      return;
    }
    const { userId, companyId } = body.value;
    if (!userId || !companyId) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_body',
        message: 'userId and companyId are required',
      });
      return;
    }
    const existing = getBagetAgentGroup(userId, companyId);
    if (!existing) {
      // Idempotent no-op — matches the path-style DELETE's 404 only
      // when the row never existed; here we return 200 because the
      // dashboard's intent ("disconnect this binding") is met when
      // there's nothing to disconnect.
      sendJson(res, 200, { ok: true, archived: false, unboundChats: 0 });
      return;
    }
    // No `existing.archived_at` short-circuit here — see the long
    // comment on `performDisconnectCleanup`. Re-disconnect MUST run
    // the cleanup so the founder can recover from stuck state (rogue
    // wiring re-introduced after the first archive — most commonly
    // by the channel-approval flow auto-approving a DM under owner
    // permissions).
    const nowIso = new Date(now()).toISOString();
    const wasAlreadyArchived = Boolean(existing.archived_at);
    // Capture the bound Telegram chat id BEFORE the cleanup tears
    // down messaging_group_agents — see the matching comment in
    // handleDelete.
    const farewellChatId = firstBoundChatId(existing.id);
    const result = performDisconnectCleanup(existing.id, {
      wasAlreadyArchived,
      nowIso,
      reason: 'founder disconnected via tuple DELETE',
    });
    const farewellDelivered = await maybeSendFarewell(farewellChatId, existing.id);
    sendJson(res, 200, {
      ok: true,
      agentGroupId: existing.id,
      // `archived` reflects whether THIS call did the archive write.
      // False on a re-disconnect of an already-archived group, even
      // though we still ran the rest of the cleanup (unbind/deny/kill)
      // — so a non-zero `unboundChats` / `killedRunners` paired with
      // `archived: false` is the "we found stuck state and cleaned it
      // up" signal the dashboard can surface for postmortem.
      archived: !wasAlreadyArchived,
      unboundChats: result.unbound,
      deniedChats: result.denied,
      killedRunners: result.killedRunners,
      channelTokenDeleted: result.tokenDeleted > 0,
      farewellDelivered,
    });
  }

  /**
   * Send the "channel disconnected" farewell to the founder's bound
   * Telegram chat — visible signal in the chat itself that the
   * dashboard's Disconnect actually did something. Without this, the
   * bot just goes silent (the cleanup works), and the founder reports
   * "the bot is still active in Telegram" because Telegram has no
   * built-in disconnect indicator.
   *
   * Best-effort:
   *   - Returns `null` when there's nothing to send (no bound chat,
   *     bot token unconfigured) — neither delivered nor failed.
   *   - Returns `false` on any transport failure (Telegram outage,
   *     chat-not-found, bot blocked by user). Logged at warn level.
   *     The DB cleanup ALREADY ran, so a failed farewell is purely
   *     cosmetic — never roll back, never throw.
   *   - Returns `true` only when Telegram acknowledges delivery.
   */
  async function maybeSendFarewell(chatId: string | null, agentGroupId: string): Promise<boolean | null> {
    if (!chatId || !config.telegramBotToken) return null;
    try {
      const result = await sendBagetTelegramFarewell({
        botToken: config.telegramBotToken,
        apiBaseUrl: config.telegramApiBaseUrl,
        fetchImpl: config.telegramFetchImpl,
        chatId,
      });
      if (!result.ok) {
        log.warn('Disconnect farewell not delivered', {
          agentGroupId,
          chatId,
          founderActionRequired: result.founderActionRequired,
        });
        return false;
      }
      return true;
    } catch (err) {
      log.warn('Disconnect farewell threw', { agentGroupId, chatId, err });
      return false;
    }
  }

  return {
    async listen(): Promise<void> {
      if (server) return;
      server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          log.error('Baget admin handler threw', { err, url: req.url });
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: 'internal_error', message: 'See server logs' });
          } else {
            try {
              res.end();
            } catch {
              // socket already gone
            }
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server!.once('error', onError);
        server!.listen(config.port, () => {
          server!.off('error', onError);
          log.info('Baget admin server listening', { port: config.port });
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    },
  };
}

export function validateCreateBody(body: CreateAgentGroupBody): string | null {
  const required: Array<keyof CreateAgentGroupBody> = [
    'userId',
    'companyId',
    'companyName',
    'teamMembers',
    'channelTokenCredentialName',
    'bagetApiBaseUrl',
  ];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || (typeof body[k] === 'string' && body[k] === '')) {
      return `Missing required field: ${k}`;
    }
  }
  const tm = body.teamMembers;
  if (!tm || typeof tm !== 'object') return 'teamMembers must be an object';
  // CoS is the only required member — every founder has one regardless
  // of plan tier. Apprenti has CoS + Intern; intern is not modeled by
  // this fork. The remaining specialists are optional: present iff the
  // founder has actively hired that role on the baget.ai dashboard.
  if (typeof tm.cos !== 'string' || tm.cos.trim().length === 0) {
    return 'teamMembers.cos must be a non-empty string';
  }
  // Optional specialists. If a key is absent OR explicitly null, treat
  // as "not hired" — fine. If present, it must be a non-empty string;
  // anything else (number, boolean, empty/whitespace string) is a
  // structural bug from the dashboard side and we want a clear error.
  for (const role of OPTIONAL_ROLES) {
    const v = (tm as Record<string, unknown>)[role];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.trim().length === 0) {
      return `teamMembers.${role} must be a non-empty string when present`;
    }
  }
  // Reject unknown keys. Catches dashboard-side typos and the case
  // where a new role is added on baget.ai before the fork knows about
  // it — silent dropping at render time would lose the founder's data
  // with no signal. Only enforce on string-shaped keys to avoid choking
  // on `__proto__`-style noise from JSON.parse on untrusted input.
  for (const key of Object.keys(tm)) {
    if (!(ALL_ROLES as readonly string[]).includes(key)) {
      return `teamMembers.${key} is not a known role (allowed: ${ALL_ROLES.join(', ')})`;
    }
  }
  // Cap user-controlled strings on the way in so a 10MB body doesn't
  // OOM us before we even start rendering.
  if (body.userId.length > 64 || body.companyId.length > 64) {
    return 'userId / companyId too long (max 64 chars)';
  }
  if (body.companyName.length > 200) return 'companyName too long (max 200 chars)';
  // channelToken is optional; when present, sanity-check the shape so
  // a malformed value can't propagate into the OneCLI vault. baget.ai
  // mints `crypto.randomBytes(32).toString('base64url')` → 43 chars
  // [A-Za-z0-9_-]. Allow [30, 256] for forward-compat (rotation could
  // pick a different size). Anything outside is structurally bogus.
  if (body.channelToken !== undefined) {
    if (typeof body.channelToken !== 'string') {
      return 'channelToken must be a string when present';
    }
    if (!/^[A-Za-z0-9_-]+$/.test(body.channelToken)) {
      return 'channelToken contains invalid characters (expected base64url)';
    }
    if (body.channelToken.length < 30 || body.channelToken.length > 256) {
      return 'channelToken length out of range';
    }
  }
  return null;
}

function validateBindTelegramBody(body: BindTelegramBody): string | null {
  const baseError = validateCreateBody(body);
  if (baseError) return baseError;
  if (typeof body.telegramUserId !== 'number' || !Number.isInteger(body.telegramUserId)) {
    return 'telegramUserId must be an integer';
  }
  // Telegram user IDs are positive 64-bit ints; reject obviously-bogus
  // values defensively (negatives, zero, > 2^53 which JS can't store
  // safely as a Number).
  if (body.telegramUserId <= 0 || body.telegramUserId > Number.MAX_SAFE_INTEGER) {
    return 'telegramUserId out of valid range';
  }
  if (
    body.telegramFirstName !== undefined &&
    (typeof body.telegramFirstName !== 'string' || body.telegramFirstName.length > 200)
  ) {
    return 'telegramFirstName must be a string ≤ 200 chars';
  }
  return null;
}

async function readJson<T>(req: http.IncomingMessage): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 64 * 1024; // 64KB — pairing bodies are tiny
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        req.destroy();
        resolve({ ok: false, error: 'body too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve({ ok: true, value: JSON.parse(raw) as T });
      } catch (err) {
        resolve({ ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

// Helper for callers (Telegram channel adapter) that need the same
// hash function the DB layer uses internally. Re-exported so callers
// don't reach into baget-pairing-tokens.ts directly.
export function tokenHash(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}
